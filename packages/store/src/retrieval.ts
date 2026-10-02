/**
 * Deterministic keyword retrieval over the approved knowledge base.
 * Scoring: TF-IDF with a title boost. Stop words are filtered from the
 * query AND from chunk text, and tokens are lightly stemmed so plural /
 * tense variants and short forms match ("payments" ~ "payment",
 * "crypto" ~ "cryptocurrency"). Returns scored chunks so callers can
 * decide whether relevant approved knowledge exists at all.
 */
import { stopwords } from "./stopwords.js";
import type { KnowledgeChunk } from "./types.js";

export interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
}

export interface RetrievalResult {
  query: string;
  matches: ScoredChunk[];
  bestScore: number;
  /** True when at least one chunk passed the relevance threshold. */
  relevant: boolean;
  /** True when the match came from exact FAQ-question routing. */
  exactFaq: boolean;
}

/**
 * Minimum score for the best chunk. Calibrated on a battery of supported
 * and unsupported questions: off-topic queries ("Help", "Tomorrow
 * afternoon", "What are your opening hours?") top out around 4.3, while
 * the weakest genuinely supported ones ("Do you support crypto
 * payments?", "Do you offer instant payments?") score 6.6+. See
 * packages/store/tests/store.test.ts for the regression battery.
 */
export const RELEVANCE_THRESHOLD = 5.5;

/** Secondary chunks must score at least this share of the best chunk. */
const SECONDARY_RATIO = 0.6;

/**
 * Exact-FAQ routing pre-pass.
 *
 * Some legitimate questions defeat TF-IDF scoring not because the
 * knowledge is missing but because the query's only meaningful tokens
 * are ubiquitous ("RelayPay" appears in most chunks → IDF ≈ 0). When the
 * user's question IS a question the knowledge base explicitly answers
 * ("What is RelayPay?" → "What Is RelayPay?"), routing to that section
 * deterministically is more faithful than declining.
 *
 * Matching is exact but separator-insensitive, and runs per sentence, so
 * "what is relay pay?" (STT splits the brand) and repeated speech ("What
 * is Relay Pay? Relay Pay?") still route. A sentence must equal the
 * WHOLE heading — paraphrases fall through to scored retrieval.
 */
export function routeFaqQuestion(
  chunks: KnowledgeChunk[],
  query: string,
): ScoredChunk | null {
  const key = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sentences = query.split(/[?!.]+/);
  for (const chunk of chunks) {
    const headingKey = key(chunk.heading);
    if (headingKey === "") continue;
    for (const sentence of sentences) {
      if (key(sentence) === headingKey) {
        return { chunk, score: RELEVANCE_THRESHOLD };
      }
    }
  }
  return null;
}

/** Light English stemmer: enough to merge plurals and common suffixes. */
export function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && /(ss|x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopwords.has(token))
    .map(stem);
}

