import { describe, expect, it } from "vitest";
import {
  classifyIntent,
  decide,
  extractIdentity,
  extractReferences,
  normalizeVoiceReferences,
} from "../src/agent/decision-engine.js";

describe("classifyIntent", () => {
  it("routes escalation language before everything else", () => {
    expect(classifyIntent("My account was restricted and nobody is helping me")).toBe("escalation");
    expect(classifyIntent("I want a refund now, this is unacceptable")).toBe("escalation");
    expect(classifyIntent("I need to verify my identity but the upload fails")).toBe("escalation");
  });

  it("routes guarantee questions to knowledge (Scenario 8)", () => {
    expect(classifyIntent("Can RelayPay guarantee my payout arrives by 9am tomorrow?")).toBe("knowledge");
  });

  it("routes explicit follow-up requests to ticket (Scenario 6)", () => {
    expect(classifyIntent("My invoice payment failed and I need someone to look at it")).toBe("ticket");
  });

  it("routes payout references to payout lookup", () => {
    expect(classifyIntent("What is happening with payout PAY-7002?")).toBe("payout_lookup");
  });

  it("routes transaction references to transaction lookup", () => {
    expect(classifyIntent("Can you check transaction TXN-9001?")).toBe("transaction_lookup");
  });

  it("routes account questions to account lookup", () => {
    expect(classifyIntent("Can you check my account?")).toBe("account_lookup");
  });

  it("routes fee questions to knowledge even when STT garbles the plural", () => {
    // Voice STT often drops the plural: "...for international payment"
    // (singular) used to match the generic-payment rule and trap the
    // customer in the payment-clarify loop (observed live on voice).
    expect(classifyIntent("What fees does RelayPay charge for international payment?")).toBe("knowledge");
    expect(classifyIntent("What fees does RelayPay charge for international payments?")).toBe("knowledge");
    expect(classifyIntent("how much does relaypay charge per transfer")).toBe("knowledge");
    expect(classifyIntent("What is your pricing?")).toBe("knowledge");
  });

  it("still looks up a reference when the question mentions fees", () => {
    expect(classifyIntent("What fees applied to payout PAY-7002?")).toBe("payout_lookup");
    expect(classifyIntent("What fees were charged on transaction TXN-9001?")).toBe("transaction_lookup");
  });
});

describe("decide", () => {
  it("asks for the payment type when a vague payment issue arrives (Scenario 2)", () => {
    const decision = decide("My payment is stuck.", { hasIdentity: false, hasReference: false });
    expect(decision.action).toBe("clarify");
    expect(decision.clarifyingQuestion).toMatch(/outgoing payout|incoming transfer|invoice payment/i);
  });

  it("does not guess payout status without a reference", () => {
    const decision = decide("My payout is late.", { hasIdentity: false, hasReference: false });
    expect(decision.action).toBe("clarify");
    expect(decision.rationale).toMatch(/must not guess/i);
  });

  it("escalates account restrictions with the account category (Scenario 7)", () => {
    const decision = decide("My account was restricted and nobody is helping me.", {
      hasIdentity: false,
      hasReference: false,
    });
    expect(decision.action).toBe("escalate");
    expect(decision.escalationCategory).toBe("account");
  });

  it("escalates compliance concerns", () => {
    const decision = decide("My KYC verification has been pending for weeks", {
      hasIdentity: false,
      hasReference: false,
    });
    expect(decision.action).toBe("escalate");
    expect(decision.escalationCategory).toBe("compliance");
  });

  it("answers general knowledge questions directly (Scenario 1)", () => {
    const decision = decide("What fees does RelayPay charge for international payments?", {
      hasIdentity: false,
      hasReference: false,
    });
    expect(decision.action).toBe("answer");
  });

  it("looks up a transaction when a reference is provided (Scenario 4)", () => {
    const decision = decide("Can you check transaction TXN-9001?", {
      hasIdentity: false,
      hasReference: true,
    });
    expect(decision.action).toBe("lookup");
    expect(decision.intent).toBe("transaction_lookup");
  });

  it("looks up an account when identity is provided (Scenario 3)", () => {
    const decision = decide("Can you check my account?", {
      hasIdentity: true,
      hasReference: false,
    });
    expect(decision.action).toBe("lookup");
    expect(decision.intent).toBe("account_lookup");
  });
});

