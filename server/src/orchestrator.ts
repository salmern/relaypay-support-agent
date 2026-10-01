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
import type { AnswerType, EscalationCategory, KnowledgeChunk, Store } from "@relaypay/store";
import {
  decide,
  extractIdentity,
  extractReferences,
  normalizeVoiceReferences,
  type Decision,
} from "./agent/decision-engine.js";
import { RetrievalService, type GroundedKnowledge } from "./knowledge/retrieval-service.js";
import { RelayPayMcpClient } from "./agent/mcp-client.js";
import { runClaudeAgent } from "./agent/claude-runner.js";
import { buildTurnPrompt } from "./agent/system-prompt.js";
import * as templates from "./agent/response-templates.js";
import { forSpeech } from "./agent/speech.js";

export interface TurnInput {
  conversationId: string;
  channel: "voice" | "text";
  userMessage: string;
  callerIdentifier?: string | null;
  /** Original STT transcript, kept when the message was normalized. */
  rawTranscript?: string | null;
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
    // Voice transcripts arrive from speech-to-text, which renders spoken
    // references as words ("TXN-nine thousand and 1"). Normalize them to
    // canonical IDs ("TXN-9001") before any decision runs, and keep the
    // raw transcript for the persisted audit trail.
    if (input.channel === "voice") {
      const normalized = normalizeVoiceReferences(input.userMessage);
      if (normalized !== input.userMessage) {
        input = { ...input, userMessage: normalized, rawTranscript: input.userMessage };
      }
    }

    await this.store.createConversation({
      conversation_id: input.conversationId,
      channel: input.channel,
      caller_identifier: input.callerIdentifier ?? null,
    });

    // A pending escalation contact request takes priority: the customer
    // is answering our ask for name/email.
    const pendingEscalation = await this.findPendingEscalation(input.conversationId);
    if (pendingEscalation) {
      // A farewell here means the customer is refusing to give contact
      // details — close politely instead of filing a contact-less
      // escalation or re-asking.
      if (FAREWELL_PATTERN.test(input.userMessage) || /^\s*(no|nope|nah)\s*[.!]?\s*$/i.test(input.userMessage)) {
        const decision: Decision = {
          action: "answer",
          intent: "knowledge",
          rationale: "Customer declined to continue the escalation — closing pleasantry",
        };
        const base = newBase(decision);
        const response = await this.phrase(input, decision, null, [], templates.farewellResponse());
        return this.finishTurn(input, base, {
          response,
          answerType: "knowledge",
          confidence: 0.95,
          uncertaintyNote: null,
        });
      }
      // Stale-marker heal: if an escalation record already holds contact
      // details but the pending event was never cleared (e.g. its write
      // was lost mid-call), finish the handover instead of dead-ending
      // the customer in a clarify loop.
      const { email } = parseContact(input.userMessage);
      if (email) {
        const escalations = await this.store.listEscalations(input.conversationId);
        const open = escalations.find((e) => e.status === "open");
        if (open && open.user_email) {
          const decision: Decision = {
            action: "escalate",
            intent: "escalation",
            escalationCategory: open.category,
            rationale: `Escalation ${open.escalation_id} already holds contact details — confirming handover`,
          };
          const base = newBase(decision);
          base.escalationId = open.escalation_id;
          const response = await this.phrase(
            input,
            decision,
            null,
            [],
            templates.escalationCreatedResponse({ hasCallback: Boolean(extractPreferredTime(input.userMessage)) }),
          );
          return this.finishTurn(input, base, {
            response,
            answerType: "escalation",
            confidence: 0.95,
            uncertaintyNote: null,
          });
        }
      }
      return this.completeEscalation(input);
    }

    const previousTurns = await this.store.listTurns(input.conversationId);

    // If the previous turn asked for name/email and the customer is now
    // answering, complete the escalation even when the pending event
    // write was lost mid-call (observed live on voice: without this, the
    // next turn fell through to the decline template). Speech-to-text
    // often drops the @ ("salmanx5 dot com"), so the signal is the
    // contact-provision wording, not a parseable address.
    const lastAssistant = previousTurns[previousTurns.length - 1]?.assistant_response ?? "";
    const askedForContact = /could i take your name and email/i.test(lastAssistant);
    const givingContact = /\b(my name is|name is|my email|email is|@|dot com|reach me at)\b/i.test(input.userMessage);
    if (!pendingEscalation && askedForContact && givingContact) {
      return this.completeEscalation(input);
    }

