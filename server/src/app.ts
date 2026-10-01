/**
 * HTTP API for the RelayPay support agent.
 *
 * Text channel:  POST /api/conversations, POST /api/conversations/:id/turns
 * Voice channel: Vapi server events on /vapi/webhook (assistant custom
 *                tools forward the customer's speech; we run the agent
 *                and return the spoken response).
 * Debug:         GET /api/debug/* (observability views, no secrets)
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { KnowledgeChunk, Store } from "@relaypay/store";
import { SupportOrchestrator } from "./orchestrator.js";

export interface BuildAppOptions {
  store: Store;
  knowledgeChunks: KnowledgeChunk[];
  corsOrigins?: string[];
  vapiServerSecret?: string | undefined;
  /** When set, /api/debug/* requires the `x-debug-token` header to match. */
  debugToken?: string | undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const orchestrator = new SupportOrchestrator(options.store, options.knowledgeChunks);

  app.addHook("onClose", async () => {
    await orchestrator.dispose();
  });

  const corsOrigins = options.corsOrigins ?? [];
  void app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
  });

  // ---------------- Health ----------------

  app.get("/api/health", async () => {
    return {
      ok: true,
      responder: process.env.ANTHROPIC_API_KEY ? "claude" : "rules",
      dataProvider: process.env.DATA_PROVIDER ?? "mock",
    };
  });

  // ---------------- Root service card ----------------

  // Browsers land here when someone opens the backend URL directly.
  // Return a small human-readable card (200) instead of Fastify's 404.
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
      "<li>Text channel: <code>POST /api/conversations/:id/turns</code></li>",
      "<li>Voice channel: <code>POST /vapi/webhook</code> (called by Vapi; GET here returns this notice)</li>",
      "<li>Debug endpoints: <code>GET /api/debug/conversations</code> (requires the <code>x-debug-token</code> header in production)</li>",
      "</ul>",
      "<p>Customer-facing voice interface: <a href=\"https://relaypay-support-agent-1.onrender.com\">relaypay-support-agent-1.onrender.com</a></p>",
      "</body></html>",
    ].join("");
  });

  // Vapi only ever POSTs here. A plain GET (someone opening the URL in a
  // browser) used to fall through to Fastify's "Route GET:/vapi/webhook
  // not found" 404, which looks like a broken endpoint; answer with a
  // friendly explainer instead. This does not affect the Vapi contract.
  app.get("/vapi/webhook", async () => {
    return {
      ok: true,
      message: "This endpoint is the Vapi voice webhook. It accepts POST requests signed with the x-vapi-secret header; GET is not part of the contract.",
      hint: "Use POST /vapi/webhook with a tool-calls or end-of-call-report message body.",
    };
  });

  // ---------------- Text channel ----------------

  app.post("/api/conversations", async (request, reply) => {
    const body = (request.body ?? {}) as { channel?: string; caller_identifier?: string };
    const channel = body.channel === "voice" ? "voice" : "text";
    const conversationId = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await options.store.createConversation({
      conversation_id: conversationId,
      channel,
      caller_identifier: body.caller_identifier ?? null,
    });
    return reply.code(201).send({ conversation_id: conversationId, channel });
  });

  app.post("/api/conversations/:id/turns", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { message?: string };
    const message = (body.message ?? "").trim();
    if (message === "") {
      return reply.code(400).send({ error: "message is required" });
    }
    if (message.length > 2000) {
      return reply.code(400).send({ error: "message too long" });
    }
    try {
      const result = await orchestrator.handleTurn({
        conversationId: id,
        channel: "text",
        userMessage: message,
      });
      return reply.code(201).send({
        conversation_id: result.conversationId,
        response: result.response,
        answer_type: result.answerType,
        confidence: result.confidence,
        uncertainty_note: result.uncertaintyNote,
        ticket_id: result.ticketId,
        escalation_id: result.escalationId,
        responder: result.responder,
      });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({
        error: "support agent failed to handle this turn",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/conversations/:id/end", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await orchestrator.endConversation(id);
    return reply.send({ conversation_id: id, ...result });
  });

  // ---------------- Vapi webhook ----------------

  app.post("/vapi/webhook", async (request, reply) => {
    // Server-secret verification (set in the Vapi dashboard + .env).
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
    // `message.call.id` (the current tool-calls shape). Reading only one
    // silently starts a NEW conversation per utterance — every multi-turn
    // flow (clarify loops, contact collection) then breaks while
    // single-turn answers still look fine (observed live: turns persisted
    // under generated vapi-* fallback ids).
    const topLevelCallId = body?.call?.id;
    const nestedCallId = body?.message?.call?.id;
    const callId = topLevelCallId ?? nestedCallId ?? `vapi-${Date.now().toString(36)}`;
    if (!topLevelCallId && !nestedCallId) {
      process.stderr.write(
        `[vapi] webhook request without call.id — using per-request fallback ${callId} (multi-turn flows will fragment)\n`,
      );
    }

    switch (messageType) {
      // Assistant custom tool invoked by Vapi: run one full agent turn.
      // Current contract (docs.vapi.ai/tools/custom-tools): message.type
      // is "tool-calls" with a toolCallList; the response must be
      // { results: [{ toolCallId, result }] }.
      case "tool-calls": {
        const toolCallList = body?.message?.toolCallList ?? [];
        const results: Array<{ toolCallId: string; result: string }> = [];
        for (const [index, toolCall] of toolCallList.entries()) {
          const toolCallId = toolCall.id ?? `tool-${index}`;
          const toolName = toolCall.function?.name ?? "";
          const transcript = String(toolCall.function?.arguments?.transcript ?? "").trim();
          if (toolName !== "support_agent" || transcript === "") {
            results.push({
              toolCallId,
              result: "I'm sorry, I did not catch that. Could you say it again?",
            });
            continue;
          }
          try {
            const turn = await orchestrator.handleTurn({
              conversationId: callId,
              channel: "voice",
              userMessage: transcript,
            });
            results.push({ toolCallId, result: turn.response });
          } catch (error) {
            request.log.error(error);
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
        const transcript = String(
          parameters.transcript ?? parameters.message ?? parameters.question ?? "",
        ).trim();
        if (transcript === "") {
          return reply.send({ result: "I'm sorry, I did not catch that. Could you say it again?" });
        }
        try {
          const turn = await orchestrator.handleTurn({
            conversationId: callId,
            channel: "voice",
            userMessage: transcript,
          });
          return reply.send({ result: turn.response });
        } catch (error) {
          request.log.error(error);
          return reply.send({
            result:
              "I'm sorry, something went wrong on our side. Please try again, or contact the support team through your dashboard.",
          });
        }
      }

      // Call ended: close the conversation record.
      case "end-of-call-report": {
        await orchestrator.endConversation(callId).catch(() => undefined);
        return reply.send({ ok: true });
      }

      default:
        // Tool-call messages, status updates, transcripts, etc.
        return reply.send({ ok: true });
    }
  });

  // ---------------- Debug / observability ----------------
  // These endpoints expose conversation transcripts, tool-call summaries
  // and escalation contact details, so they must never be public. When
  // DEBUG_TOKEN is configured, every /api/debug/* request must present a
  // matching `x-debug-token` header (constant-time compare). Without the
  // variable the endpoints stay open for local development only.
  const debugToken = options.debugToken ?? process.env.DEBUG_TOKEN;

  app.addHook("onRequest", async (request, reply) => {
    if (!debugToken) return;
    if (!request.url.startsWith("/api/debug/")) return;
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

  app.get("/api/debug/evaluations", async () => {
    return options.store.listEvaluations();
  });

  return app;
}
