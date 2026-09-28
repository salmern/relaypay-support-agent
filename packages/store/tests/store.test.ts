import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadKnowledgeChunksFromAssets,
  loadSeedFromAssets,
  MockFileStore,
  parseKnowledgeBase,
  retrieveKnowledge,
} from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relaypay-store-"));

describe("knowledge base parsing", () => {
  const kb = loadKnowledgeChunksFromAssets();

  it("chunks every subsection of the approved KB", () => {
    // The approved KB has 40+ sections; chunking must not silently drop content.
    expect(kb.length).toBeGreaterThan(30);
  });

  it("keeps titles from structural headings", () => {
    const titles = kb.map((c) => c.title);
    expect(titles.some((t) => t.includes("Frequently Asked Questions"))).toBe(true);
    expect(titles.some((t) => t.includes("Policies And Compliance"))).toBe(true);
  });

  it("produces non-empty content for every chunk", () => {
    for (const chunk of kb) {
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.summary.length).toBeGreaterThan(0);
    }
  });

  it("handles markdown without headings", () => {
    const chunks = parseKnowledgeBase("Just a plain paragraph about fees.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("fees");
  });
});

describe("seed data parsing", () => {
  const seed = loadSeedFromAssets();

  it("loads all 5 customers with stable IDs", () => {
    expect(seed.customers).toHaveLength(5);
    expect(seed.customers.map((c) => c.customer_id)).toEqual([
      "CUS-1001", "CUS-1002", "CUS-1003", "CUS-1004", "CUS-1005",
    ]);
  });

  it("loads all 5 transactions", () => {
    expect(seed.transactions).toHaveLength(5);
    const txn9003 = seed.transactions.find((t) => t.transaction_id === "TXN-9003")!;
    expect(txn9003.status).toBe("review required");
  });

  it("loads all 3 payouts", () => {
    expect(seed.payouts).toHaveLength(3);
    const pay7002 = seed.payouts.find((p) => p.payout_id === "PAY-7002")!;
    expect(pay7002.status).toBe("review required");
    expect(pay7002.failure_reason).toBe("compliance review");
  });

  it("normalizes empty CSV cells to null", () => {
    const txn9003 = seed.transactions.find((t) => t.transaction_id === "TXN-9003")!;
    expect(txn9003.estimated_arrival).toBeNull();
  });
});

describe("retrieval", () => {
  const kb = loadKnowledgeChunksFromAssets();

  it("ranks the fees section first for the fees question", () => {
    const result = retrieveKnowledge(kb, "What fees does RelayPay charge for international payments?");
    expect(result.relevant).toBe(true);
    expect(result.matches[0]!.chunk.title).toMatch(/fees/i);
  });

  it("finds payout timeline knowledge for payout questions", () => {
    const result = retrieveKnowledge(kb, "How long do payouts take?");
    expect(result.relevant).toBe(true);
    const combined = result.matches.map((m) => m.chunk.title).join(" ");
    expect(combined).toMatch(/payout|payments/i);
  });

  it("finds the does-not-support answer for crypto questions", () => {
    // The KB covers this: RelayPay does not support cryptocurrency payments.
    const result = retrieveKnowledge(kb, "Do you offer cryptocurrency trading signals?");
    expect(result.relevant).toBe(true);
    expect(result.matches[0]!.chunk.title).toMatch(/feature availability|limitations/i);
    expect(result.matches[0]!.chunk.content).toContain("Cryptocurrency");
  });

  it("marks a truly uncovered topic as not relevant", () => {
    const result = retrieveKnowledge(kb, "What is the capital of France and who won the football league?");
    expect(result.relevant).toBe(false);
  });
});

describe("mock store", () => {
  const seed = loadSeedFromAssets();

  it("seeds idempotently — reruns do not duplicate", async () => {
    const path = join(tmp, `store-${Math.random().toString(36).slice(2)}.json`);
    const store1 = new MockFileStore({ filePath: path, seed });
    await store1.seedIfEmpty(seed);
    const store2 = new MockFileStore({ filePath: path });
    await store2.seedIfEmpty(seed);
    const s = JSON.parse(await import("node:fs").then((f) => f.readFileSync(path, "utf8")));
    expect(s.customers).toHaveLength(5);
    expect(s.transactions).toHaveLength(5);
    expect(s.payouts).toHaveLength(3);
  });

  it("looks up customers by id, email and company", async () => {
    const store = new MockFileStore({ filePath: join(tmp, `store-${Math.random().toString(36).slice(2)}.json`), seed });
    expect((await store.getCustomer({ customer_id: "cus-1001" }))?.company_name).toBe("LagosLedger");
    expect((await store.getCustomer({ email: "AMARA@lagosledger.example" }))?.customer_id).toBe("CUS-1001");
    expect((await store.getCustomer({ company_name: "lagosledger" }))?.customer_id).toBe("CUS-1001");
    expect(await store.getCustomer({ customer_id: "CUS-9999" })).toBeNull();
  });

  it("looks up transactions and payouts case-insensitively", async () => {
    const store = new MockFileStore({ filePath: join(tmp, `store-${Math.random().toString(36).slice(2)}.json`), seed });
    expect((await store.getTransaction("txn-9001"))?.status).toBe("processing");
    expect((await store.getPayout({ payout_id: "pay-7002" }))?.status).toBe("review required");
    expect(await store.getTransaction("TXN-0000")).toBeNull();
  });

  it("persists runtime records", async () => {
    const store = new MockFileStore({
      filePath: join(tmp, `store-${Math.random().toString(36).slice(2)}.json`),
      seed,
      knowledgeChunks: loadKnowledgeChunksFromAssets(),
    });
    await store.createConversation({ conversation_id: "conv-1", channel: "text" });
    await store.addTurn({
      conversation_id: "conv-1",
      user_transcript: "hi",
      assistant_response: "hello",
      answer_type: "knowledge",
      confidence: 0.9,
      uncertainty_note: null,
    });
    const turns = await store.listTurns("conv-1");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.answer_type).toBe("knowledge");
  });
});
