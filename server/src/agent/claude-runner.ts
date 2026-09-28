/**
 * Claude Agent SDK integration.
 *
 * Each support turn runs through query() with:
 *  - the agent identity system prompt (no business logic in the prompt)
 *  - our MCP server mounted for this conversation
 *  - only our six MCP tools allowed
 * Claude performs the tool calls itself inside the agent loop; the MCP
 * server audits every call. The deterministic decision engine decided
 * the action beforehand; the turn prompt constrains the TASK.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  MCP_ALLOWED_TOOLS,
  MCP_SERVER_KEY,
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
}

interface SdkErrorMessage {
  type: "result";
  subtype: "error_during_execution" | "error_max_turns" | string;
  error?: unknown;
}

export async function runClaudeAgent(params: {
  conversationId: string;
  turnPrompt: string;
}): Promise<ClaudeRunResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const toolCalls: ClaudeToolCall[] = [];
  let text = "";
  let isError = false;
  let errorMessage: string | null = null;

  const options = {
    systemPrompt: AGENT_IDENTITY,
    mcpServers: stdioServerConfig(params.conversationId),
    allowedTools: MCP_ALLOWED_TOOLS,
    maxTurns: 8,
    ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
  } as Record<string, unknown>;

  type SdkMessage = SdkAssistantMessage | SdkResultMessage | ({ type: string } & Record<string, unknown>);
  const stream = query({
    prompt: params.turnPrompt,
    options: options as never,
  });

  for await (const message of stream) {
    const m = message as SdkMessage;
    if (m.type === "assistant") {
      const blocks = (m as SdkAssistantMessage).message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_use" && block.name) {
          toolCalls.push({ tool: block.name, input: block.input });
        } else if (block.type === "text" && block.text) {
          text = block.text;
        }
      }
    } else if (m.type === "result") {
      const result = m as SdkResultMessage & SdkErrorMessage;
      if (result.subtype === "success") {
        text = result.result ?? text;
      } else {
        isError = true;
        errorMessage = `agent run ended with ${result.subtype}`;
        if (result.error) errorMessage += `: ${String(result.error)}`;
      }
    }
  }

  return { text, toolCalls, isError, errorMessage };
}

export { MCP_SERVER_KEY };
