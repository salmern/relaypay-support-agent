/**
 * Support orchestrator — executes one support turn.
 *
 * Flow (per assets/support-decision-rules.md):
 *   1. Conversation state is read from the previous turn's audit event:
 *      what the agent was waiting for (contact details, a callback time,
 *      a reference, a yes/no to an offer). State is structured data, not
 *      a regex over the previous reply's wording, so it survives Claude
 *      rewording the reply.
 *   2. A reply to that pending ask is handled first; anything else falls
 *      through to the deterministic decision engine.
 *   3. Required MCP tool calls are executed through our MCP server.
 *   4. Approved knowledge retrieval runs (and is logged) for knowledge answers.
 *   5. Claude (Agent SDK) rewords the statement of the reply; the required
 *      next step (the exact question/offer/citation) is appended verbatim.
 *      Without an API key the deterministic responder phrases it.
 *   6. Conversation, turn, retrieval, tool-call and event records persist,
 *      and the turn result carries the audit rows written for this turn.
 */
import {
  extractAnswer,
  RELEVANCE_THRESHOLD,
  stopwords,
  type AnswerType,
  type EscalationCategory,
  type KnowledgeChunk,
  type Store,
} from "@relaypay/store";
import {
  classifyIntent,
  decide,
  extractBareReference,
  extractIdentity,
  extractReferences,
  hasUnparsedReference,
  normalizeVoiceReferences,
  type Decision,
} from "./agent/decision-engine.js";
import { RetrievalService, type GroundedKnowledge } from "./knowledge/retrieval-service.js";
import { RelayPayMcpClient } from "./agent/mcp-client.js";
import { claudeTimeoutMs, claudeVoiceTimeoutMs, runClaudeAgent } from "./agent/claude-runner.js";
import { buildTurnPrompt } from "./agent/system-prompt.js";
import * as templates from "./agent/response-templates.js";
import { render, type Reply } from "./agent/response-templates.js";
import { forSpeech } from "./agent/speech.js";

export interface TurnInput {
  conversationId: string;
  channel: "voice" | "text";
  userMessage: string;
  callerIdentifier?: string | null;
  /** Original STT transcript, kept when the message was normalized. */
  rawTranscript?: string | null;
}

/** What the agent asked for at the end of a turn (drives the next turn). */
export type Awaiting =
  | "contact"
  | "callback_time"
  | "follow_up_offer"
  | "anything_else"
  | "payment_clarify"
  | "ticket_reference"
  | "ticket_offer"
  | null;

/** One MCP tool call written to the audit table during this turn. */
export interface ToolActivity {
  tool_name: string;
  event_type: string | null;
  status: string;
  input_summary: string;
  result_summary: string;
  error_message: string | null;
}

export interface TurnActivity {
  /** Rows from the tool_calls audit table written during this turn. */
  toolCalls: ToolActivity[];
  retrieval: { query: string; chunks: string[]; sourceTitle: string } | null;
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
  /** Which responder actually phrased THIS turn. */
  responder: "claude" | "rules";
  awaiting: Awaiting;
  activity: TurnActivity;
}

interface TurnBase {
  decision: Decision;
  /** Set when an account lookup identified the caller's customer record. */
  identifiedCustomerId?: string | null;
  retrieval: GroundedKnowledge | null;
  mcpCalls: Array<{ tool: string; result: unknown }>;
  ticketId: string | null;
  escalationId: string | null;
  customerId: string | null;
  responder: "claude" | "rules";
  /** Why Claude was not used for this turn (timeout, error, cooldown, rejected rewrite). */
  claudeNote?: string | null;
  /** Milliseconds spent in the Claude phrasing step. */
  phraseMs?: number;
}

interface TurnOutcome {
  response: string;
  answerType: AnswerType;
  confidence: number;
  uncertaintyNote: string | null;
  awaiting?: Awaiting;
  state?: Record<string, unknown>;
}

interface ConversationState {
  awaiting: Awaiting;
  data: Record<string, unknown>;
  /**
   * Customer the caller identified as (account lookup by company name or
   * customer ID). A transaction or payout lookup does NOT identify the
   * caller — knowing a reference is not proof of owning the account — so
   * it never sets this.
   */
  customerId: string | null;
  /** Latest ticket created in the conversation. */
  ticketId: string | null;
}

interface TurnContext {
  turnStartedAt: string;
  previousTurns: Array<{ user_transcript: string; assistant_response: string }>;
  events: Array<{ event_type: string; summary: string; metadata: Record<string, unknown>; created_at: string }>;
  state: ConversationState;
}

interface Inspection {
  error?: string;
  found: boolean;
  lead: string;
  closing?: string;
  notFoundRef?: string;
  review?: { category: EscalationCategory; reason: string };
  customerId?: string | null;
}

