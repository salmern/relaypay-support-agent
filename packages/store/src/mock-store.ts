/**
 * Deterministic file-backed store used for automated tests, the
 * evaluation harness, and credential-free local runs. Implements the
 * exact same Store interface as SupabaseStore.
 *
 * IMPORTANT: every operation re-reads the file and writes it back, so
 * multiple processes sharing the same MOCK_STORE_PATH (the API server
 * and its spawned MCP server subprocesses) see each other's writes.
 * This is intentionally simple; SupabaseStore is the concurrency-safe
 * production provider.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

export interface ConversationEventRecord {
  conversation_id: string;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface MockData {
  customers: Customer[];
  transactions: Transaction[];
  payouts: Payout[];
  conversations: Conversation[];
  turns: ConversationTurn[];
  retrieval_logs: RetrievalLog[];
  tool_calls: ToolCallLog[];
  conversation_events: ConversationEventRecord[];
  tickets: SupportTicket[];
  escalations: Escalation[];
  evaluations: EvaluationRecord[];
  kb_chunks: KnowledgeChunk[];
}

function emptyData(): MockData {
  return {
    customers: [],
    transactions: [],
    payouts: [],
    conversations: [],
    turns: [],
    retrieval_logs: [],
    tool_calls: [],
    conversation_events: [],
    tickets: [],
    escalations: [],
    evaluations: [],
    kb_chunks: [],
  };
}

export interface MockFileStoreOptions {
  filePath: string;
  seed?: {
    customers: Customer[];
    transactions: Transaction[];
    payouts: Payout[];
    knowledgeChunks?: KnowledgeChunk[];
  };
  /** Convenience alias for seed.knowledgeChunks. */
  knowledgeChunks?: KnowledgeChunk[];
}

export class MockFileStore implements Store {
  private readonly filePath: string;

  constructor(options: MockFileStoreOptions) {
    this.filePath = options.filePath;
    if (!existsSync(this.filePath)) {
      const data = emptyData();
      if (options.seed) {
        data.customers = options.seed.customers;
        data.transactions = options.seed.transactions;
        data.payouts = options.seed.payouts;
        data.kb_chunks = options.seed.knowledgeChunks ?? [];
      }
      if (options.knowledgeChunks) {
        data.kb_chunks = options.knowledgeChunks;
      }
      this.persist(data);
    }
  }

  /** Re-read from disk so cross-process writes are visible. */
  private load(): MockData {
    if (!existsSync(this.filePath)) return emptyData();
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<MockData>;
    return { ...emptyData(), ...parsed };
  }

  private persist(data: MockData): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private mutate(fn: (data: MockData) => void): void {
    const data = this.load();
    fn(data);
    this.persist(data);
  }

  private id(prefix: string): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  // ---------- Seed lookups ----------

  async getCustomer(input: { customer_id?: string; email?: string; company_name?: string }): Promise<Customer | null> {
    const norm = (s: string) => s.trim().toLowerCase();
    const { customers } = this.load();
    const customer = customers.find((c) => {
      if (input.customer_id) return c.customer_id.toLowerCase() === norm(input.customer_id);
      if (input.email) return c.contact_email.toLowerCase() === norm(input.email);
      if (input.company_name) return c.company_name.toLowerCase() === norm(input.company_name);
      return false;
    });
    return customer ?? null;
  }

  async getTransaction(transaction_id: string): Promise<Transaction | null> {
    const id = transaction_id.trim().toLowerCase();
    return this.load().transactions.find((t) => t.transaction_id.toLowerCase() === id) ?? null;
  }

  async getPayout(query: { payout_id?: string; transaction_id?: string }): Promise<Payout | null> {
    const norm = (s: string) => s.trim().toLowerCase();
    return this.load().payouts.find((p) => {
      if (query.payout_id) return p.payout_id.toLowerCase() === norm(query.payout_id);
      if (query.transaction_id) return p.transaction_id.toLowerCase() === norm(query.transaction_id);
      return false;
    }) ?? null;
  }

  // ---------- Conversations ----------

  async createConversation(input: { conversation_id: string; channel: "voice" | "text"; caller_identifier?: string | null }): Promise<Conversation> {
    const existing = this.load().conversations.find((c) => c.id === input.conversation_id);
    if (existing) return existing;
    const conversation: Conversation = {
      id: input.conversation_id,
      channel: input.channel,
      caller_identifier: input.caller_identifier ?? null,
      started_at: new Date().toISOString(),
      ended_at: null,
      final_status: null,
      summary: null,
    };
    this.mutate((data) => data.conversations.push(conversation));
    return conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.load().conversations.find((c) => c.id === id) ?? null;
  }

  async completeConversation(id: string, final_status: Conversation["final_status"], summary: string | null): Promise<void> {
    this.mutate((data) => {
      const conversation = data.conversations.find((c) => c.id === id);
      if (conversation) {
        conversation.ended_at = new Date().toISOString();
        conversation.final_status = final_status;
        conversation.summary = summary;
      }
    });
  }

  async addTurn(turn: Omit<ConversationTurn, "created_at">): Promise<ConversationTurn> {
    const row: ConversationTurn = { ...turn, created_at: new Date().toISOString() };
    this.mutate((data) => data.turns.push(row));
    return row;
  }

  async listTurns(conversation_id: string): Promise<ConversationTurn[]> {
    return this.load().turns.filter((t) => t.conversation_id === conversation_id);
  }

  // ---------- Logs ----------

  async addRetrievalLog(log: Omit<RetrievalLog, "created_at">): Promise<RetrievalLog> {
    const row: RetrievalLog = { ...log, created_at: new Date().toISOString() };
    this.mutate((data) => data.retrieval_logs.push(row));
    return row;
  }

