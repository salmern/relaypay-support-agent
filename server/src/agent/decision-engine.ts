/**
 * Deterministic decision engine.
 *
 * Implements assets/support-decision-rules.md (answer / clarify /
 * lookup / escalate / decline) and assets/escalation-rules.md
 * (escalation triggers) as explicit, testable application logic.
 * The LLM interprets language and phrases responses; these rules
 * constrain what it is allowed to do.
 */
import type { EscalationCategory } from "@relaypay/store";

export type Intent =
  | "knowledge"
  | "account_lookup"
  | "transaction_lookup"
  | "payout_lookup"
  | "ticket"
  | "escalation";

export interface IntentSignals {
  /** Company name or customer id present in the message. */
  hasIdentity: boolean;
  /** TXN-#### or PAY-#### reference present. */
  hasReference: boolean;
}

export interface Decision {
  action: "answer" | "clarify" | "lookup" | "ticket" | "escalate" | "decline";
  intent: Intent;
  /** Escalation category when action === "escalate". */
  escalationCategory?: EscalationCategory;
  /** Why this decision was made (for audit logs). */
  rationale: string;
  /** The single clarifying question to ask when action === "clarify". */
  clarifyingQuestion?: string;
}

export const ESCALATION_TRIGGERS: Array<{
  name: string;
  pattern: RegExp;
  category: EscalationCategory;
  reason: string;
}> = [
  {
    name: "account_restriction",
    pattern: /\b(suspend\w*|restrict\w*|locked?|frozen|banned|deactivat\w*|account (was |is )?(blocked|on hold))\b/i,
    category: "account",
    reason: "Reported account restriction, suspension, or lock",
  },
  {
    name: "dispute",
    pattern: /\b(dispute\w*|chargeback|unauthori[sz]ed|fraud\w*|scam\w*|stolen|money (is )?missing|lost money)\b/i,
    category: "dispute",
    reason: "Dispute or unauthorized-transaction report",
  },
  {
    name: "refund_cancellation",
    pattern: /\b(refund\w*|reverse the (payment|transaction|transfer)|cancel\w* (my|the|our) (account|transfer|payment|payout|subscription))\b/i,
    category: "dispute",
    reason: "Refund or cancellation request",
  },
  {
    name: "compliance",
    pattern: /\b(compliance|kyc|kyb|aml|identity verification|verif(y|ication) (my|the) (identity|business|documents)|documents? (review|check)|account (is )?under review)\b/i,
    category: "compliance",
    reason: "Compliance or identity-verification concern",
  },
  {
    name: "frustration",
    pattern: /\b(angry|furious|unacceptable|terrible|worst|nobody (is )?(helping|listening|responding)|no ?body is helping|sick of|fed up|frustrat\w*|this is urgent|speak to (a )?(human|manager|supervisor|real person))\b/i,
    category: "other",
    reason: "Customer frustration, urgency, or request for a human",
  },
];

const PAYOUT_INTENT = /\b(payout|pay\s?out|contractor payment|vendor payment|beneficiary payment)\b/i;
const REFERENCE_TXN = /\bTXN-\d+\b/i;
const REFERENCE_PAY = /\bPAY-\d+\b/i;
const GENERIC_PAYMENT = /\b(transaction|payment|transfer|wire|invoice payment)\b/i;
const ACCOUNT_INTENT = /\b(my (account|plan|profile)|account status|our account|kyc status|verification status|account state|the account|check my account|my account\?|account information)\b/i;
const GUARANTEE_INTENT = /\bguarantee\b/i;
const TICKET_INTENT = /\b(ticket|complaint|report (a |this )?problem|look into|look at it|someone (to )?(look|check|help)|need (someone|a person) to|investigate)\b/i;

