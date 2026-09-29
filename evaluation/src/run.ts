/**
 * Week 6 evaluation harness.
 *
 * Runs every scenario from assets/test-scenarios.md against the REAL
 * orchestrator + REAL MCP server (mock data provider for determinism),
 * records pass/fail evidence per scenario, persists the records via the
 * configured store (Supabase in production, mock file locally), and
 * prints a testing-evidence table ready for submission.
 *
 * Run: npm run evaluate
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  loadKnowledgeChunksFromAssets,
  loadRootDotenv,
  loadSeedFromAssets,
  MockFileStore,
  type Store,
} from "@relaypay/store";
import { SupportOrchestrator, type TurnResult } from "@relaypay/server/orchestrator";

// Load the repo-root `.env` before anything reads process.env.
loadRootDotenv();

interface ScenarioOutcome {
  scenario: string;
  expected_behavior: string;
  actual_behavior: string;
  verdict: "pass" | "fail";
  notes: string;
}

const results: ScenarioOutcome[] = [];

function record(
  scenario: string,
  expected: string,
  condition: boolean,
  actual: string,
  notes = "",
): void {
  results.push({
    scenario,
    expected_behavior: expected,
    actual_behavior: actual,
    verdict: condition ? "pass" : "fail",
    notes,
  });
  console.log(`${condition ? "PASS" : "FAIL"}  ${scenario}`);
  if (!condition && notes) console.log(`      ${notes}`);
}

function fmt(result: TurnResult): string {
  return `${result.answerType}: ${result.response}`;
}

async function main(): Promise<number> {
  // Deterministic run: isolated mock store, seeded from assets.
  const seed = loadSeedFromAssets();
  const chunks = loadKnowledgeChunksFromAssets();
  const useSupabase = process.env.DATA_PROVIDER === "supabase";
  const storePath = process.env.EVAL_STORE_PATH
    ?? join(mkdtempSync(join(tmpdir(), "relaypay-eval-")), "store.json");
  let store: Store;
  if (useSupabase) {
    // Persist conversations AND evaluation records to the real project.
    store = createStore();
    await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });
  } else {
    store = new MockFileStore({ filePath: storePath, seed, knowledgeChunks: chunks });
    await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });
  }

  // Point spawned MCP subprocesses at the same store.
  process.env.DATA_PROVIDER = useSupabase ? "supabase" : "mock";
  process.env.MOCK_STORE_PATH = storePath;
  // Force deterministic (rules) responses regardless of local keys.
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const orchestrator = new SupportOrchestrator(store, chunks);

  // Unique conversation IDs per run: with DATA_PROVIDER=supabase, records
  // persist across runs, and fixed IDs would let stale rows from earlier
  // runs pollute verdicts (e.g. escalations.length === 1).
  const runId = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const evalConv = (base: string): string => `${base}-${runId}`;

  try {
    // ---------- Scenario 1: knowledge-grounded answer ----------
    {
      const conv = evalConv("eval-s1");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "What fees does RelayPay charge for international payments?",
      });
      const logs = await store.listRetrievalLogs(conv);
      const grounded = r.answerType === "knowledge"
        && /fees vary/i.test(r.response)
        && /before/i.test(r.response)
        && !/\$\s?\d+|\d+\s?%/.test(r.response)
        && logs.length === 1
        && logs[0]!.knowledge_chunks.length > 0;
      record(
        "Scenario 1: Knowledge-Grounded Answer",
        "Retrieve fee policy; explain fees depend on corridor/method; mention fees shown before confirmation; no invented amounts; retrieval logged",
        grounded,
        fmt(r),
        `retrieval_chunks=${logs[0]?.knowledge_chunks.join(",") ?? "none"}`,
      );
    }

    // ---------- Scenario 2: clarifying question ----------
    {
      const conv = evalConv("eval-s2");
      const r1 = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "My payment is stuck.",
      });
      const r2 = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "It is TXN-9005",
      });
      const ok = r1.answerType === "clarification"
        && /outgoing payout|incoming transfer|invoice payment/i.test(r1.response)
        && r2.answerType === "lookup"
        && /TXN-9005/.test(r2.response)
        && /delayed/i.test(r2.response);
      record(
        "Scenario 2: Clarifying Question",
        "Ask whether incoming transfer/outgoing payout/invoice payment; request reference if needed; no guessing; resolves after the reference is given",
        ok,
        `${fmt(r1)} || follow-up ${fmt(r2)}`,
      );
    }

    // ---------- Scenario 3: customer lookup ----------
    {
      const conv = evalConv("eval-s3");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "I am Amara from LagosLedger. Can you check my account?",
      });
      const calls = await store.listToolCalls(conv);
      const usedLookup = calls.some((c) => c.tool_name === "lookup_customer" && c.status === "success");
      const safe = r.response.includes("LagosLedger")
        && r.response.includes("Growth")
        && !r.response.includes("amara@lagosledger.example");
      record(
        "Scenario 3: Customer Lookup",
        "Use MCP customer lookup; summarize only safe account information; no sensitive details spoken",
        usedLookup && safe && r.answerType === "lookup",
        fmt(r),
        `lookup_customer_called=${usedLookup}`,
      );
    }

    // ---------- Scenario 4: transaction lookup ----------
    {
      const conv = evalConv("eval-s4");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "Can you check transaction TXN-9001?",
      });
      const calls = await store.listToolCalls(conv);
      const usedLookup = calls.some((c) => c.tool_name === "lookup_transaction" && c.status === "success");
      const ok = usedLookup
        && r.response.includes("TXN-9001")
        && /processing/i.test(r.response)
        && /normal expected window/i.test(r.response);
      record(
        "Scenario 4: Transaction Lookup",
        "Use MCP transaction lookup; give customer-safe status summary; no arrival promises beyond the record",
        ok,
        fmt(r),
      );
    }

    // ---------- Scenario 5: payout lookup + escalation ----------
    {
      const conv = evalConv("eval-s5");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "What is happening with payout PAY-7002?",
      });
      const escalations = await store.listEscalations(conv);
      const calls = await store.listToolCalls(conv);
      const ok = /review/i.test(r.response)
        && r.escalationId !== null
        && escalations.length === 1
        && escalations[0]!.category === "compliance"
        && calls.some((c) => c.tool_name === "lookup_payout")
        && calls.some((c) => c.tool_name === "create_escalation");
      record(
        "Scenario 5: Payout Lookup (review required)",
        "Use MCP payout lookup; identify that the payout requires review; escalate because it involves compliance review; escalation record created",
        ok,
        fmt(r),
        `escalation=${escalations[0]?.escalation_id ?? "none"}`,
      );
    }

    // ---------- Scenario 6: ticket creation ----------
    {
      const conv = evalConv("eval-s6");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "My invoice payment failed and I need someone to look at it. Transaction TXN-9002.",
      });
      const tickets = await store.listTickets(conv);
      const ok = r.ticketId !== null
        && tickets.length === 1
        && tickets[0]!.ticket_id === r.ticketId
        && tickets[0]!.transaction_id === "TXN-9002"
        && tickets[0]!.category === "invoice"
        && /ticket/i.test(r.response);
      record(
        "Scenario 6: Ticket Creation",
        "Create a support ticket through MCP; persist in store; confirmation returned only after success",
        ok,
        fmt(r),
        `ticket=${tickets[0]?.ticket_id ?? "none"}`,
      );
    }

    // ---------- Scenario 7: human escalation ----------
    {
      const conv = evalConv("eval-s7");
      const r1 = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "My account was restricted and nobody is helping me.",
      });
      const r2 = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "My name is Efua Mensah, email efua@accrastack.example, callback tomorrow afternoon",
      });
      const escalations = await store.listEscalations(conv);
      const ok = r1.answerType === "escalation"
        && r1.escalationId === null
        && r2.escalationId !== null
        && escalations.length === 1
        && escalations[0]!.user_email === "efua@accrastack.example"
        && escalations[0]!.call_booked === true
        && !/compliance (rule|system|team decided)/i.test(r2.response);
      record(
        "Scenario 7: Human Escalation",
        "Escalate restricted account; collect name/email/callback time; create escalation record; no internal compliance explanations",
        ok,
        `${fmt(r1)} || ${fmt(r2)}`,
        `escalation=${escalations[0]?.escalation_id ?? "none"}`,
      );
    }

    // ---------- Scenario 8: unsupported question ----------
    {
      const conv = evalConv("eval-s8");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "Can RelayPay guarantee my payout arrives by 9am tomorrow?",
      });
      const logs = await store.listRetrievalLogs(conv);
      const ok = r.answerType === "knowledge"
        && /no\.|cannot|not guarantee|external banking/i.test(r.response)
        && !/yes, (we|i) can guarantee/i.test(r.response)
        && logs.length === 1
        && /guarantee/i.test(logs[0]!.source_title);
      record(
        "Scenario 8: Unsupported Question",
        "Decline to guarantee the outcome; use approved timeline policy; no promises",
        ok,
        fmt(r),
        `source=${logs[0]?.source_title ?? "none"}`,
      );
    }

    // ---------- Scenario 9: voice flow ----------
    // Voice requires live Vapi credentials; the backend voice contract
    // (POST /vapi/webhook function-call -> { result }) is covered by the
    // API integration check below plus the manual procedure in TESTING.md.
    {
      const conv = evalConv("eval-s9");
      const r = await orchestrator.handleTurn({
        conversationId: conv,
        channel: "voice",
        userMessage: "What is happening with payout PAY-7003?",
      });
      record(
        "Scenario 9: Voice Flow (backend contract)",
        "Voice-channel turn executes the full agent path (this validates the backend half; live Vapi audio requires credentials — see TESTING.md)",
        r.answerType === "lookup" && /PAY-7003|failed|beneficiary/i.test(r.response),
        fmt(r),
        "manual Vapi audio check required for full sign-off",
      );
    }

    // ---------- Scenario 10: logging completeness ----------
    {
      const conv = evalConv("eval-s10");
      await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "What fees does RelayPay charge?",
      });
      await orchestrator.handleTurn({
        conversationId: conv,
        channel: "text",
        userMessage: "Check transaction TXN-9001",
      });
      await orchestrator.endConversation(conv);
      const [turns, retrievals, toolCalls, tickets, escalations] = await Promise.all([
        store.listTurns(conv),
        store.listRetrievalLogs(conv),
        store.listToolCalls(conv),
        store.listTickets(conv),
        store.listEscalations(conv),
      ]);
      const conversation = await store.getConversation(conv);
      const ok = turns.length === 2
        && retrievals.length === 1
        && toolCalls.length === 3 // 2 decision events + 1 lookup
        && conversation !== null
        && conversation.final_status === "completed"
        && conversation.ended_at !== null
        && conversation.summary !== null;
      record(
        "Scenario 10: Logging Completeness",
        "Conversation, turns, retrieval, tool-call and event records all persist and match the run",
        ok,
        `turns=${turns.length} retrievals=${retrievals.length} toolCalls=${toolCalls.length} tickets=${tickets.length} escalations=${escalations.length} final=${conversation?.final_status}`,
      );
    }

    // ---------- Persist evaluation records ----------
    for (const outcome of results) {
      await store.addEvaluation(outcome);
    }

    // ---------- Evidence table ----------
    const passed = results.filter((r) => r.verdict === "pass").length;
    console.log("\n================ TESTING EVIDENCE ================");
    console.log("Scenario".padEnd(46), "Verdict");
    for (const r of results) {
      console.log(`${r.scenario.padEnd(46)} ${r.verdict.toUpperCase()}`);
    }
    console.log("==================================================");
    console.log(`${passed}/${results.length} scenarios passed.`);
    if (useSupabase) {
      console.log("Evaluation records persisted to Supabase (evaluations table).");
    } else {
      console.log(`Evaluation records stored in: ${storePath}`);
      console.log("Persist to Supabase: rerun with DATA_PROVIDER=supabase (see .env.example).");
    }
    return passed === results.length ? 0 : 1;
  } finally {
    await orchestrator.dispose();
    if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Evaluation crashed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
