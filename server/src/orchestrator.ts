/**
 * Support orchestrator — executes one support turn.
 *
 * Flow (per assets/support-decision-rules.md):
 *   1. Deterministic decision engine classifies the request
 *   2. Required MCP tool calls are executed through our MCP server
 *   3. Approved knowledge retrieval runs (and is logged) for knowledge answers
 *   4. Claude (Agent SDK) phrases the customer-facing response from the
 *      decision + approved context + tool results. Without an API key the
 *      deterministic responder phrases it instead.
 *   5. Conversation, turn, retrieval, tool-call and event records persist.
 */
import type { AnswerType, KnowledgeChunk, Store } from "@relaypay/store";
import { decide, extractIdentity, extractReferences, type Decision } from "./agent/decision-engine.js";
import { RetrievalService, type GroundedKnowledge } from "./knowledge/retrieval-service.js";
import { RelayPayMcpClient } from "./agent/mcp-client.js";
import { runClaudeAgent } from "./agent/claude-runner.js";
import { buildTurnPrompt } from "./agent/system-prompt.js";
import * as templates from "./agent/response-templates.js";

export interface TurnInput {
  conversationId: string;
  channel: "voice" | "text";
  userMessage: string;
  callerIdentifier?: string | null;
}

export interface TurnResult {
  conversationId: string;
  response: string;
  answerType: AnswerType;
  confidence: number;
  uncertaintyNote: string | null;
  decision: Decision;
  retrieval: GroundedKnowledge | null;
  mcpCalls: Array<{ tool: string; result: unknown }>;
  ticketId: string | null;
  escalationId: string | null;
  responder: "claude" | "rules";
}

interface TurnBase {
  decision: Decision;
  retrieval: GroundedKnowledge | null;
  mcpCalls: Array<{ tool: string; result: unknown }>;
  ticketId: string | null;
  escalationId: string | null;
}

interface TurnOutcome {
  response: string;
  answerType: AnswerType;
  confidence: number;
  uncertaintyNote: string | null;
}

function newBase(decision: Decision): TurnBase {
  return {
    decision,
    retrieval: null,
    mcpCalls: [],
    ticketId: null,
    escalationId: null,
  };
}

export class SupportOrchestrator {
  private readonly retrieval: RetrievalService;
  private readonly mcpClients = new Map<string, RelayPayMcpClient>();

  constructor(
    private readonly store: Store,
    chunks: KnowledgeChunk[],
  ) {
    this.retrieval = new RetrievalService(store, chunks);
  }

  async dispose(): Promise<void> {
    for (const client of this.mcpClients.values()) {
      await client.close().catch(() => undefined);
    }
    this.mcpClients.clear();
  }

  private async mcp(conversationId: string): Promise<RelayPayMcpClient> {
    let client = this.mcpClients.get(conversationId);
    if (!client) {
      client = await RelayPayMcpClient.spawn(conversationId);
      this.mcpClients.set(conversationId, client);
    }
    return client;
  }

  async handleTurn(input: TurnInput): Promise<TurnResult> {
    await this.store.createConversation({
      conversation_id: input.conversationId,
      channel: input.channel,
      caller_identifier: input.callerIdentifier ?? null,
    });

    // A pending escalation contact request takes priority: the customer
    // is answering our ask for name/email.
    const pendingEscalation = await this.findPendingEscalation(input.conversationId);
    if (pendingEscalation) {
      return this.completeEscalation(input);
    }

    const previousTurns = await this.store.listTurns(input.conversationId);

    // Collect identity info from this message or earlier turns.
    let identity = extractIdentity(input.userMessage);
    if (!identity.companyName && !identity.contactName) {
      for (const past of previousTurns) {
        identity = extractIdentity(past.user_transcript);
        if (identity.companyName || identity.contactName) break;
      }
    }
    // References in the CURRENT message take priority; earlier turns are
    // only a fallback so "It is TXN-9005" still resolves after a clarify.
    const currentRefs = extractReferences(input.userMessage);
    const historyRefs = extractReferences(
      previousTurns.map((t) => t.user_transcript).join(" "),
    );
    const refs = {
      transactionId: currentRefs.transactionId ?? historyRefs.transactionId,
      payoutId: currentRefs.payoutId ?? historyRefs.payoutId,
      customerId: currentRefs.customerId ?? historyRefs.customerId,
    };

    const decision = decide(input.userMessage, {
      hasIdentity: Boolean(identity.companyName || identity.contactName || refs.customerId),
      hasReference: Boolean(refs.transactionId || refs.payoutId),
    });

    return this.executeDecision(input, decision, { identity, refs });
  }

