/**
 * Customer-safe response phrasing for the deterministic responder.
 *
 * Every reply has two parts:
 *  - `lead`: the statement for this turn. Claude (when enabled) may
 *    reword it, keeping every fact.
 *  - `closing`: the required next step (the exact clarifying question,
 *    the contact ask, the follow-up offer, the source citation). It is
 *    appended verbatim and never reworded, so the customer is always
 *    asked for the right thing (name and email — never a phone number),
 *    whichever responder phrases the lead.
 *
 * All phrasing follows the communications rules: no guarantees, no
 * internal logic, no promises.
 */

export interface Reply {
  lead: string;
  closing?: string;
}

export function render(reply: Reply): string {
  return [reply.lead, reply.closing].filter((part) => part && part.trim() !== "").join(" ").trim();
}

export const CONTACT_ASK = "Could I take your name and email so the specialist can follow up with you?";
export const FOLLOW_UP_OFFER = "Would you like me to arrange for our support team to follow up with you?";
export const ANYTHING_ELSE = "Is there anything else I can help with?";
export const CALLBACK_ASK = "Would you also like to book a callback? If so, what day and time suit you?";
export const CITATION_PREFIX = "This comes from our approved support guidelines on";

const PAYMENT_CLARIFY =
  "Is this about an outgoing payout, an incoming transfer, or an invoice payment? " +
  "If you have the reference handy — it looks like TXN-1234 or, for payouts, PAY-1234 — I can check it right away.";

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

// ---------- Clarifying questions ----------

export function clarifyPayment(): Reply {
  return { lead: "I can help with that.", closing: PAYMENT_CLARIFY };
}

export function clarifyAccount(): Reply {
  return {
    lead: "I can look into that for you.",
    closing: "Could you tell me the company name on the account, or your customer ID?",
  };
}

export function askReferenceForKind(): Reply {
  return { lead: "Thanks.", closing: "What's the reference? It looks like TXN-1234, or PAY-1234 for a payout." };
}

export function repeatReference(): Reply {
  return {
    lead: "I want to make sure I check the right record.",
    closing: "Could you say the full reference again? It looks like TXN-1234, or PAY-1234 for a payout.",
  };
}

export function generalHelp(): Reply {
  return {
    lead: "I'm here to help.",
    closing: "Is it about a payment or payout, an invoice, your account, or a general question about RelayPay?",
  };
}

export function greeting(): Reply {
  return {
    lead:
      "Hello, I'm RelayPay's virtual support assistant. I can help with payments, payouts, invoices, " +
      "your account, and general questions about RelayPay.",
    closing: "What can I help you with?",
  };
}

export function presenceCheck(): Reply {
  return { lead: "Yes, I can hear you.", closing: "What can I help you with?" };
}

// ---------- Knowledge ----------

export function knowledgeAnswer(answer: string, sourceHeading: string): Reply {
  return { lead: answer, closing: `${CITATION_PREFIX} “${sourceHeading}”.` };
}

// ---------- Declines ----------

export function declineResponse(): Reply {
  return {
    lead: "I'm sorry, but I don't have approved information to answer that confidently, and I don't want to guess.",
    closing: FOLLOW_UP_OFFER,
  };
}

export function privacyDecline(): Reply {
  return {
    lead:
      "For privacy and security, I can't share personal or account details such as emails, phone numbers, " +
      "balances, or internal notes.",
    closing: "Is there something else I can help you with?",
  };
}

export function scopeDecline(): Reply {
  return {
    lead: "I can only help with RelayPay support questions, and I can't change how I work or share internal information.",
    closing: "What can I help you with today?",
  };
}

// ---------- Lookups ----------

export function transactionFound(t: {
  transaction_id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  support_summary: string;
}): Reply {
  const summary = t.support_summary ? ` ${t.support_summary}` : "";
  return {
    lead:
      `I found transaction ${t.transaction_id}. It's ${article(t.type)} ${t.type} of ${t.amount} ${t.currency}, ` +
      `and the current status is ${t.status}.${summary}`,
  };
}

export function transactionNotFound(transactionId: string): Reply {
  return {
    lead: `I couldn't find a transaction with reference ${transactionId}.`,
    closing: "Could you double-check the reference? If it's correct, I can file a ticket so the team can investigate.",
  };
}

export function payoutFound(p: { payout_id: string; support_summary: string }): Reply {
  return { lead: `I checked payout ${p.payout_id}. ${p.support_summary}`.trim() };
}

export function payoutNotFound(payoutId: string): Reply {
  return {
    lead: `I couldn't find a payout with reference ${payoutId}.`,
    closing: "Could you double-check the reference? If it's correct, I can file a ticket so the team can investigate.",
  };
}

