/** Activity rows exactly as the backend's audit trail recorded them. */
export interface ToolCallActivity {
  tool_name: string;
  event_type?: string | null;
  status: string;
  result_summary: string;
  input_summary?: string;
  error_message?: string | null;
}

export interface RetrievalActivity {
  query?: string;
  knowledge_chunks: string[];
  source_title: string;
}

export interface TurnActivity {
  answer_type: string;
  confidence: number;
  uncertainty_note: string | null;
  responder?: "claude" | "rules";
  tool_calls: ToolCallActivity[] | null;
  retrieval: RetrievalActivity | null;
}

export interface TextTurnResponse {
  conversation_id: string;
  response: string;
  answer_type: string;
  confidence: number;
  uncertainty_note: string | null;
  ticket_id: string | null;
  escalation_id: string | null;
  responder: "claude" | "rules";
  activity: { tool_calls: ToolCallActivity[]; retrieval: RetrievalActivity | null };
}

export interface ConversationActivity {
  conversation_id: string;
  channel: "voice" | "text";
  final_status: string | null;
  escalated: boolean;
  ticket_ids: string[];
  turns: TurnActivity[];
}

export interface TextSession {
  conversationId: string;
  token: string;
}

/** Customer-facing message for a failed request — never backend internals. */
async function failure(res: Response): Promise<Error> {
  if (res.status === 429) return new Error("You're sending messages quickly — please wait a moment and try again.");
  if (res.status === 401 || res.status === 404) return new Error("This conversation has expired. Please start a new conversation.");
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(res.status < 500 && body.error ? body.error : "The support agent is unavailable right now. Please try again in a moment.");
}

export async function startTextConversation(apiBase: string): Promise<TextSession> {
  const res = await fetch(`${apiBase}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { conversation_id?: string; conversation_token?: string };
  if (!body.conversation_id || !body.conversation_token) {
    throw new Error("Could not start a conversation. Please try again.");
  }
  return { conversationId: body.conversation_id, token: body.conversation_token };
}

export async function textTurn(apiBase: string, session: TextSession, message: string): Promise<TextTurnResponse> {
  const res = await fetch(`${apiBase}/api/conversations/${encodeURIComponent(session.conversationId)}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-conversation-token": session.token },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as TextTurnResponse;
}

export async function endTextConversation(apiBase: string, session: TextSession): Promise<void> {
  await fetch(`${apiBase}/api/conversations/${encodeURIComponent(session.conversationId)}/end`, {
    method: "POST",
    headers: { "x-conversation-token": session.token },
  }).catch(() => undefined);
}

/** Per-turn activity for a conversation (voice: keyed by the Vapi call id). */
export async function fetchActivity(apiBase: string, conversationId: string, token?: string): Promise<ConversationActivity | null> {
  const res = await fetch(`${apiBase}/api/conversations/${encodeURIComponent(conversationId)}/activity`, {
    headers: token ? { "x-conversation-token": token } : {},
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json()) as ConversationActivity;
}