  private async executeDecision(
    input: TurnInput,
    decision: Decision,
    ctx: {
      identity: { companyName?: string; contactName?: string };
      refs: ReturnType<typeof extractReferences>;
    },
  ): Promise<TurnResult> {
    switch (decision.action) {
      case "clarify":
        return this.finishTurn(input, newBase(decision), {
          response: await this.phrase(input, decision, null, [], templates.clarifyResponse(decision.clarifyingQuestion!)),
          answerType: "clarification",
          confidence: 0.9,
          uncertaintyNote: null,
        });

      case "answer":
        return this.answerWithKnowledge(input, decision);

      case "lookup":
        if (decision.intent === "payout_lookup") {
          return this.lookupPayout(input, decision, ctx.refs);
        }
        if (decision.intent === "account_lookup") {
          return this.lookupAccount(input, decision, ctx.identity, ctx.refs);
        }
        return this.lookupTransaction(input, decision, ctx.refs);

      case "ticket":
        return this.createTicket(input, decision, ctx.refs);

      case "escalate":
        return this.beginEscalation(input, decision);

      case "decline":
      default:
        return this.finishTurn(input, newBase(decision), {
          response: await this.phrase(input, decision, null, [], templates.declineResponse()),
          answerType: "decline",
          confidence: 0.6,
          uncertaintyNote: "No approved knowledge covers this topic",
        });
    }
  }

  // ---------- Knowledge ----------

  private async answerWithKnowledge(input: TurnInput, decision: Decision): Promise<TurnResult> {
    const base = newBase(decision);
    const knowledge = await this.retrieval.retrieve(input.userMessage, input.conversationId);
    base.retrieval = knowledge;

    if (!knowledge.found) {
      // Deterministic safety net: decline rather than answer ungrounded.
      const response = await this.phrase(input, decision, knowledge, [], templates.declineResponse());
      return this.finishTurn(input, base, {
        response,
        answerType: "decline",
        confidence: 0.6,
        uncertaintyNote: "Retrieval found no relevant approved knowledge",
      });
    }

    const fallback = templates.knowledgeResponse(this.bestChunkContent(knowledge), knowledge.sourceTitle);
    const response = await this.phrase(input, decision, knowledge, [], fallback);

    return this.finishTurn(input, base, {
      response,
      answerType: "knowledge",
      confidence: 0.85,
      uncertaintyNote: null,
    });
  }

  private bestChunkContent(knowledge: GroundedKnowledge): string {
    // The retrieval service embeds full chunk content into `context`.
    const firstBlock = knowledge.context.split("\n\n---\n\n")[0] ?? "";
    return firstBlock.split("\n").slice(1).join("\n").trim();
  }

  // ---------- Lookups ----------

  private async lookupPayout(
    input: TurnInput,
    decision: Decision,
    refs: ReturnType<typeof extractReferences>,
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);
    const args: Record<string, unknown> = {};
    if (refs.payoutId) args.payout_id = refs.payoutId;
    else if (refs.transactionId) args.transaction_id = refs.transactionId;

    const result = await client.callTool("lookup_payout", args);
    base.mcpCalls.push({ tool: "lookup_payout", result });

