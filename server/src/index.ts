/**
 * Server entrypoint.
 * Required env: none strictly — runs with mock store + rules responder
 * for local testing; set SUPABASE_*, ANTHROPIC_API_KEY and VAPI_* for
 * the full production flow.
 */
import {
  createStore,
  loadKnowledgeChunksFromAssets,
  loadRootDotenv,
  loadSeedFromAssets,
} from "@relaypay/store";
import { buildApp } from "./app.js";

// Load the repo-root `.env` before anything reads process.env.
loadRootDotenv();

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const store = createStore();
  const chunks = loadKnowledgeChunksFromAssets();

  // Seed on boot for the mock provider so local runs always have data.
  if ((process.env.DATA_PROVIDER ?? "mock") === "mock") {
    const seed = loadSeedFromAssets();
    await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });
  }

  const app = buildApp({
    store,
    knowledgeChunks: chunks,
    corsOrigins,
    vapiServerSecret: process.env.VAPI_SERVER_SECRET,
  });

  await app.listen({ port, host: "0.0.0.0" });
  process.stdout.write(
    `RelayPay support agent API listening on :${port} ` +
      `(responder=${process.env.ANTHROPIC_API_KEY ? "claude" : "rules"}, ` +
      `data=${process.env.DATA_PROVIDER ?? "mock"})\n`,
  );
}

// Touch a marker file so `npm run dev` output shows the server booted.
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
