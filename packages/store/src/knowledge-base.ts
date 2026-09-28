/**
 * Parses the approved RelayPay knowledge base markdown file into
 * retrievable chunks. Structural headings ("## X", "### Y") become the
 * title; the chunk contains the section body up to the next heading.
 */
import { readFileSync } from "node:fs";
import type { KnowledgeChunk } from "./types.js";

function titleize(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarize(content: string): string {
  const firstSentence = content
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s/)
    .find((s) => s.trim().length > 20);
  return (firstSentence ?? content.slice(0, 120)).trim().slice(0, 200);
}

export function parseKnowledgeBase(markdown: string): KnowledgeChunk[] {
  const lines = markdown.split("\n");
  const chunks: KnowledgeChunk[] = [];
  let currentSection = "";
  let heading = "";
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content.length === 0) {
      buffer = [];
      return;
    }
    const title = [currentSection, heading].filter(Boolean).join(" — ");
    chunks.push({
      id: `KB-${String(chunks.length + 1).padStart(3, "0")}`,
      title,
      heading,
      content,
      summary: summarize(content),
    });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentSection = line.slice(3).trim();
      heading = "";
      continue;
    }
    if (line.startsWith("### ")) {
      flush();
      heading = line.slice(4).trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  // Fallback title when the KB has no structural headings at all.
  if (chunks.length > 0 && chunks.every((c) => c.title === "")) {
    for (const chunk of chunks) {
      chunk.title = titleize(chunk.id);
    }
  }
  return chunks;
}

export function loadKnowledgeBase(path: string): KnowledgeChunk[] {
  return parseKnowledgeBase(readFileSync(path, "utf8"));
}
