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
const FEES_INTENT = /\b(fee|fees|charge|charges|charged|pricing|price|prices|cost|costs)\b/i;
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
  if (REFERENCE_TXN.test(message)) return "transaction_lookup";
  // Fee/pricing questions are policy questions (Scenario 1) — but they sit
  // AFTER explicit references, so "what fees apply to payout PAY-7002?"
  // still looks the payout up. Speech-to-text often garbles the plural
  // ("...for international payment"), which used to slip past
  // GENERIC_PAYMENT's word boundary and trap the customer in the
  // payment-clarify loop; explicit fee keywords route to knowledge first.
  if (FEES_INTENT.test(message)) return "knowledge";
  if (GENERIC_PAYMENT.test(message)) return "transaction_lookup";
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

// --- Voice-channel reference normalization -------------------------------
// Speech-to-text renders spoken references as words: customers say
// "T X N nine thousand and one" and Deepgram writes
// "TXN-nine thousand and 1" or "TXN 9 0 0 1". The strict TXN-\d+
// extraction above cannot read those, so voice lookups would always
// fail. This deterministic normalizer rewrites spoken references into
// canonical IDs before the decision engine runs. Text-channel input is
// left untouched (typed references are already canonical).

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

const NUMBER_WORD_PATTERN =
  "\\d+|zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|" +
  "twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|" +
  "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";

/**
 * Parses spoken number tokens into a value. Digit-by-digit runs
 * ("9 0 0 1", "nine oh oh one") concatenate; magnitude phrases
 * ("nine thousand and one") use additive magnitude parsing.
 */
function parseSpokenNumberTokens(rawTokens: string[]): number | null {
  const tokens = rawTokens
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token !== "" && token !== "and");
  if (tokens.length === 0) return null;

  // Any "oh" means digit-by-digit speech ("nine oh oh one" = 9001),
  // never additive (9+0+0+1 = 10). Every token must be a single digit —
  // spoken ("nine", "one") or numeric ("9", "1") — or an "oh".
  if (tokens.some((token) => token === "oh")) {
    const isSingleDigit = (token: string): boolean =>
      /^\d$/.test(token) || (NUMBER_WORDS[token] !== undefined && NUMBER_WORDS[token]! < 10);
    if (!tokens.every(isSingleDigit)) return null;
    return Number(tokens.map((token) => (token === "oh" ? "0" : String(NUMBER_WORDS[token] ?? token))).join(""));
  }
  if (tokens.every((token) => /^\d$/.test(token))) {
    return Number(tokens.map((token) => token).join(""));
  }

  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      current += Number(token);
      continue;
    }
    const value = NUMBER_WORDS[token];
    if (value === undefined) return null;
    if (value === 100) {
      current = (current === 0 ? 1 : current) * 100;
    } else if (value === 1000) {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
    } else {
      current += value;
    }
  }
  const result = total + current;
  return result > 0 ? result : null;
}

/**
 * Only rewrite confident matches: at least two number tokens
 * ("nine thousand", "9 0 0 1") or one multi-digit number ("9001").
 * A lone word ("pay one") is too ambiguous in plain English.
 */
function isConfidentSpokenReference(tokens: string[]): boolean {
  if (tokens.length >= 2) return true;
  return tokens.length === 1 && /^\d{2,}$/.test(tokens[0] ?? "");
}

const NUMBER_OR_AND = new RegExp(`^(?:${NUMBER_WORD_PATTERN}|and)$`, "i");
// Trailing courtesy phrases customers append to a reference request
// ("check t x n 9 0 0 1 for me"). They are stripped before the strict
// number check and re-attached to the output, so they never break
// normalization — but they also never mask a non-reference tail like
// "for the invoice".
const COURTESY_TAIL = /\s*(?:for\s+(?:me|us)|please|thanks|thank\s+you)\s*$/i;

function canonicalPrefix(prefix: string): "TXN" | "PAY" | "CUS" {
  // Spoken prefixes arrive letter-by-letter ("t x n"); collapse before
  // matching so they canonicalize the same as fused ones ("txn").
  const upper = prefix.replace(/\s+/g, "").toUpperCase();
  if (upper.startsWith("TXN")) return "TXN";
  if (upper.startsWith("CUS")) return "CUS";
  return "PAY"; // "pay" and "payout"
}

export function normalizeVoiceReferences(text: string): string {
  // Capture the spoken tail after TXN/PAY/PAYOUT/CUS up to the next
  // sentence boundary or a trailing courtesy word ("please"). The lazy
  // quantifier keeps separators OUT of the match, so spacing and other
  // references in the sentence are never consumed or merged.
  // Deepgram sometimes spells the prefix letter-by-letter ("t x n 9 0 0
  // 1") instead of fusing it ("TXN 9 0 0 1"), so the alternation accepts
  // both shapes. Order matters: fused forms first, then spaced ones.
  const refRegex = new RegExp(
    "\\b(txn|payout|pay|cus|t\\s?x\\s?n|p\\s?a\\s?y(?:\\s?o\\s?u\\s?t)?|c\\s?u\\s?s)\\b[\\s:-]*([^.,;!?]*?)(?=[.,;!?]|$|\\b(?:please|thanks)\\b)",
    "gi",
  );
  return text.replace(refRegex, (match: string, prefix: string, tail: string) => {
    const courtesy = tail.match(COURTESY_TAIL)?.[0] ?? "";
    const trimmedTail = courtesy ? tail.slice(0, tail.length - courtesy.length) : tail;
    const words = trimmedTail.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    // Strict mode: every word in the tail must be a number word, "and",
    // or digits. Anything else ("payout PAY-7002", "for the invoice")
    // means this is not a clean spoken reference — leave it untouched.
    if (!words.every((word) => NUMBER_OR_AND.test(word))) return match;
    const numberTokens =
      trimmedTail.match(new RegExp(NUMBER_WORD_PATTERN, "gi")) ?? [];
    if (!isConfidentSpokenReference(numberTokens)) return match;
    const parsed = parseSpokenNumberTokens(numberTokens);
    if (parsed === null) return match;
    // Preserve any whitespace the lazy tail swallowed ("TXN-9001 please"),
    // and keep the spoken noun for payout references ("payout PAY-9002"),
    // since "payout" is sentence wording rather than part of the ID.
    const trailing = match.match(/\s*$/)?.[0] ?? "";
    const reference = `${canonicalPrefix(prefix)}-${parsed}`;
    const spoken = prefix.toLowerCase().replace(/\s+/g, "");
    const courtesySuffix = courtesy.trim();
    return spoken === "pay" || spoken === "payout"
      ? `${spoken} ${reference}${courtesySuffix ? ` ${courtesySuffix}` : ""}${trailing}`
      : `${reference}${courtesySuffix ? ` ${courtesySuffix}` : ""}${trailing}`;
  });
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
