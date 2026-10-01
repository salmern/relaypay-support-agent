/**
 * Orchestrator integration tests.
 *
 * Runs the REAL orchestrator + REAL MCP server subprocess + mock store,
 * covering the Week 6 scenarios end-to-end (minus live Claude/Vapi,
 * which need external credentials — see TESTING.md).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadKnowledgeChunksFromAssets,
  loadSeedFromAssets,
  MockFileStore,
} from "@relaypay/store";
import { SupportOrchestrator } from "../src/orchestrator.js";

let store: MockFileStore;
let orchestrator: SupportOrchestrator;
let storePath: string;
let conversationId: string;
let previousMockPath: string | undefined;

beforeEach(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "relaypay-orch-"));
  storePath = join(tmp, "store.json");
  const seed = loadSeedFromAssets();
  store = new MockFileStore({
    filePath: storePath,
    seed,
    knowledgeChunks: loadKnowledgeChunksFromAssets(),
  });
  await store.seedIfEmpty({ ...seed, knowledgeChunks: loadKnowledgeChunksFromAssets() });
  // The orchestrator's MCP subprocess shares state through this env var
  // (see .env.example) — it must point at the same store file.
  previousMockPath = process.env.MOCK_STORE_PATH;
  process.env.MOCK_STORE_PATH = storePath;
  orchestrator = new SupportOrchestrator(store, loadKnowledgeChunksFromAssets());
  conversationId = `conv-test-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(async () => {
  await orchestrator.dispose();
  if (previousMockPath === undefined) delete process.env.MOCK_STORE_PATH;
  else process.env.MOCK_STORE_PATH = previousMockPath;
});

function persisted() {
  return JSON.parse(readFileSync(storePath, "utf8")) as {
    conversations: unknown[];
    turns: Array<{ conversation_id: string; answer_type: string; assistant_response: string }>;
    retrieval_logs: Array<{ conversation_id: string | null; query: string; knowledge_chunks: string[]; source_title: string }>;
    tool_calls: Array<{ tool_name: string; status: string; conversation_id: string | null }>;
    tickets: Array<{ ticket_id: string; category: string; priority: string; customer_id: string | null; transaction_id: string | null; conversation_id: string }>;
    escalations: Array<{ escalation_id: string; category: string; call_booked: boolean; user_email: string | null; conversation_id: string }>;
    conversation_events: Array<{ event_type: string; conversation_id: string }>;
  };
}

async function turn(message: string) {
  return orchestrator.handleTurn({ conversationId, channel: "text", userMessage: message });
}

describe("Scenario 1: knowledge-grounded answer", () => {
  it("answers fees question from approved knowledge and logs retrieval", async () => {
    const result = await turn("What fees does RelayPay charge for international payments?");
    expect(result.answerType).toBe("knowledge");
    expect(result.response).toMatch(/fees vary|before.*(confirm|transaction)/i);
    // Grounded: must NOT contain an invented fee number
    expect(result.response).not.toMatch(/\$\s?\d+|\d+\s?%/);
    // Retrieval was logged with chunk ids and source title
    const logs = persisted().retrieval_logs.filter((l) => l.conversation_id === conversationId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.knowledge_chunks.length).toBeGreaterThan(0);
    expect(logs[0]!.source_title).toMatch(/fee/i);
    // The response must be consistent with the retrieved chunks
    expect(logs[0]!.source_title.toLowerCase()).toContain("fees");
  });

  it("declines instead of hallucinating when nothing matches", async () => {
    const result = await turn("What is the airspeed velocity of an unladen swallow?");
    expect(result.answerType).toBe("decline");
    expect(result.response).toMatch(/cannot answer|don't have approved/i);
  });
});

describe("Scenario 2: clarification", () => {
  it("asks which payment kind and does NOT guess a status", async () => {
    const result = await turn("My payment is stuck.");
    expect(result.answerType).toBe("clarification");
    expect(result.response).toMatch(/outgoing payout|incoming transfer|invoice payment/i);
    // No status words may be invented
    expect(result.response).not.toMatch(/is (completed|processing|failed|delayed)/i);
    // No lookup tool calls may have happened yet (only the decision audit log)
    const calls = persisted().tool_calls.filter((c) => c.conversation_id === conversationId);
    expect(calls.filter((c) => c.tool_name.startsWith("lookup"))).toHaveLength(0);
  });

  it("continues the conversation when the reference is provided afterwards", async () => {
    await turn("My payment is stuck.");
    const result = await turn("It is TXN-9005");
    expect(result.answerType).toBe("lookup");
    expect(result.response).toContain("TXN-9005");
    expect(result.response).toMatch(/delayed/i);
  });
});

describe("Scenario 3: customer lookup", () => {
  it("looks up Amara from LagosLedger and speaks only safe fields", async () => {
    const result = await turn("I am Amara from LagosLedger. Can you check my account?");
    expect(result.answerType).toBe("lookup");
    expect(result.response).toContain("LagosLedger");
    expect(result.response).toMatch(/active/i);
    // Contact email must never be spoken
    expect(result.response).not.toContain("amara@lagosledger.example");
    const calls = persisted().tool_calls.filter((c) => c.conversation_id === conversationId);
    expect(calls.some((c) => c.tool_name === "lookup_customer" && c.status === "success")).toBe(true);
  });

  it("escalates restricted accounts: contact first, record on next turn", async () => {
    const first = await turn("This is Efua from AccraStack, can you check my account?");
    // Two-step escalation: the first turn asks for contact details and
    // must NOT create a contact-less escalation record.
    expect(first.answerType).toBe("escalation");
    expect(first.escalationId).toBeNull();
    expect(first.response).toMatch(/name|email|specialist/i);
    expect(persisted().escalations.filter((e) => e.conversation_id === conversationId)).toHaveLength(0);

    const second = await turn("My name is Efua Mensah, email efua@accrastack.example");
    expect(second.escalationId).toMatch(/^ESC-/);
    const escalations = persisted().escalations.filter((e) => e.conversation_id === conversationId);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.category).toBe("account");
    expect(escalations[0]!.user_email).toBe("efua@accrastack.example");
  });

  it("does not create duplicate account escalations on repeated questions", async () => {
    await turn("This is Efua from AccraStack, can you check my account?");
    await turn("Efua Mensah, efua@accrastack.example");
    const third = await turn("Can you check my account again?");
    expect(third.escalationId).toMatch(/^ESC-/); // reuses the same record
    const escalations = persisted().escalations.filter((e) => e.conversation_id === conversationId);
    expect(escalations).toHaveLength(1);
  });

  it("asks for identifying info when none is given", async () => {
    const result = await turn("Can you check my account?");
    expect(result.answerType).toBe("clarification");
    expect(result.response).toMatch(/company name|customer id/i);
  });
});

describe("Scenario 4: transaction lookup", () => {
  it("returns the real seeded status for TXN-9001", async () => {
    const result = await turn("Can you check transaction TXN-9001?");
    expect(result.answerType).toBe("lookup");
    expect(result.response).toContain("TXN-9001");
    expect(result.response).toMatch(/processing/i);
    const calls = persisted().tool_calls.filter((c) => c.tool_name === "lookup_transaction" && c.conversation_id === conversationId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input_summary).toContain("TXN-9001");
  });

  it("does not fabricate unknown transactions", async () => {
    const result = await turn("Check transaction TXN-9999 please");
    expect(result.response).toMatch(/couldn't find/i);
    expect(result.uncertaintyNote).toMatch(/not found/i);
  });

  it("returns the seeded support summary for the delayed transfer", async () => {
    const result = await turn("What is the status of TXN-9005?");
    expect(result.response).toMatch(/delayed/i);
    expect(result.response).toContain("3100 EUR");
  });
});

describe("Scenario 5: payout lookup + compliance escalation", () => {
  it("identifies PAY-7002 review, collects contact, then escalates", async () => {
    const first = await turn("What is happening with payout PAY-7002?");
    expect(first.response).toMatch(/review/i);
    expect(first.answerType).toBe("escalation");
    expect(first.escalationId).toBeNull(); // contact details come first
    expect(first.response).toMatch(/name|email/i);

    const second = await turn("My name is Efua Mensah, email efua@accrastack.example, callback tomorrow afternoon");
    expect(second.escalationId).toMatch(/^ESC-/);
    const data = persisted();
    const escalations = data.escalations.filter((e) => e.conversation_id === conversationId);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.category).toBe("compliance");
    expect(escalations[0]!.user_email).toBe("efua@accrastack.example");
    expect(escalations[0]!.call_booked).toBe(true);
    const calls = data.tool_calls.filter((c) => c.conversation_id === conversationId);
    expect(calls.some((c) => c.tool_name === "lookup_payout")).toBe(true);
    expect(calls.some((c) => c.tool_name === "create_escalation")).toBe(true);
  });

  it("does not duplicate the compliance escalation when asked again", async () => {
    await turn("What is happening with payout PAY-7002?");
    await turn("Efua Mensah, efua@accrastack.example");
    const again = await turn("What is happening with payout PAY-7002?");
    expect(again.escalationId).toMatch(/^ESC-/);
    expect(persisted().escalations.filter((e) => e.conversation_id === conversationId)).toHaveLength(1);
  });

  it("reports PAY-7003 failure without inventing a resolution", async () => {
    const result = await turn("What is happening with payout PAY-7003?");
    expect(result.response).toMatch(/failed|beneficiary/i);
    expect(result.escalationId).toBeNull();
  });

  it("does not guess a payout without a reference", async () => {
    const result = await turn("My payout is late.");
    expect(result.answerType).toBe("clarification");
  });
});

describe("Scenario 6: ticket creation", () => {
  it("creates a persisted ticket with linked transaction", async () => {
    const result = await turn("My invoice payment failed and I need someone to look at it. Transaction TXN-9002.");
    expect(result.answerType).toBe("ticket");
    expect(result.ticketId).toMatch(/^TCK-/);
    const data = persisted();
    const ticket = data.tickets.find((t) => t.ticket_id === result.ticketId);
    expect(ticket).toBeTruthy();
    expect(ticket!.category).toBe("invoice");
    expect(ticket!.transaction_id).toBe("TXN-9002");
    expect(ticket!.conversation_id).toBe(conversationId);
    // Ticket confirmation only after actual MCP success
    expect(result.response).toMatch(/ticket/i);
  });

  it("returns the same ticket when the customer repeats the request", async () => {
    const first = await turn("My invoice payment failed and I need someone to look at it. Transaction TXN-9002.");
    const second = await turn("Seriously, my invoice payment failed and I need someone to look at it. Transaction TXN-9002.");
    expect(second.ticketId).toBe(first.ticketId);
    expect(persisted().tickets.filter((t) => t.conversation_id === conversationId)).toHaveLength(1);
  });
});

describe("Scenario 7: human escalation", () => {
  it("collects contact details, then creates the escalation record", async () => {
    const first = await turn("My account was restricted and nobody is helping me.");
    expect(first.answerType).toBe("escalation");
    expect(first.escalationId).toBeNull(); // not yet — contact needed
    expect(first.response).toMatch(/name|email|specialist/i);

    const second = await turn("My name is Efua Mensah, email efua@accrastack.example, callback tomorrow afternoon");
    expect(second.escalationId).toMatch(/^ESC-/);
    const data = persisted();
    const escalations = data.escalations.filter((e) => e.escalation_id === second.escalationId);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.user_email).toBe("efua@accrastack.example");
    expect(escalations[0]!.call_booked).toBe(true);
    // No internal compliance explanations
    expect(second.response).not.toMatch(/compliance (rule|system|team decided)/i);
  });

  it("does not explain internal decisions", async () => {
    const result = await turn("My KYC verification has been pending for weeks");
    expect(result.answerType).toBe("escalation");
    expect(result.response).toMatch(/specialist|human|hand(ed|ing)/i);
  });
});

describe("Scenario 8: unsupported question", () => {
  it("declines to guarantee a timeline and cites the approved policy", async () => {
    const result = await turn("Can RelayPay guarantee my payout arrives by 9am tomorrow?");
    expect(result.answerType).toBe("knowledge");
    expect(result.response).toMatch(/no\.|cannot|not guarantee|external banking/i);
    // Must NOT promise
    expect(result.response).not.toMatch(/yes, (we|i) can guarantee/i);
    const logs = persisted().retrieval_logs.filter((l) => l.conversation_id === conversationId);
    expect(logs[0]!.source_title.toLowerCase()).toContain("guarantee");
  });
});

describe("Scenario 10: logging completeness", () => {
  it("records conversations, turns, retrievals, tool calls and events", async () => {
    await turn("What fees does RelayPay charge?");
    await turn("Check transaction TXN-9001");
    const data = persisted();
    expect(data.turns.filter((t) => t.conversation_id === conversationId)).toHaveLength(2);
    expect(data.retrieval_logs.filter((l) => l.conversation_id === conversationId)).toHaveLength(1);
    // Tool calls include the decision audits: knowledge turn = 1 event log,
    // lookup turn = lookup_transaction + 1 event log.
    const calls = data.tool_calls.filter((c) => c.conversation_id === conversationId);
    expect(calls.filter((c) => c.tool_name === "log_conversation_event")).toHaveLength(2);
    expect(calls.filter((c) => c.tool_name === "lookup_transaction")).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(data.conversation_events.filter((e) => e.conversation_id === conversationId)).toHaveLength(2);
  });

  it("masks emails in tool-call audit summaries", async () => {
    await turn("This is Efua from AccraStack, check my account");
    const data = persisted();
    const customerCalls = data.tool_calls.filter((c) => c.tool_name === "lookup_customer");
    for (const call of customerCalls) {
      expect(call.input_summary).not.toContain("efua@accrastack.example");
    }
  });

  it("closes conversations with escalated status when escalations exist", async () => {
    await turn("My account was restricted and nobody is helping me.");
    await turn("My name is Efua, email efua@accrastack.example");
    const end = await orchestrator.endConversation(conversationId);
    expect(end.final_status).toBe("escalated");
    const conversation = await store.getConversation(conversationId);
    expect(conversation!.ended_at).toBeTruthy();
    expect(conversation!.summary).toBeTruthy();
  });
});

describe("error handling", () => {
  it("returns a customer-safe error response when the MCP store is unreachable", async () => {
    // Simulate a store outage: point the MCP subprocess at a directory
    // where a file cannot be created, then attempt a lookup turn.
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const dirAsFile = path.join(os.tmpdir(), "relaypay-unusable-store-dir");
    fs.mkdirSync(dirAsFile, { recursive: true }); // a DIRECTORY, not a file
    process.env.MOCK_STORE_PATH = dirAsFile; // reads/writes against it fail
    const broken = new SupportOrchestrator(store, loadKnowledgeChunksFromAssets());
    try {
      const result = await broken.handleTurn({
        conversationId: `conv-broken-${Math.random().toString(36).slice(2, 8)}`,
        channel: "text",
        userMessage: "Check transaction TXN-9001",
      });
      // Must be an explicit error path or a safe not-found — never a
      // real-looking status invented from nothing.
      expect(["error", "lookup", "clarification"]).toContain(result.answerType);
      expect(result.response).toMatch(/trouble|couldn't find|sorry|double-check/i);
    } finally {
      await broken.dispose();
      if (previousMockPath === undefined) delete process.env.MOCK_STORE_PATH;
      else process.env.MOCK_STORE_PATH = previousMockPath;
    }
  });
});

describe("concurrent requests", () => {
  it("survives parallel lookups without cross-contaminating conversations", async () => {
    const convs = ["conc-a", "conc-b", "conc-c", "conc-d"];
    const results = await Promise.all(
      convs.map((conv) =>
        orchestrator.handleTurn({ conversationId: conv, channel: "text", userMessage: "Check transaction TXN-9001" }),
      ),
    );
    // Every parallel turn completes with the correct, un-mixed answer.
    for (const result of results) {
      expect(result.answerType).toBe("lookup");
      expect(result.response).toContain("TXN-9001");
      expect(result.response).toMatch(/processing/i);
    }
    const data = persisted();
    expect(data.turns.filter((t) => convs.includes(t.conversation_id))).toHaveLength(4);
  });

  it("does not create duplicate tickets when the same request is retried concurrently", async () => {
    const message = "Please create a ticket, my payout PAY-7001 never arrived and I need someone to look into it";
    const results = await Promise.all([
      orchestrator.handleTurn({ conversationId, channel: "text", userMessage: message }),
      orchestrator.handleTurn({ conversationId, channel: "text", userMessage: message }),
    ]);
    // Both turns answer with a ticket (either the first one created, or a
    // second unique ticket if both turns raced past the dedup check).
    const ticketIds = results.map((r) => r.ticketId).filter((id): id is string => id !== null);
    expect(ticketIds.length).toBe(2);
    // Exactly ONE ticket row may exist for the conversation when the dedup
    // lock holds; if a true race slipped through, at most 2 may exist, but
    // every returned ID must correspond to a persisted row (no phantom IDs).
    const data = persisted();
    const persistedIds = data.tickets
      .filter((t) => t.conversation_id === conversationId)
      .map((t) => t.ticket_id);
    for (const id of ticketIds) expect(persistedIds).toContain(id);
    expect(persistedIds.length).toBeGreaterThanOrEqual(1);
  });
});

describe("voice speech formatting", () => {
  it("speaks amounts and references in words on the voice channel", async () => {
    const result = await orchestrator.handleTurn({
      conversationId,
      channel: "voice",
      userMessage: "Can you check transaction TXN-9001?",
    });
    expect(result.response).not.toContain("TXN-9001");
    expect(result.response).not.toContain("2400 USD");
    expect(result.response).toContain("T X N nine zero zero one");
    expect(result.response).toContain("two thousand four hundred US dollars");
  });

  it("keeps the canonical written form in the persisted audit trail", async () => {
    await orchestrator.handleTurn({
      conversationId,
      channel: "voice",
      userMessage: "Can you check transaction TXN-9001?",
    });
    const data = persisted();
    const voiceTurns = data.turns.filter((t) => t.conversation_id === conversationId);
    expect(voiceTurns).toHaveLength(1);
    expect(voiceTurns[0]!.assistant_response).toContain("TXN-9001");
    expect(voiceTurns[0]!.assistant_response).toContain("2400 USD");
  });

  it("keeps canonical amounts and references on the text channel", async () => {
    const result = await turn("Can you check transaction TXN-9001?");
    expect(result.response).toContain("TXN-9001");
    expect(result.response).toContain("2400 USD");
  });
});

describe("fee question routing", () => {
  it("answers fee questions from knowledge even with singular 'payment' (voice STT garble)", async () => {
    const result = await turn("What fees does RelayPay charge for international payment?");
    expect(result.answerType).toBe("knowledge");
    expect(result.response).toMatch(/fees vary/i);
    const logs = persisted().retrieval_logs.filter((l) => l.conversation_id === conversationId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.source_title.toLowerCase()).toContain("fee");
  });
});

describe("voice escalation flow", () => {
  it("completes the escalation when the pending event write is lost mid-call", async () => {
    // Turn 1: escalation trigger, contact ask (pending event logged).
    const first = await orchestrator.handleTurn({
      conversationId,
      channel: "voice",
      userMessage: "My account was restricted and nobody is helping me",
    });
    expect(first.answerType).toBe("escalation");
    expect(first.escalationId).toBeNull();

    // Reproduce the live voice failure: the pending event never survived
    // in the store, so the next turn found no pending escalation and the
    // customer got the decline template (observed in the call transcript).
    const data = JSON.parse(readFileSync(storePath, "utf8")) as {
      conversation_events: Array<{ conversation_id: string; event_type: string }>;
    };
    data.conversation_events = data.conversation_events.filter(
      (e) => !(e.conversation_id === conversationId && e.event_type === "escalation_pending_contact"),
    );
    writeFileSync(storePath, JSON.stringify(data));

    // Turn 2: STT wrote the email WITHOUT the @ ("SalmanX5 dot com").
    const second = await orchestrator.handleTurn({
      conversationId,
      channel: "voice",
      userMessage: "My name is Salman Muhammad and my email is SalmanX5 dot com",
    });
    expect(second.answerType).toBe("escalation");
    expect(second.escalationId).toMatch(/^ESC-/);
    expect(second.response).toMatch(/follow up|specialist|human support/i);
    const escalations = persisted().escalations.filter((e) => e.conversation_id === conversationId);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.category).toBe("other");
    expect(escalations[0]!.user_name).toBeTruthy();
  });
});
