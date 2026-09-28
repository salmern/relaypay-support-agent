export interface TextTurnResponse {
  conversation_id: string;
  response: string;
  answer_type: string;
  confidence: number;
  uncertainty_note: string | null;
  ticket_id: string | null;
  escalation_id: string | null;
  responder: "claude" | "rules";
}

export async function textTurn(apiBase: string, conversationId: string, message: string): Promise<TextTurnResponse> {
  const res = await fetch(`${apiBase}/api/conversations/${encodeURIComponent(conversationId)}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as TextTurnResponse;
}

export async function endTextConversation(apiBase: string, conversationId: string): Promise<void> {
  await fetch(`${apiBase}/api/conversations/${encodeURIComponent(conversationId)}/end`, {
    method: "POST",
  }).catch(() => undefined);
}
