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
  | "escalation"
  | "greeting"
  | "general_help"
  | "restricted_request";

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
  /** Which escalation trigger fired (for empathetic phrasing). */
  escalationTrigger?: string;
  /** Why a decline happened: no approved knowledge, privacy, or out of scope. */
  declineKind?: "no_knowledge" | "privacy" | "scope";
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
    name: "balance",
    pattern: /\b(my|our) (account |current |available )?balance\b|\bhow much (money )?(do|have) (i|we) (have|got)\b/i,
    category: "account",
    reason: "Account-specific balance request (never read out; needs a specialist)",
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

// Attempts to override the agent's rules ("ignore previous instructions").
const INJECTION =
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(instructions|rules|prompt|guidelines|guardrails|restrictions)\b|\bsystem prompt\b|\bdeveloper mode\b|\bjailbreak\b|\bpretend (to be|you are|you're)\b|\byou are now\b|\bact as (a|an|my|the)\b|\breveal (your|the) (prompt|instructions|rules)\b/i;
// Requests to read out personal or internal data (anyone's).
const SENSITIVE_FIELD =
  /\b(e-?mail(?: address)?|phone(?: number)?|mobile number|password|passcode|pin|card number|account number|iban|swift code|routing number|bank details|home address|contact details|support notes|internal notes|personal (?:details|data|information))\b/i;
const DISCLOSURE_VERB =
  /\b(what(?:'s| is| are)|give|tell|read|share|send|show|list|print|reveal|disclose|look up|find|get)\b/i;
const GIVING_OWN_DETAILS = /\b(my|our)\s+(e-?mail|phone|name)(?: address| number)?\s+(is|'s)\b/i;
const GREETING_ONLY =
  /^(hi|hello|hey|hiya|howdy|greetings|good (morning|afternoon|evening))( (there|relaypay|team|sarah))?$/i;
const PRESENCE_ONLY =
  /^(hello|can you hear me|are you there|is anyone there|is this working|testing|test|hm+|um+|uh+|er+|mm+|ok(ay)?|right)$/i;
const HELP_ONLY =
  /^\s*(help|help me|please help|i need (some )?help|can you help( me)?|i have a (question|problem|issue)|support|question|problem|issue)[\s.!?]*$/i;

/** True when every sentence of the message is a greeting or a "can you hear me" check. */
export function isGreetingOrPresence(message: string): boolean {
  const parts = message.toLowerCase().split(/[.!?,]+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => GREETING_ONLY.test(p) || PRESENCE_ONLY.test(p));
}

export function isPromptInjection(message: string): boolean {
  return INJECTION.test(message);
}

export function isSensitiveDataRequest(message: string): boolean {
  return SENSITIVE_FIELD.test(message) && DISCLOSURE_VERB.test(message) && !GIVING_OWN_DETAILS.test(message);
}

export function classifyIntent(message: string): Intent {
  // Rule-override attempts and requests for personal/internal data are
  // refused before anything else runs.
  if (isPromptInjection(message) || isSensitiveDataRequest(message)) return "restricted_request";
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
  // A bare CUS-#### reference is always an account lookup, even without
  // account-specific phrasing ("check CUS-1001", "CUS-1001 for me").
  if (/\bCUS-\d+\b/i.test(message)) return "account_lookup";
  if (isGreetingOrPresence(message)) return "greeting";
  if (HELP_ONLY.test(message)) return "general_help";
  return "knowledge";
}

export function decide(
  message: string,
  signals: IntentSignals,
): Decision {
  const intent = classifyIntent(message);

  // 0. Refusals: rule-override attempts and personal-data requests.
  if (intent === "restricted_request") {
    const injection = isPromptInjection(message);
    return {
      action: "decline",
      intent,
      declineKind: injection ? "scope" : "privacy",
      rationale: injection
        ? "Message tries to override the support rules — refused"
        : "Request to disclose personal or internal data — refused",
    };
  }

  // 1. Escalation triggers first — never guess on these.
  for (const trigger of ESCALATION_TRIGGERS) {
    if (trigger.pattern.test(message)) {
      return {
        action: "escalate",
        intent,
        escalationCategory: trigger.category,
        escalationTrigger: trigger.name,
        rationale: `Escalation trigger '${trigger.name}': ${trigger.reason}`,
      };
    }
  }

  switch (intent) {
    case "greeting":
      return {
        action: "clarify",
        intent,
        rationale: "Greeting or presence check — introduce and ask what the customer needs",
      };

    case "general_help":
      return {
        action: "clarify",
        intent,
        rationale: "Request too vague to route — ask which area it concerns",
        clarifyingQuestion:
          "Is it about a payment or payout, an invoice, your account, or a general question about RelayPay?",
      };

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

/**
 * A reference number given without its prefix but with an explicit cue
 * ("transaction 9001", "payout number 7003", "reference is 9005"). Only
 * used when the message has no prefixed reference; the reply names the
 * canonical ID it checked, so the customer can correct it.
 */
export function extractBareReference(text: string, intent: Intent): { transactionId?: string; payoutId?: string } {
  const match = text.match(/\b(transaction|payment|transfer|reference|ref|payout|id|number)\s+(?:number\s+|id\s+|is\s+|no\.?\s+)?#?(\d{4,6})\b/i);
  if (!match) return {};
  const digits = match[2]!;
  if (intent === "payout_lookup" || /payout/i.test(match[1]!)) return { payoutId: `PAY-${digits}` };
  if (intent === "transaction_lookup" || intent === "ticket") return { transactionId: `TXN-${digits}` };
  return {};
}

/**
 * True when the message seems to contain a reference we could not parse
 * ("payout ninety oh one", "TXN 9-0"). The orchestrator must then ask the
 * customer to repeat it instead of silently reusing an older reference.
 */
export function hasUnparsedReference(text: string): boolean {
  const refs = extractReferences(text);
  if (refs.transactionId || refs.payoutId || refs.customerId) return false;
  return /\d{3,}/.test(text) ||
    /\b\d(?:\s\d){2,}\b/.test(text) ||
    /\b(txn|t x n|pay|payout)\s*[-#:]?\s*\d/i.test(text) ||
    /\b(txn|t x n)\b/i.test(text) ||
    /(?:\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|hundred|thousand)\b[\s,-]*){3,}/i.test(text);
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
 * Parses spoken number tokens into a DIGIT STRING. Digit-by-digit runs
 * ("9 0 0 1", "nine oh oh one") concatenate — keeping leading zeros
 * ("oh oh one" = "001", not 1); magnitude phrases ("nine thousand and
 * one") use additive magnitude parsing and render as "9001".
 */
function parseSpokenNumberTokens(rawTokens: string[]): string | null {
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
    return tokens.map((token) => (token === "oh" ? "0" : String(NUMBER_WORDS[token] ?? token))).join("");
  }
  // Pure digit tokens join verbatim, preserving leading zeros ("001"
  // stays 001 — Number() would silently corrupt canonical references
  // like TXN-001 that this parser re-visits after the fused rewrite).
  if (tokens.every((token) => /^\d+$/.test(token))) {
    return tokens.join("");
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
  return result > 0 ? String(result) : null;
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

export function normalizeVoiceReferences(input: string): string {
  // "payout PAY 7 0 0 3" / "payout pay 7003": the noun "payout" followed
  // by the spoken PAY prefix would otherwise swallow the prefix as an
  // unparseable tail, leaving no reference at all (which once let an
  // older reference from the conversation be used instead).
  // Similarly "customer c u s 1 0 0 1": strip the noun "customer" before
  // a spaced-out CUS prefix so the refRegex can match it cleanly.
  const text = input
    .replace(/\bpay\s?out\s+(?=p\s?a\s?y\b(?!-\d))/gi, "")
    .replace(/\bcustomer\s+(?=c\s?u\s?s\b)/gi, "");
  // Fused alphanumerics: STT often merges the prefix with the digits and
  // drops the separator entirely ("txn001", "pay7002"). The word-boundary
  // in the main pattern below cannot match inside those, so rewrite them
  // first. At least three digits keeps "pay 20" style fragments alone.
  const withFused = text.replace(
    /\b(t\s?x\s?n|p\s?a\s?y(?:\s?o\s?u\s?t)?|c\s?u\s?s)(\d{3,12})\b/gi,
    (match: string, prefix: string, digits: string) => {
      const spoken = prefix.toLowerCase().replace(/\s+/g, "");
      const canonical = `${canonicalPrefix(prefix)}-${digits}`;
      return spoken === "pay" || spoken === "payout" ? `${spoken} ${canonical}` : canonical;
    },
  );

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
  return withFused.replace(refRegex, (match: string, prefix: string, tail: string) => {
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
    const digits = parseSpokenNumberTokens(numberTokens);
    if (digits === null) return match;
    // Preserve any whitespace the lazy tail swallowed ("TXN-9001 please"),
    // and keep the spoken noun for payout references ("payout PAY-9002"),
    // since "payout" is sentence wording rather than part of the ID.
    const trailing = match.match(/\s*$/)?.[0] ?? "";
    const reference = `${canonicalPrefix(prefix)}-${digits}`;
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
