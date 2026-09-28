import { z } from "zod";
import { withAudit, type ToolContext } from "../context.js";

export const createEscalationInputSchema = {
  ticket_id: z.string().optional().describe("Related ticket ID if one was created"),
  customer_id: z.string().optional().describe("Related customer ID if known"),
  user_name: z.string().optional().describe("Name of the person requesting escalation"),
  user_email: z.string().optional().describe("Email for the support team to follow up"),
  category: z.string().min(1).describe("One of: compliance, account, dispute, payment, other"),
  reason: z.string().min(1).describe("Why human support is required"),
  preferred_time: z.string().optional().describe("Requested callback or appointment time"),
};

export const createEscalationTool = {
  name: "create_escalation",
  description:
    "Escalate the conversation to human support. Use for compliance, account restrictions, " +
    "disputes, refunds, cancellations, verification issues, or frustrated customers. " +
    "Creates an escalation record that a specialist will act on.",
  purpose: "Persist an escalation record for human support",
};

export type EscalationInput = z.infer<z.ZodObject<typeof createEscalationInputSchema>>;

const CATEGORIES = new Set(["compliance", "account", "dispute", "payment", "other"]);

export async function handleCreateEscalation(
  ctx: ToolContext,
  input: EscalationInput,
  conversationId: string,
) {
  const category = CATEGORIES.has(input.category.trim().toLowerCase())
    ? (input.category.trim().toLowerCase() as "compliance" | "account" | "dispute" | "payment" | "other")
    : "other";
  const outcome = await withAudit(ctx, createEscalationTool.name, createEscalationTool.purpose, input, async () => {
    const escalation = await ctx.store.createEscalation({
      ticket_id: input.ticket_id ?? null,
      customer_id: input.customer_id ?? null,
      conversation_id: conversationId,
      user_name: input.user_name ?? null,
      user_email: input.user_email ?? null,
      category,
      reason: input.reason,
      call_booked: Boolean(input.preferred_time),
      preferred_time: input.preferred_time ?? null,
    });
    return {
      escalation_id: escalation.escalation_id,
      status: escalation.status,
      follow_up_summary:
        "A RelayPay support specialist will follow up with the customer" +
        (escalation.preferred_time ? ` at the requested time (${escalation.preferred_time})` : "") +
        ".",
    };
  });
  if (!outcome.ok) {
    return {
      escalation_id: "",
      status: "error",
      follow_up_summary: "",
      error: outcome.error,
    };
  }
  return outcome.result;
}
