/**
 * HTTP API integration tests using Fastify's inject() (no network).
 * Covers the text channel, the Vapi webhook contract (function-call →
 * spoken result, end-of-call-report → conversation closed), secret
 * verification, and the debug/observability endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadKnowledgeChunksFromAssets,
  loadSeedFromAssets,
  MockFileStore,
} from "@relaypay/store";
import { buildApp } from "../src/app.js";

const storePath = join(mkdtempSync(join(tmpdir(), "relaypay-api-")), "store.json");
const seed = loadSeedFromAssets();
const chunks = loadKnowledgeChunksFromAssets();
const store = new MockFileStore({
  filePath: storePath,
  seed,
  knowledgeChunks: chunks,
});

const app = buildApp({
  store,
  knowledgeChunks: chunks,
  corsOrigins: ["http://localhost:5173"],
  vapiServerSecret: "test-secret",
});

// A second app instance with DEBUG_TOKEN set, to verify the debug
// endpoints are locked down in production-style configuration.
const guardedApp = buildApp({
  store,
  knowledgeChunks: chunks,
  corsOrigins: ["http://localhost:5173"],
  vapiServerSecret: "test-secret",
  debugToken: "audit-token-123",
});

beforeAll(async () => {
  process.env.MOCK_STORE_PATH = storePath;
  await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });
  await app.ready();
  await guardedApp.ready();
});

afterAll(async () => {
  delete process.env.MOCK_STORE_PATH;
  await app.close();
  await guardedApp.close();
});

describe("health", () => {
  it("reports responder and data provider", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; responder: string };
    expect(body.ok).toBe(true);
    expect(["claude", "rules"]).toContain(body.responder);
  });
});

describe("service card and webhook explainer", () => {
  it("serves a friendly root page instead of a 404", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("RelayPay Support Agent API");
    expect(res.body).toContain("/api/health");
  });

  it("explains the webhook contract on GET /vapi/webhook instead of 404", async () => {
    const res = await app.inject({ method: "GET", url: "/vapi/webhook" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("POST");
  });
});

async function newConversation() {
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: {} });
  const body = created.json() as { conversation_id: string; conversation_token: string };
  return { id: body.conversation_id, headers: { "x-conversation-token": body.conversation_token } };
}

describe("text channel", () => {
  it("rejects empty messages", async () => {
    const { id, headers } = await newConversation();
    const res = await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, headers, payload: { message: "   " } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-string messages with 400, not 500", async () => {
    const { id, headers } = await newConversation();
    const res = await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, headers, payload: { message: 123 } });
    expect(res.statusCode).toBe(400);
  });

  it("runs a grounded knowledge turn end-to-end and returns its activity", async () => {
    const { id, headers } = await newConversation();
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${id}/turns`,
      headers,
      payload: { message: "How do I create a RelayPay account?" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { answer_type: string; response: string; activity: { retrieval: { knowledge_chunks: string[] } } };
    expect(body.answer_type).toBe("knowledge");
    expect(body.response).toContain("signing up");
    expect(body.activity.retrieval.knowledge_chunks.length).toBeGreaterThan(0);
  });

  it("returns the lookup tool call in the turn activity (the audit trail the UI shows)", async () => {
    const { id, headers } = await newConversation();
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${id}/turns`,
      headers,
      payload: { message: "Can you check transaction TXN-9001?" },
    });
    const body = res.json() as { activity: { tool_calls: Array<{ tool_name: string; status: string }> } };
    expect(body.activity.tool_calls.some((c) => c.tool_name === "lookup_transaction" && c.status === "success")).toBe(true);

    const activity = await app.inject({ method: "GET", url: `/api/conversations/${id}/activity`, headers });
    expect(activity.statusCode).toBe(200);
    const view = activity.json() as { turns: Array<{ tool_calls: Array<{ tool_name: string }> }> };
    expect(view.turns[0]!.tool_calls.some((c) => c.tool_name === "lookup_transaction")).toBe(true);
  });

  it("requires the conversation token for turns, ending and activity", async () => {
    const { id } = await newConversation();
    const turnRes = await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "hi" } });
    expect(turnRes.statusCode).toBe(401);
    const endRes = await app.inject({ method: "POST", url: `/api/conversations/${id}/end`, headers: { "x-conversation-token": "wrong" } });
    expect(endRes.statusCode).toBe(401);
    const activity = await app.inject({ method: "GET", url: `/api/conversations/${id}/activity` });
    expect(activity.statusCode).toBe(401);
  });

  it("never lets the text channel post into a voice conversation", async () => {
    await store.createConversation({ conversation_id: "call-protected", channel: "voice" });
    // Even a correctly-shaped token for that id is refused: the id is not a text conversation.
    const created = await app.inject({ method: "POST", url: "/api/conversations", payload: {} });
    const res = await app.inject({
      method: "POST",
      url: "/api/conversations/call-protected/turns",
      headers: { "x-conversation-token": (created.json() as { conversation_token: string }).conversation_token },
      payload: { message: "hi" },
    });
    expect([401, 404]).toContain(res.statusCode);
  });

  it("hides internal error details from the customer", async () => {
    const { id, headers } = await newConversation();
    const broken = buildApp({
      store: { ...store, getConversation: store.getConversation.bind(store), createConversation: async () => { throw new Error("db password=hunter2 unreachable"); } } as never,
      knowledgeChunks: chunks,
      conversationTokenSecret: undefined,
      vapiServerSecret: "test-secret",
    });
    await broken.ready();
    const res = await broken.inject({ method: "POST", url: `/api/conversations/${id}/turns`, headers, payload: { message: "hi" } });
    await broken.close();
    expect(res.body).not.toContain("hunter2");
  });

  it("rate-limits a burst from one client", async () => {
    const limited = buildApp({ store, knowledgeChunks: chunks, vapiServerSecret: "test-secret", rateLimitPerMinute: 2 });
    await limited.ready();
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await limited.inject({ method: "POST", url: "/api/conversations", payload: {} })).statusCode);
    }
    await limited.close();
    expect(codes).toEqual([201, 201, 429]);
  });
});

describe("Vapi webhook", () => {
  it("rejects requests with the wrong secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "wrong" },
      payload: {
        message: { type: "tool-calls", toolCallList: [{ id: "t1", function: { name: "support_agent", arguments: { transcript: "hello" } } }] },
        call: { id: "call-1" },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers a tool-calls request with the agent reply to speak", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: {
          type: "tool-calls",
          toolCallList: [{ id: "tc-9001", function: { name: "support_agent", arguments: { transcript: "Can you check transaction TXN-9001?" } } }],
        },
        call: { id: "call-api-test" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ toolCallId: string; result: string }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.toolCallId).toBe("tc-9001");
    // Voice responses are formatted for speech: no hyphenated references
    // (read as "minus" by TTS) and amounts spelled in words.
    expect(body.results[0]!.result).toContain("T X N nine zero zero one");
    expect(body.results[0]!.result).toContain("two thousand four hundred US dollars");
    expect(body.results[0]!.result).toMatch(/processing/i);
    // The voice conversation was logged under the Vapi call id
    const conversation = await store.getConversation("call-api-test");
    expect(conversation?.channel).toBe("voice");
  });

  it("handles multiple tool calls in one request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: {
          type: "tool-calls",
          toolCallList: [
            { id: "tc-a", function: { name: "support_agent", arguments: { transcript: "What is the status of TXN-9005?" } } },
            { id: "tc-b", function: { name: "support_agent", arguments: { transcript: "How long do payments take to process?" } } },
          ],
        },
        call: { id: "call-multi" },
      },
    });
    const body = res.json() as { results: Array<{ toolCallId: string; result: string }> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]!.toolCallId).toBe("tc-a");
    expect(body.results[1]!.toolCallId).toBe("tc-b");
  });

  it("closes the conversation on end-of-call-report", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: { type: "end-of-call-report" },
        call: { id: "call-api-test" },
      },
    });
    expect(res.statusCode).toBe(200);
    const conversation = await store.getConversation("call-api-test");
    expect(conversation?.final_status).toBe("completed");
    expect(conversation?.ended_at).toBeTruthy();
  });

  it("supports the legacy function-call shape for older assistant configs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: { type: "function-call", functionCall: { name: "support_agent", parameters: { transcript: "Can you check transaction TXN-9001?" } } },
        call: { id: "call-legacy" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: string };
    expect(body.result).toContain("T X N nine zero zero one");
    expect(body.result).toContain("two thousand four hundred US dollars");
    expect(body.result).toMatch(/processing/i);
  });

  it("responds safely when the transcript is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: { type: "tool-calls", toolCallList: [{ id: "tc-empty", function: { name: "support_agent", arguments: {} } }] },
        call: { id: "call-empty" },
      },
    });
    const body = res.json() as { results: Array<{ result: string }> };
    expect(body.results[0]!.result).toMatch(/catch|again/i);
  });

  it("keeps one conversation across turns when the call id is nested in message.call (live bug)", async () => {
    // Vapi's current tool-calls payload carries the call id inside
    // message.call.id, not top-level call. Reading only the top-level id
    // made every utterance a NEW conversation: the escalation contact ask
    // was never seen again, so the name/email turn declined (observed
    // live — turns persisted under generated vapi-* fallback ids).
    const post = (transcript: string, toolCallId: string) =>
      app.inject({
        method: "POST",
        url: "/vapi/webhook",
        headers: { "x-vapi-secret": "test-secret" },
        payload: {
          message: {
            type: "tool-calls",
            call: { id: "call-nested-77" },
            toolCallList: [{ id: toolCallId, function: { name: "support_agent", arguments: { transcript } } }],
          },
        },
      });

    const first = await post("My account was restricted and nobody is helping me.", "tc-n1");
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { results: Array<{ result: string }> };
    expect(firstBody.results[0]!.result).toMatch(/name and email|specialist/i);

    const second = await post("My name is Salman and my email is salman at relaypay dot com", "tc-n2");
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { results: Array<{ result: string }> };
    // Both turns must land in the SAME conversation, so the contact ask
    // completes into a created escalation instead of declining.
    expect(secondBody.results[0]!.result).toMatch(/support representative will follow up/i);
    expect(secondBody.results[0]!.result).not.toMatch(/don't have approved information/i);

    const conversation = await store.getConversation("call-nested-77");
    expect(conversation?.channel).toBe("voice");
    const turns = await store.listTurns("call-nested-77");
    expect(turns).toHaveLength(2);
  });
});

describe("caller identifier", () => {
  it("records web-text for chat conversations", async () => {
    const { id } = await newConversation();
    expect((await store.getConversation(id))?.caller_identifier).toBe("web-text");
  });

  it("records the phone number for phone calls and web-voice for browser calls", async () => {
    const post = (callId: string, call: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/vapi/webhook",
        headers: { "x-vapi-secret": "test-secret" },
        payload: {
          message: {
            type: "tool-calls",
            call: { id: callId, ...call },
            toolCallList: [{ id: "tc", function: { name: "support_agent", arguments: { transcript: "Check TXN-9001" } } }],
          },
        },
      });
    await post("call-phone-1", { type: "inboundPhoneCall", customer: { number: "+2348000000000" } });
    await post("call-web-1", { type: "webCall" });
    expect((await store.getConversation("call-phone-1"))?.caller_identifier).toBe("+2348000000000");
    expect((await store.getConversation("call-web-1"))?.caller_identifier).toBe("web-voice");
  });
});

describe("debug endpoints", () => {
  it("exposes conversation details for observability", async () => {
    const res = await app.inject({ method: "GET", url: "/api/debug/conversations/call-api-test" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      conversation: { id: string };
      turns: unknown[];
      tool_calls: unknown[];
      retrieval_logs: unknown[];
      events: unknown[];
    };
    expect(body.conversation.id).toBe("call-api-test");
    expect(body.turns.length).toBeGreaterThan(0);
    expect(body.tool_calls.length).toBeGreaterThan(0);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("rejects unauthenticated access when DEBUG_TOKEN is configured", async () => {
    const noHeader = await guardedApp.inject({ method: "GET", url: "/api/debug/conversations" });
    expect(noHeader.statusCode).toBe(401);
    const wrongHeader = await guardedApp.inject({
      method: "GET",
      url: "/api/debug/conversations",
      headers: { "x-debug-token": "wrong" },
    });
    expect(wrongHeader.statusCode).toBe(401);
    const rightHeader = await guardedApp.inject({
      method: "GET",
      url: "/api/debug/conversations",
      headers: { "x-debug-token": "audit-token-123" },
    });
    expect(rightHeader.statusCode).toBe(200);
  });

  it("keeps non-debug endpoints open when DEBUG_TOKEN is configured", async () => {
    const res = await guardedApp.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("disables debug endpoints in production when no DEBUG_TOKEN is set", async () => {
    const prod = buildApp({ store, knowledgeChunks: chunks, vapiServerSecret: "test-secret", production: true, debugToken: undefined });
    await prod.ready();
    const previous = process.env.DEBUG_TOKEN;
    delete process.env.DEBUG_TOKEN;
    const res = await prod.inject({ method: "GET", url: "/api/debug/conversations" });
    if (previous !== undefined) process.env.DEBUG_TOKEN = previous;
    await prod.close();
    expect(res.statusCode).toBe(404);
  });

  it("404s for unknown conversations", async () => {
    const res = await app.inject({ method: "GET", url: "/api/debug/conversations/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("lists evaluations", async () => {
    const res = await app.inject({ method: "GET", url: "/api/debug/evaluations" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe("CORS", () => {
  it("allows the configured origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/conversations",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not reflect arbitrary origins", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/conversations",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