export function accountFound(c: { company_name: string; plan: string; account_status: string; kyc_status: string }): Reply {
  return {
    lead:
      `I found the account for ${c.company_name}. Your plan is ${c.plan} and the account is ${c.account_status}. ` +
      (c.kyc_status === "approved" ? "Verification is complete." : `Verification status: ${c.kyc_status}.`),
  };
}

export function accountNotFound(): Reply {
  return {
    lead: "I couldn't find an account with those details.",
    closing:
      "Could you confirm the company name on the account, or your customer ID? If you don't have them, I can arrange for the support team to help.",
  };
}

// ---------- Escalation ----------

/** Lead used when a looked-up record (payout/transaction/account) needs a specialist. */
export function reviewHandover(recordLead: string): Reply {
  return { lead: `${recordLead} This needs our specialist team, so I'm handing it over.`.trim(), closing: CONTACT_ASK };
}

export function restrictedAccountHandover(): Reply {
  return {
    lead:
      "I can see the account, but it's currently restricted, and I'm not able to discuss the details here. " +
      "I'm handing this to our specialist team.",
    closing: CONTACT_ASK,
  };
}

export function escalationContactRequest(trigger?: string): Reply {
  const empathy =
    trigger === "frustration"
      ? "I'm sorry you've had this experience, and I understand the frustration."
      : trigger === "account_restriction"
        ? "I'm sorry you're dealing with this, and I understand how stressful it is."
        : "I understand.";
  return {
    lead: `${empathy} This does need a human specialist, so I'm handing it over now.`,
    closing: CONTACT_ASK,
  };
}

export function reaskContact(): Reply {
  return { lead: "Sorry, I didn't catch that.", closing: CONTACT_ASK };
}

export function askEmail(name: string | null): Reply {
  return {
    lead: name ? `Thanks, ${name}.` : "Thanks.",
    closing: "What email address should the specialist use to reach you?",
  };
}

export function invalidEmail(): Reply {
  return {
    lead: "Sorry, I didn't catch a valid email address.",
    closing: "Could you say it again? For example: name at example dot com.",
  };
}

export function askName(): Reply {
  return { lead: "Thanks.", closing: "And what name should I put on the request?" };
}

export function escalationCreated(opts: { name: string | null; preferredTime: string | null }): Reply {
  const thanks = opts.name ? `Thank you, ${opts.name}.` : "Thank you.";
  if (opts.preferredTime) {
    return {
      lead:
        `${thanks} I've passed this to our specialist team and noted ${opts.preferredTime} for your callback. ` +
        "A support representative will follow up with you.",
      closing: `${ANYTHING_ELSE.replace("?", " in the meantime?")}`,
    };
  }
  return {
    lead: `${thanks} I've passed this to our specialist team, and a support representative will follow up with you by email.`,
    closing: CALLBACK_ASK,
  };
}

export function callbackBooked(preferredTime: string): Reply {
  return {
    lead: `Thanks — I've noted ${preferredTime} for your callback, and a support representative will follow up with you then.`,
    closing: ANYTHING_ELSE,
  };
}

export function callbackAskDay(partOfDay: string): Reply {
  return { lead: `Sure, ${partOfDay} works.`, closing: `Which day would you like the ${partOfDay} callback — today, tomorrow, or another day?` };
}

export function callbackInvalid(): Reply {
  return {
    lead: "Sorry, I couldn't use that time.",
    closing:
      "What day and time would suit you? For example, tomorrow afternoon or Monday at 10am. Or just say no if email is fine.",
  };
}

export function callbackDeclined(): Reply {
  return { lead: "No problem — the specialist will follow up with you by email.", closing: ANYTHING_ELSE };
}

export function alreadyEscalated(): Reply {
  return { lead: "This is already with our specialist team, and they will follow up with you.", closing: ANYTHING_ELSE };
}

export function escalationCancelled(): Reply {
  return { lead: "No problem, I won't pass this on.", closing: ANYTHING_ELSE };
}

// ---------- Tickets ----------

export function ticketAskReference(): Reply {
  return {
    lead: "I can open a support ticket for that.",
    closing:
      "Do you have the transaction reference? It looks like TXN-1234. If you don't have it, just say so and I'll open the ticket without it.",
  };
}

export function ticketCreated(): Reply {
  return {
    lead: "I've created a support ticket for this and our team will look into it. You'll be contacted with updates.",
    closing: ANYTHING_ELSE,
  };
}

// ---------- Errors and closings ----------

export function toolError(action: string): Reply {
  return {
    lead: `I'm sorry — I had trouble ${action} just now.`,
    closing: "Please try again in a moment, or I can arrange for the support team to follow up.",
  };
}

export function farewell(): Reply {
  return { lead: "Thank you for contacting RelayPay. Goodbye." };
}

export function thanksAcknowledge(): Reply {
  return { lead: "You're welcome.", closing: ANYTHING_ELSE };
}

export function farewellAfter(lead: string): Reply {
  return { lead: `${lead} Thank you for contacting RelayPay. Goodbye.` };
}
