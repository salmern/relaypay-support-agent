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

beforeAll(async () => {
  process.env.MOCK_STORE_PATH = storePath;
  await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });
  await app.ready();
});

afterAll(async () => {
  delete process.env.MOCK_STORE_PATH;
  await app.close();
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
      payload: { message: { type: "function-call", functionCall: { name: "support_agent", parameters: { transcript: "hello" } } }, call: { id: "call-1" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers a function-call with the agent reply to speak", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: { type: "function-call", functionCall: { name: "support_agent", parameters: { transcript: "Can you check transaction TXN-9001?" } } },
        call: { id: "call-api-test" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: string };
    expect(body.result).toContain("TXN-9001");
    expect(body.result).toMatch(/processing/i);
    // The voice conversation was logged under the Vapi call id
    const conversation = await store.getConversation("call-api-test");
    expect(conversation?.channel).toBe("voice");
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

  it("responds safely when the transcript is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "x-vapi-secret": "test-secret" },
      payload: {
        message: { type: "function-call", functionCall: { name: "support_agent", parameters: {} } },
        call: { id: "call-empty" },
      },
    });
    const body = res.json() as { result: string };
    expect(body.result).toMatch(/catch|again/i);
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
