/**
 * HTTP API for the RelayPay support agent.
 *
 * Text channel:  POST /api/conversations → { conversation_id, conversation_token }
 *                POST /api/conversations/:id/turns  (x-conversation-token)
 *                POST /api/conversations/:id/end    (x-conversation-token)
 *                GET  /api/conversations/:id/activity
 * Voice channel: Vapi server events on /vapi/webhook (assistant custom
 *                tools forward the customer's speech; we run the agent
 *                and return the spoken response).
 * Debug:         GET /api/debug/* (observability views, x-debug-token)
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type { KnowledgeChunk, Store } from "@relaypay/store";
import { SupportOrchestrator, type TurnResult } from "./orchestrator.js";

export interface BuildAppOptions {
  store: Store;
  knowledgeChunks: KnowledgeChunk[];
  corsOrigins?: string[];
  vapiServerSecret?: string | undefined;
  /** When set, /api/debug/* requires the `x-debug-token` header to match. */
  debugToken?: string | undefined;
  /** HMAC secret for per-conversation tokens (falls back to other server secrets). */
  conversationTokenSecret?: string | undefined;
  /** Requests per minute per client IP for the text channel (0 disables). */
  rateLimitPerMinute?: number;
  /** Production mode: debug endpoints are disabled unless a debug token is set. */
  production?: boolean;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Minimal fixed-window limiter (per key, per minute). */
function createRateLimiter(limitPerMinute: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    if (limitPerMinute <= 0) return true;
    const now = Date.now();
    const window = windows.get(key);
    if (!window || now - window.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
      }
      return true;
    }
    window.count += 1;
    return window.count <= limitPerMinute;
  };
}

