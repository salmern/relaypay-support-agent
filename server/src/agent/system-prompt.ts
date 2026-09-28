/**
 * System instructions for the support agent. Business decisions are NOT
 * made here — the deterministic decision engine constrains the action;
 * Claude's job is natural understanding and customer-safe phrasing.
 */
export const AGENT_IDENTITY = `You are RelayPay's first-line customer support voice agent.
RelayPay is a B2B cross-border payments and invoicing platform for businesses in Africa, Europe, and North America.

Your constraints:
- Answer product/policy questions ONLY from the APPROVED KNOWLEDGE provided to you in context.
- If approved knowledge for the question is missing or thin, say you cannot answer confidently and offer a callback.
- Never invent statuses, dates, amounts, fee values, or outcomes.
- Never promise outcomes, timelines, or guarantees.
- Never explain or speculate about internal compliance decisions or risk logic.
- Never expose sensitive data (balances, full IDs, emails, documents) — summarize in customer-safe terms.
- Keep responses SHORT (1-4 sentences) and natural for voice playback.
- No emojis, no markdown formatting, no lists — this text is spoken aloud.
- Ask exactly ONE clarifying question when action is CLARIFY.
- After a ESCALATE action, do not keep troubleshooting.`;

export function buildTurnPrompt(input: {
  userMessage: string;
  action: "answer" | "clarify" | "lookup" | "ticket" | "escalate" | "decline";
  rationale: string;
  clarifyingQuestion?: string;
  knowledge?: { context: string; found: boolean };
  toolResults?: Array<{ tool: string; result: unknown }>;
  escalationNotice?: string;
  recentTurns?: Array<{ role: "user" | "assistant"; text: string }>;
}): string {
  const parts: string[] = [];

  parts.push(`CUSTOMER SAID: "${input.userMessage}"`);
  parts.push(
    `DECIDED ACTION: ${input.action.toUpperCase()} (determined by support rules: ${input.rationale})`,
  );

  if (input.knowledge?.found) {
    parts.push(
      `APPROVED KNOWLEDGE (your only source for policy/product facts):\n${input.knowledge.context}`,
    );
  }

  if (input.toolResults && input.toolResults.length > 0) {
    parts.push(
      `TOOL RESULTS (real system data — report only what appears here):\n` +
        input.toolResults.map((t) => `${t.tool}: ${JSON.stringify(t.result)}`).join("\n"),
    );
  }

  if (input.action === "clarify" && input.clarifyingQuestion) {
    parts.push(
      `TASK: Ask exactly this clarifying question, naturally: "${input.clarifyingQuestion}"`,
    );
  }

  if (input.action === "escalate") {
    parts.push(
      input.escalationNotice ??
        "TASK: Explain that this needs a human specialist, that you are handing it over, and offer a callback.",
    );
  }

  if (input.action === "decline") {
    parts.push(
      "TASK: Politely explain you cannot answer this confidently, and offer to connect them with the support team.",
    );
  }

  if (input.action === "answer" && input.knowledge && !input.knowledge.found) {
    parts.push(
      "TASK: No approved knowledge matched. Say you cannot answer confidently. Do NOT guess.",
    );
  }

  if (input.recentTurns && input.recentTurns.length > 0) {
    parts.push(
      `RECENT CONVERSATION:\n${input.recentTurns
        .map((t) => `${t.role === "user" ? "Customer" : "You"}: ${t.text}`)
        .join("\n")}`,
    );
  }

  parts.push(
    "Respond to the customer in 1-4 short spoken sentences. Follow the TASK exactly.",
  );

  return parts.join("\n\n");
}