/**
 * Two stemmed tokens match when equal, or when the shorter one (at least
 * five characters) is a prefix of the longer ("crypto" ~
 * "cryptocurrency", "invoic" ~ "invoice").
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function containsToken(tokens: string[], token: string): boolean {
  return tokens.some((candidate) => tokensMatch(candidate, token));
}

export function retrieveKnowledge(
  chunks: KnowledgeChunk[],
  query: string,
  topK = 3,
): RetrievalResult {
  const routed = routeFaqQuestion(chunks, query);
  if (routed) {
    return { query, matches: [routed], bestScore: routed.score, relevant: true, exactFaq: true };
  }
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) {
    return { query, matches: [], bestScore: 0, relevant: false, exactFaq: false };
  }

  const docs = chunks.map((chunk) => ({
    chunk,
    titleTokens: [...new Set(tokenize(`${chunk.title} ${chunk.heading}`))],
    bodyTokens: [...new Set(tokenize(chunk.content))],
  }));
  const idf = new Map<string, number>();
  for (const token of queryTokens) {
    const df = docs.filter(
      (doc) => containsToken(doc.titleTokens, token) || containsToken(doc.bodyTokens, token),
    ).length;
    // Sharpened IDF: rare, discriminating terms (e.g. "guarantee") must
    // outweigh common ones (e.g. "payout", "payment").
    if (df > 0) idf.set(token, Math.pow(Math.log((chunks.length + 1) / (df + 0.5)) + 0.1, 1.2));
  }

  const matches: ScoredChunk[] = [];
  for (const doc of docs) {
    let score = 0;
    let titleMatchCount = 0;
    for (const token of queryTokens) {
      const weight = idf.get(token);
      if (weight === undefined) continue;
      if (containsToken(doc.titleTokens, token)) {
        score += 2 * weight;
        titleMatchCount += 1;
      }
      if (containsToken(doc.bodyTokens, token)) score += weight;
    }
    // FAQ-title boost: several query terms in the section title means
    // that section is almost certainly the direct answer.
    if (titleMatchCount >= 2) score *= 1 + 1.5 * (titleMatchCount - 1);
    if (score > 0) matches.push({ chunk: doc.chunk, score });
  }

  matches.sort((a, b) => b.score - a.score);
  const bestScore = matches[0]?.score ?? 0;
  const relevant = bestScore >= RELEVANCE_THRESHOLD;
  // Only chunks close to the best one count as supporting context, so a
  // weak third match is never cited as a source.
  const top = matches
    .slice(0, topK)
    .filter((m, index) => index === 0 || (m.score >= RELEVANCE_THRESHOLD && m.score >= bestScore * SECONDARY_RATIO));

  return { query, matches: top, bestScore, relevant, exactFaq: false };
}

/**
 * Extracts the part of a chunk that actually answers the query.
 *
 * Short FAQ answers (up to three sentences, no list) are returned whole —
 * they ARE the answer, including a leading "No." or "Yes.". Longer
 * sections are split into units (sentences, and list items joined to the
 * line that introduces them, e.g. "RelayPay does not support:
 * cryptocurrency payments."), scored by query-token overlap, and the best
 * one or two units are returned in their original order. Markdown list
 * markers never leak into the answer.
 */
export function extractAnswer(content: string, query: string, maxUnits = 2): string {
  const blocks = content.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const isList = (block: string) => block.split("\n").every((line) => /^\s*[-*]\s+/.test(line));
  const sentencesOf = (text: string) =>
    text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);

  const hasList = blocks.some(isList);
  const allSentences = blocks.filter((b) => !isList(b)).flatMap(sentencesOf);
  if (!hasList && allSentences.length <= 3) return allSentences.join(" ");

  const units: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (isList(block)) continue;
    const next = blocks[i + 1];
    if (block.endsWith(":") && next && isList(next)) {
      const intro = block.replace(/\s+/g, " ").replace(/:$/, "");
      for (const line of next.split("\n")) {
        const item = line.replace(/^\s*[-*]\s+/, "").trim().replace(/[.;,]$/, "");
        if (item) units.push(`${intro} ${item.charAt(0).toLowerCase()}${item.slice(1)}.`);
      }
      continue;
    }
    units.push(...sentencesOf(block));
  }

  const queryTokens = [...new Set(tokenize(query))];
  const scored = units.map((unit, index) => {
    const unitTokens = tokenize(unit);
    const overlap = queryTokens.filter((token) => containsToken(unitTokens, token)).length;
    return { unit, index, overlap };
  });
  // A second unit is added only when it is as relevant as the best one,
  // so a list item sharing just the intro's words never tags along.
  const topOverlap = Math.max(0, ...scored.map((s) => s.overlap));
  const best = scored
    .filter((s) => s.overlap > 0 && s.overlap === topOverlap)
    .sort((a, b) => a.index - b.index)
    .slice(0, maxUnits)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.unit);
  if (best.length > 0) return best.join(" ");
  return (allSentences.length > 0 ? allSentences : units).slice(0, maxUnits).join(" ");
}