describe("extractReferences / extractIdentity", () => {
  it("extracts transaction, payout and customer references", () => {
    expect(extractReferences("check TXN-9001 and PAY-7002 for CUS-1003")).toEqual({
      transactionId: "TXN-9001",
      payoutId: "PAY-7002",
      customerId: "CUS-1003",
    });
  });

  it("lowercase references are normalized to uppercase", () => {
    expect(extractReferences("txn-9005 please")).toEqual({
      transactionId: "TXN-9005",
      payoutId: undefined,
      customerId: undefined,
    });
  });

  it("extracts 'I am X from Y' identity", () => {
    const identity = extractIdentity("I am Amara from LagosLedger. Can you check my account?");
    expect(identity.contactName).toBe("Amara");
    expect(identity.companyName).toBe("LagosLedger");
  });

  it("treats a CUS reference as identity", () => {
    const identity = extractIdentity("It's CUS-1004, check the account");
    expect(identity.companyName).toBe("CUS-1004");
  });
});

describe("normalizeVoiceReferences", () => {
  it("converts spoken transaction references to canonical IDs", () => {
    expect(normalizeVoiceReferences("Can you check transaction TXN-nine thousand and 1?")).toBe(
      "Can you check transaction TXN-9001?",
    );
  });

  it("converts spoken payout references to canonical IDs", () => {
    expect(normalizeVoiceReferences("what is happening with payout nine thousand and two")).toBe(
      "what is happening with payout PAY-9002",
    );
  });

  it("converts digit-by-digit speech (TXN 9 0 0 1)", () => {
    expect(normalizeVoiceReferences("Can you check transaction TXN 9 0 0 1?")).toBe(
      "Can you check transaction TXN-9001?",
    );
  });

  it("handles oh for zero (nine oh oh one)", () => {
    expect(normalizeVoiceReferences("transaction TXN nine oh oh one please")).toBe(
      "transaction TXN-9001 please",
    );
  });

  it("leaves canonical text-channel references untouched", () => {
    const text = "Can you check transaction TXN-9001 and payout PAY-7002?";
    expect(normalizeVoiceReferences(text)).toBe(text);
  });

  it("does not rewrite ambiguous single words outside a reference", () => {
    const text = "I need help with a payment to one of my vendors";
    expect(normalizeVoiceReferences(text)).toBe(text);
  });

  it("accepts letter-by-letter prefixes (live STT shape: t x n 9 0 0 1)", () => {
    expect(normalizeVoiceReferences("Can you check transaction t x n 9 0 0 1? For me?")).toBe(
      "Can you check transaction TXN-9001? For me?",
    );
    expect(normalizeVoiceReferences("I said t x n 9 0 0 1. T x n 9 0 0 1.")).toBe(
      "I said TXN-9001. TXN-9001.",
    );
    expect(normalizeVoiceReferences("p a y 7 0 0 2")).toBe("pay PAY-7002");
  });

  it("handles trailing courtesy phrases after the digits (live STT shape)", () => {
    // "for me" used to break the strict number check and the whole
    // normalization bailed — the customer got the clarify loop instead
    // of a lookup (observed live).
    expect(normalizeVoiceReferences("Can you check transaction t x n 9 0 0 1 for me?")).toBe(
      "Can you check transaction TXN-9001 for me?",
    );
    expect(normalizeVoiceReferences("check TXN 9 0 0 1 please")).toBe("check TXN-9001 please");
  });

  it("still leaves non-reference tails untouched", () => {
    const text = "what happened with my payment for the invoice";
    expect(normalizeVoiceReferences(text)).toBe(text);
  });
});