  async addToolCallLog(log: Omit<ToolCallLog, "created_at">): Promise<ToolCallLog> {
    const row: ToolCallLog = { ...log, created_at: new Date().toISOString() };
    this.mutate((data) => data.tool_calls.push(row));
    return row;
  }

  async addConversationEvent(event: { conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown> }): Promise<{ logged: true }> {
    const row: ConversationEventRecord = { ...event, created_at: new Date().toISOString() };
    this.mutate((data) => data.conversation_events.push(row));
    return { logged: true };
  }

  // ---------- Tickets / escalations / evaluations ----------

  async createTicket(ticket: Omit<SupportTicket, "ticket_id" | "created_at" | "status"> & { status?: SupportTicket["status"] }): Promise<SupportTicket> {
    const row: SupportTicket = {
      ...ticket,
      status: ticket.status ?? "open",
      ticket_id: this.id("TCK"),
      created_at: new Date().toISOString(),
    };
    this.mutate((data) => data.tickets.push(row));
    return row;
  }

  async getTicket(ticket_id: string): Promise<SupportTicket | null> {
    return this.load().tickets.find((t) => t.ticket_id === ticket_id) ?? null;
  }

  async createEscalation(escalation: Omit<Escalation, "escalation_id" | "created_at" | "status"> & { status?: Escalation["status"] }): Promise<Escalation> {
    const row: Escalation = {
      ...escalation,
      status: escalation.status ?? "open",
      escalation_id: this.id("ESC"),
      created_at: new Date().toISOString(),
    };
    this.mutate((data) => data.escalations.push(row));
    return row;
  }

  async updateEscalationContact(
    escalation_id: string,
    contact: { user_name?: string | null; user_email?: string | null; preferred_time?: string | null },
  ): Promise<Escalation | null> {
    let updated: Escalation | null = null;
    this.mutate((data) => {
      const row = data.escalations.find((e) => e.escalation_id === escalation_id);
      if (!row) return;
      if (contact.user_name !== undefined && contact.user_name !== null) row.user_name = contact.user_name;
      if (contact.user_email !== undefined && contact.user_email !== null) row.user_email = contact.user_email;
      if (contact.preferred_time !== undefined && contact.preferred_time !== null) {
        row.preferred_time = contact.preferred_time;
        row.call_booked = true;
      }
      updated = row;
    });
    return updated;
  }

  async getEscalation(escalation_id: string): Promise<Escalation | null> {
    return this.load().escalations.find((e) => e.escalation_id === escalation_id) ?? null;
  }

  async addEvaluation(record: Omit<EvaluationRecord, "created_at">): Promise<EvaluationRecord> {
    const row: EvaluationRecord = { ...record, created_at: new Date().toISOString() };
    this.mutate((data) => data.evaluations.push(row));
    return row;
  }

  async listEvaluations(): Promise<EvaluationRecord[]> {
    return [...this.load().evaluations].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // ---------- Observability listings ----------

  async listConversations(): Promise<Conversation[]> {
    return [...this.load().conversations].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  async listToolCalls(conversationId?: string): Promise<ToolCallLog[]> {
    const calls = conversationId
      ? this.load().tool_calls.filter((c) => c.conversation_id === conversationId)
      : this.load().tool_calls;
    return [...calls].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listRetrievalLogs(conversationId?: string): Promise<RetrievalLog[]> {
    const logs = conversationId
      ? this.load().retrieval_logs.filter((r) => r.conversation_id === conversationId)
      : this.load().retrieval_logs;
    return [...logs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listTickets(conversationId?: string): Promise<SupportTicket[]> {
    const tickets = conversationId
      ? this.load().tickets.filter((t) => t.conversation_id === conversationId)
      : this.load().tickets;
    return [...tickets].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listEscalations(conversationId?: string): Promise<Escalation[]> {
    const escalations = conversationId
      ? this.load().escalations.filter((e) => e.conversation_id === conversationId)
      : this.load().escalations;
    return [...escalations].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listConversationEvents(conversationId: string): Promise<ConversationEventRecord[]> {
    return this.load().conversation_events
      .filter((e) => e.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listKnowledgeChunks(): Promise<KnowledgeChunk[]> {
    return this.load().kb_chunks;
  }

  // ---------- Seed pipeline ----------

  async seedIfEmpty(seed: {
    customers: Customer[];
    transactions: Transaction[];
    payouts: Payout[];
    knowledgeChunks?: KnowledgeChunk[];
  }): Promise<{ seeded: boolean }> {
    // Idempotent: upsert by stable ID so reruns update in place.
    this.mutate((data) => {
      for (const customer of seed.customers) {
        const idx = data.customers.findIndex((c) => c.customer_id === customer.customer_id);
        if (idx >= 0) data.customers[idx] = customer;
        else data.customers.push(customer);
      }
      for (const tx of seed.transactions) {
        const idx = data.transactions.findIndex((t) => t.transaction_id === tx.transaction_id);
        if (idx >= 0) data.transactions[idx] = tx;
        else data.transactions.push(tx);
      }
      for (const p of seed.payouts) {
        const idx = data.payouts.findIndex((x) => x.payout_id === p.payout_id);
        if (idx >= 0) data.payouts[idx] = p;
        else data.payouts.push(p);
      }
      for (const chunk of seed.knowledgeChunks ?? []) {
        const idx = data.kb_chunks.findIndex((k) => k.id === chunk.id);
        if (idx >= 0) data.kb_chunks[idx] = chunk;
        else data.kb_chunks.push(chunk);
      }
    });
    return { seeded: true };
  }
}