    // A bare digit run ("9 0 0 1.") right after the payment-clarify
    // question is the customer reading out a reference without saying
    // the prefix — treat it as a transaction lookup instead of a new
    // unsupported question (observed live on voice).
    const clarifyQuestion = /outgoing payout, an incoming transfer/i.test(lastAssistant);
    const bareDigits = input.userMessage.trim().match(/^([\d\s.,-]{3,12})[.!]?\s*$/);
    if (clarifyQuestion && bareDigits) {
      const digits = bareDigits[1]!.replace(/\D/g, "");
      if (digits.length >= 3) {
        input = {
          ...input,
          userMessage: `Check transaction TXN-${digits}`,
          rawTranscript: input.rawTranscript ?? input.userMessage,
        };
      }
    }

    // The decline response offers follow-up ("Would you like me to arrange
    // for our support team to follow up with you?"). A "yes please" must
    // START that escalation — answering it as a new question looped back
    // to the same decline (observed live on voice). A bare "No." there
    // politely ends the call instead of declining again.
    const askedForFollowUp = /would you like me to arrange for our support team to follow up/i.test(lastAssistant);
    const bareNegative = /^\s*(no|nope|nah)\s*[.!]?\s*$/i.test(input.userMessage);
    if (!pendingEscalation && askedForFollowUp) {
      if (AFFIRMATIVE_PATTERN.test(input.userMessage)) {
        return this.beginEscalation(input, {
          action: "escalate",
          intent: "escalation",
          escalationCategory: "other",
          rationale: "Customer accepted the follow-up offer",
        });
      }
      if (bareNegative) {
        const decision: Decision = {
          action: "answer",
          intent: "knowledge",
          rationale: "Customer declined the follow-up offer — closing pleasantry",
        };
        const base = newBase(decision);
        const response = await this.phrase(input, decision, null, [], templates.farewellResponse());
        return this.finishTurn(input, base, {
          response,
          answerType: "knowledge",
          confidence: 0.95,
          uncertaintyNote: null,
        });
      }
    }

    // A bare "No." right after "Is there anything else I can help with?"
    // declines the offer — close politely instead of answering a question
    // nobody asked (observed live on text AND voice).
    const offeredAnythingElse = /anything else/i.test(lastAssistant);
    if (!pendingEscalation && offeredAnythingElse && bareNegative) {
      const decision: Decision = {
        action: "answer",
        intent: "knowledge",
        rationale: "Customer declined the anything-else offer — closing pleasantry",
      };
      const base = newBase(decision);
      const response = await this.phrase(input, decision, null, [], templates.farewellResponse());
      return this.finishTurn(input, base, {
        response,
        answerType: "knowledge",
        confidence: 0.95,
        uncertaintyNote: null,
      });
    }

