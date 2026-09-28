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
      };
      call?: { id?: string };
    } | undefined;

    const messageType = body?.message?.type ?? "";
    const callId = body?.call?.id ?? `vapi-${Date.now().toString(36)}`;

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
