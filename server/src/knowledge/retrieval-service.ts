/**
 * Knowledge retrieval service.
 *
 * Retrieval runs against the approved RelayPay knowledge base (loaded
 * from assets/relaypay-knowledge-base.md, or the kb_chunks table once
 * seeded). Every retrieval is logged to retrieval_logs with the query,
 * chunk IDs, source title and summary — including misses.
 */
import {
  retrieveKnowledge,
  type KnowledgeChunk,
  type RetrievalResult,
  type Store,
} from "@relaypay/store";

export interface GroundedKnowledge {
  query: string;
  found: boolean;
  /** Assembled approved context for the responder. */
  context: string;
  chunks: Array<{ id: string; title: string; summary: string }>;
  sourceTitle: string;
  sourceSummary: string;
}

const KB_SOURCE_TITLE = "RelayPay Knowledge Base (approved)";

export class RetrievalService {
  constructor(
    private readonly store: Store,
    private readonly chunks: KnowledgeChunk[],
  ) {}

  async retrieve(query: string, conversationId: string | null): Promise<GroundedKnowledge> {
    const result: RetrievalResult = retrieveKnowledge(this.chunks, query);
    const relevant = result.relevant ? result.matches : [];
    const found = relevant.length > 0;

    const context = found
      ? relevant
          .map((m) => `[${m.chunk.id}] ${m.chunk.title}\n${m.chunk.content}`)
          .join("\n\n---\n\n")
      : "";

    if (conversationId) {
      const sourceTitle = found ? this.sourceTitleFor(relevant) : KB_SOURCE_TITLE;
      const sourceSummary = found
        ? relevant.map((m) => `${m.chunk.title}: ${m.chunk.summary}`).join(" | ").slice(0, 500)
        : "No relevant approved knowledge found — agent must not answer from memory";
      await this.store.addRetrievalLog({
        conversation_id: conversationId,
        query,
        knowledge_chunks: relevant.map((m) => m.chunk.id),
        source_title: sourceTitle,
        source_summary: sourceSummary,
      });
    }

    return {
      query,
      found,
      context,
      chunks: relevant.map((m) => ({ id: m.chunk.id, title: m.chunk.title, summary: m.chunk.summary })),
      sourceTitle: found ? this.sourceTitleFor(relevant) : KB_SOURCE_TITLE,
      sourceSummary: found
        ? relevant.map((m) => `${m.chunk.title}: ${m.chunk.summary}`).join(" | ").slice(0, 500)
        : "No relevant approved knowledge found",
    };
  }

  private sourceTitleFor(matches: RetrievalResult["matches"]): string {
    return matches.map((m) => m.chunk.title).join(" + ");
  }
}
