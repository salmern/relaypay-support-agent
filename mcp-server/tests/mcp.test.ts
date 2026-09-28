/**
 * MCP server integration tests. Each test boots the compiled server as a
 * subprocess and communicates over the real stdio transport with the MCP
 * client SDK — the same path the Claude Agent SDK uses in production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadKnowledgeChunksFromAssets,
  loadSeedFromAssets,
  MockFileStore,
} from "@relaypay/store";

const tmp = mkdtempSync(join(tmpdir(), "relaypay-mcp-"));
const storePath = join(tmp, "mcp-test-store.json");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // Pre-seed the shared mock store file the MCP subprocess will read.
  const store = new MockFileStore({
    filePath: storePath,
    seed: loadSeedFromAssets(),
    knowledgeChunks: loadKnowledgeChunksFromAssets(),
  });
  await store.seedIfEmpty({
    ...loadSeedFromAssets(),
    knowledgeChunks: loadKnowledgeChunksFromAssets(),
  });

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: {
      ...(process.env as Record<string, string>),
      DATA_PROVIDER: "mock",
      MOCK_STORE_PATH: storePath,
      RELAYPAY_CONVERSATION_ID: "conv-mcp-test",
    },
  });
  client = new Client({ name: "mcp-test", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  transport?.close();
});

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError).toBeFalsy();
  const content = response.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

describe("tools/list", () => {
  it("exposes exactly the six required tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_escalation",
      "create_support_ticket",
      "log_conversation_event",
      "lookup_customer",
      "lookup_payout",
      "lookup_transaction",
    ]);
  });
});

describe("lookup_customer", () => {
  it("finds a seeded customer by ID and returns customer-safe fields", async () => {
    const result = await callTool("lookup_customer", { customer_id: "CUS-1001" });
    expect(result.found).toBe(true);
    expect(result.company_name).toBe("LagosLedger");
    expect(result.plan).toBe("Growth");
    expect(result.account_status).toBe("active");
    // contact_email / contact_name must NOT be part of the tool contract
    expect(result).not.toHaveProperty("contact_email");
  });

  it("finds a customer by company name (case-insensitive)", async () => {
    const result = await callTool("lookup_customer", { company_name: "accrastack" });
    expect(result.found).toBe(true);
    expect(result.customer_id).toBe("CUS-1003");
    expect(result.account_status).toBe("restricted");
  });

  it("returns found:false without crashing for an unknown customer", async () => {
    const result = await callTool("lookup_customer", { customer_id: "CUS-4242" });
    expect(result.found).toBe(false);
  });
});

describe("lookup_transaction", () => {
  it("returns the seeded status for TXN-9001", async () => {
    const result = await callTool("lookup_transaction", { transaction_id: "TXN-9001" });
    expect(result.found).toBe(true);
    expect(result.status).toBe("processing");
    expect(result.type).toBe("outgoing payout");
    expect(result.currency).toBe("USD");
    expect(result.support_summary).toContain("normal expected window");
  });

  it("returns found:false for a transaction that does not exist", async () => {
    const result = await callTool("lookup_transaction", { transaction_id: "TXN-0000" });
    expect(result.found).toBe(false);
  });
});

describe("lookup_payout", () => {
  it("identifies the compliance review on PAY-7002", async () => {
    const result = await callTool("lookup_payout", { payout_id: "PAY-7002" });
    expect(result.found).toBe(true);
    expect(result.status).toBe("review required");
    expect(result.support_summary).toContain("review");
  });

  it("resolves payouts by linked transaction", async () => {
    const result = await callTool("lookup_payout", { transaction_id: "TXN-9004" });
    expect(result.found).toBe(true);
    expect(result.payout_id).toBe("PAY-7003");
  });
});

describe("create_support_ticket", () => {
  it("persists a ticket and returns a stable ticket id", async () => {
    const result = await callTool("create_support_ticket", {
      customer_id: "CUS-1004",
      category: "payment",
      priority: "high",
      summary: "Contractor payout failed and needs review",
      conversation_id: "conv-mcp-test",
    });
    expect(typeof result.ticket_id).toBe("string");
    expect(String(result.ticket_id)).toMatch(/^TCK-/);
    expect(result.status).toBe("open");
    const persisted = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(storePath, "utf8")));
    const tickets = persisted.tickets as Array<{ ticket_id: string; customer_id: string }>;
    expect(tickets.some((t) => t.ticket_id === result.ticket_id && t.customer_id === "CUS-1004")).toBe(true);
  });
});

describe("create_escalation", () => {
  it("persists an escalation with call_booked when a time is given", async () => {
    const result = await callTool("create_escalation", {
      customer_id: "CUS-1003",
      user_name: "Efua Mensah",
      user_email: "efua@accrastack.example",
      category: "compliance",
      reason: "Payout stuck in compliance review",
      preferred_time: "weekdays after 2pm",
    });
    expect(String(result.escalation_id)).toMatch(/^ESC-/);
    expect(result.status).toBe("open");
    expect(String(result.follow_up_summary)).toContain("specialist");
    const persisted = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(storePath, "utf8")));
    const escalations = persisted.escalations as Array<{ escalation_id: string; call_booked: boolean }>;
    const match = escalations.find((e) => e.escalation_id === result.escalation_id);
    expect(match?.call_booked).toBe(true);
  });
});

describe("log_conversation_event", () => {
  it("writes an auditable event", async () => {
    const result = await callTool("log_conversation_event", {
      conversation_id: "conv-mcp-test",
      event_type: "decision",
      summary: "Chose to clarify before lookup",
      metadata: { answer_type: "clarification" },
    });
    expect(result.logged).toBe(true);
  });
});

describe("audit logging", () => {
  it("records a tool_calls entry for every tool invocation", async () => {
    await callTool("lookup_transaction", { transaction_id: "TXN-9005" });
    const persisted = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(storePath, "utf8")));
    const calls = persisted.tool_calls as Array<{ tool_name: string; status: string; conversation_id: string | null }>;
    const lookupCalls = calls.filter((c) => c.tool_name === "lookup_transaction");
    expect(lookupCalls.length).toBeGreaterThan(0);
    expect(lookupCalls[lookupCalls.length - 1]!.status).toBe("success");
    expect(lookupCalls[lookupCalls.length - 1]!.conversation_id).toBe("conv-mcp-test");
  });
});
