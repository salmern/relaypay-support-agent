/**
 * MCP connection management.
 *
 * - stdioServerConfig(): the config object handed to the Claude Agent
 *   SDK so Claude's tool loop runs against OUR MCP server.
 * - RelayPayMcpClient: a direct MCP client used by the deterministic
 *   (rule-based) responder and by decision-event logging.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the compiled MCP server entrypoint by walking up from this
 * module's directory (and the cwd), so it works regardless of build
 * layout. Override with RELAYPAY_MCP_SERVER_PATH when deploying.
 */
export function resolveMcpServerPath(): string {
  if (process.env.RELAYPAY_MCP_SERVER_PATH) {
    return process.env.RELAYPAY_MCP_SERVER_PATH;
  }
  const relative = "mcp-server/dist/index.js";
  const startDirs = [
    dirname(fileURLToPath(import.meta.url)),
    process.cwd(),
  ];
  for (const start of startDirs) {
    let dir = resolve(start);
    for (;;) {
      const candidate = `${dir}/${relative}`;
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "Could not locate mcp-server/dist/index.js. " +
      "Build it (npm run build -w @relaypay/mcp-server) or set RELAYPAY_MCP_SERVER_PATH.",
  );
}

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args: string[];
}

/**
 * MCP server config for the Agent SDK, scoped to one conversation.
 *
 * SECURITY: the Agent SDK serializes this config (including any `env`)
 * onto the Claude CLI's command line, where every local user can read it
 * with `ps`. So NO environment is passed here: the CLI subprocess
 * inherits this process's environment and hands it to the MCP server,
 * and the (non-secret) conversation id travels as a CLI argument.
 */
export function stdioServerConfig(conversationId: string): { "relaypay-support": StdioServerConfig } {
  return {
    "relaypay-support": {
      type: "stdio",
      command: process.execPath,
      args: [resolveMcpServerPath(), "--conversation-id", conversationId],
    },
  };
}

/** All six MCP tools, in Agent SDK naming. */
export const MCP_ALLOWED_TOOLS = [
  "mcp__relaypay-support__lookup_customer",
  "mcp__relaypay-support__lookup_transaction",
  "mcp__relaypay-support__lookup_payout",
  "mcp__relaypay-support__create_support_ticket",
  "mcp__relaypay-support__create_escalation",
  "mcp__relaypay-support__log_conversation_event",
];

/** The tools Claude may call itself: read-only lookups only. */
export const MCP_READ_ONLY_TOOLS = MCP_ALLOWED_TOOLS.filter((t) => /__lookup_/.test(t));

/** Side-effecting tools: only the deterministic orchestrator calls these. */
export const MCP_WRITE_TOOLS = MCP_ALLOWED_TOOLS.filter((t) => !/__lookup_/.test(t));

export const MCP_SERVER_KEY = "relaypay-support" as const;

export class RelayPayMcpClient {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async spawn(conversationId: string): Promise<RelayPayMcpClient> {
    // Spawned directly (not via a CLI), so the environment is passed to
    // the child process privately — never on a command line.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolveMcpServerPath(), "--conversation-id", conversationId],
      env: { ...process.env } as Record<string, string>,
    });
    const client = new Client({ name: "relaypay-orchestrator", version: "1.0.0" });
    await client.connect(transport);
    return new RelayPayMcpClient(client, transport);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.callTool({ name, arguments: args });
    if (response.isError) {
      const content = response.content as Array<{ type: string; text?: string }> | undefined;
      throw new Error(content?.[0]?.text ?? `MCP tool ${name} failed`);
    }
    const content = response.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.text ?? "{}";
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      this.transport.close();
    }
  }
}
