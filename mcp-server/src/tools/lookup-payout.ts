import { z } from "zod";
import { withAudit, type ToolContext } from "../context.js";

export const lookupPayoutInputSchema = {
  payout_id: z.string().optional().describe("Payout reference, e.g. PAY-7002"),
  transaction_id: z.string().optional().describe("Linked transaction reference, e.g. TXN-9001"),
};

export const lookupPayoutTool = {
  name: "lookup_payout",
  description:
    "Look up a contractor/vendor payout by payout reference or linked transaction reference. " +
    "Use for payout status questions. Never guess payout status, date, recipient, or failure reason.",
  purpose: "Find the payout record and its customer-safe status",
};

export async function handleLookupPayout(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof lookupPayoutInputSchema>>,
) {
  const outcome = await withAudit(ctx, lookupPayoutTool.name, lookupPayoutTool.purpose, input, async () => {
    if (!input.payout_id && !input.transaction_id) {
      throw new Error("lookup_payout requires payout_id or transaction_id");
    }
    const payout = await ctx.store.getPayout({
      payout_id: input.payout_id,
      transaction_id: input.transaction_id,
    });
    if (!payout) {
      return { found: false as const, payout_id: input.payout_id ?? "", transaction_id: input.transaction_id ?? "" };
    }
    return {
      found: true as const,
      payout_id: payout.payout_id,
      customer_id: payout.customer_id,
      transaction_id: payout.transaction_id,
      status: payout.status,
      scheduled_for: payout.scheduled_for,
      failure_reason: payout.failure_reason ?? "",
      support_summary: payoutFailureSummary(payout),
    };
  });
  if (!outcome.ok) {
    return { found: false as const, payout_id: input.payout_id ?? "", error: outcome.error };
  }
  return outcome.result;
}

/** Customer-safe payout summary (never exposes internal risk logic). */
function payoutFailureSummary(payout: {
  status: string;
  scheduled_for: string;
  failure_reason: string | null;
}): string {
  switch (payout.status) {
    case "scheduled":
      return `Payout is scheduled for ${payout.scheduled_for}.`;
    case "processing":
      return "Payout is currently processing.";
    case "completed":
      return "Payout has been completed.";
    case "failed":
      return `Payout could not be completed: ${payout.failure_reason ?? "processing issue"}. `;
    case "review required":
      return "Payout is pending review. Our team will follow up with next steps.";
    default:
      return `Payout status: ${payout.status}.`;
  }
}
