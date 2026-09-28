import { z } from "zod";
import { withAudit, type ToolContext } from "../context.js";

export const lookupTransactionInputSchema = {
  transaction_id: z.string().min(1).describe("Transaction reference, e.g. TXN-9001"),
};

export const lookupTransactionTool = {
  name: "lookup_transaction",
  description:
    "Look up a RelayPay transaction by its reference (e.g. TXN-9001). " +
    "Use for any question about a specific payment, transfer, or invoice payment. " +
    "Never guess transaction status — always use this tool.",
  purpose: "Find the transaction record and its customer-safe status",
};

export async function handleLookupTransaction(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof lookupTransactionInputSchema>>,
) {
  const outcome = await withAudit(ctx, lookupTransactionTool.name, lookupTransactionTool.purpose, input, async () => {
    const transaction = await ctx.store.getTransaction(input.transaction_id);
    if (!transaction) {
      return { found: false as const, transaction_id: input.transaction_id };
    }
    return {
      found: true as const,
      transaction_id: transaction.transaction_id,
      customer_id: transaction.customer_id,
      type: transaction.transaction_type,
      status: transaction.status,
      amount: transaction.amount,
      currency: transaction.currency,
      estimated_arrival: transaction.estimated_arrival ?? "",
      support_summary: transaction.support_summary,
    };
  });
  if (!outcome.ok) {
    return { found: false as const, transaction_id: input.transaction_id, error: outcome.error };
  }
  return outcome.result;
}
