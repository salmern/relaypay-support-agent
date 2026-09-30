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

describe("text channel", () => {
  it("rejects empty messages", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { channel: "text" },
    });
    const { conversation_id } = created.json() as { conversation_id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation_id}/turns`,
      payload: { message: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs a grounded knowledge turn end-to-end", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { channel: "text" },
    });
    const { conversation_id } = created.json() as { conversation_id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation_id}/turns`,
      payload: { message: "How do I create a RelayPay account?" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { answer_type: string; response: string };
    expect(body.answer_type).toBe("knowledge");
    expect(body.response).toContain("signing up");
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
    expect(body.results[0]!.result).toContain("TXN-9001");
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
    expect(body.result).toContain("TXN-9001");
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
