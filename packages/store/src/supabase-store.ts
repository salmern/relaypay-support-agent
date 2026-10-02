/**
 * Supabase-backed store. Used in production and for live demos.
 * All access happens with the service role key from the server side
 * only; no Supabase credentials ever reach the browser.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "./store.js";
import type {
  Conversation,
  ConversationTurn,
  Customer,
  Escalation,
  EvaluationRecord,
  KnowledgeChunk,
  Payout,
  RetrievalLog,
  SupportTicket,
  ToolCallLog,
  Transaction,
} from "./types.js";

export interface SupabaseStoreOptions {
  url: string;
  serviceRoleKey: string;
}

export class SupabaseStore implements Store {
  private readonly client: SupabaseClient;

  constructor(options: SupabaseStoreOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async getCustomer(input: { customer_id?: string; email?: string; company_name?: string }): Promise<Customer | null> {
    let query = this.client.from("customers").select("*");
    if (input.customer_id) query = query.eq("customer_id", input.customer_id.trim().toUpperCase());
    else if (input.email) query = query.eq("contact_email", input.email.trim().toLowerCase());
    // ilike gives a case-insensitive EXACT match only when the LIKE
    // wildcards in user input are escaped ("%" would match every row).
    else if (input.company_name) query = query.ilike("company_name", escapeLike(input.company_name.trim()));
    else return null;
    const { data, error } = await query.limit(1);
    if (error) throw new Error(`Supabase customer lookup failed: ${error.message}`);
    const row = (data ?? [])[0] as Customer | undefined;
    return row ?? null;
  }

  async getTransaction(transaction_id: string): Promise<Transaction | null> {
    const { data, error } = await this.client
      .from("transactions")
      .select("*")
      .eq("transaction_id", transaction_id.trim().toUpperCase())
      .limit(1);
    if (error) throw new Error(`Supabase transaction lookup failed: ${error.message}`);
    const row = (data ?? [])[0] as Transaction | undefined;
    return row ?? null;
  }

  async getPayout(query: { payout_id?: string; transaction_id?: string }): Promise<Payout | null> {
    let q = this.client.from("payouts").select("*");
    if (query.payout_id) q = q.eq("payout_id", query.payout_id.trim().toUpperCase());
    else if (query.transaction_id) q = q.eq("transaction_id", query.transaction_id.trim().toUpperCase());
    else return null;
    const { data, error } = await q.limit(1);
    if (error) throw new Error(`Supabase payout lookup failed: ${error.message}`);
    const row = (data ?? [])[0] as Payout | undefined;
    return row ?? null;
  }

  async createConversation(input: { conversation_id: string; channel: "voice" | "text"; caller_identifier?: string | null }): Promise<Conversation> {
    // Insert-if-missing. This runs on EVERY turn, so it must never touch
    // an existing row: an upsert here used to reset started_at and wipe
    // caller_identifier on each turn.
    const existing = await this.getConversation(input.conversation_id);
    if (existing) return existing;
    const row = {
      id: input.conversation_id,
      channel: input.channel,
      caller_identifier: input.caller_identifier ?? null,
      started_at: new Date().toISOString(),
      final_status: "active",
    };
    const { data, error } = await this.client.from("conversations").insert(row).select().single();
    if (error) {
      // Unique violation: a concurrent turn created it first.
      if (error.code === "23505") {
        const raced = await this.getConversation(input.conversation_id);
        if (raced) return raced;
      }
      throw new Error(`Supabase createConversation failed: ${error.message}`);
    }
    return data as Conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { data, error } = await this.client.from("conversations").select("*").eq("id", id).limit(1);
    if (error) throw new Error(`Supabase getConversation failed: ${error.message}`);
    const row = (data ?? [])[0] as Conversation | undefined;
    return row ?? null;
  }

  async completeConversation(id: string, final_status: Conversation["final_status"], summary: string | null): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({ ended_at: new Date().toISOString(), final_status, summary })
      .eq("id", id);
    if (error) throw new Error(`Supabase completeConversation failed: ${error.message}`);
  }

  async addTurn(turn: Omit<ConversationTurn, "created_at">): Promise<ConversationTurn> {
    const row = { ...turn, created_at: new Date().toISOString() };
    let { data, error } = await this.client.from("conversation_turns").insert(row).select().single();
    if (error && error.code === "23514" && turn.answer_type === "closing") {
      // Schema without migration 002 rejects the 'closing' answer type.
      // Keep the turn (the audit trail matters more than the label) and
      // say so in the uncertainty note instead of failing the whole turn.
      process.stderr.write("[store] answer_type 'closing' rejected — apply supabase/migrations/002_audit_fixes.sql\n");
      ({ data, error } = await this.client
        .from("conversation_turns")
        .insert({ ...row, answer_type: "clarification", uncertainty_note: "closing turn (schema pending migration 002)" })
        .select()
        .single());
    }
    if (error) throw new Error(`Supabase addTurn failed: ${error.message}`);
    return data as ConversationTurn;
  }

  async listTurns(conversation_id: string): Promise<ConversationTurn[]> {
    const { data, error } = await this.client
      .from("conversation_turns")
      .select("*")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Supabase listTurns failed: ${error.message}`);
    return (data ?? []) as ConversationTurn[];
  }

  async addRetrievalLog(log: Omit<RetrievalLog, "created_at">): Promise<RetrievalLog> {
    const row = { ...log, created_at: new Date().toISOString() };
    const { data, error } = await this.client.from("retrieval_logs").insert(row).select().single();
    if (error) throw new Error(`Supabase addRetrievalLog failed: ${error.message}`);
    return data as RetrievalLog;
  }

  async addToolCallLog(log: Omit<ToolCallLog, "created_at">): Promise<ToolCallLog> {
    const row = { ...log, created_at: new Date().toISOString() };
    const { data, error } = await this.client.from("tool_calls").insert(row).select().single();
    if (error) throw new Error(`Supabase addToolCallLog failed: ${error.message}`);
    return data as ToolCallLog;
  }

  async addConversationEvent(event: { conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown> }): Promise<{ logged: true }> {
    const { error } = await this.client.from("conversation_events").insert(event);
    if (error) throw new Error(`Supabase addConversationEvent failed: ${error.message}`);
    return { logged: true };
  }

  async createTicket(ticket: Omit<SupportTicket, "ticket_id" | "created_at" | "status"> & { status?: SupportTicket["status"] }): Promise<SupportTicket> {
    const ticket_id = `TCK-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const row = {
      ...ticket,
      status: ticket.status ?? "open",
      ticket_id,
      created_at: new Date().toISOString(),
    };
    const { data, error } = await this.client.from("support_tickets").insert(row).select().single();
    if (error) throw new Error(`Supabase createTicket failed: ${error.message}`);
    return data as SupportTicket;
  }

  async getTicket(ticket_id: string): Promise<SupportTicket | null> {
    const { data, error } = await this.client.from("support_tickets").select("*").eq("ticket_id", ticket_id).limit(1);
    if (error) throw new Error(`Supabase getTicket failed: ${error.message}`);
    const row = (data ?? [])[0] as SupportTicket | undefined;
    return row ?? null;
  }

  async createEscalation(escalation: Omit<Escalation, "escalation_id" | "created_at" | "status"> & { status?: Escalation["status"] }): Promise<Escalation> {
    const escalation_id = `ESC-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const row = {
      ...escalation,
      status: escalation.status ?? "open",
      escalation_id,
      created_at: new Date().toISOString(),
    };
    const { data, error } = await this.client.from("escalations").insert(row).select().single();
    if (error) throw new Error(`Supabase createEscalation failed: ${error.message}`);
    return data as Escalation;
  }

  async updateEscalationContact(
    escalation_id: string,
    contact: { user_name?: string | null; user_email?: string | null; preferred_time?: string | null; customer_id?: string | null; ticket_id?: string | null },
  ): Promise<Escalation | null> {
    const patch: Record<string, string | null | boolean> = {};
    if (contact.user_name !== undefined && contact.user_name !== null) patch.user_name = contact.user_name;
    if (contact.user_email !== undefined && contact.user_email !== null) patch.user_email = contact.user_email;
    if (contact.preferred_time !== undefined && contact.preferred_time !== null) {
      patch.preferred_time = contact.preferred_time;
      patch.call_booked = true;
    }
    if (contact.customer_id) patch.customer_id = contact.customer_id;
    if (contact.ticket_id) patch.ticket_id = contact.ticket_id;
    if (Object.keys(patch).length === 0) return this.getEscalation(escalation_id);
    const { data, error } = await this.client
      .from("escalations")
      .update(patch)
      .eq("escalation_id", escalation_id)
      .select()
      .single();
    if (error) throw new Error(`Supabase updateEscalationContact failed: ${error.message}`);
    return (data as Escalation | null) ?? null;
  }

  async getEscalation(escalation_id: string): Promise<Escalation | null> {
    const { data, error } = await this.client
      .from("escalations")
      .select("*")
      .eq("escalation_id", escalation_id)
      .limit(1);
    if (error) throw new Error(`Supabase getEscalation failed: ${error.message}`);
    const row = (data ?? [])[0] as Escalation | undefined;
    return row ?? null;
  }

  async addEvaluation(record: Omit<EvaluationRecord, "created_at">): Promise<EvaluationRecord> {
    const row = { ...record, created_at: new Date().toISOString() };
    let { data, error } = await this.client.from("evaluations").insert(row).select().single();
    if (error && /run_id/.test(error.message)) {
      // Schema without migration 002 has no run_id column: keep the
      // record and fold the run id into the notes instead.
      const { run_id, ...rest } = row;
      ({ data, error } = await this.client
        .from("evaluations")
        .insert({ ...rest, notes: `[run ${run_id ?? "?"}] ${rest.notes}` })
        .select()
        .single());
    }
    if (error) throw new Error(`Supabase addEvaluation failed: ${error.message}`);
    return data as EvaluationRecord;
  }

  async listEvaluations(): Promise<EvaluationRecord[]> {
    const { data, error } = await this.client.from("evaluations").select("*").order("created_at", { ascending: false });
    if (error) throw new Error(`Supabase listEvaluations failed: ${error.message}`);
    return (data ?? []) as EvaluationRecord[];
  }

  async listConversations(): Promise<Conversation[]> {
    const { data, error } = await this.client.from("conversations").select("*").order("started_at", { ascending: false });
    if (error) throw new Error(`Supabase listConversations failed: ${error.message}`);
    return (data ?? []) as Conversation[];
  }

  async listToolCalls(conversationId?: string): Promise<ToolCallLog[]> {
    let query = this.client.from("tool_calls").select("*").order("created_at", { ascending: true });
    if (conversationId) query = query.eq("conversation_id", conversationId);
    const { data, error } = await query;
    if (error) throw new Error(`Supabase listToolCalls failed: ${error.message}`);
    return (data ?? []) as ToolCallLog[];
  }

  async listRetrievalLogs(conversationId?: string): Promise<RetrievalLog[]> {
    let query = this.client.from("retrieval_logs").select("*").order("created_at", { ascending: true });
    if (conversationId) query = query.eq("conversation_id", conversationId);
    const { data, error } = await query;
    if (error) throw new Error(`Supabase listRetrievalLogs failed: ${error.message}`);
    return (data ?? []) as RetrievalLog[];
  }

  async listTickets(conversationId?: string): Promise<SupportTicket[]> {
    let query = this.client.from("support_tickets").select("*").order("created_at", { ascending: true });
    if (conversationId) query = query.eq("conversation_id", conversationId);
    const { data, error } = await query;
    if (error) throw new Error(`Supabase listTickets failed: ${error.message}`);
    return (data ?? []) as SupportTicket[];
  }

  async listEscalations(conversationId?: string): Promise<Escalation[]> {
    let query = this.client.from("escalations").select("*").order("created_at", { ascending: true });
    if (conversationId) query = query.eq("conversation_id", conversationId);
    const { data, error } = await query;
    if (error) throw new Error(`Supabase listEscalations failed: ${error.message}`);
    return (data ?? []) as Escalation[];
  }

  async listConversationEvents(conversationId: string): Promise<Array<{ conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown>; created_at: string }>> {
    const { data, error } = await this.client
      .from("conversation_events")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Supabase listConversationEvents failed: ${error.message}`);
    return (data ?? []) as Array<{ conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown>; created_at: string }>;
  }

  async listKnowledgeChunks(): Promise<KnowledgeChunk[]> {
    const { data, error } = await this.client.from("kb_chunks").select("*").order("id", { ascending: true });
    if (error) throw new Error(`Supabase listKnowledgeChunks failed: ${error.message}`);
    return (data ?? []) as KnowledgeChunk[];
  }

  async seedIfEmpty(seed: {
    customers: Customer[];
    transactions: Transaction[];
    payouts: Payout[];
    knowledgeChunks?: KnowledgeChunk[];
  }): Promise<{ seeded: boolean }> {
    // Idempotent: upsert by the stable primary keys. Reruns update in place
    // instead of duplicating.
    const upsertInto = async (table: string, rows: unknown[]) => {
      const { error } = await this.client.from(table).upsert(rows);
      if (error) throw new Error(`Supabase seed ${table} failed: ${error.message}`);
    };
    await upsertInto("customers", seed.customers);
    await upsertInto("transactions", seed.transactions);
    await upsertInto("payouts", seed.payouts);
    if (seed.knowledgeChunks && seed.knowledgeChunks.length > 0) {
      await upsertInto("kb_chunks", seed.knowledgeChunks);
    }
    return { seeded: true };
  }
}

/** Escapes LIKE/ILIKE wildcards so user input matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
