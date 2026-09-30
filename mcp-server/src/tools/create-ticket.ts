import { z } from "zod";
import { withAudit, type ToolContext } from "../context.js";

export const createTicketInputSchema = {
  customer_id: z.string().optional().describe("Related customer ID if known"),
  transaction_id: z.string().optional().describe("Related transaction reference if known (e.g. TXN-9002)"),
  category: z.string().min(1).describe("Ticket category, e.g. payment, account, invoice, other"),
  priority: z.string().min(1).describe("Ticket priority: low, medium, high, or urgent"),
  summary: z.string().min(1).describe("Short human-readable summary of the issue"),
  conversation_id: z.string().min(1).describe("Conversation the ticket originates from"),
};

export const createTicketTool = {
  name: "create_support_ticket",
  description:
    "Create a support ticket for an issue that needs follow-up by the support team. " +
    "Use when the customer reports a problem that cannot be resolved in the conversation. " +
    "Only report a ticket to the customer if this call succeeds.",
  purpose: "Persist a support ticket for human follow-up",
};

export async function handleCreateTicket(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof createTicketInputSchema>>,
) {
  const outcome = await withAudit(ctx, createTicketTool.name, createTicketTool.purpose, input, async () => {
    // Duplicate prevention: a repeated request in the same conversation
    // returns the existing open ticket (same category and, when present,
    // same linked transaction) instead of filing another one.
    const existing = (await ctx.store.listTickets(input.conversation_id)).find(
      (t) =>
        t.status === "open" &&
        t.category === input.category &&
        (input.transaction_id === undefined || t.transaction_id === input.transaction_id),
    );
    if (existing) {
      return { ticket_id: existing.ticket_id, status: existing.status, duplicate_prevented: true };
    }
    const ticket = await ctx.store.createTicket({
      customer_id: input.customer_id ?? null,
      transaction_id: input.transaction_id ?? null,
      conversation_id: input.conversation_id,
      category: input.category,
      priority: normalizePriority(input.priority),
      summary: input.summary,
    });
    return { ticket_id: ticket.ticket_id, status: ticket.status };
  });
  if (!outcome.ok) {
    return { ticket_id: "", status: "error", error: outcome.error };
  }
  return outcome.result;
}

const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

function normalizePriority(priority: string): string {
  const p = priority.trim().toLowerCase();
  return PRIORITIES.has(p) ? p : "medium";
}