function newBase(decision: Decision): TurnBase {
  return {
    decision,
    retrieval: null,
    mcpCalls: [],
    ticketId: null,
    escalationId: null,
    customerId: null,
    responder: "rules",
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Circuit breaker for Claude phrasing: after repeated timeouts/errors the
 * model is skipped for a cooldown, so callers are not made to wait for a
 * model that keeps failing (each failed attempt costs the full timeout).
 */
const claudeBreaker = { consecutiveFailures: 0, openUntil: 0 };
const BREAKER_THRESHOLD = 2;
function breakerCooldownMs(): number {
  const configured = Number(process.env.CLAUDE_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5 * 60_000;
}
export function resetClaudeBreaker(): void {
  claudeBreaker.consecutiveFailures = 0;
  claudeBreaker.openUntil = 0;
}

/** Idle MCP subprocesses are closed after this long (each holds ~80 MB). */
function mcpIdleMs(): number {
  const configured = Number(process.env.MCP_IDLE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60_000;
}

export class SupportOrchestrator {
  private readonly retrieval: RetrievalService;
  private readonly mcpClients = new Map<string, { client: Promise<RelayPayMcpClient>; lastUsed: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    chunks: KnowledgeChunk[],
  ) {
    this.retrieval = new RetrievalService(store, chunks);
    // One MCP subprocess per active conversation; idle ones are reaped so
    // memory stays bounded even when callers never end the conversation.
    this.sweeper = setInterval(() => void this.reapIdleClients(), Math.min(60_000, mcpIdleMs()));
    this.sweeper.unref();
  }

  /** Number of live MCP subprocesses (observability / tests). */
  get activeMcpClients(): number {
    return this.mcpClients.size;
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper);
    const ids = [...this.mcpClients.keys()];
    await Promise.all(ids.map((id) => this.releaseClient(id)));
  }

  private async reapIdleClients(): Promise<void> {
    const cutoff = Date.now() - mcpIdleMs();
    for (const [id, entry] of this.mcpClients) {
      if (entry.lastUsed < cutoff) await this.releaseClient(id);
    }
  }

  async releaseClient(conversationId: string): Promise<void> {
    const entry = this.mcpClients.get(conversationId);
    if (!entry) return;
    this.mcpClients.delete(conversationId);
    try {
      const client = await entry.client;
      await client.close();
    } catch {
      // already closed or never started
    }
  }

  private async mcp(conversationId: string): Promise<RelayPayMcpClient> {
    let entry = this.mcpClients.get(conversationId);
    if (!entry) {
      // Store the PROMISE so concurrent turns share one spawn.
      const client = RelayPayMcpClient.spawn(conversationId);
      entry = { client, lastUsed: Date.now() };
      this.mcpClients.set(conversationId, entry);
      client.catch(() => this.mcpClients.delete(conversationId));
    }
    entry.lastUsed = Date.now();
    return entry.client;
  }

  /** Calls an MCP tool, respawning the subprocess once if it died. */
  private async callTool(conversationId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await (await this.mcp(conversationId)).callTool(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/closed|EPIPE|not connected|ECONNRESET/i.test(message)) throw error;
      await this.releaseClient(conversationId);
      return (await this.mcp(conversationId)).callTool(name, args);
    }
  }

  // ======================================================================
  // Turn entry point
  // ======================================================================

  async handleTurn(rawInput: TurnInput): Promise<TurnResult> {
    let input = rawInput;
    const turnStartedAt = new Date().toISOString();
    // References arrive in loose shapes: speech-to-text writes words
    // ("TXN-nine thousand and 1"), and people type without the hyphen
    // ("txn99999", "TXN 9001"). Normalize them to canonical IDs on BOTH
    // channels before any decision runs, and keep what the customer
    // actually said/typed for the persisted audit trail.
    const normalized = normalizeVoiceReferences(input.userMessage);
    if (normalized !== input.userMessage) {
      input = { ...input, userMessage: normalized, rawTranscript: input.userMessage };
    }

    await this.store.createConversation({
      conversation_id: input.conversationId,
      channel: input.channel,
      caller_identifier: input.callerIdentifier ?? null,
    });

    const [previousTurns, events] = await Promise.all([
      this.store.listTurns(input.conversationId),
      this.store.listConversationEvents(input.conversationId),
    ]);
    const ctx: TurnContext = {
      turnStartedAt,
      previousTurns,
      events,
      state: readState(events, previousTurns),
    };

    // 1. A reply to what the previous turn asked for.
    const pending = await this.handleAwaiting(input, ctx);
    if (pending.result) return pending.result;
    input = pending.input;

    // 2. Farewells end the conversation; they are never new requests.
    if (FAREWELL_PATTERN.test(input.userMessage) ||
      (previousTurns.length > 0 && BARE_THANKS_PATTERN.test(input.userMessage))) {
      return this.closeConversationTurn(input, ctx, "Customer farewell — closing pleasantry", templates.farewell());
    }

    // 3. A new request.
    return this.route(input, ctx);
  }

  // ======================================================================
  // Pending asks
  // ======================================================================

  private async handleAwaiting(
    input: TurnInput,
    ctx: TurnContext,
  ): Promise<{ result?: TurnResult; input: TurnInput }> {
    const message = input.userMessage;
    const { awaiting, data } = ctx.state;
    const negative = BARE_NEGATIVE.test(message);

    switch (awaiting) {
      case "contact":
        return { result: (await this.handleContactReply(input, ctx)) ?? undefined, input };

      case "callback_time":
        return { result: (await this.handleCallbackReply(input, ctx)) ?? undefined, input };

      case "follow_up_offer":
        if (AFFIRMATIVE_PATTERN.test(message) && !looksLikeNewRequest(message)) {
          return {
            result: await this.beginEscalation(input, ctx, {
              action: "escalate",
              intent: "escalation",
              escalationCategory: "other",
              rationale: "Customer accepted the follow-up offer",
            }),
            input,
          };
        }
        if (negative) {
          return { result: await this.closeConversationTurn(input, ctx, "Customer declined the follow-up offer — closing pleasantry", templates.farewell()), input };
        }
        return { input };

      case "anything_else":
        if (negative) {
          return { result: await this.closeConversationTurn(input, ctx, "Customer declined the anything-else offer — closing pleasantry", templates.farewell()), input };
        }
        return { input };

      case "payment_clarify": {
        // A bare digit run ("9 0 0 1.") after the payment-clarify question
        // is the customer reading out a reference without the prefix.
        const bareDigits = message.trim().match(/^([\d\s.,-]{3,12})[.!]?\s*$/);
        if (bareDigits) {
          const digits = bareDigits[1]!.replace(/\D/g, "");
          if (digits.length >= 3) {
            return {
              input: {
                ...input,
                userMessage: `Check transaction TXN-${digits}`,
                rawTranscript: input.rawTranscript ?? input.userMessage,
              },
            };
          }
        }
        // "An outgoing payout." — the kind, but no reference yet.
        const refs = extractReferences(message);
        if (!refs.transactionId && !refs.payoutId && !/\d/.test(message) &&
          /\b(outgoing|incoming|payout|transfer|invoice)\b/i.test(message) && message.split(/\s+/).length <= 8) {
          const decision: Decision = {
            action: "clarify",
            intent: /payout/i.test(message) ? "payout_lookup" : "transaction_lookup",
            rationale: "Customer named the payment kind but no reference — asking for it",
          };
          return {
            result: await this.reply(input, ctx, newBase(decision), templates.askReferenceForKind(), {
              answerType: "clarification",
              confidence: 0.9,
              awaiting: "payment_clarify",
            }),
            input,
          };
        }
        return { input };
      }

      case "ticket_reference": {
        const summary = str(data.summary) ?? message;
        const refs = { ...extractReferences(message), ...extractBareReference(message, "ticket") };
        const ticketDecision: Decision = { action: "ticket", intent: "ticket", rationale: "Customer answered the ticket reference question" };
        if (refs.transactionId || refs.payoutId) {
          return {
            result: await this.createTicket(input, ctx, ticketDecision, refs, { summary, skipReferenceAsk: true }),
            input,
          };
        }
        if (negative || NO_REFERENCE_PATTERN.test(message)) {
          return {
            result: await this.createTicket(input, ctx, ticketDecision, {}, { summary, skipReferenceAsk: true }),
            input,
          };
        }
        return { input };
      }

      case "ticket_offer": {
        const reference = str(data.reference) ?? "the reference";
        if (AFFIRMATIVE_PATTERN.test(message) && !looksLikeNewRequest(message)) {
          return {
            result: await this.createTicket(
              input,
              ctx,
              { action: "ticket", intent: "ticket", rationale: "Customer asked for a ticket about a reference that could not be found" },
              {},
              { summary: `Customer asked us to investigate ${reference}, which could not be found in our records`, skipReferenceAsk: true, category: "payment" },
            ),
            input,
          };
        }
        if (negative) {
          const decision: Decision = { action: "answer", intent: "knowledge", rationale: "Customer declined the ticket offer" };
          return {
            result: await this.reply(input, ctx, newBase(decision), { lead: "No problem.", closing: templates.ANYTHING_ELSE }, {
              answerType: "closing",
              confidence: 0.95,
              awaiting: "anything_else",
            }),
            input,
          };
        }
        return { input };
      }

      default:
        return { input };
    }
  }

  // ---------- Escalation contact collection ----------

  private async handleContactReply(input: TurnInput, ctx: TurnContext): Promise<TurnResult | null> {
    const message = input.userMessage;
    const decision: Decision = {
      action: "escalate",
      intent: "escalation",
      escalationCategory: escalationCategoryFrom(ctx),
      rationale: "Collecting contact details for the pending escalation",
    };

    // Refusing to give details ends the call politely instead of filing a
    // contact-less escalation or re-asking.
    if (FAREWELL_PATTERN.test(message) || BARE_NEGATIVE.test(message)) {
      return this.closeConversationTurn(input, ctx, "Customer declined to give contact details — closing pleasantry", templates.farewell());
    }
    // Changing their mind cancels the handover (audited). If they asked
    // something else in the same breath ("never mind, what are your
    // fees?"), that question is answered next.
    if (CANCEL_PATTERN.test(message)) {
      await this.callTool(input.conversationId, "log_conversation_event", {
        conversation_id: input.conversationId,
        event_type: "escalation_cancelled",
        summary: "Customer withdrew the escalation request before giving contact details",
        metadata: { category: decision.escalationCategory ?? "other" },
      });
      const remainder = message.replace(CANCEL_PATTERN, " ").replace(/^[\s,.;!-]*(actually|ok|okay|so)?[\s,.;!-]*/i, "").trim();
      if (remainder && looksLikeNewRequest(remainder)) return null;
      return this.reply(input, ctx, newBase({ ...decision, rationale: "Customer cancelled the pending escalation" }), templates.escalationCancelled(), {
        answerType: "closing",
        confidence: 0.9,
        awaiting: "anything_else",
      });
    }

    const parsed = parseContact(message);
    if (parsed.name || parsed.email || parsed.emailAttempted) {
      return this.continueEscalation(input, ctx, decision, parsed);
    }
    // A new question or request: drop the pending ask and handle it.
    if (looksLikeNewRequest(message)) return null;
    return this.reply(input, ctx, newBase(decision), templates.reaskContact(), {
      answerType: "escalation",
      confidence: 0.8,
      uncertaintyNote: "Still waiting for the customer's name and email",
      awaiting: "contact",
      state: ctx.state.data,
    });
  }

  private async continueEscalation(
    input: TurnInput,
    ctx: TurnContext,
    decision: Decision,
    parsed: ParsedContact,
  ): Promise<TurnResult> {
    const name = parsed.name ?? str(ctx.state.data.name);
    const email = parsed.email ?? str(ctx.state.data.email);
    const progress = { ...ctx.state.data, name, email };
    const waiting = (reply: Reply, note: string) =>
      this.reply(input, ctx, newBase(decision), reply, {
        answerType: "escalation",
        confidence: 0.85,
        uncertaintyNote: note,
        awaiting: "contact",
        state: progress,
      });

    if (parsed.emailAttempted && !parsed.email) return waiting(templates.invalidEmail(), "Email address could not be read — asked again");
    if (!email) return waiting(templates.askEmail(name), "Have the name, waiting for the email address");
    if (!name) return waiting(templates.askName(), "Have the email address, waiting for the name");

    const category = escalationCategoryFrom(ctx);
    const reason = str(ctx.state.data.reason) ?? lastPendingEvent(ctx)?.summary ?? `Customer requested human support (${category})`;
    const time = extractPreferredTime(input.userMessage);
    const base = newBase({ ...decision, escalationCategory: category, rationale: "Contact details collected — creating the escalation record" });
    const linkedCustomer = str(ctx.state.data.customer_id) ?? ctx.state.customerId;
    base.customerId = linkedCustomer;

    const result = await this.callTool(input.conversationId, "create_escalation", {
      user_name: name,
      user_email: email,
      category,
      reason,
      ...(time?.valid ? { preferred_time: time.value } : {}),
      ...(linkedCustomer ? { customer_id: linkedCustomer } : {}),
      ...(ctx.state.ticketId ? { ticket_id: ctx.state.ticketId } : {}),
    });
    base.mcpCalls.push({ tool: "create_escalation", result });
    const escalationId = str(result.escalation_id);
    if (!escalationId) {
      return this.reply(input, ctx, base, templates.toolError("creating the escalation"), {
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Escalation creation failed: ${String(result.error ?? "unknown")}`,
        awaiting: "contact",
        state: progress,
      });
    }
    base.escalationId = escalationId;

    await this.callTool(input.conversationId, "log_conversation_event", {
      conversation_id: input.conversationId,
      event_type: "escalation_created",
      summary: `Escalation ${escalationId} created with customer contact details`,
      metadata: { escalation_id: escalationId, category },
    });

    if (time?.valid) {
      return this.reply(input, ctx, base, templates.escalationCreated({ name, preferredTime: time.value }), {
        answerType: "escalation",
        confidence: 0.95,
        awaiting: "anything_else",
      });
    }
    const created = templates.escalationCreated({ name, preferredTime: null });
    const reply: Reply = time && !time.valid
      ? { lead: `${created.lead} ${templates.callbackInvalid().lead}`, closing: templates.callbackInvalid().closing }
      : created;
    return this.reply(input, ctx, base, reply, {
      answerType: "escalation",
      confidence: 0.95,
      uncertaintyNote: time && !time.valid ? `Callback time "${time.value}" is not a valid time` : null,
      awaiting: "callback_time",
      state: { escalation_id: escalationId, category },
    });
  }

  private async handleCallbackReply(input: TurnInput, ctx: TurnContext): Promise<TurnResult | null> {
    const message = input.userMessage;
    const category = (str(ctx.state.data.category) as EscalationCategory | null) ?? escalationCategoryFrom(ctx);
    const escalationId = str(ctx.state.data.escalation_id);
    const decision: Decision = {
      action: "escalate",
      intent: "escalation",
      escalationCategory: category,
      rationale: "Customer answered the callback-time question",
    };
    const time = extractPreferredTime(message);

    if (time?.valid) {
      const base = newBase(decision);
      const result = await this.callTool(input.conversationId, "create_escalation", {
        category,
        reason: "Callback time added to the existing escalation",
        preferred_time: time.value,
      });
      base.mcpCalls.push({ tool: "create_escalation", result });
      base.escalationId = str(result.escalation_id) ?? escalationId;
      if (!str(result.escalation_id)) {
        return this.reply(input, ctx, base, templates.toolError("saving your callback time"), {
          answerType: "error",
          confidence: 0.3,
          uncertaintyNote: `Callback update failed: ${String(result.error ?? "unknown")}`,
          awaiting: "callback_time",
          state: ctx.state.data,
        });
      }
      return this.reply(input, ctx, base, templates.callbackBooked(time.value), {
        answerType: "escalation",
        confidence: 0.95,
        awaiting: "anything_else",
      });
    }
    if (time && !time.valid) {
      return this.reply(input, ctx, newBase(decision), templates.callbackInvalid(), {
        answerType: "escalation",
        confidence: 0.8,
        uncertaintyNote: `Callback time "${time.value}" is not a valid time`,
        awaiting: "callback_time",
        state: ctx.state.data,
      });
    }
    if (FAREWELL_PATTERN.test(message)) {
      return this.closeConversationTurn(input, ctx, "Customer declined a callback and said goodbye",
        templates.farewellAfter("No problem — the specialist will follow up with you by email."));
    }
    if (BARE_NEGATIVE.test(message) || NO_CALLBACK_PATTERN.test(message)) {
      return this.reply(input, ctx, newBase({ ...decision, rationale: "Customer declined a callback" }), templates.callbackDeclined(), {
        answerType: "escalation",
        confidence: 0.95,
        awaiting: "anything_else",
      });
    }
    if (AFFIRMATIVE_PATTERN.test(message) && !looksLikeNewRequest(message)) {
      return this.reply(input, ctx, newBase(decision), { lead: "Great.", closing: "What day and time suit you for the callback?" }, {
        answerType: "escalation",
        confidence: 0.9,
        awaiting: "callback_time",
        state: ctx.state.data,
      });
    }
    if (looksLikeNewRequest(message)) return null;
    return this.reply(input, ctx, newBase(decision), templates.callbackInvalid(), {
      answerType: "escalation",
      confidence: 0.8,
      uncertaintyNote: "Could not read a callback time",
      awaiting: "callback_time",
      state: ctx.state.data,
    });
  }

  // ======================================================================
  // New requests
  // ======================================================================

  private async route(input: TurnInput, ctx: TurnContext): Promise<TurnResult> {
    const message = input.userMessage;
    const intentPreview = classifyIntent(message);

    // Identity from this message or earlier turns.
    let identity = extractIdentity(message);
    if (!identity.companyName && !identity.contactName) {
      for (const past of ctx.previousTurns) {
        identity = extractIdentity(past.user_transcript);
        if (identity.companyName || identity.contactName) break;
      }
    }

    // References: the current message wins. An earlier reference is only
    // reused when this message has no reference-like content at all, and
    // only for the same kind of record — a reference we could not parse
    // must never be silently replaced by an older one.
    const current = { ...extractReferences(message) };
    if (!current.transactionId && !current.payoutId) Object.assign(current, extractBareReference(message, intentPreview));
    const unparsed = !current.transactionId && !current.payoutId && hasUnparsedReference(message);
    const history = latestReferences(ctx.previousTurns.map((t) => t.user_transcript));
    const lookupLike = intentPreview === "transaction_lookup" || intentPreview === "payout_lookup" || intentPreview === "ticket";

    if (unparsed && lookupLike) {
      const decision: Decision = {
        action: "clarify",
        intent: intentPreview,
        rationale: "Message contains a reference that could not be read — asking to repeat it instead of guessing",
      };
      return this.reply(input, ctx, newBase(decision), templates.repeatReference(), {
        answerType: "clarification",
        confidence: 0.9,
        uncertaintyNote: "Reference in the message could not be parsed",
        awaiting: "payment_clarify",
      });
    }

    const refs = {
      transactionId:
        current.transactionId ??
        (!unparsed && (intentPreview === "transaction_lookup" || intentPreview === "ticket") ? history.transactionId : undefined),
      payoutId: current.payoutId ?? (!unparsed && intentPreview === "payout_lookup" ? history.payoutId : undefined),
      customerId: current.customerId ?? history.customerId,
    };
    const fromHistory =
      (refs.transactionId !== undefined && refs.transactionId !== current.transactionId) ||
      (refs.payoutId !== undefined && refs.payoutId !== current.payoutId);

    const decision = decide(message, {
      hasIdentity: Boolean(identity.companyName || identity.contactName || refs.customerId),
      hasReference: Boolean(refs.transactionId || refs.payoutId),
    });
    if (fromHistory && decision.action === "lookup") {
      decision.rationale += ` (reference ${refs.payoutId ?? refs.transactionId} taken from earlier in the conversation)`;
    }

    switch (decision.action) {
      case "clarify":
        return this.clarify(input, ctx, decision);
      case "answer":
        return this.answerWithKnowledge(input, ctx, decision);
      case "lookup":
        if (decision.intent === "account_lookup") return this.lookupAccount(input, ctx, decision, identity, refs);
        return this.lookupRecords(input, ctx, decision, refs, current);
      case "ticket":
        return this.createTicket(input, ctx, decision, refs);
      case "escalate":
        return this.beginEscalation(input, ctx, decision);
      case "decline":
      default:
        return this.decline(input, ctx, decision);
    }
  }

  private async clarify(input: TurnInput, ctx: TurnContext, decision: Decision): Promise<TurnResult> {
    if (decision.intent === "greeting") {
      const reply = ctx.previousTurns.length === 0 ? templates.greeting() : templates.presenceCheck();
      return this.reply(input, ctx, newBase(decision), reply, { answerType: "clarification", confidence: 0.95 });
    }
    if (decision.intent === "general_help") {
      return this.reply(input, ctx, newBase(decision), templates.generalHelp(), { answerType: "clarification", confidence: 0.9 });
    }
    if (decision.intent === "account_lookup") {
      return this.reply(input, ctx, newBase(decision), templates.clarifyAccount(), { answerType: "clarification", confidence: 0.9 });
    }
    return this.reply(input, ctx, newBase(decision), templates.clarifyPayment(), {
      answerType: "clarification",
      confidence: 0.9,
      awaiting: "payment_clarify",
    });
  }

  private async decline(input: TurnInput, ctx: TurnContext, decision: Decision): Promise<TurnResult> {
    if (decision.declineKind === "privacy") {
      return this.reply(input, ctx, newBase(decision), templates.privacyDecline(), {
        answerType: "decline",
        confidence: 0.95,
        uncertaintyNote: "Refused to disclose personal or internal data",
        awaiting: "anything_else",
      });
    }
    if (decision.declineKind === "scope") {
      return this.reply(input, ctx, newBase(decision), templates.scopeDecline(), {
        answerType: "decline",
        confidence: 0.95,
        uncertaintyNote: "Refused an attempt to override the support rules",
      });
    }
    return this.reply(input, ctx, newBase(decision), templates.declineResponse(), {
      answerType: "decline",
      confidence: 0.6,
      uncertaintyNote: "No approved knowledge covers this topic",
      awaiting: "follow_up_offer",
    });
  }

  // ---------- Knowledge ----------

  private async answerWithKnowledge(input: TurnInput, ctx: TurnContext, decision: Decision): Promise<TurnResult> {
    const base = newBase(decision);
    const knowledge = await this.retrieval.retrieve(input.userMessage, input.conversationId);
    base.retrieval = knowledge;

    if (!knowledge.found || !knowledge.primary) {
      // Deterministic safety net: decline rather than answer ungrounded.
      return this.reply(input, ctx, base, templates.declineResponse(), {
        answerType: "decline",
        confidence: 0.6,
        uncertaintyNote: "Retrieval found no relevant approved knowledge",
        awaiting: "follow_up_offer",
      }, knowledge);
    }

    const primary = knowledge.primary;
    const answer = dropYesNoForOpenQuestion(extractAnswer(primary.content, input.userMessage), input.userMessage);
    // Confidence reflects retrieval strength: an exact FAQ match is 0.95;
    // otherwise it rises from 0.55 at the relevance threshold towards 0.95.
    const confidence = knowledge.exactFaq
      ? 0.95
      : Math.round(Math.min(0.95, 0.55 + 0.4 * (1 - RELEVANCE_THRESHOLD / knowledge.bestScore)) * 100) / 100;
    return this.reply(input, ctx, base, templates.knowledgeAnswer(answer, primary.heading || primary.title), {
      answerType: "knowledge",
      confidence,
      uncertaintyNote: confidence < 0.7 ? `Weak retrieval match (score ${knowledge.bestScore.toFixed(1)})` : null,
    }, knowledge);
  }

  // ---------- Transaction / payout lookups ----------

  private async inspectTransaction(conversationId: string, base: TurnBase, transactionId: string): Promise<Inspection> {
    const result = await this.callTool(conversationId, "lookup_transaction", { transaction_id: transactionId });
    base.mcpCalls.push({ tool: "lookup_transaction", result });
    if (result.error) return { error: `lookup_transaction failed: ${String(result.error)}`, found: false, lead: "" };
    if (result.found !== true) {
      const notFound = templates.transactionNotFound(transactionId);
      return { found: false, lead: notFound.lead, closing: notFound.closing, notFoundRef: transactionId };
    }
    const lead = templates.transactionFound(result as never).lead;
    const customerId = str(result.customer_id);
    if (result.status === "review required") {
      const compliance = /compliance/i.test(String(result.support_summary ?? ""));
      return {
        found: true,
        lead,
        customerId,
        review: {
          category: compliance ? "compliance" : "payment",
          reason: `Transaction ${transactionId} requires review${compliance ? " (compliance)" : ""}`,
        },
      };
    }
    return { found: true, lead, customerId };
  }

  private async inspectPayout(conversationId: string, base: TurnBase, ref: { payoutId?: string; transactionId?: string }): Promise<Inspection> {
    const args: Record<string, unknown> = ref.payoutId ? { payout_id: ref.payoutId } : { transaction_id: ref.transactionId };
    const result = await this.callTool(conversationId, "lookup_payout", args);
    base.mcpCalls.push({ tool: "lookup_payout", result });
    if (result.error) return { error: `lookup_payout failed: ${String(result.error)}`, found: false, lead: "" };
    const reference = ref.payoutId ?? ref.transactionId ?? "that reference";
    if (result.found !== true) {
      const notFound = templates.payoutNotFound(reference);
      return { found: false, lead: notFound.lead, closing: notFound.closing, notFoundRef: reference };
    }
    const lead = templates.payoutFound(result as never).lead;
    const customerId = str(result.customer_id);
    if (result.status === "review required") {
      const compliance = /compliance/i.test(String(result.failure_reason ?? ""));
      return {
        found: true,
        lead,
        customerId,
        review: {
          category: compliance ? "compliance" : "payment",
          reason: `Payout ${String(result.payout_id)} requires review: ${String(result.failure_reason || "status review")}`,
        },
      };
    }
    return { found: true, lead, customerId };
  }

  private async lookupRecords(
    input: TurnInput,
    ctx: TurnContext,
    decision: Decision,
    refs: { transactionId?: string; payoutId?: string },
    current: { transactionId?: string; payoutId?: string },
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const inspections: Inspection[] = [];
    // Both references in one message ("TXN-9001 and PAY-7002"): check both.
    const both = Boolean(current.transactionId && current.payoutId);
    if (decision.intent === "payout_lookup" || both) {
      inspections.push(await this.inspectPayout(input.conversationId, base, refs.payoutId ? { payoutId: refs.payoutId } : { transactionId: refs.transactionId }));
    }
    if (decision.intent === "transaction_lookup" || both) {
      inspections.unshift(await this.inspectTransaction(input.conversationId, base, refs.transactionId!));
    }

    const failed = inspections.find((i) => i.error);
    if (failed) {
      return this.reply(input, ctx, base, templates.toolError(decision.intent === "payout_lookup" ? "checking that payout" : "checking that transaction"), {
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `MCP ${failed.error}`,
        awaiting: "follow_up_offer",
      });
    }

    base.customerId = inspections.find((i) => i.customerId)?.customerId ?? null;
    const lead = inspections.map((i) => i.lead).join(" ");
    const review = inspections.find((i) => i.review)?.review;
    if (review) return this.handoverForReview(input, ctx, base, lead, review);

    const notFound = inspections.find((i) => !i.found);
    if (notFound) {
      return this.reply(input, ctx, base, { lead, closing: notFound.closing }, {
        answerType: "lookup",
        confidence: 0.7,
        uncertaintyNote: decision.intent === "payout_lookup" && !both ? "Payout record not found" : "Transaction record not found",
        awaiting: "ticket_offer",
        state: { reference: notFound.notFoundRef },
      });
    }
    return this.reply(input, ctx, base, { lead }, { answerType: "lookup", confidence: 0.95 });
  }

  /**
   * A record that needs a specialist (review required, restricted
   * account): reuse an open escalation that already has contact details,
   * otherwise log the pending escalation and ask for contact details.
   */
  private async handoverForReview(
    input: TurnInput,
    ctx: TurnContext,
    base: TurnBase,
    recordLead: string,
    review: { category: EscalationCategory; reason: string },
    handover: Reply = templates.reviewHandover(recordLead),
  ): Promise<TurnResult> {
    const existing = (await this.store.listEscalations(input.conversationId)).find(
      (e) => e.category === review.category && e.status === "open" && e.user_email,
    );
    if (existing) {
      base.escalationId = existing.escalation_id;
      const already = templates.alreadyEscalated();
      return this.reply(input, ctx, base, { lead: `${recordLead} ${already.lead}`.trim(), closing: already.closing }, {
        answerType: "escalation",
        confidence: 0.9,
        awaiting: "anything_else",
      });
    }
    const pending = await this.callTool(input.conversationId, "log_conversation_event", {
      conversation_id: input.conversationId,
      event_type: "escalation_pending_contact",
      summary: review.reason,
      metadata: { category: review.category },
    });
    if (pending.logged !== true) {
      return this.reply(input, ctx, base, templates.toolError("starting the handover"), {
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Pending-escalation event not logged: ${String(pending.error ?? "unknown error")}`,
      });
    }
    return this.reply(input, ctx, base, handover, {
      answerType: "escalation",
      confidence: 0.9,
      uncertaintyNote: "Waiting for customer contact details to create the escalation record",
      awaiting: "contact",
      state: { category: review.category, reason: review.reason, customer_id: base.customerId },
    });
  }

  // ---------- Account lookup ----------

  private async lookupAccount(
    input: TurnInput,
    ctx: TurnContext,
    decision: Decision,
    identity: { companyName?: string; contactName?: string },
    refs: { customerId?: string },
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const args: Record<string, unknown> = {};
    if (refs.customerId) args.customer_id = refs.customerId;
    else if (identity.companyName) args.company_name = identity.companyName;
    if (Object.keys(args).length === 0) {
      return this.reply(input, ctx, base, templates.clarifyAccount(), { answerType: "clarification", confidence: 0.9 });
    }

    const result = await this.callTool(input.conversationId, "lookup_customer", args);
    base.mcpCalls.push({ tool: "lookup_customer", result });
    if (result.error) {
      return this.reply(input, ctx, base, templates.toolError("checking that account"), {
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `MCP lookup_customer failed: ${String(result.error)}`,
        awaiting: "follow_up_offer",
      });
    }
    if (result.found !== true) {
      return this.reply(input, ctx, base, templates.accountNotFound(), {
        answerType: "lookup",
        confidence: 0.7,
        uncertaintyNote: "Customer record not found",
      });
    }
    base.customerId = str(result.customer_id);
    base.identifiedCustomerId = base.customerId;

    // Restricted accounts always go to human support (escalation rules).
    if (String(result.account_status) === "restricted") {
      return this.handoverForReview(input, ctx, base, "I can see the account, but it's currently restricted, and I'm not able to discuss the details here.", {
        category: "account",
        reason: `Account ${String(result.customer_id)} is restricted; customer requested account help`,
      }, templates.restrictedAccountHandover());
    }

    // Customer-safe summary: never read emails, contacts, or notes aloud.
    return this.reply(input, ctx, base, templates.accountFound(result as never), { answerType: "lookup", confidence: 0.95 });
  }

  // ---------- Tickets ----------

  private async createTicket(
    input: TurnInput,
    ctx: TurnContext,
    decision: Decision,
    refs: { transactionId?: string; payoutId?: string; customerId?: string },
    opts: { summary?: string; skipReferenceAsk?: boolean; category?: string } = {},
  ): Promise<TurnResult> {
    const base = newBase(decision);
    const summarySource = opts.summary ?? input.userMessage;

    // A payment/invoice problem without a reference: ask for it first
    // (Scenario 6) — the customer can say they don't have one.
    if (!refs.transactionId && !refs.payoutId && !opts.skipReferenceAsk &&
      /\b(payment|invoice|transaction|transfer|payout)\b/i.test(input.userMessage)) {
      return this.reply(input, ctx, base, templates.ticketAskReference(), {
        answerType: "clarification",
        confidence: 0.9,
        awaiting: "ticket_reference",
        state: { summary: input.userMessage },
      });
    }

    // Look up any referenced record so the ticket links real data only.
    let transactionId: string | null = null;
    let customerId: string | null = refs.customerId ?? null;
    let note = "";
    if (refs.transactionId) {
      const tx = await this.callTool(input.conversationId, "lookup_transaction", { transaction_id: refs.transactionId });
      base.mcpCalls.push({ tool: "lookup_transaction", result: tx });
      if (tx.found === true) {
        transactionId = String(tx.transaction_id);
        customerId ??= str(tx.customer_id);
        note = ` (linked transaction ${transactionId}, status: ${String(tx.status)})`;
      } else {
        note = ` (referenced transaction ${refs.transactionId} could not be found)`;
      }
    } else if (refs.payoutId) {
      const payout = await this.callTool(input.conversationId, "lookup_payout", { payout_id: refs.payoutId });
      base.mcpCalls.push({ tool: "lookup_payout", result: payout });
      if (payout.found === true) {
        transactionId = str(payout.transaction_id);
        customerId ??= str(payout.customer_id);
        note = ` (linked payout ${String(payout.payout_id)}, status: ${String(payout.status)})`;
      } else {
        note = ` (referenced payout ${refs.payoutId} could not be found)`;
      }
    }
    customerId ??= ctx.state.customerId;
    base.customerId = customerId;

    const category = opts.category ?? (/invoice/i.test(summarySource)
      ? "invoice"
      : /payout/i.test(summarySource)
        ? "payment"
        : /account/i.test(summarySource)
          ? "account"
          : /\b(payment|transaction|transfer|txn|pay-?\d)/i.test(summarySource)
            ? "payment"
            : "other");
    const priority = /\b(failed|urgent|missing|broken|never arrived)\b/i.test(summarySource) ? "high" : "medium";

    const result = await this.callTool(input.conversationId, "create_support_ticket", {
      ...(customerId ? { customer_id: customerId } : {}),
      ...(transactionId ? { transaction_id: transactionId } : {}),
      category,
      priority,
      summary: `${summarySource}${note}`,
      conversation_id: input.conversationId,
    });
    base.mcpCalls.push({ tool: "create_support_ticket", result });

    const ticketId = str(result.ticket_id);
    if (!ticketId) {
      return this.reply(input, ctx, base, templates.toolError("creating your ticket"), {
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Ticket creation failed: ${String(result.error ?? "unknown error")}`,
        awaiting: "follow_up_offer",
      });
    }
    base.ticketId = ticketId;
    return this.reply(input, ctx, base, templates.ticketCreated(), {
      answerType: "ticket",
      confidence: 0.9,
      awaiting: "anything_else",
    });
  }

  // ---------- Escalation ----------

  private async beginEscalation(input: TurnInput, ctx: TurnContext, decision: Decision): Promise<TurnResult> {
    const base = newBase(decision);
    base.customerId = ctx.state.customerId;
    const category = decision.escalationCategory ?? "other";

    // Already handed over in this conversation: never ask again.
    const existing = (await this.store.listEscalations(input.conversationId)).find(
      (e) => e.category === category && e.status === "open" && e.user_email,
    );
    if (existing) {
      base.escalationId = existing.escalation_id;
      return this.reply(input, ctx, base, templates.alreadyEscalated(), {
        answerType: "escalation",
        confidence: 0.9,
        awaiting: "anything_else",
      });
    }

    // Record the pending state through MCP so it is auditable.
    const pendingResult = await this.callTool(input.conversationId, "log_conversation_event", {
      conversation_id: input.conversationId,
      event_type: "escalation_pending_contact",
      summary: `Escalation required (${category}): ${decision.rationale}`,
      metadata: { category },
    });
    if (pendingResult.logged !== true) {
      return this.reply(input, ctx, base, templates.toolError("starting the escalation"), {
        answerType: "error",
        confidence: 0.3,
        uncertaintyNote: `Pending-escalation event not logged: ${String(pendingResult.error ?? "unknown error")}`,
      });
    }

    return this.reply(input, ctx, base, templates.escalationContactRequest(decision.escalationTrigger), {
      answerType: "escalation",
      confidence: 0.9,
      uncertaintyNote: "Waiting for customer contact details to create the escalation record",
      awaiting: "contact",
      state: { category, reason: `Escalation required (${category}): ${decision.rationale}` },
    });
  }

  private closeConversationTurn(input: TurnInput, ctx: TurnContext, rationale: string, reply: Reply): Promise<TurnResult> {
    const decision: Decision = { action: "answer", intent: "knowledge", rationale };
    return this.reply(input, ctx, newBase(decision), reply, { answerType: "closing", confidence: 0.95 });
  }

  // ======================================================================
  // Phrasing and persistence
  // ======================================================================

  /** Phrases the reply (Claude or deterministic) and finishes the turn. */
  private async reply(
    input: TurnInput,
    ctx: TurnContext,
    base: TurnBase,
    reply: Reply,
    outcome: Omit<TurnOutcome, "response" | "uncertaintyNote"> & { uncertaintyNote?: string | null },
    knowledge: GroundedKnowledge | null = null,
  ): Promise<TurnResult> {
    const response = await this.phrase(input, ctx, base, knowledge, reply);
    return this.finishTurn(input, ctx, base, {
      ...outcome,
      response,
      uncertaintyNote: outcome.uncertaintyNote ?? null,
    });
  }

  private async phrase(
    input: TurnInput,
    ctx: TurnContext,
    base: TurnBase,
    knowledge: GroundedKnowledge | null,
    reply: Reply,
  ): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) return render(reply);
    if (Date.now() < claudeBreaker.openUntil) {
      base.claudeNote = "skipped: cooling down after repeated model failures";
      return render(reply);
    }
    const started = Date.now();
    const failed = (note: string, countsAsFailure: boolean) => {
      base.claudeNote = note;
      base.phraseMs = Date.now() - started;
      if (countsAsFailure) {
        claudeBreaker.consecutiveFailures += 1;
        if (claudeBreaker.consecutiveFailures >= BREAKER_THRESHOLD) {
          claudeBreaker.openUntil = Date.now() + breakerCooldownMs();
          claudeBreaker.consecutiveFailures = 0;
          process.stderr.write(`[orchestrator] claude failing repeatedly — skipping it for ${breakerCooldownMs()}ms\n`);
        }
      }
      process.stderr.write(`[orchestrator] claude phrasing unusable (${note}); using deterministic response\n`);
      return render(reply);
    };
    try {
      const turnPrompt = buildTurnPrompt({
        userMessage: input.userMessage,
        action: base.decision.action,
        rationale: base.decision.rationale,
        draft: reply.lead,
        closing: reply.closing,
        knowledge: knowledge ? { context: knowledge.context, found: knowledge.found } : undefined,
        toolResults: base.mcpCalls,
        recentTurns: ctx.previousTurns.slice(-3).flatMap((t) => [
          { role: "user" as const, text: t.user_transcript },
          { role: "assistant" as const, text: t.assistant_response },
        ]),
      });
      const run = await runClaudeAgent({
        conversationId: input.conversationId,
        turnPrompt,
        timeoutMs: input.channel === "voice" ? Math.min(claudeVoiceTimeoutMs(), claudeTimeoutMs()) : claudeTimeoutMs(),
      });
      if (run.isError) return failed(run.errorMessage ?? "model error", true);
      const lead = acceptClaudeLead(run.text, reply);
      // A rewrite rejected for dropping a fact is a content problem, not
      // an availability problem: it does not trip the breaker.
      if (!lead) return failed(run.text.trim() ? "rewrite rejected (changed or dropped a fact)" : "empty output", !run.text.trim());
      claudeBreaker.consecutiveFailures = 0;
      base.responder = "claude";
      base.phraseMs = Date.now() - started;
      return render({ lead, closing: reply.closing });
    } catch (error) {
      return failed(`runner threw: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private async finishTurn(input: TurnInput, ctx: TurnContext, base: TurnBase, outcome: TurnOutcome): Promise<TurnResult> {
    const awaiting = outcome.awaiting ?? null;
    await this.store.addTurn({
      conversation_id: input.conversationId,
      user_transcript: input.rawTranscript ?? input.userMessage,
      assistant_response: outcome.response,
      answer_type: outcome.answerType,
      confidence: outcome.confidence,
      uncertainty_note: outcome.uncertaintyNote,
    });

    const turnToolCalls = async () =>
      (await this.store.listToolCalls(input.conversationId).catch(() => []))
        .filter((c) => c.created_at >= ctx.turnStartedAt)
        .map((c) => ({
          tool_name: c.tool_name,
          // log_conversation_event rows say WHICH event they logged.
          event_type: c.input_summary.match(/event_type=([\w-]+)/)?.[1] ?? null,
          status: c.status,
          input_summary: c.input_summary,
          result_summary: c.result_summary,
          error_message: c.error_message,
        }));
    const retrievalActivity = base.retrieval
      ? { query: base.retrieval.query, chunks: base.retrieval.chunks.map((c) => c.id), sourceTitle: base.retrieval.sourceTitle }
      : null;

    // Decision audit through MCP (logging flows through the MCP server).
    // Its metadata carries the conversation state for the next turn and
    // the audit rows this turn wrote (for the activity view).
    const businessCalls = await turnToolCalls();
    try {
      await this.callTool(input.conversationId, "log_conversation_event", {
        conversation_id: input.conversationId,
        event_type: "decision",
        summary: `${base.decision.action}/${base.decision.intent}: ${base.decision.rationale}`,
        metadata: {
          answer_type: outcome.answerType,
          confidence: outcome.confidence,
          ticket_id: base.ticketId,
          escalation_id: base.escalationId,
          customer_id: base.customerId,
          identified_customer_id: base.identifiedCustomerId ?? null,
          responder: base.responder,
          claude_note: base.claudeNote ?? null,
          timings_ms: { phrase: base.phraseMs ?? null, turn: Date.now() - Date.parse(ctx.turnStartedAt) },
          awaiting,
          state: outcome.state ?? {},
          turn_number: ctx.previousTurns.length + 1,
          activity: {
            tool_calls: businessCalls.map((c) => ({ tool_name: c.tool_name, event_type: c.event_type, status: c.status, result_summary: c.result_summary })),
            retrieval: retrievalActivity
              ? { knowledge_chunks: retrievalActivity.chunks, source_title: retrievalActivity.sourceTitle }
              : null,
          },
        },
      });
    } catch (error) {
      process.stderr.write(
        `[orchestrator] decision event log failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    // What the audit trail recorded for this turn (including the decision
    // log just written) — the UI shows exactly these rows, so it can never
    // claim more (or less) than happened.
    const toolCalls = await turnToolCalls();

    // Voice responses are formatted for speech: the source citation is
    // audit metadata (kept in the transcript and on the text channel),
    // amounts are read as words and references drop the hyphen.
    let response = outcome.response;
    if (input.channel === "voice") {
      const citation = response.indexOf(templates.CITATION_PREFIX);
      if (citation >= 0) response = response.slice(0, citation);
      // Example formats ("TXN-1234") are not real references: say the shape.
      response = response
        .replace(/\bTXN-1234\b/g, "T X N followed by the number")
        .replace(/\bPAY-1234\b/g, "P A Y followed by the number");
      response = forSpeech(response.replace(/\s+/g, " ").trim());
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
      responder: base.responder,
      awaiting,
      activity: {
        toolCalls,
        retrieval: retrievalActivity,
      },
    };
  }

  async endConversation(conversationId: string): Promise<{ final_status: string }> {
    const [turns, events] = await Promise.all([
      this.store.listTurns(conversationId),
      this.store.listConversationEvents(conversationId),
    ]);
    const escalated = events.some((e) => e.event_type === "escalation_created");
    const summary =
      turns.length === 0
        ? "Conversation ended without completed turns"
        : `${turns.length} turn(s). Last topic: ${turns[turns.length - 1]!.user_transcript.slice(0, 120)}`;
    try {
      await this.store.completeConversation(conversationId, escalated ? "escalated" : "completed", summary);
    } finally {
      // The conversation is over: free its MCP subprocess.
      await this.releaseClient(conversationId);
    }
    return { final_status: escalated ? "escalated" : "completed" };
  }
}

// ==========================================================================
// Conversation state
// ==========================================================================

const LEGACY_AWAITING: Array<[RegExp, Awaiting]> = [
  [/could i take your name and email|what email address should|what name should i put/i, "contact"],
  [/would you also like to book a callback|what day and time/i, "callback_time"],
  [/do you have the transaction reference/i, "ticket_reference"],
  [/outgoing payout, an incoming transfer|say the full reference again|what's the reference\?/i, "payment_clarify"],
  [/would you like me to arrange for our support team to follow up|i can arrange for the support team to follow up/i, "follow_up_offer"],
  [/i can file a ticket so the team can investigate/i, "ticket_offer"],
  [/anything else/i, "anything_else"],
];

/**
 * Reads what the previous turn was waiting for. The source of truth is
 * the decision event of that turn (structured metadata). If that event
 * was lost, the canonical wording of the previous reply is the fallback.
 */
function readState(
  events: TurnContext["events"],
  previousTurns: TurnContext["previousTurns"],
): ConversationState {
  const decisions = events.filter((e) => e.event_type === "decision");
  const last = decisions[decisions.length - 1];
  let customerId: string | null = null;
  let ticketId: string | null = null;
  for (const event of decisions) {
    customerId = str(event.metadata.identified_customer_id) ?? customerId;
    ticketId = str(event.metadata.ticket_id) ?? ticketId;
  }

  if (last && last.metadata.turn_number === previousTurns.length && "awaiting" in last.metadata) {
    const data = last.metadata.state;
    return {
      awaiting: (last.metadata.awaiting as Awaiting) ?? null,
      data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {},
      customerId,
      ticketId,
    };
  }

  const lastAssistant = previousTurns[previousTurns.length - 1]?.assistant_response ?? "";
  const legacy = LEGACY_AWAITING.find(([pattern]) => pattern.test(lastAssistant));
  return { awaiting: legacy?.[1] ?? null, data: {}, customerId, ticketId };
}

function lastPendingEvent(ctx: TurnContext) {
  const pending = ctx.events.filter((e) => e.event_type === "escalation_pending_contact");
  return pending[pending.length - 1];
}

function escalationCategoryFrom(ctx: TurnContext): EscalationCategory {
  const fromState = str(ctx.state.data.category);
  const fromEvent = lastPendingEvent(ctx)?.metadata.category;
  const category = fromState ?? (typeof fromEvent === "string" ? fromEvent : null);
  return (["compliance", "account", "dispute", "payment", "other"].includes(category ?? "") ? category : "other") as EscalationCategory;
}

/** The most recent reference of each kind mentioned in earlier user turns. */
function latestReferences(userTurns: string[]): { transactionId?: string; payoutId?: string; customerId?: string } {
  const out: { transactionId?: string; payoutId?: string; customerId?: string } = {};
  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const refs = extractReferences(normalizeVoiceReferences(userTurns[i]!));
    out.transactionId ??= refs.transactionId;
    out.payoutId ??= refs.payoutId;
    out.customerId ??= refs.customerId;
  }
  return out;
}

// ==========================================================================
// Language helpers
// ==========================================================================

const FAREWELL_PATTERN =
  /\b(no,? (thank you|thanks)|no thanks?|no goodbye|goodbye|bye( bye)?|that('s| is) all|that will be all|nothing else)\b/i;
const AFFIRMATIVE_PATTERN =
  /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|please|of course|correct|right|affirmative|go ahead|sounds good)\b/i;
// A lone "Thank you." / "Thanks." is a closing pleasantry, not a request.
const BARE_THANKS_PATTERN = /^\s*(thank you|thanks)( so much| very much)?\s*[.!]?\s*$/i;
const BARE_NEGATIVE = /^\s*(no|nope|nah|no,? it'?s fine|not really|not now)\s*[.!]?\s*$/i;
const CANCEL_PATTERN = /\b(never ?mind|forget (it|that|about it)|cancel (that|it|the request)|don'?t (bother|escalate)|i changed my mind|not anymore)\b/i;
const NO_REFERENCE_PATTERN = /\b(don'?t|do not|didn'?t) (have|know|remember)\b|\bno (reference|ref|idea)\b|\bnot sure\b/i;
const NO_CALLBACK_PATTERN = /\b(email is fine|no (callback|call|need)|not needed|that'?s fine|email only|no thanks)\b/i;
const QUESTION_START = /^\s*(what|how|why|when|where|which|who|can|could|do|does|is|are|will|would|should|tell me|check|show)\b/i;

/** True when a message reads as a new question/request rather than an answer. */
function looksLikeNewRequest(message: string): boolean {
  if (/\?\s*$/.test(message)) return true;
  const refs = extractReferences(message);
  if (refs.transactionId || refs.payoutId || refs.customerId) return true;
  if (QUESTION_START.test(message)) return true;
  const intent = classifyIntent(message);
  return intent !== "knowledge" && intent !== "greeting" && intent !== "general_help";
}

/** "Which currencies…?" should not be answered starting with "Yes." */
function dropYesNoForOpenQuestion(answer: string, question: string): string {
  if (!/^\s*(what|which|how|when|where|why|who)\b/i.test(question)) return answer;
  return answer.replace(/^(yes|no)\.\s+/i, "");
}

/**
 * Accepts Claude's rewording only if it keeps every reference, number and
 * status word of the draft, and adds no question of its own (the required
 * question is appended separately). Otherwise the deterministic lead is
 * used — a model rewrite can never drop or change a fact.
 */
export function acceptClaudeLead(text: string, reply: Reply): string {
  let lead = text.replace(/\s+/g, " ").trim();
  if (!lead) return "";
  if (reply.closing && lead.includes(reply.closing)) lead = lead.replace(reply.closing, "").trim();
  // Drop any question/offer sentence the model appended.
  const sentences = lead.split(/(?<=[.!?])\s+/);
  while (sentences.length > 1 && /\?$/.test(sentences[sentences.length - 1]!)) sentences.pop();
  if (sentences.length === 1 && /\?$/.test(sentences[0]!)) return "";
  lead = sentences.join(" ");

  const normalize = (s: string) => s.toLowerCase().replace(/(\d),(\d)/g, "$1$2");
  const haystack = normalize(lead);
  const facts = [
    ...(reply.lead.match(/\b[A-Z]{3}-\d+\b/g) ?? []),
    ...(reply.lead.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, "")),
    ...(reply.lead.match(/\b(processing|completed|delayed|failed|review required|restricted|active|pending)\b/gi) ?? []),
  ];
  for (const fact of facts) {
    if (!haystack.includes(normalize(fact))) return "";
  }
  return lead;
}

// ---------- Contact details ----------

const LITERAL_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const EMAIL_TLDS = "com|net|org|io|co|ai|dev|us|uk|ca|me|ng|ke|gh|za|tv|example";
// "salman at relaypay dot com" — the final group must be a TLD so
// "tomorrow at nine dot thirty" (callback times) never matches.
const SPOKEN_AT_EMAIL = new RegExp(
  `\\b([a-z0-9][\\w.-]*)\\s+at\\s+([a-z][\\w-]*)\\s+(?:dot|\\.)\\s*(${EMAIL_TLDS})\\b`,
  "i",
);
// "salmanx550gmail dot com" / "salmanx550 gmail dot com".
const SPOKEN_PROVIDER_EMAIL = new RegExp(
  `\\b([a-z0-9][\\w.-]*?)\\s*(gmail|googlemail|hotmail|yahoo|outlook|icloud|protonmail)\\s+(?:dot|\\.)\\s*(${EMAIL_TLDS})\\b`,
  "i",
);
// "jdoe acmecorp dot com" — generic two-word address with a TLD ending.
const SPOKEN_GENERIC_EMAIL = new RegExp(
  `\\b([a-z0-9][\\w.-]{2,})\\s+([a-z][\\w-]{2,})\\s+(?:dot|\\.)\\s*(${EMAIL_TLDS})\\b`,
  "i",
);
const VALID_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const EMAIL_ATTEMPT = /@|\b(e-?mail|dot com|gmail|yahoo|hotmail|outlook|icloud)\b/i;

/**
 * Reads an email out of a message, whether typed ("sal@x.com") or spoken
 * ("sal at x dot com", "salmanx550gmail dot com" — STT drops the @).
 */
function extractSpokenEmail(message: string): { email: string; source: string } | null {
  const literal = message.match(LITERAL_EMAIL);
  if (literal) return { email: literal[0].toLowerCase().replace(/[.]+$/, ""), source: literal[0] };
  for (const pattern of [SPOKEN_AT_EMAIL, SPOKEN_PROVIDER_EMAIL, SPOKEN_GENERIC_EMAIL]) {
    const match = message.match(pattern);
    if (match) {
      return { email: `${match[1]}@${match[2]}.${match[3]}`.toLowerCase(), source: match[0] };
    }
  }
  return null;
}

const NON_NAME_WORDS = new Set([
  "check", "checking", "transaction", "payout", "payment", "account", "email", "mail", "e-mail", "callback", "call",
  "back", "today", "tonight", "tomorrow", "morning", "afternoon", "evening", "noon", "please", "thanks", "thank",
  "yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "think", "mean", "want", "need", "hello", "hi", "hey",
  "restricted", "help", "gmail", "yahoo", "hotmail", "outlook", "icloud", "dot", "com", "net", "org", "sorry",
  "name", "txn", "pay", "reference", "number", "fine", "good", "great", "actually", "never", "mind", "cancel",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "next", "week", "pm", "am",
  "script", "alert", "null", "undefined", "test", "relaypay", "support", "specialist", "invoice", "transfer",
  "time", "works", "best", "reach", "contact", "here", "calling", "speaking", "again", "said", "sir", "madam",
]);

function isNameWord(word: string): boolean {
  const lower = word.toLowerCase();
  return /^[a-z][a-z'’-]{0,29}$/i.test(word) && !NON_NAME_WORDS.has(lower) && !stopwords.has(lower);
}

function titleCase(word: string): string {
  return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/**
 * Extracts a person's name: after an explicit cue ("my name is…",
 * "this is…", "I'm…"), or — for short replies — the leading run of
 * name-like words. Anything that isn't plausibly a name (questions,
 * markup, filler like "I think I mean", references) yields null, so the
 * agent asks for the name instead of storing junk.
 */
function parseName(message: string, emailSource: string | null): string | null {
  // With an email in the message, a name given without a cue comes
  // before it ("Salman, salman@x.com, callback Monday") — never after it.
  let text = message;
  if (emailSource) {
    const at = message.indexOf(emailSource);
    const before = message.slice(0, at);
    const hasCue = /\b(my name is|my name's|name is|name's|this is|i am|i'm|call me|it's)\b/i.test(message);
    text = hasCue || before.trim() === "" ? message.replace(emailSource, " ") : before;
  }
  text = text.replace(TIME_SPAN, " ");
  if (/[<>{}[\]=\\/|]/.test(text)) return null;
  if (message.trim().endsWith("?")) return null;

  const cue = text.match(/\b(?:my name is|my name's|name is|name's|this is|i am|i'm|call me|it's)\s+([a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,2})/i);
  let words: string[];
  if (cue) {
    words = cue[1]!.split(/\s+/);
  } else {
    // No cue: accept only a reply that IS a name ("Efua", "Efua Mensah,
    // efua@…", "Salman here"). Anything sentence-like — e.g. speech-to-text
    // garbling "my name is Salman" into "Please send man and my email
    // is…" — yields null, so the agent asks for the name instead of
    // storing "Send Man".
    const stripped = text
      .replace(/\b(my e-?mail(?: address)? is|e-?mail(?: address)?|callback|call me back)\b.*$/i, " ")
      .replace(/\b(here|speaking)\b/gi, " ")
      .replace(/(^|[\s,;.!:])(and|thanks|thank you)[\s,;.!:]*$/i, " ");
    const tokens = stripped.split(/[\s,;.!:]+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 3 || !tokens.every(isNameWord)) return null;
    words = tokens;
  }
  const name: string[] = [];
  for (const word of words) {
    if (!isNameWord(word)) break;
    name.push(titleCase(word));
    if (name.length === 3) break;
  }
  return name.length > 0 ? name.join(" ") : null;
}

interface ParsedContact {
  name: string | null;
  email: string | null;
  /** The customer tried to give an email, but no valid address could be read. */
  emailAttempted: boolean;
}

function parseContact(message: string): ParsedContact {
  const spoken = extractSpokenEmail(message);
  const email = spoken && VALID_EMAIL.test(spoken.email) ? spoken.email : null;
  return {
    name: parseName(message, spoken?.source ?? null),
    email,
    emailAttempted: !email && EMAIL_ATTEMPT.test(message) && !/\?\s*$/.test(message),
  };
}

// ---------- Callback times ----------

const NUMBER_WORD_HOURS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const TIME_TOKEN = new RegExp(
  [
    "\\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|the weekend)\\b",
    "\\b(?:morning|afternoon|evening|noon|midday|lunchtime)\\b",
    "\\b(?:at|around|after|before|by)\\s+\\d{1,2}(?::\\d{2})?(?:\\s?(?:am|pm|a\\.m\\.|p\\.m\\.))?(?!\\d)",
    "\\b\\d{1,2}(?::\\d{2})?\\s?(?:am|pm|a\\.m\\.|p\\.m\\.)",
    "\\b\\d{1,2}:\\d{2}\\b",
    `\\b(?:${NUMBER_WORD_HOURS})\\s?(?:am|pm|o'?clock)\\b`,
  ].join("|"),
  "gi",
);
const TIME_SPAN = new RegExp(TIME_TOKEN.source, "gi");

/**
 * Finds a preferred callback time ("tomorrow afternoon", "Monday at
 * 10am") and validates any clock value: "25pm" or "13:75" is not a time.
 */
export function extractPreferredTime(message: string): { value: string; valid: boolean } | null {
  const matches = [...message.matchAll(new RegExp(TIME_TOKEN.source, "gi"))];
  if (matches.length === 0) return null;
  const start = matches[0]!.index!;
  const last = matches[matches.length - 1]!;
  let value = message.slice(start, last.index! + last[0].length).replace(/\s+/g, " ").trim();
  if (value.length > 40) value = matches[0]![0];
  // Read naturally mid-sentence: "noted tomorrow afternoon", but keep
  // weekday names capitalised ("Monday at 10am").
  if (!/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(value)) {
    value = value.charAt(0).toLowerCase() + value.slice(1);
  }

  let valid = true;
  for (const match of matches) {
    const clock = match[0].match(/(\d{1,2})(?::(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?/i);
    if (!clock) continue;
    const hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = Boolean(clock[3]);
    if (minute > 59) valid = false;
    if (meridiem ? hour < 1 || hour > 12 : hour > 23) valid = false;
  }
  return { value, valid };
}
