import type { Conversation, ConversationTurn, Customer, Escalation, EvaluationRecord, KnowledgeChunk, Payout, RetrievalLog, SupportTicket, ToolCallLog, Transaction } from "./types.js";

/**
 * Storage abstraction. Implemented by SupabaseStore (production) and
 * MockFileStore (deterministic tests / no-credential runs).
 */
export interface Store {
  // Seed data
  getCustomer(input: { customer_id?: string; email?: string; company_name?: string }): Promise<Customer | null>;
  getTransaction(transaction_id: string): Promise<Transaction | null>;
  getPayout(query: { payout_id?: string; transaction_id?: string }): Promise<Payout | null>;

  // Runtime records
  createConversation(input: { conversation_id: string; channel: "voice" | "text"; caller_identifier?: string | null }): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  completeConversation(id: string, final_status: Conversation["final_status"], summary: string | null): Promise<void>;
  addTurn(turn: Omit<ConversationTurn, "created_at">): Promise<ConversationTurn>;
  listTurns(conversation_id: string): Promise<ConversationTurn[]>;
  addRetrievalLog(log: Omit<RetrievalLog, "created_at">): Promise<RetrievalLog>;
  addToolCallLog(log: Omit<ToolCallLog, "created_at">): Promise<ToolCallLog>;
  addConversationEvent(event: { conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown> }): Promise<{ logged: true }>;
  createTicket(ticket: Omit<SupportTicket, "ticket_id" | "created_at" | "status"> & { status?: SupportTicket["status"] }): Promise<SupportTicket>;
  getTicket(ticket_id: string): Promise<SupportTicket | null>;
  createEscalation(escalation: Omit<Escalation, "escalation_id" | "created_at" | "status"> & { status?: Escalation["status"] }): Promise<Escalation>;
  /** Attaches follow-up contact details to an existing escalation record. */
  updateEscalationContact(escalation_id: string, contact: { user_name?: string | null; user_email?: string | null; preferred_time?: string | null; customer_id?: string | null; ticket_id?: string | null }): Promise<Escalation | null>;
  getEscalation(escalation_id: string): Promise<Escalation | null>;
  addEvaluation(record: Omit<EvaluationRecord, "created_at">): Promise<EvaluationRecord>;
  listEvaluations(): Promise<EvaluationRecord[]>;

  // Observability / debug listing
  listConversations(): Promise<Conversation[]>;
  listToolCalls(conversationId?: string): Promise<ToolCallLog[]>;
  listRetrievalLogs(conversationId?: string): Promise<RetrievalLog[]>;
  listTickets(conversationId?: string): Promise<SupportTicket[]>;
  listEscalations(conversationId?: string): Promise<Escalation[]>;
  listConversationEvents(conversationId: string): Promise<Array<{ conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown>; created_at: string }>>;

  // KB retrieval source
  listKnowledgeChunks(): Promise<KnowledgeChunk[]>;

  // Seed pipeline
  seedIfEmpty(seed: {
    customers: Customer[];
    transactions: Transaction[];
    payouts: Payout[];
    knowledgeChunks?: KnowledgeChunk[];
  }): Promise<{ seeded: boolean }>;
}
