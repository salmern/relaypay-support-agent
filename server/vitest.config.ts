import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    environment: "node",
    // The orchestrator tests spawn real MCP server subprocesses; run
    // them sequentially in forked workers so stdio pipes are managed
    // cleanly and stores stay deterministic.
    pool: "forks",
    fileParallelism: false,
  },
});
