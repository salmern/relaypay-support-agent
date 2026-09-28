import { z } from "zod";
import { withAudit, type ToolContext } from "../context.js";

export const lookupCustomerInputSchema = {
  customer_id: z.string().optional().describe("Stable customer ID, e.g. CUS-1001"),
  email: z.string().optional().describe("Contact email on the account"),
  company_name: z.string().optional().describe("Company name on the account"),
};

export const lookupCustomerTool = {
  name: "lookup_customer",
  description:
    "Look up a RelayPay customer account by customer_id, email, or company_name. " +
    "Use when the user asks an account-specific question and has provided enough " +
    "identifying information. Returns customer-safe account fields only.",
  purpose: "Find the customer account record for account-specific support",
};

export async function handleLookupCustomer(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof lookupCustomerInputSchema>>,
) {
  const outcome = await withAudit(ctx, lookupCustomerTool.name, lookupCustomerTool.purpose, input, async () => {
    if (!input.customer_id && !input.email && !input.company_name) {
      throw new Error("lookup_customer requires one of: customer_id, email, company_name");
    }
    const customer = await ctx.store.getCustomer({
      customer_id: input.customer_id,
      email: input.email,
      company_name: input.company_name,
    });
    if (!customer) {
      return { found: false as const };
    }
    return {
      found: true as const,
      customer_id: customer.customer_id,
      company_name: customer.company_name,
      plan: customer.plan,
      account_status: customer.account_status,
      kyc_status: customer.kyc_status,
      support_notes: customer.support_notes,
    };
  });
  if (!outcome.ok) {
    return { found: false as const, error: outcome.error };
  }
  return outcome.result;
}
