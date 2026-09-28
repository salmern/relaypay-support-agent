/**
 * MCP smoke test: boots the compiled server as a subprocess and calls
 * every tool over a real stdio transport using the MCP client SDK.
 *
 * Run: npm run mcp:smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadKnowledgeChunksFromAssets,
  loadSeedFromAssets,
  MockFileStore,
} from "@relaypay/store";

interface SmokeResult {
  tool: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const useMock = process.env.DATA_PROVIDER !== "supabase";
  if (useMock) {
    process.env.DATA_PROVIDER = "mock";
    process.env.MOCK_STORE_PATH =
      process.env.MOCK_STORE_PATH ?? "./data/mcp-smoke.json";
    // Seed the shared mock store file BEFORE spawning the server so
    // lookups in the subprocess see the seed data (idempotent upserts).
    const store = new MockFileStore({ filePath: process.env.MOCK_STORE_PATH });
    await store.seedIfEmpty({
      ...loadSeedFromAssets(),
      knowledgeChunks: loadKnowledgeChunksFromAssets(),
    });
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./index.js", import.meta.url).pathname],
    env: {
      ...(process.env as Record<string, string>),
      RELAYPAY_CONVERSATION_ID: "conv-smoke",
    },
  });

  const client = new Client({ name: "relaypay-smoke", version: "1.0.0" });
  await client.connect(transport);

  const results: SmokeResult[] = [];

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await client.callTool({ name, arguments: args });
    const content = response.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.text ?? "{}";
    return JSON.parse(text) as Record<string, unknown>;
  }

  const customer = await call("lookup_customer", { customer_id: "CUS-1001" });
  results.push({
    tool: "lookup_customer",
    ok: customer.found === true && customer.company_name === "LagosLedger",
    detail: JSON.stringify(customer).slice(0, 120),
  });

  const transaction = await call("lookup_transaction", { transaction_id: "TXN-9001" });
  results.push({
    tool: "lookup_transaction",
    ok: transaction.found === true && transaction.status === "processing",
    detail: JSON.stringify(transaction).slice(0, 120),
  });

  const payout = await call("lookup_payout", { payout_id: "PAY-7002" });
  results.push({
    tool: "lookup_payout",
    ok: payout.found === true && payout.status === "review required",
    detail: JSON.stringify(payout).slice(0, 120),
  });

  const ticket = await call("create_support_ticket", {
    customer_id: "CUS-1001",
    category: "payment",
    priority: "high",
    summary: "Smoke test ticket",
    conversation_id: "conv-smoke",
  });
  results.push({
    tool: "create_support_ticket",
    ok: typeof ticket.ticket_id === "string" && ticket.ticket_id.startsWith("TCK-"),
    detail: JSON.stringify(ticket).slice(0, 120),
  });

  const escalation = await call("create_escalation", {
    customer_id: "CUS-1001",
    user_name: "Smoke Test",
    user_email: "smoke@example.com",
    category: "compliance",
    reason: "Smoke test escalation",
    preferred_time: "tomorrow 10am",
  });
  results.push({
    tool: "create_escalation",
    ok: typeof escalation.escalation_id === "string" && escalation.escalation_id.startsWith("ESC-"),
    detail: JSON.stringify(escalation).slice(0, 120),
  });

  const event = await call("log_conversation_event", {
    conversation_id: "conv-smoke",
    event_type: "note",
    summary: "Smoke test event",
    metadata: { source: "smoke" },
  });
  results.push({
    tool: "log_conversation_event",
    ok: event.logged === true,
    detail: JSON.stringify(event).slice(0, 120),
  });

  await client.close();
  transport.close();

  let failures = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.tool}  ${r.detail}`);
    if (!r.ok) failures += 1;
  }
  console.log(failures === 0 ? "\nAll MCP smoke checks passed." : `\n${failures} MCP smoke check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Smoke test crashed:", error);
    process.exit(1);
  });
