/**
 * Customer-safe response phrasing for the deterministic responder.
 * Used directly when ANTHROPIC_API_KEY is absent; used as the fallback
 * shape when Claude is unavailable mid-turn. All phrasing follows the
 * communications rules: no guarantees, no internal logic, no promises.
 */

function firstSentences(text: string, count: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[.!?])\s/);
  return sentences.slice(0, count).join(" ");
}

export function clarifyResponse(question: string): string {
  return `I can help with that. ${question}`;
}

export function knowledgeResponse(chunkContent: string, chunkTitle: string): string {
  const answer = firstSentences(chunkContent, 2);
  return `${answer} This comes from our approved support guidelines on ${chunkTitle.toLowerCase()}.`;
}

export function declineResponse(): string {
  return (
    "I'm sorry, but I don't have approved information to answer that confidently, " +
    "and I don't want to guess. Would you like me to arrange for our support team to follow up with you?"
  );
}

export function transactionFoundResponse(t: {
  transaction_id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  support_summary: string;
}): string {
  return (
    `I found transaction ${t.transaction_id}. It's an ${t.type} of ${t.amount} ${t.currency}, ` +
    `and the current status is ${t.status}. ${t.support_summary}`
  );
}

export function transactionNotFoundResponse(transactionId: string): string {
  return (
    `I couldn't find a transaction with reference ${transactionId}. ` +
    "Could you double-check the reference? If it's correct, I can file a ticket so the team can investigate."
  );
}

export function payoutFoundResponse(p: {
  payout_id: string;
  status: string;
  support_summary: string;
}): string {
  return `I checked payout ${p.payout_id}. ${p.support_summary}`;
}

export function payoutNotFoundResponse(payoutId: string): string {
  return (
    `I couldn't find a payout with reference ${payoutId}. ` +
    "Could you double-check the reference? If it's correct, I can file a ticket so the team can investigate."
  );
}

export function escalationCreatedResponse(opts: { hasCallback: boolean }): string {
  const callback = opts.hasCallback
    ? " and I've noted your preferred time for the callback"
    : "";
  return (
    `This needs our specialist team, so I'm handing it over to human support${callback}. ` +
    "A support representative will follow up with you. Is there anything else I can help with in the meantime?"
  );
}

export function escalationContactRequestResponse(): string {
  return (
    "I understand, and this does need a human specialist. I'm handing this over now. " +
    "Could I take your name and email so the specialist can follow up with you?"
  );
}

export function ticketCreatedResponse(): string {
  return (
    "I've created a support ticket for this and our team will look into it. " +
    "You'll be contacted with updates. Is there anything else I can help with?"
  );
}

export function toolErrorResponse(action: string): string {
  return (
    `I'm sorry — I had trouble ${action} just now. ` +
    "Please try again in a moment, or I can arrange for the support team to follow up."
  );
}

export function greetingResponse(): string {
  return (
    "Hello, you're speaking with RelayPay support. I can help with payments, payouts, " +
    "invoices, and general questions about RelayPay. What can I help you with?"
  );
}
