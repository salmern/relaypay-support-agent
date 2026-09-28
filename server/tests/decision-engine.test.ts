import { describe, expect, it } from "vitest";
import { classifyIntent, decide, extractIdentity, extractReferences } from "../src/agent/decision-engine.js";

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