export function classifyIntent(message: string): Intent {
  // Escalation language dominates everything else.
  for (const trigger of ESCALATION_TRIGGERS) {
    if (trigger.pattern.test(message)) return "escalation";
  }
  // Guarantee questions are policy questions, even when they mention payouts
  // (Scenario 8) — the KB covers timeline guarantees explicitly.
  if (GUARANTEE_INTENT.test(message)) return "knowledge";
  // An explicit request for human follow-up wins over the lookup (Scenario 6):
  // the ticket flow still links any referenced transaction for context.
  if (TICKET_INTENT.test(message)) return "ticket";
  if (PAYOUT_INTENT.test(message) || REFERENCE_PAY.test(message)) return "payout_lookup";
  if (REFERENCE_TXN.test(message) || GENERIC_PAYMENT.test(message)) return "transaction_lookup";
  if (ACCOUNT_INTENT.test(message)) return "account_lookup";
  return "knowledge";
}

export function decide(
  message: string,
  signals: IntentSignals,
): Decision {
  const intent = classifyIntent(message);

  // 1. Escalation triggers first — never guess on these.
  for (const trigger of ESCALATION_TRIGGERS) {
    if (trigger.pattern.test(message)) {
      return {
        action: "escalate",
        intent,
        escalationCategory: trigger.category,
        rationale: `Escalation trigger '${trigger.name}': ${trigger.reason}`,
      };
    }
  }

  switch (intent) {
    case "payout_lookup":
    case "transaction_lookup": {
      if (!signals.hasReference) {
        return {
          action: "clarify",
          intent,
          rationale: "Payment/payout question without a reference — must not guess status",
          clarifyingQuestion:
            "Is this about an outgoing payout, an incoming transfer, or an invoice payment? " +
            "If you have the reference handy — it looks like TXN-1234 or, for payouts, PAY-1234 — I can check it right away.",
        };
      }
      return {
        action: "lookup",
        intent,
        rationale: "Reference provided — safe to use the lookup tool",
      };
    }

    case "account_lookup": {
      if (!signals.hasIdentity) {
        return {
          action: "clarify",
          intent,
          rationale: "Account question without identifying information",
          clarifyingQuestion:
            "I can look into that for you. Could you tell me the company name on the account, or your customer ID?",
        };
      }
      return {
        action: "lookup",
        intent,
        rationale: "Identity provided — safe to use the customer lookup tool",
      };
    }

    case "ticket":
      return {
        action: "ticket",
        intent,
        rationale: "Customer asked for follow-up on a support issue",
      };

    case "knowledge":
    default:
      return {
        action: "answer",
        intent,
        rationale: "General question — answer from approved knowledge",
      };
  }
}

/** Extracts structured references (TXN-####, PAY-####, CUS-####) from text. */
export function extractReferences(text: string): {
  transactionId?: string;
  payoutId?: string;
  customerId?: string;
} {
  const transaction = text.match(/\b(TXN-\d+)\b/i);
  const payout = text.match(/\b(PAY-\d+)\b/i);
  const customer = text.match(/\b(CUS-\d+)\b/i);
  return {
    transactionId: transaction?.[1]?.toUpperCase(),
    payoutId: payout?.[1]?.toUpperCase(),
    customerId: customer?.[1]?.toUpperCase(),
  };
}

/**
 * Detects likely identity information: "I am X from Y" / "this is Y" /
 * a company-like name or a CUS- reference. Used to decide whether a
 * customer lookup is safe without asking the customer again.
 */
export function extractIdentity(text: string): { companyName?: string; contactName?: string } {
  const fromMatch = text.match(/\b(?:i am|i'm|this is|it's|my name is)\s+([a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,3}?)(?:\s+from\s+|\s+at\s+|[,.;!?]|$)/i);
  const companyMatch = text.match(/\bfrom\s+([a-z][a-z0-9'’&-]*(?:\s+[a-z][a-z0-9'’&-]*){0,3})/i);
  const customerRef = text.match(/\b(CUS-\d+)\b/i);
  if (customerRef) return { companyName: customerRef[1] };
  return {
    contactName: fromMatch?.[1]?.trim(),
    companyName: companyMatch?.[1]?.trim(),
  };
}
