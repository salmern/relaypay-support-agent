/**
 * Shared domain types for the RelayPay support agent.
 * Field names align with assets/mcp-tool-requirements.md and
 * assets/supabase-schema-and-seed-data.md.
 */

// ---------- Seed records ----------

export interface Customer {
  customer_id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  plan: string;
  account_status: string;
  region: string;
  kyc_status: string;
  support_notes: string;
}

export interface Transaction {
  transaction_id: string;
  customer_id: string;
  transaction_type: string;
  amount: string;
  currency: string;
  destination_country: string;
  status: string;
  created_at: string;
  estimated_arrival: string | null;
  support_summary: string;
}

export interface Payout {
  payout_id: string;
  transaction_id: string;
  customer_id: string;
  recipient_name: string;
  amount: string;
  currency: string;
  status: string;
  scheduled_for: string;
  failure_reason: string | null;
}

// ---------- Runtime records ----------

export type ConversationStatus =
  | "active"
  | "completed"
  | "escalated"
  | "error";

export interface Conversation {
  id: string;
  channel: "voice" | "text";
  caller_identifier: string | null;
  started_at: string;
  ended_at: string | null;
  final_status: ConversationStatus | null;
  summary: string | null;
}

export type AnswerType =
  | "knowledge"
  | "clarification"
  | "lookup"
  | "ticket"
  | "escalation"
  | "decline"
  | "closing"
  | "error";

export interface ConversationTurn {
  conversation_id: string;
  user_transcript: string;
  assistant_response: string;
  answer_type: AnswerType;
  confidence: number;
  uncertainty_note: string | null;
  created_at: string;
}

export interface RetrievalLog {
  conversation_id: string | null;
  query: string;
  knowledge_chunks: string[];
  source_title: string;
  source_summary: string;
  created_at: string;
}

export type ToolCallStatus = "success" | "error";

export interface ToolCallLog {
  conversation_id: string | null;
  tool_name: string;
  purpose: string;
  input_summary: string;
  result_summary: string;
  status: ToolCallStatus;
  error_message: string | null;
  created_at: string;
}

export type TicketStatus = "open" | "in_progress" | "closed";

export interface SupportTicket {
  ticket_id: string;
  customer_id: string | null;
  transaction_id: string | null;
  conversation_id: string;
  category: string;
  priority: string;
  summary: string;
  status: TicketStatus;
  created_at: string;
}

export type EscalationStatus = "open" | "in_progress" | "closed";
export type EscalationCategory =
  | "compliance"
  | "account"
  | "dispute"
  | "payment"
  | "other";

export interface Escalation {
  escalation_id: string;
  ticket_id: string | null;
  customer_id: string | null;
  conversation_id: string;
  user_name: string | null;
  user_email: string | null;
  category: EscalationCategory;
  reason: string;
  call_booked: boolean;
  preferred_time: string | null;
  status: EscalationStatus;
  created_at: string;
}

export type EvaluationVerdict = "pass" | "fail";

export interface EvaluationRecord {
  /** Groups the records of one `npm run evaluate` run. */
  run_id?: string | null;
  scenario: string;
  expected_behavior: string;
  actual_behavior: string;
  verdict: EvaluationVerdict;
  notes: string;
  created_at: string;
}

export interface KnowledgeChunk {
  id: string;
  title: string;
  heading: string;
  content: string;
  summary: string;
}