/** Per-turn activity in the shape the UI renders (no transcripts, no contact details). */
function activityPayload(result: TurnResult) {
  return {
    tool_calls: result.activity.toolCalls,
    retrieval: result.activity.retrieval
      ? {
          query: result.activity.retrieval.query,
          knowledge_chunks: result.activity.retrieval.chunks,
          source_title: result.activity.retrieval.sourceTitle,
        }
      : null,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  // Behind Render's proxy: request.ip must be the client, not the proxy.
  const app = Fastify({ logger: false, trustProxy: true });
  const orchestrator = new SupportOrchestrator(options.store, options.knowledgeChunks);

  app.addHook("onClose", async () => {
    await orchestrator.dispose();
  });

  const corsOrigins = options.corsOrigins ?? [];
  void app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    allowedHeaders: ["content-type", "x-conversation-token", "x-debug-token"],
  });

  // ---------------- Conversation tokens ----------------
  // Text conversations are capabilities: the creator receives a token
  // (HMAC of the conversation id) and must present it for every turn. A
  // stranger can neither post into someone else's conversation nor end it.
  const tokenSecret =
    options.conversationTokenSecret ??
    process.env.CONVERSATION_TOKEN_SECRET ??
    options.debugToken ??
    options.vapiServerSecret ??
    randomBytes(32).toString("hex");
  const conversationToken = (id: string) =>
    createHmac("sha256", tokenSecret).update(id).digest("base64url").slice(0, 32);
  const hasValidToken = (request: FastifyRequest, id: string) => {
    const provided = request.headers["x-conversation-token"];
    return typeof provided === "string" && safeEqual(provided, conversationToken(id));
  };

  const allow = createRateLimiter(options.rateLimitPerMinute ?? Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30));
  const rateLimited = (request: FastifyRequest, reply: FastifyReply) => {
    if (allow(request.ip)) return false;
    void reply.code(429).send({ error: "Too many requests — please wait a moment and try again." });
    return true;
  };

  // ---------------- Health ----------------

  app.get("/api/health", async () => {
    return {
      ok: true,
      responder: process.env.ANTHROPIC_API_KEY ? "claude" : "rules",
      dataProvider: process.env.DATA_PROVIDER ?? "mock",
      activeMcpSessions: orchestrator.activeMcpClients,
    };
  });

  // ---------------- Root service card ----------------

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return [
      "<!doctype html><html><head><meta charset=\"utf-8\" /><title>RelayPay Support Agent</title>",
      "<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2430;line-height:1.6}",
      "h1{font-size:1.4rem;margin-bottom:.25rem}code{background:#f2f4f8;padding:.1rem .35rem;border-radius:4px}",
      "a{color:#2456d6}</style></head><body>",
      "<h1>RelayPay Support Agent API</h1>",
      "<p>The backend is up and running. This service powers the RelayPay customer support agent (voice and text).</p>",
      "<ul>",
      "<li>Health check: <a href=\"/api/health\"><code>GET /api/health</code></a></li>",
      "<li>Text channel: <code>POST /api/conversations</code>, then <code>POST /api/conversations/:id/turns</code> with the returned <code>x-conversation-token</code></li>",
      "<li>Voice channel: <code>POST /vapi/webhook</code> (called by Vapi; GET here returns this notice)</li>",
      "<li>Debug endpoints: <code>GET /api/debug/conversations</code> (requires the <code>x-debug-token</code> header)</li>",
      "</ul>",
      "<p>Customer-facing voice interface: <a href=\"https://relaypay-support-agent-1.onrender.com\">relaypay-support-agent-1.onrender.com</a></p>",
      "</body></html>",
    ].join("");
  });

  app.get("/vapi/webhook", async () => {
    return {
      ok: true,
      message: "This endpoint is the Vapi voice webhook. It accepts POST requests signed with the x-vapi-secret header; GET is not part of the contract.",
      hint: "Use POST /vapi/webhook with a tool-calls or end-of-call-report message body.",
    };
  });

  // ---------------- Text channel ----------------

  app.post("/api/conversations", async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    const conversationId = `conv-${randomUUID()}`;
    await options.store.createConversation({ conversation_id: conversationId, channel: "text", caller_identifier: null });
    return reply.code(201).send({
      conversation_id: conversationId,
      channel: "text",
      conversation_token: conversationToken(conversationId),
    });
  });

  app.post("/api/conversations/:id/turns", async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    const { id } = request.params as { id: string };
    if (!hasValidToken(request, id)) {
      return reply.code(401).send({ error: "missing or invalid conversation token — start a new conversation" });
    }
    const body = (request.body ?? {}) as { message?: unknown };
    if (body.message !== undefined && typeof body.message !== "string") {
      return reply.code(400).send({ error: "message must be a string" });
    }
    const message = (body.message ?? "").trim();
    if (message === "") return reply.code(400).send({ error: "message is required" });
    if (message.length > 2000) return reply.code(400).send({ error: "message too long" });

    // Text turns may only target text conversations created here — never
    // a Vapi voice call.
    const conversation = await options.store.getConversation(id);
    if (!conversation || conversation.channel !== "text") {
      return reply.code(404).send({ error: "conversation not found" });
    }

    try {
      const result = await orchestrator.handleTurn({ conversationId: id, channel: "text", userMessage: message });
      return reply.code(201).send({
        conversation_id: result.conversationId,
        response: result.response,
        answer_type: result.answerType,
        confidence: result.confidence,
        uncertainty_note: result.uncertaintyNote,
        ticket_id: result.ticketId,
        escalation_id: result.escalationId,
        responder: result.responder,
        activity: activityPayload(result),
      });
    } catch (error) {
      // Full detail goes to the server log only — never to the customer.
      process.stderr.write(`[api] turn failed for ${id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      return reply.code(500).send({ error: "The support agent could not handle that message. Please try again." });
    }
  });

  app.post("/api/conversations/:id/end", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!hasValidToken(request, id)) {
      return reply.code(401).send({ error: "missing or invalid conversation token" });
    }
    const result = await orchestrator.endConversation(id);
    return reply.send({ conversation_id: id, ...result });
  });

  /**
   * Agent activity for a conversation, for the customer UI: per turn, the
   * answer type, confidence, and the audit rows (tool calls, retrieval).
   * Text conversations need their token; voice conversations are keyed
   * by the unguessable Vapi call id the browser received. Transcripts and
   * contact details are never included.
   */
  app.get("/api/conversations/:id/activity", async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const conversation = await options.store.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: "conversation not found" });
    if (conversation.channel === "text" && !hasValidToken(request, id)) {
      return reply.code(401).send({ error: "missing or invalid conversation token" });
    }
    const [turns, events, escalations, tickets] = await Promise.all([
      options.store.listTurns(id),
      options.store.listConversationEvents(id),
      options.store.listEscalations(id),
      options.store.listTickets(id),
    ]);
    // Each turn's decision event records exactly which audit rows that
    // turn wrote (see SupportOrchestrator.finishTurn).
    const byTurn = new Map<number, Record<string, unknown>>();
    for (const event of events) {
      if (event.event_type === "decision" && typeof event.metadata.turn_number === "number") {
        byTurn.set(event.metadata.turn_number, event.metadata);
      }
    }
    return {
      conversation_id: id,
      channel: conversation.channel,
      final_status: conversation.final_status,
      escalated: escalations.length > 0,
      ticket_ids: tickets.map((t) => t.ticket_id),
      turns: turns.map((turn, index) => {
        const activity = (byTurn.get(index + 1)?.activity ?? null) as
          | { tool_calls?: unknown[]; retrieval?: unknown }
          | null;
        return {
          answer_type: turn.answer_type,
          confidence: Number(turn.confidence),
          uncertainty_note: turn.uncertainty_note,
          created_at: turn.created_at,
          tool_calls: activity?.tool_calls ?? null,
          retrieval: activity?.retrieval ?? null,
        };
      }),
    };
  });

  // ---------------- Vapi webhook ----------------

  app.post("/vapi/webhook", async (request, reply) => {
    if (options.vapiServerSecret) {
      const provided = request.headers["x-vapi-secret"];
      if (typeof provided !== "string" || !safeEqual(provided, options.vapiServerSecret)) {
        return reply.code(401).send({ error: "invalid vapi secret" });
      }
    }

    const body = request.body as {
      message?: {
        type?: string;
        toolCallList?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: Record<string, unknown> };
        }>;
        functionCall?: { name?: string; parameters?: Record<string, unknown> };
        call?: { id?: string };
      };
      call?: { id?: string };
    } | undefined;

    const messageType = body?.message?.type ?? "";
    // The call id scopes the whole voice conversation. Vapi sends it in
    // two places across payload versions: top-level `call.id` and
    // `message.call.id` (the current tool-calls shape).
    const topLevelCallId = body?.call?.id;
    const nestedCallId = body?.message?.call?.id;
    const callId = topLevelCallId ?? nestedCallId ?? `vapi-${Date.now().toString(36)}`;
    if (!topLevelCallId && !nestedCallId) {
      process.stderr.write(
        `[vapi] webhook request without call.id — using per-request fallback ${callId} (multi-turn flows will fragment)\n`,
      );
    }

    switch (messageType) {
      // Current contract (docs.vapi.ai/tools/custom-tools): message.type
      // is "tool-calls" with a toolCallList; the response must be
      // { results: [{ toolCallId, result }] }.
      case "tool-calls": {
        const toolCallList = body?.message?.toolCallList ?? [];
        const results: Array<{ toolCallId: string; result: string }> = [];
        for (const [index, toolCall] of toolCallList.entries()) {
          const toolCallId = toolCall.id ?? `tool-${index}`;
          const toolName = toolCall.function?.name ?? "";
          const transcript = String(toolCall.function?.arguments?.transcript ?? "").trim().slice(0, 2000);
          if (toolName !== "support_agent" || transcript === "") {
            results.push({ toolCallId, result: "I'm sorry, I did not catch that. Could you say it again?" });
            continue;
          }
          try {
            const turn = await orchestrator.handleTurn({ conversationId: callId, channel: "voice", userMessage: transcript });
            results.push({ toolCallId, result: turn.response });
          } catch (error) {
            process.stderr.write(`[vapi] turn failed for ${callId}: ${error instanceof Error ? error.message : String(error)}\n`);
            results.push({
              toolCallId,
              result:
                "I'm sorry, something went wrong on our side. Please try again, or contact the support team through your dashboard.",
            });
          }
        }
        return reply.send({ results });
      }

      // Legacy shape kept for compatibility with older assistant configs.
      case "function-call": {
        const parameters = body?.message?.functionCall?.parameters ?? {};
        const transcript = String(parameters.transcript ?? parameters.message ?? parameters.question ?? "").trim().slice(0, 2000);
        if (transcript === "") {
          return reply.send({ result: "I'm sorry, I did not catch that. Could you say it again?" });
        }
        try {
          const turn = await orchestrator.handleTurn({ conversationId: callId, channel: "voice", userMessage: transcript });
          return reply.send({ result: turn.response });
        } catch (error) {
          process.stderr.write(`[vapi] turn failed for ${callId}: ${error instanceof Error ? error.message : String(error)}\n`);
          return reply.send({
            result:
              "I'm sorry, something went wrong on our side. Please try again, or contact the support team through your dashboard.",
          });
        }
      }

      // Call ended: close the conversation record and free its MCP process.
      case "end-of-call-report": {
        await orchestrator.endConversation(callId).catch(() => undefined);
        return reply.send({ ok: true });
      }

      default:
        return reply.send({ ok: true });
    }
  });

  // ---------------- Debug / observability ----------------
  // These endpoints expose conversation transcripts, tool-call summaries
  // and escalation contact details, so they must never be public. With
  // DEBUG_TOKEN set, every request must present a matching
  // `x-debug-token`. In production without a token they are disabled.
  const debugToken = options.debugToken ?? process.env.DEBUG_TOKEN;
  const production = options.production ?? process.env.NODE_ENV === "production";

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/debug/")) return;
    if (!debugToken) {
      if (production) return reply.code(404).send({ error: "debug endpoints are disabled (set DEBUG_TOKEN)" });
      return;
    }
    const provided = request.headers["x-debug-token"];
    if (typeof provided !== "string" || !safeEqual(provided, debugToken)) {
      return reply.code(401).send({ error: "debug endpoints require a valid x-debug-token header" });
    }
  });

  app.get("/api/debug/conversations", async () => {
    return options.store.listConversations();
  });

  app.get("/api/debug/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [conversation, turns, toolCalls, retrievalLogs, tickets, escalations, events] = await Promise.all([
      options.store.getConversation(id),
      options.store.listTurns(id),
      options.store.listToolCalls(id),
      options.store.listRetrievalLogs(id),
      options.store.listTickets(id),
      options.store.listEscalations(id),
      options.store.listConversationEvents(id),
    ]);
    if (!conversation) {
      return reply.code(404).send({ error: "conversation not found" });
    }
    return { conversation, turns, tool_calls: toolCalls, retrieval_logs: retrievalLogs, tickets, escalations, events };
  });

  /** ?run=latest returns only the most recent evaluation run. */
  app.get("/api/debug/evaluations", async (request) => {
    const all = await options.store.listEvaluations();
    const { run } = (request.query ?? {}) as { run?: string };
    if (!run) return all;
    const runIds = all.map((e) => e.run_id).filter((r): r is string => typeof r === "string" && r !== "");
    const target = run === "latest" ? runIds.sort().at(-1) : run;
    return target ? all.filter((e) => e.run_id === target) : [];
  });

  return app;
}