    if (result.error) {
      return this.finishTurn(input, base, {
        response: templates.toolErrorResponse("checking that payout"),
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `MCP lookup_payout failed: ${String(result.error)}`,
      });
    }

    if (result.found !== true) {
      const payoutRef = refs.payoutId ?? refs.transactionId ?? "that reference";
      const response = await this.phrase(input, decision, null, base.mcpCalls, templates.payoutNotFoundResponse(payoutRef));
      return this.finishTurn(input, base, {
        response,
        answerType: "lookup",
        confidence: 0.7,
        uncertaintyNote: "Payout record not found",
      });
    }

    // Escalation rule: payout stuck in review needs a human (Scenario 5).
    if (result.status === "review required") {
      const complianceRelated = /compliance/i.test(String(result.failure_reason ?? ""));
      const escalation = await client.callTool("create_escalation", {
        category: complianceRelated ? "compliance" : "payment",
        reason: `Payout ${String(result.payout_id)} requires review: ${String(result.failure_reason ?? "status review")}`,
      });
      base.mcpCalls.push({ tool: "create_escalation", result: escalation });
      const escalationOk = typeof escalation.escalation_id === "string" && escalation.escalation_id !== "";
      base.escalationId = escalationOk ? String(escalation.escalation_id) : null;

      const response =
        (await this.phrase(input, decision, null, base.mcpCalls, templates.payoutFoundResponse(result as never))) +
        (escalationOk ? " I'm also handing this to our specialist team, and they will follow up with you." : "");

      return this.finishTurn(input, base, {
        response,
        answerType: escalationOk ? "escalation" : "lookup",
        confidence: 0.9,
        uncertaintyNote: escalationOk ? null : "Escalation creation failed",
      });
    }

