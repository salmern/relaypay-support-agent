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
    // Duplicate prevention: customers repeat themselves (frustration,
    // re-asks while waiting). One OPEN escalation per conversation and
    // category — a repeat returns the existing record instead of
    // creating another. When the existing record has no contact details
    // yet and this call provides them, enrich the record instead.
    const existing = (await ctx.store.listEscalations(conversationId)).find(
      (e) => e.category === category && e.status === "open",
    );
    if (existing) {
      // Fill in whatever the existing record is still missing: contact
      // details, a callback time given in a later turn, or the customer /
      // ticket link. Fields already on the record are never overwritten.
      const patch = {
        user_name: !existing.user_name && input.user_name ? input.user_name : null,
        user_email: !existing.user_email && input.user_email ? input.user_email : null,
        preferred_time: !existing.preferred_time && input.preferred_time ? input.preferred_time : null,
      };
      const linkPatch = {
        customer_id: !existing.customer_id && input.customer_id ? input.customer_id : null,
        ticket_id: !existing.ticket_id && input.ticket_id ? input.ticket_id : null,
      };
      const enriches = Object.values(patch).some(Boolean) || Object.values(linkPatch).some(Boolean);
      const updated = enriches
        ? await ctx.store.updateEscalationContact(existing.escalation_id, { ...patch, ...linkPatch })
        : existing;
      const record = updated ?? existing;
      return {
        escalation_id: existing.escalation_id,
        status: record.status,
        follow_up_summary:
          "A RelayPay support specialist will follow up with the customer" +
          (record.preferred_time ? ` at the requested time (${record.preferred_time})` : "") +
          ".",
        ...(enriches ? { contact_recorded: true } : { duplicate_prevented: true }),
      };
    }
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
