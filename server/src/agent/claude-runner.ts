/**
 * Claude Agent SDK integration.
 *
 * Each support turn's customer-facing wording runs through query() with:
 *  - the agent identity system prompt (no business logic in the prompt)
 *  - our MCP server mounted for this conversation, with ONLY the three
 *    read-only lookup tools allowed: Claude may re-check a record, but it
 *    can never create tickets, escalations or log events — the
 *    deterministic orchestrator owns every side effect, so a model turn
 *    can never duplicate or invent one
 *  - every built-in Claude Code tool removed (`tools: []`), unlisted tools
 *    denied without prompting (`permissionMode: "dontAsk"`), no on-disk
 *    settings or MCP configs, no session persistence, and an empty
 *    scratch working directory — no shell, no filesystem
 *  - a hard timeout, so a slow model run falls back to the deterministic
 *    wording before the voice caller hears dead air
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  MCP_READ_ONLY_TOOLS,
  MCP_SERVER_KEY,
  MCP_WRITE_TOOLS,
  stdioServerConfig,
} from "./mcp-client.js";
import { AGENT_IDENTITY } from "./system-prompt.js";

export interface ClaudeToolCall {
  tool: string;
  input: unknown;
}

export interface ClaudeRunResult {
  text: string;
  toolCalls: ClaudeToolCall[];
  isError: boolean;
  errorMessage: string | null;
}

interface SdkAssistantMessage {
  type: "assistant";
  message: { content: Array<{ type: string; name?: string; input?: unknown; text?: string }> };
}

interface SdkResultMessage {
  type: "result";
  subtype: string;
  result?: string;
  is_error?: boolean;
  error?: unknown;
}

/** Built-in Claude Code tools, denied explicitly as defence in depth. */
const BUILT_IN_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "ExitPlanMode", "Skill",
];

/** Empty scratch directory: the agent process never runs in the repo (which holds .env). */
let scratchDir: string | null = null;
function agentCwd(): string {
  scratchDir ??= mkdtempSync(join(tmpdir(), "relaypay-agent-"));
  return scratchDir;
}

/** Backend phrasing model (override with CLAUDE_MODEL). */
export function claudeModel(): string {
  return process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
}

export function claudeTimeoutMs(): number {
  const configured = Number(process.env.CLAUDE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 12_000;
}

/** Voice turns must fit Vapi's tool timeout, so their model budget is tighter. */
export function claudeVoiceTimeoutMs(): number {
  const configured = Number(process.env.CLAUDE_VOICE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 8_000;
}

export async function runClaudeAgent(params: {
  conversationId: string;
  turnPrompt: string;
  /** Overrides the default timeout (e.g. the tighter voice budget). */
  timeoutMs?: number;
}): Promise<ClaudeRunResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const toolCalls: ClaudeToolCall[] = [];
  let text = "";
  let isError = false;
  let errorMessage: string | null = null;

  const abortController = new AbortController();
  const timeoutMs = params.timeoutMs ?? claudeTimeoutMs();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  // CLAUDE_MOUNT_MCP=false skips the per-turn MCP subprocess on
  // memory-constrained hosts: the orchestrator already passes the real
  // tool results in the prompt, so Claude does not need to re-check them.
  const mountMcp = process.env.CLAUDE_MOUNT_MCP !== "false";
  const options = {
    systemPrompt: AGENT_IDENTITY,
    mcpServers: mountMcp ? stdioServerConfig(params.conversationId) : {},
    strictMcpConfig: true,
    tools: [],
    allowedTools: mountMcp ? MCP_READ_ONLY_TOOLS : [],
    disallowedTools: [...BUILT_IN_TOOLS, ...MCP_WRITE_TOOLS],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    cwd: agentCwd(),
    maxTurns: 3,
    abortController,
    model: claudeModel(),
  } as Record<string, unknown>;

  try {
    const stream = query({ prompt: params.turnPrompt, options: options as never });
    for await (const message of stream) {
      const m = message as SdkAssistantMessage | SdkResultMessage | { type: string };
      if (m.type === "assistant") {
        for (const block of (m as SdkAssistantMessage).message?.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            toolCalls.push({ tool: block.name, input: block.input });
          } else if (block.type === "text" && block.text) {
            text = block.text;
          }
        }
      } else if (m.type === "result") {
        const result = m as SdkResultMessage;
        if (result.subtype === "success") {
          text = result.result ?? text;
        } else {
          isError = true;
          errorMessage = `agent run ended with ${result.subtype}`;
          if (result.error) errorMessage += `: ${String(result.error)}`;
        }
      }
    }
  } catch (error) {
    isError = true;
    errorMessage = abortController.signal.aborted
      ? `agent run timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  return { text, toolCalls, isError, errorMessage };
}

export { MCP_SERVER_KEY };
