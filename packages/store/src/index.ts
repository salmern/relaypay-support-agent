export * from "./types.js";
export * from "./store.js";
export * from "./supabase-store.js";
export * from "./mock-store.js";
export * from "./knowledge-base.js";
export * from "./seed-data.js";
export * from "./retrieval.js";
export * from "./stopwords.js";
export * from "./factory.js";

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseKnowledgeBase } from "./knowledge-base.js";
import { loadSeedData } from "./seed-data.js";
import type { KnowledgeChunk } from "./types.js";

/** Walks up from a starting directory to locate a file by name. */
export function findUp(startDir: string, filename: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = `${dir}/${filename}`;
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolves the assets/ directory by locating the approved knowledge base
 * file (works from any workspace cwd and after compilation). Override
 * with RELAYPAY_ASSETS_DIR when running from an unusual location.
 */
export function resolveAssetsDir(startDir: string = process.cwd()): string {
  if (process.env.RELAYPAY_ASSETS_DIR) {
    return resolve(process.env.RELAYPAY_ASSETS_DIR);
  }
  const kbPath = findUp(startDir, "assets/relaypay-knowledge-base.md");
  if (!kbPath) {
    throw new Error(
      "Could not locate assets/relaypay-knowledge-base.md from " +
        `${startDir}. Set RELAYPAY_ASSETS_DIR to the repo's assets directory.`,
    );
  }
  return dirname(kbPath);
}

export function loadSeedFromAssets(startDir: string = process.cwd()) {
  return loadSeedData(`${resolveAssetsDir(startDir)}/seed-data`);
}

export function loadKnowledgeChunksFromAssets(startDir: string = process.cwd()): KnowledgeChunk[] {
  const kbPath = `${resolveAssetsDir(startDir)}/relaypay-knowledge-base.md`;
  return parseKnowledgeBase(readFileSync(kbPath, "utf8"));
}