    const response = await this.phrase(input, decision, null, base.mcpCalls, templates.payoutFoundResponse(result as never));
    return this.finishTurn(input, base, {
      response,
      answerType: "lookup",
      confidence: 0.95,
      uncertaintyNote: null,
    });
  }

  private async lookupTransaction(
    input: TurnInput,
    decision: Decision,
    refs: ReturnType<typeof extractReferences>,
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);
    const transactionId = refs.transactionId!;
    const result = await client.callTool("lookup_transaction", { transaction_id: transactionId });
    base.mcpCalls.push({ tool: "lookup_transaction", result });

    if (result.error) {
      return this.finishTurn(input, base, {
        response: templates.toolErrorResponse("checking that transaction"),
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `MCP lookup_transaction failed: ${String(result.error)}`,
      });
    }

    if (result.found !== true) {
      const response = await this.phrase(input, decision, null, base.mcpCalls, templates.transactionNotFoundResponse(transactionId));
      return this.finishTurn(input, base, {
        response,
        answerType: "lookup",
        confidence: 0.7,
        uncertaintyNote: "Transaction record not found",
      });
    }

    const response = await this.phrase(input, decision, null, base.mcpCalls, templates.transactionFoundResponse(result as never));
    return this.finishTurn(input, base, {
      response,
      answerType: "lookup",
      confidence: 0.95,
      uncertaintyNote: null,
    });
  }

  // ---------- Account lookup ----------

  private async lookupAccount(
    input: TurnInput,
    decision: Decision,
    identity: { companyName?: string; contactName?: string },
    refs: ReturnType<typeof extractReferences>,
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);

    const args: Record<string, unknown> = {};
    if (refs.customerId) args.customer_id = refs.customerId;
    else if (identity.companyName) args.company_name = identity.companyName;

    const result = await client.callTool("lookup_customer", args);
    base.mcpCalls.push({ tool: "lookup_customer", result });

    if (result.error) {
      return this.finishTurn(input, base, {
        response: templates.toolErrorResponse("checking that account"),
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `MCP lookup_customer failed: ${String(result.error)}`,
      });
    }

    if (result.found !== true) {
      const response = await this.phrase(
        input,
        decision,
        null,
        base.mcpCalls,
        "I couldn't find an account with those details. Could you confirm the company name on the account, or your customer ID? If you don't have them, I can arrange for the support team to help.",
      );
      return this.finishTurn(input, base, {
        response,
        answerType: "lookup",
        confidence: 0.7,
        uncertaintyNote: "Customer record not found",
      });
    }

    // Restricted accounts always go to human support (escalation rules).
    if (String(result.account_status) === "restricted") {
      const escalation = await client.callTool("create_escalation", {
        customer_id: String(result.customer_id),
        category: "account",
        reason: `Account ${String(result.customer_id)} is restricted; customer requested account help`,
      });
      base.mcpCalls.push({ tool: "create_escalation", result: escalation });
      const escalationOk = typeof escalation.escalation_id === "string" && escalation.escalation_id !== "";
      base.escalationId = escalationOk ? String(escalation.escalation_id) : null;

      const response =
        (await this.phrase(
          input,
          decision,
          null,
          base.mcpCalls,
          `I can see the account, but it's currently restricted, and I'm not able to discuss the details over voice support. I'm handing this to our specialist team${escalationOk ? ", and they will follow up with you" : ""}.`,
        )) ;
      return this.finishTurn(input, base, {
        response,
        answerType: escalationOk ? "escalation" : "lookup",
        confidence: 0.9,
        uncertaintyNote: escalationOk ? null : "Escalation creation failed",
      });
    }

    // Customer-safe summary: never read emails, contacts, or notes aloud.
    const fallback =
      `I found the account for ${String(result.company_name)}. ` +
      `Your plan is ${String(result.plan)} and the account is ${String(result.account_status)}. ` +
      (String(result.kyc_status) === "approved"
        ? "Verification is complete."
        : `Verification status: ${String(result.kyc_status)}.`);
    const response = await this.phrase(input, decision, null, base.mcpCalls, fallback);
    return this.finishTurn(input, base, {
      response,
      answerType: "lookup",
      confidence: 0.95,
      uncertaintyNote: null,
    });
  }

  // ---------- Tickets ----------

  private async createTicket(
    input: TurnInput,
    decision: Decision,
    refs: ReturnType<typeof extractReferences>,
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);

    // If the customer included a transaction reference, look it up so the
    // ticket reflects real data.
    let transactionNote = "";
    if (refs.transactionId) {
      const tx = await client.callTool("lookup_transaction", { transaction_id: refs.transactionId });
      base.mcpCalls.push({ tool: "lookup_transaction", result: tx });
      transactionNote =
        tx.found === true
          ? ` (linked transaction ${String(tx.transaction_id)}, status: ${String(tx.status)})`
          : ` (referenced transaction ${refs.transactionId} could not be found)`;
    }

    const category = /invoice/i.test(input.userMessage)
      ? "invoice"
      : /payout/i.test(input.userMessage)
        ? "payment"
        : /account/i.test(input.userMessage)
          ? "account"
          : "payment";
    const priority = /\b(failed|urgent|missing|broken)\b/i.test(input.userMessage) ? "high" : "medium";

    const result = await client.callTool("create_support_ticket", {
      customer_id: refs.customerId,
      transaction_id: refs.transactionId,
      category,
      priority,
      summary: `${input.userMessage}${transactionNote}`,
      conversation_id: input.conversationId,
    });
    base.mcpCalls.push({ tool: "create_support_ticket", result });

    const ticketId = typeof result.ticket_id === "string" && result.ticket_id !== "" ? result.ticket_id : null;
    if (!ticketId) {
      return this.finishTurn(input, base, {
        response: templates.toolErrorResponse("creating your ticket"),
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Ticket creation failed: ${String(result.error ?? "unknown error")}`,
      });
    }
    base.ticketId = ticketId;

    const response = await this.phrase(input, decision, null, base.mcpCalls, templates.ticketCreatedResponse());
    return this.finishTurn(input, base, {
      response,
      answerType: "ticket",
      confidence: 0.9,
      uncertaintyNote: null,
    });
  }

  // ---------- Escalation ----------

  private async beginEscalation(input: TurnInput, decision: Decision): Promise<TurnResult> {
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);

    // Record the pending state through MCP so it is auditable and the
    // next turn can complete the escalation with contact details.
    await client.callTool("log_conversation_event", {
      conversation_id: input.conversationId,
      event_type: "escalation_pending_contact",
      summary: `Escalation required (${decision.escalationCategory}): ${decision.rationale}`,
      metadata: { category: decision.escalationCategory ?? "other" },
    });

    const response = await this.phrase(input, decision, null, [], templates.escalationContactRequestResponse());
    return this.finishTurn(input, base, {
      response,
      answerType: "escalation",
      confidence: 0.9,
      uncertaintyNote: "Waiting for customer contact details to create the escalation record",
    });
  }

  private async completeEscalation(input: TurnInput): Promise<TurnResult> {
    const decision: Decision = {
      action: "escalate",
      intent: "escalation",
      escalationCategory: "other",
      rationale: "Completing pending escalation with customer contact details",
    };
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);

    const { name, email } = parseContact(input.userMessage);
    const events = await this.store.listConversationEvents(input.conversationId);
    const priorEvent = events.find((e) => e.event_type === "escalation_pending_contact");
    const category =
      priorEvent && typeof priorEvent.metadata.category === "string"
        ? priorEvent.metadata.category
        : "other";

    const result = await client.callTool("create_escalation", {
      user_name: name ?? undefined,
      user_email: email ?? undefined,
      category,
      reason: priorEvent?.summary ?? "Customer requested human support",
      preferred_time: extractPreferredTime(input.userMessage) ?? undefined,
    });
    base.mcpCalls.push({ tool: "create_escalation", result });

    const escalationId = typeof result.escalation_id === "string" && result.escalation_id !== "" ? result.escalation_id : null;
    if (!escalationId) {
      return this.finishTurn(input, base, {
        response: templates.toolErrorResponse("creating the escalation"),
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Escalation creation failed: ${String(result.error ?? "unknown")}`,
      });
    }
    base.escalationId = escalationId;

    await client.callTool("log_conversation_event", {
      conversation_id: input.conversationId,
      event_type: "escalation_created",
      summary: `Escalation ${escalationId} created with customer contact details`,
      metadata: { escalation_id: escalationId },
    });

    const hasCallback = Boolean(extractPreferredTime(input.userMessage));
    const response = await this.phrase(input, decision, null, base.mcpCalls, templates.escalationCreatedResponse({ hasCallback }));

    return this.finishTurn(input, base, {
      response,
      answerType: "escalation",
      confidence: 0.95,
      uncertaintyNote: null,
    });
  }

  private async findPendingEscalation(conversationId: string): Promise<{ pending: true } | null> {
    const events = await this.store.listConversationEvents(conversationId);
    const pending = events.filter((e) => e.event_type === "escalation_pending_contact");
    if (pending.length === 0) return null;
    const completed = events.filter((e) => e.event_type === "escalation_created");
    const lastPending = pending[pending.length - 1]!;
    const lastCompleted = completed[completed.length - 1];
    if (lastCompleted && lastCompleted.created_at > lastPending.created_at) return null;
    return { pending: true };
  }

  // ---------- Response phrasing ----------

  private async phrase(
    input: TurnInput,
    decision: Decision,
    knowledge: GroundedKnowledge | null,
    mcpCalls: Array<{ tool: string; result: unknown }>,
    fallback: string,
  ): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return fallback;
    }
    try {
      const previousTurns = await this.store.listTurns(input.conversationId);
      const recent = previousTurns.slice(-4).map((t) => ({
        role: "user" as const,
        text: t.user_transcript,
      }));
      const turnPrompt = buildTurnPrompt({
        userMessage: input.userMessage,
        action: decision.action,
        rationale: decision.rationale,
        clarifyingQuestion: decision.clarifyingQuestion,
        knowledge: knowledge ? { context: knowledge.context, found: knowledge.found } : undefined,
        toolResults: mcpCalls,
        recentTurns: recent,
      });
      const run = await runClaudeAgent({ conversationId: input.conversationId, turnPrompt });
      if (run.isError || run.text.trim() === "") {
        process.stderr.write(
          `[orchestrator] claude phrasing failed (${run.errorMessage ?? "empty"}); using deterministic response\n`,
        );
        return fallback;
      }
      return run.text.trim();
    } catch (error) {
      process.stderr.write(
        `[orchestrator] claude runner threw: ${error instanceof Error ? error.message : String(error)}; using deterministic response\n`,
      );
      return fallback;
    }
  }

  // ---------- Turn completion ----------

  private async finishTurn(input: TurnInput, base: TurnBase, outcome: TurnOutcome): Promise<TurnResult> {
    const responder: "claude" | "rules" = process.env.ANTHROPIC_API_KEY ? "claude" : "rules";

    await this.store.addTurn({
      conversation_id: input.conversationId,
      user_transcript: input.userMessage,
      assistant_response: outcome.response,
      answer_type: outcome.answerType,
      confidence: outcome.confidence,
      uncertainty_note: outcome.uncertaintyNote,
    });

    // Decision audit through MCP (logging flows through the MCP server).
    try {
      const client = await this.mcp(input.conversationId);
      await client.callTool("log_conversation_event", {
        conversation_id: input.conversationId,
        event_type: "decision",
        summary: `${base.decision.action}/${base.decision.intent}: ${base.decision.rationale}`,
        metadata: {
          answer_type: outcome.answerType,
          confidence: outcome.confidence,
          ticket_id: base.ticketId,
          escalation_id: base.escalationId,
        },
      });
    } catch (error) {
      process.stderr.write(
        `[orchestrator] decision event log failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    return {
      conversationId: input.conversationId,
      response: outcome.response,
      answerType: outcome.answerType,
      confidence: outcome.confidence,
      uncertaintyNote: outcome.uncertaintyNote,
      decision: base.decision,
      retrieval: base.retrieval,
      mcpCalls: base.mcpCalls,
      ticketId: base.ticketId,
      escalationId: base.escalationId,
      responder,
    };
  }

  async endConversation(conversationId: string): Promise<{ final_status: string }> {
    const turns = await this.store.listTurns(conversationId);
    const events = await this.store.listConversationEvents(conversationId);
    const escalated = events.some((e) => e.event_type === "escalation_created");
    const summary =
      turns.length === 0
        ? "Conversation ended without completed turns"
        : `${turns.length} turn(s). Last topic: ${turns[turns.length - 1]!.user_transcript.slice(0, 120)}`;
    await this.store.completeConversation(conversationId, escalated ? "escalated" : "completed", summary);
    return { final_status: escalated ? "escalated" : "completed" };
  }
}

function parseContact(message: string): { name: string | null; email: string | null } {
  const email = message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
  let name = message
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
    .replace(/\b(my name is|this is|i am|i'm|it's|email is|email|callback|tomorrow|today|morning|afternoon|at|on|please|thanks|thank you|and)\b/gi, " ")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > 60) name = name.slice(0, 60);
  return { name: name === "" ? null : name, email };
}

function extractPreferredTime(message: string): string | null {
  const match = message.match(
    /\b(\d{1,2}(:\d{2})?\s?(am|pm)|(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)(\s+(morning|afternoon|evening))?|morning|afternoon|evening)\b/i,
  );
  return match?.[0] ?? null;
}
