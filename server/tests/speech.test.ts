/**
 * Unit tests for voice-channel speech formatting (server/src/agent/speech.ts).
 *
 * Regression tests for the live-call issue where the TTS voice read
 * "2400 USD" digit-by-digit and "TXN-9001" as "TXN minus 9001".
 */
import { describe, expect, it } from "vitest";
import { forSpeech, spokenMoney, spokenReference } from "../src/agent/speech.js";

describe("spokenMoney", () => {
  it("spells the seeded transaction amount in words", () => {
    expect(spokenMoney("2400", "USD")).toBe("two thousand four hundred US dollars");
  });

  it("spells the seeded delayed transfer amount", () => {
    expect(spokenMoney("3100", "EUR")).toBe("three thousand one hundred euros");
  });

  it("expands every seeded currency code", () => {
    expect(spokenMoney("5300", "GBP")).toBe("five thousand three hundred pounds sterling");
    expect(spokenMoney("1", "KES")).toBe("one Kenyan shillings");
  });

  it("handles thousands separators and decimals", () => {
    expect(spokenMoney("1,250.50", "USD")).toBe("one thousand two hundred and fifty point fifty US dollars");
  });

  it("keeps the raw amount but expands unknown currency codes", () => {
    expect(spokenMoney("42", "XYZ")).toBe("forty-two X Y Z");
  });

  it("keeps a non-numeric amount verbatim", () => {
    expect(spokenMoney("varies", "USD")).toBe("varies US dollars");
  });
});

describe("spokenReference", () => {
  it("spells the seeded transaction reference without the hyphen", () => {
    expect(spokenReference("TXN-9001")).toBe("T X N nine zero zero one");
  });

  it("spells payout references", () => {
    expect(spokenReference("PAY-7002")).toBe("P A Y seven zero zero two");
  });

  it("passes through anything that is not a prefixed reference", () => {
    expect(spokenReference("processing")).toBe("processing");
    expect(spokenReference("TXN9001")).toBe("TXN9001");
  });
});

describe("forSpeech", () => {
  it("formats the transaction-found response exactly as the voice should read it", () => {
    expect(
      forSpeech(
        "I found transaction TXN-9001. It's an outgoing payout of 2400 USD, and the current status is processing. Payout is processing within the normal expected window.",
      ),
    ).toBe(
      "I found transaction T X N nine zero zero one. It's an outgoing payout of two thousand four hundred US dollars, and the current status is processing. Payout is processing within the normal expected window.",
    );
  });

  it("formats multiple amounts and references in one response", () => {
    expect(forSpeech("TXN-9002 completed for 1200 EUR; PAY-7003 still processing."))
      .toBe("T X N nine zero zero two completed for one thousand two hundred euros; P A Y seven zero zero three still processing.");
  });

  it("leaves plain sentences unchanged", () => {
    const plain = "Could I take your name and email so the specialist can follow up with you?";
    expect(forSpeech(plain)).toBe(plain);
  });

  it("does not mangle lowercase letter-number pairs without a hyphen", () => {
    expect(forSpeech("call me on extension 9001")).toBe("call me on extension 9001");
  });
});
