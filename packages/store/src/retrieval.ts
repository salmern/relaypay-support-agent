/**
 * Deterministic keyword retrieval over the approved knowledge base.
 * Scoring: TF-IDF with a title boost. Stop words are filtered from the
 * query AND from chunk text. Returns scored chunks so callers can decide
 * whether relevant approved knowledge exists at all.
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
}

const RELEVANCE_THRESHOLD = 2;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopwords.has(token));
}

export function retrieveKnowledge(
  chunks: KnowledgeChunk[],
  query: string,
  topK = 3,
): RetrievalResult {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { query, matches: [], bestScore: 0, relevant: false };
  }

  // Precompute per-chunk term sets and document frequencies (for IDF).
  const docs = chunks.map((chunk) => {
    const titleTokens = new Set(tokenize(`${chunk.title} ${chunk.heading}`));
    const bodyTokens = new Set(tokenize(chunk.content));
    return { chunk, titleTokens, bodyTokens };
  });
  const docFrequency = new Map<string, number>();
  for (const token of new Set(queryTokens)) {
    let df = 0;
    for (const doc of docs) {
      if (doc.titleTokens.has(token) || doc.bodyTokens.has(token)) df += 1;
    }
    docFrequency.set(token, df);
  }

  const matches: ScoredChunk[] = [];
  for (const doc of docs) {
    let score = 0;
    let titleMatchCount = 0;
    for (const token of new Set(queryTokens)) {
      const df = docFrequency.get(token) ?? 0;
      if (df === 0) continue;
      // Sharpened IDF: rare, discriminating terms (e.g. "guarantee",
      // "timelines") must outweigh common ones (e.g. "payout", "payment").
      const idf = Math.pow(Math.log((chunks.length + 1) / (df + 0.5)) + 0.1, 1.2);
      if (doc.titleTokens.has(token)) {
        score += 2 * idf;
        titleMatchCount += 1;
      }
      if (doc.bodyTokens.has(token)) score += 1 * idf;
    }
    // FAQ-title boost: when several query terms appear in the section
    // title, that section is almost certainly the direct answer (e.g.
    // "Can RelayPay Guarantee Payment Timelines?").
    if (titleMatchCount >= 2) {
      score *= 1 + 1.5 * (titleMatchCount - 1);
    }
    if (score > 0) {
      matches.push({ chunk: doc.chunk, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, topK);
  const bestScore = top.length > 0 ? top[0]!.score : 0;

  return {
    query,
    matches: top,
    bestScore,
    relevant: bestScore >= RELEVANCE_THRESHOLD,
  };
}
