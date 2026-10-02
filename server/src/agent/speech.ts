/**
 * Speech-friendly formatting for voice-channel responses.
 *
 * Deterministic templates emit database-literal strings ("2400 USD",
 * "TXN-9001") which text-to-speech engines read awkwardly: digits one by
 * one ("2 400"), currency codes letter by letter ("U S D"), and the hyphen
 * in references as "minus" ("T X N minus 9001"). These helpers render the
 * same data in spoken words so the voice reads it naturally. Text-channel
 * responses keep the canonical written forms.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const CURRENCY_WORDS: Record<string, string> = {
  USD: "US dollars",
  EUR: "euros",
  GBP: "pounds sterling",
  KES: "Kenyan shillings",
  NGN: "Nigerian naira",
  GHS: "Ghanaian cedis",
  RWF: "Rwandan francs",
};

/** "two thousand four hundred" style words for a non-negative integer. */
function numberToWords(n: number): string {
  if (n === 0) return "zero";
  if (n < 0) return `minus ${numberToWords(-n)}`;

  const parts: string[] = [];
  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;

  if (billions > 0) parts.push(`${numberToWords(billions)} billion`);
  if (millions > 0) parts.push(`${numberToWords(millions)} million`);
  if (thousands > 0) parts.push(`${belowThousand(thousands)} thousand`);
  if (rest > 0) {
    const words = belowThousand(rest);
    // "nine thousand AND one", but "two thousand four hundred" (no "and").
    const needsAnd = (billions > 0 || millions > 0 || thousands > 0) && rest < 100;
    parts.push(needsAnd ? `and ${words}` : words);
  }
  return parts.join(" ");
}

function belowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) {
    parts.push(`${ONES[hundreds]} hundred`);
    if (rest > 0) parts.push("and");
  }
  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]!);
    } else {
      const tens = TENS[Math.floor(rest / 10)]!;
      const unit = rest % 10;
      parts.push(unit > 0 ? `${tens}-${ONES[unit]!}` : tens);
    }
  }
  return parts.join(" ");
}

/** "2400" + "USD" -> "two thousand four hundred US dollars". */
export function spokenMoney(amount: string | number, currency: string): string {
  const parsed = Number.parseFloat(String(amount).replace(/[, ]/g, ""));
  const currencyWords = CURRENCY_WORDS[currency.toUpperCase()] ?? currency.toUpperCase().split("").join(" ");
  if (!Number.isFinite(parsed)) {
    // Unparseable amount: keep it verbatim but still expand the currency.
    return `${String(amount)} ${currencyWords}`;
  }
  const absolute = Math.abs(parsed);
  let whole = Math.trunc(absolute);
  let cents = Math.round((absolute - whole) * 100);
  if (cents === 100) {
    whole += 1;
    cents = 0;
  }
  const sign = parsed < 0 ? "minus " : "";
  // Money is read the way people say it: "twelve US dollars and five
  // cents", never "twelve point five" (which would mean 12.50).
  if (cents === 0) return `${sign}${numberToWords(whole)} ${currencyWords}`;
  return `${sign}${numberToWords(whole)} ${currencyWords} and ${numberToWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
}

/** "TXN-9001" -> "T X N nine zero zero one"; returns the input unchanged when it is not a reference. */
export function spokenReference(reference: string): string {
  const match = /^([A-Za-z]{2,5})-(\d{3,12})$/.exec(reference.trim());
  if (!match) return reference;
  const prefix = match[1]!.toUpperCase().split("").join(" ");
  const digits = match[2]!.split("").map((d) => ONES[Number(d)]!).join(" ");
  return `${prefix} ${digits}`;
}

const MONEY_IN_TEXT = /\b(\d[\d,]*(?:\.\d+)?)\s?(USD|EUR|GBP|KES|NGN|GHS|RWF)\b/g;
const REFERENCE_IN_TEXT = /\b([A-Za-z]{2,5})-(\d{3,12})\b/g;

/**
 * Formats every money amount and "ABC-123" style reference inside a
 * sentence for speech. Safe to run on any response: plain sentences pass
 * through unchanged.
 */
export function forSpeech(text: string): string {
  const withMoney = text.replace(MONEY_IN_TEXT, (_match, amount: string, currency: string) =>
    spokenMoney(amount, currency),
  );
  return withMoney.replace(REFERENCE_IN_TEXT, (reference, prefix: string, digits: string) =>
    // Guard: the money pass already consumed currency codes, so anything
    // matching here is a prefixed reference like TXN-9001 / PAY-7002.
    spokenReference(`${prefix}-${digits}`),
  );
}
