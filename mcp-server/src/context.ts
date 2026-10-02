/**
 * Shared context + audit wrapper for MCP tool handlers.
 *
 * Every tool call is recorded to the tool_calls audit table with:
 * tool name, purpose, input summary, result summary, status, error, time.
 * Audit logging itself must never crash a tool; failures go to stderr.
 *
 * The conversation id is injected per MCP server process via the
 * --conversation-id argument (the orchestrator spawns the server
 * scoped to the active conversation), so tool contracts stay exactly as
 * specified in assets/mcp-tool-requirements.md.
 */
import type { Store } from "@relaypay/store";

export interface ToolContext {
  store: Store;
  getConversationId: () => string | null;
}

export type ToolOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

/** Mask the local part of an email for audit summaries. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 3);
  return `${visible}***@${domain}`;
}

export function summarizeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    let display = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof display === "string" && display.includes("@") && display.includes(".")) {
      display = maskEmail(display);
    }
    if (display.length > 60) display = `${display.slice(0, 57)}...`;
    parts.push(`${key}=${display}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(no input)";
}

export async function withAudit<T>(
  ctx: ToolContext,
  toolName: string,
  purpose: string,
  input: Record<string, unknown>,
  handler: () => Promise<T>,
): Promise<ToolOutcome<T>> {
  const startedAt = Date.now();
  try {
    const result = await handler();
    const resultSummary = summarizeResult(result);
    await logAudit(ctx, {
      tool_name: toolName,
      purpose,
      input_summary: summarizeInput(input),
      result_summary: resultSummary,
      status: "success",
      error_message: null,
    });
    process.stderr.write(`[mcp] ${toolName} ok (${Date.now() - startedAt}ms) ${resultSummary}\n`);
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logAudit(ctx, {
      tool_name: toolName,
      purpose,
      input_summary: summarizeInput(input),
      result_summary: "call failed",
      status: "error",
      error_message: message,
    });
    process.stderr.write(`[mcp] ${toolName} FAILED: ${message}\n`);
    return { ok: false, error: message };
  }
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "(empty)";
  if (typeof result === "string") return result.slice(0, 160);
  if (typeof result !== "object") return String(result).slice(0, 160);
  const record = result as Record<string, unknown>;
  const keys = ["found", "ticket_id", "escalation_id", "logged", "status", "customer_id", "transaction_id", "payout_id"];
  const parts: string[] = [];
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      parts.push(`${key}=${String(record[key])}`);
    }
  }
  if (record.error) parts.push(`error=${String(record.error).slice(0, 80)}`);
  return parts.length > 0 ? parts.join(" ") : "(result)";
}

async function logAudit(
  ctx: ToolContext,
  entry: {
    tool_name: string;
    purpose: string;
    input_summary: string;
    result_summary: string;
    status: "success" | "error";
    error_message: string | null;
  },
): Promise<void> {
  try {
    await ctx.store.addToolCallLog({
      conversation_id: ctx.getConversationId(),
      ...entry,
    });
  } catch (error) {
    process.stderr.write(
      `[mcp] audit log write failed for ${entry.tool_name}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
