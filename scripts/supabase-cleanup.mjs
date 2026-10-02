#!/usr/bin/env node
/**
 * Supabase demo-data cleanup (DRY RUN by default — nothing changes
 * without --apply).
 *
 *   npm run db:cleanup                      show what would change
 *   npm run db:cleanup -- --apply           remove test data + close stale conversations
 *   npm run db:cleanup -- --all-runtime --apply
 *                                           wipe ALL runtime records (conversations,
 *                                           turns, logs, tickets, escalations,
 *                                           evaluations) for a clean recording;
 *                                           seed tables and kb_chunks are kept
 *
 * Default scope (without --all-runtime):
 *   - conversations whose id starts with eval- (evaluation runs), vapi-
 *     (fragments from the old call-id bug), conc- / conv-test- (tests),
 *     plus any ids passed with --id <conversation-id> (repeatable)
 *   - every row that belongs to those conversations
 *   - evaluation records (regenerate with `npm run evaluate:supabase`)
 *   - open conversations idle for more than an hour are CLOSED (not
 *     deleted): ended_at = last turn time, final_status completed/escalated
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or
 * the repo-root .env. Prints counts only — never row contents.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL_RUNTIME = args.includes("--all-runtime");
const KEEP_EVALUATIONS = args.includes("--keep-evaluations");
const EXTRA_IDS = args.flatMap((a, i) => (a === "--id" && args[i + 1] ? [args[i + 1]] : []));

function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function all(table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function deleteWhereIn(table, column, values) {
  let removed = 0;
  for (let i = 0; i < values.length; i += 100) {
    const chunk = values.slice(i, i + 100);
    const { error, count } = await db.from(table).delete({ count: "exact" }).in(column, chunk);
    if (error) throw new Error(`${table}: ${error.message}`);
    removed += count ?? 0;
  }
  return removed;
}

const TEST_PREFIXES = ["eval-", "vapi-", "conc-", "conv-test-"];
// Child tables first (foreign keys): escalations reference tickets.
const CHILD_TABLES = ["tool_calls", "retrieval_logs", "conversation_events", "conversation_turns", "escalations", "support_tickets"];

async function main() {
  console.log(`Supabase cleanup — ${APPLY ? "APPLYING CHANGES" : "dry run (add --apply to change data)"}${ALL_RUNTIME ? " — ALL runtime records" : ""}\n`);

  const conversations = await all("conversations", "id, ended_at, final_status");
  const targets = ALL_RUNTIME
    ? conversations.map((c) => c.id)
    : conversations
        .map((c) => c.id)
        .filter((id) => TEST_PREFIXES.some((p) => id.startsWith(p)) || EXTRA_IDS.includes(id));
  const targetSet = new Set(targets);

  // Count dependent rows.
  const counts = {};
  for (const table of CHILD_TABLES) {
    const rows = await all(table, "conversation_id");
    counts[table] = rows.filter((r) => targetSet.has(r.conversation_id)).length;
  }
  const evaluations = KEEP_EVALUATIONS ? [] : await all("evaluations", "id");

  // Stale open conversations that are NOT being deleted get closed.
  const turns = await all("conversation_turns", "conversation_id, created_at, user_transcript");
  const events = await all("conversation_events", "conversation_id, event_type");
  const lastTurn = new Map();
  for (const t of turns) {
    const prev = lastTurn.get(t.conversation_id);
    if (!prev || t.created_at > prev.created_at) lastTurn.set(t.conversation_id, t);
  }
  const escalated = new Set(events.filter((e) => e.event_type === "escalation_created").map((e) => e.conversation_id));
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stale = conversations.filter((c) => !targetSet.has(c.id) && !c.ended_at && (lastTurn.get(c.id)?.created_at ?? "") < cutoff);

  console.log(`conversations to delete: ${targets.length} of ${conversations.length}`);
  for (const table of CHILD_TABLES) console.log(`  ${table.padEnd(22)} rows to delete: ${counts[table]}`);
  console.log(`evaluations to delete:   ${evaluations.length}${KEEP_EVALUATIONS ? " (kept: --keep-evaluations)" : ""}`);
  console.log(`stale open conversations to close: ${stale.length}`);

  if (!APPLY) {
    console.log("\nNothing changed. Re-run with --apply to perform the cleanup.");
    return;
  }

  for (const table of CHILD_TABLES) {
    if (counts[table] > 0) await deleteWhereIn(table, "conversation_id", targets);
  }
  if (targets.length > 0) await deleteWhereIn("conversations", "id", targets);
  if (evaluations.length > 0) await deleteWhereIn("evaluations", "id", evaluations.map((e) => e.id));

  for (const c of stale) {
    const last = lastTurn.get(c.id);
    const { error } = await db
      .from("conversations")
      .update({
        ended_at: last?.created_at ?? new Date().toISOString(),
        final_status: escalated.has(c.id) ? "escalated" : "completed",
        summary: last ? `Closed by cleanup (no end event received). Last topic: ${String(last.user_transcript).slice(0, 120)}` : "Closed by cleanup (no turns)",
      })
      .eq("id", c.id);
    if (error) throw new Error(`close ${c.id}: ${error.message}`);
  }
  console.log("\nCleanup applied.");
}

main().catch((error) => {
  console.error("Cleanup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