    // Farewells end the conversation; they are never new support requests.
    // Without this, "No thank you" after "anything else?" fell through to
    // the decline template (observed live on voice and text).
    if (previousTurns.length > 0 &&
      (FAREWELL_PATTERN.test(input.userMessage) || BARE_THANKS_PATTERN.test(input.userMessage))) {
      const decision: Decision = {
        action: "answer",
        intent: "knowledge",
        rationale: "Customer farewell — closing pleasantry",
      };
      const base = newBase(decision);
      const response = await this.phrase(input, decision, null, [], templates.farewellResponse());
      return this.finishTurn(input, base, {
        response,
        answerType: "knowledge",
        confidence: 0.95,
        uncertaintyNote: null,
      });
    }

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
    // Compliance reviews follow the same two-step escalation: log pending,
    // collect contact details, then create the record (see lookupAccount).
    // An already-open escalation for this category is reused instead of
    // duplicated, so repeated questions never file a second record.
    if (result.status === "review required") {
      const complianceRelated = /compliance/i.test(String(result.failure_reason ?? ""));
      const category = complianceRelated ? "compliance" : "payment";
      const existing = (await this.store.listEscalations(input.conversationId)).find(
        (e) => e.category === category && e.status === "open",
      );
      if (existing && existing.user_email) {
        base.escalationId = existing.escalation_id;
        const response =
          (await this.phrase(input, decision, null, base.mcpCalls, templates.payoutFoundResponse(result as never))) +
          " This is already with our specialist team, and they will follow up with you.";
        return this.finishTurn(input, base, {
          response,
          answerType: "escalation",
          confidence: 0.9,
          uncertaintyNote: null,
        });
      }
      await client.callTool("log_conversation_event", {
        conversation_id: input.conversationId,
        event_type: "escalation_pending_contact",
        summary: `Payout ${String(result.payout_id)} requires review: ${String(result.failure_reason ?? "status review")}`,
        metadata: { category },
      });

      const response =
        (await this.phrase(input, decision, null, base.mcpCalls, templates.payoutFoundResponse(result as never))) +
        " This needs our specialist team, so I'm handing it over. Could I take your name and email so they can follow up with you?";

      return this.finishTurn(input, base, {
        response,
        answerType: "escalation",
        confidence: 0.9,
        uncertaintyNote: "Waiting for customer contact details to create the escalation record",
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
    // Record the pending escalation through the SAME two-step flow as
    // explicit escalations: log it, then ask for contact details on the
    // next turn, so the escalation record ends up with real follow-up
    // information instead of nulls (escalation-rules.md).
    if (String(result.account_status) === "restricted") {
      const existing = (await this.store.listEscalations(input.conversationId)).find(
        (e) => e.category === "account" && e.status === "open",
      );
      if (existing && existing.user_email) {
        base.escalationId = existing.escalation_id;
        const response = await this.phrase(
          input,
          decision,
          null,
          base.mcpCalls,
          `I can see the account, but it's currently restricted, and I'm not able to discuss the details over voice support. This is already with our specialist team, and they will follow up with you.`,
        );
        return this.finishTurn(input, base, {
          response,
          answerType: "escalation",
          confidence: 0.9,
          uncertaintyNote: null,
        });
      }
      await client.callTool("log_conversation_event", {
        conversation_id: input.conversationId,
        event_type: "escalation_pending_contact",
        summary: `Account ${String(result.customer_id)} is restricted; customer requested account help`,
        metadata: { category: "account" },
      });

      const response = await this.phrase(
        input,
        decision,
        null,
        base.mcpCalls,
        `I can see the account, but it's currently restricted, and I'm not able to discuss the details over voice support. I'm handing this to our specialist team. Could I take your name and email so they can follow up with you?`,
      );
      return this.finishTurn(input, base, {
        response,
        answerType: "escalation",
        confidence: 0.9,
        uncertaintyNote: "Waiting for customer contact details to create the escalation record",
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
    // next turn can complete the escalation with contact details. The
    // write must succeed: if the pending marker is silently lost, the
    // next turn sees no pending escalation and the customer gets the
    // decline template (observed live on voice).
    const pendingResult = await client.callTool("log_conversation_event", {
      conversation_id: input.conversationId,
      event_type: "escalation_pending_contact",
      summary: `Escalation required (${decision.escalationCategory}): ${decision.rationale}`,
      metadata: { category: decision.escalationCategory ?? "other" },
    });
    if (pendingResult.logged !== true) {
      return this.finishTurn(input, base, {
        response: templates.toolErrorResponse("starting the escalation"),
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Pending-escalation event not logged: ${String(pendingResult.error ?? "unknown error")}`,
      });
    }

    const response = await this.phrase(input, decision, null, [], templates.escalationContactRequestResponse());
    return this.finishTurn(input, base, {
      response,
      answerType: "escalation",
      confidence: 0.9,
      uncertaintyNote: "Waiting for customer contact details to create the escalation record",
    });
  }

  private async completeEscalation(input: TurnInput, categoryOverride?: EscalationCategory): Promise<TurnResult> {
    const { name, email } = parseContact(input.userMessage);
    const events = await this.store.listConversationEvents(input.conversationId);
    // Use the LAST pending event: a conversation can escalate more than
    // once, and the newest ask is the one being answered.
    const pendingEvents = events.filter((e) => e.event_type === "escalation_pending_contact");
    const priorEvent = pendingEvents[pendingEvents.length - 1];
    const category: EscalationCategory =
      categoryOverride ??
      (priorEvent && typeof priorEvent.metadata.category === "string"
        ? (priorEvent.metadata.category as EscalationCategory)
        : "other");

    // Stale-marker heal: no pending event survives (e.g. the event write
    // was lost mid-call), but the customer is giving contact details.
    // Re-log the marker (best effort) so the audit trail shows what this
    // escalation completes, then carry on with "other" as the category.
    if (!priorEvent) {
      try {
        const client = await this.mcp(input.conversationId);
        await client.callTool("log_conversation_event", {
          conversation_id: input.conversationId,
          event_type: "escalation_pending_contact",
          summary: `Pending escalation marker re-logged: customer provided contact details without a surviving pending event`,
          metadata: { category: "other", relogged: true },
        });
      } catch (error) {
        process.stderr.write(
          `[orchestrator] pending-marker heal log failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    const decision: Decision = {
      action: "escalate",
      intent: "escalation",
      escalationCategory: category,
      rationale: "Completing pending escalation with customer contact details",
    };
    const base = newBase(decision);
    const client = await this.mcp(input.conversationId);

    // Nothing usable in the reply: re-ask instead of filing a contact-less
    // escalation. The pending event stays, so the next message retries.
    if (!name && !email) {
      const response = await this.phrase(
        input,
        decision,
        null,
        [],
        templates.escalationContactRequestResponse(),
      );
      return this.finishTurn(input, base, {
        response,
        answerType: "escalation",
        confidence: 0.8,
        uncertaintyNote: "Still waiting for the customer's name and email",
      });
    }

    const result = await client.callTool("create_escalation", {
      user_name: name ?? undefined,
      user_email: email ?? undefined,
      category,
      reason:
        priorEvent?.summary ??
        `Customer provided contact details during ${category} escalation`,
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
      user_transcript: input.rawTranscript ?? input.userMessage,
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

    // Voice responses are formatted for speech: the retrieval-source
    // citation ("This comes from our approved support guidelines on …")
    // is audit metadata — it stays in the persisted transcript and on the
    // text channel, but the voice reads only the answer so replies stay
    // short and natural. Amounts are read as words ("two thousand four
    // hundred US dollars") and references drop the hyphen ("T X N nine
    // zero zero one") so the voice does not say "minus".
    let response = outcome.response;
    if (input.channel === "voice") {
      response = response
        .replace(/\s*This comes from our approved support guidelines on [^.]+\.\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      response = forSpeech(response);
    }

    return {
      conversationId: input.conversationId,
      response,
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

// --- Farewells and affirmations -----------------------------------------

const FAREWELL_PATTERN =
  /\b(no,? (thank you|thanks)|no thanks?|no goodbye|goodbye|bye( bye)?|that('s| is) all|that will be all|nothing else)\b/i;
const AFFIRMATIVE_PATTERN =
  /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|please|of course|correct|right|affirmative|go ahead|sounds good)\b/i;
// A lone "Thank you." / "Thanks." is a closing pleasantry, not a request.
const BARE_THANKS_PATTERN = /^\s*(thank you|thanks)\s*[.!]?\s*$/i;

// --- Spoken-email extraction ---------------------------------------------

const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const EMAIL_TLDS = "com|net|org|io|co|ai|dev|us|uk|ca|me|ng|ke|gh|za|tv";
// "salman at relaypay dot com" — the final group must be a TLD so
// "tomorrow at nine dot thirty" (callback times) never matches.
const SPOKEN_AT_EMAIL = new RegExp(
  `\\b([a-z0-9][\\w.-]*)\\s+at\\s+([a-z][\\w-]*)\\s+(?:dot|\\.)\\s*(${EMAIL_TLDS})\\b`,
  "i",
);
// "salmanx550gmail dot com" / "salmanx550 gmail dot com" — local part and
// known provider fused by speech-to-text or separated by a pause.
const SPOKEN_PROVIDER_EMAIL = new RegExp(
  `\\b([a-z0-9][\\w.-]*?)\\s*(gmail|googlemail|hotmail|yahoo|outlook|icloud|protonmail)\\s+(?:dot|\\.)\\s*(${EMAIL_TLDS})\\b`,
  "i",
);
// "jdoe acmecorp dot com" — generic two-word address with a TLD ending.
const SPOKEN_GENERIC_EMAIL = new RegExp(
  `\\b([a-z0-9][\\w.-]{2,})\\s+([a-z][\\w-]{2,})\\s+(?:dot|\\.)\\s*(${EMAIL_TLDS})\\b`,
  "i",
);

/**
 * Reads an email out of a message, whether it was typed ("sal@x.com") or
 * spoken ("sal at x dot com", "salmanx550gmail dot com"). Speech-to-text
 * writes spoken addresses WITHOUT the @, so the old literal-only regex
 * returned null and the escalation flow lost the address (observed live).
 * Returns the matched source so callers can strip it from the name.
 */
function extractSpokenEmail(message: string): { email: string; source: string } | null {
  const literal = message.match(LITERAL_EMAIL);
  if (literal) return { email: literal[0].toLowerCase(), source: literal[0] };
  for (const pattern of [SPOKEN_AT_EMAIL, SPOKEN_PROVIDER_EMAIL, SPOKEN_GENERIC_EMAIL]) {
    const match = message.match(pattern);
    if (match) {
      return {
        email: `${match[1]}@${match[2]}.${match[3]}`.toLowerCase(),
        source: match[0],
      };
    }
  }
  return null;
}

const CONTACT_FILLERS =
  /\b(my name is|this is|i am|i'm|it's|email is|email|callback|tomorrow|today|morning|afternoon|my|is|at|on|please|thanks|thank you|and)\b/gi;

function parseContact(message: string): { name: string | null; email: string | null } {
  const spokenEmail = extractSpokenEmail(message);
  let name: string | null = (spokenEmail ? message.replace(spokenEmail.source, " ") : message)
    .replace(CONTACT_FILLERS, " ")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > 60) name = name.slice(0, 60);
  // A reply that is itself a question ("What are your opening hours?")
  // is not contact information, even after filler stripping.
  if (message.trim().endsWith("?")) name = null;
  return {
    name: name === "" ? null : name,
    email: spokenEmail?.email ?? null,
  };
}

function extractPreferredTime(message: string): string | null {
  const match = message.match(
    /\b(\d{1,2}(:\d{2})?\s?(am|pm)|(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)(\s+(morning|afternoon|evening))?|morning|afternoon|evening)\b/i,
  );
  return match?.[0] ?? null;
}
