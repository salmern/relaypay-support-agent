/**
 * Idempotent seed process.
 *
 * Loads customers, transactions, payouts (assets/seed-data/*.csv) and the
 * approved knowledge chunks (assets/relaypay-knowledge-base.md), then
 * upserts them by stable ID. Running it multiple times is safe — no
 * duplicates are created.
 *
 * Run: npm run seed  (respects DATA_PROVIDER)
 */
import {
  createStore,
  loadKnowledgeChunksFromAssets,
  loadRootDotenv,
  loadSeedFromAssets,
} from "@relaypay/store";

// Load the repo-root `.env` before anything reads process.env.
loadRootDotenv();

async function main(): Promise<number> {
  const seed = loadSeedFromAssets();
  const chunks = loadKnowledgeChunksFromAssets();
  const store = createStore();

  console.log(
    `Seeding with DATA_PROVIDER=${process.env.DATA_PROVIDER ?? "mock"}: ` +
      `${seed.customers.length} customers, ${seed.transactions.length} transactions, ` +
      `${seed.payouts.length} payouts, ${chunks.length} knowledge chunks...`,
  );

  await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });

  console.log("Seed complete (idempotent upserts by stable ID).");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
