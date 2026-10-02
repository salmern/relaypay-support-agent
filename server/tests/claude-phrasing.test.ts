/**
 * The Claude Agent SDK path, with the model call mocked: Claude rewords
 * every statement (as the real model does), and the multi-turn flows must
 * still work — state lives in the audit events, and the required next step
 * (contact ask, callback question, offers) is appended verbatim. A rewrite
 * that drops a fact is rejected in favour of the deterministic wording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledgeChunksFromAssets, loadSeedFromAssets, MockFileStore } from "@relaypay/store";

const runClaudeAgent = vi.fn();
vi.mock("../src/agent/claude-runner.js", () => ({ runClaudeAgent: (...args: unknown[]) => runClaudeAgent(...args) }));

const { SupportOrchestrator } = await import("../src/orchestrator.js");

let storePath: string;
let orchestrator: InstanceType<typeof SupportOrchestrator>;
let previousMockPath: string | undefined;

/** Reword like a chatty model: new opener, same DRAFT facts, plus an unwanted question. */
function rewordDraft(prompt: string): string {
  const draft = prompt.match(/DRAFT \(approved content for this turn\): "([\s\S]*?)"\n/)?.[1] ?? "";
  return `Absolutely, happy to help. ${draft} Would you like a call on your phone number?`;
}

beforeEach(async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  storePath = join(mkdtempSync(join(tmpdir(), "relaypay-claude-")), "store.json");
  const seed = loadSeedFromAssets();
  const chunks = loadKnowledgeChunksFromAssets();
  const store = new MockFileStore({ filePath: storePath, seed, knowledgeChunks: chunks });
  await store.seedIfEmpty({ ...seed, knowledgeChunks: chunks });
  previousMockPath = process.env.MOCK_STORE_PATH;
  process.env.MOCK_STORE_PATH = storePath;
  orchestrator = new SupportOrchestrator(store, chunks);
  runClaudeAgent.mockReset();
  runClaudeAgent.mockImplementation(async ({ turnPrompt }: { turnPrompt: string }) => ({
    text: rewordDraft(turnPrompt),
    toolCalls: [],
    isError: false,
    errorMessage: null,
  }));
});

afterEach(async () => {
  await orchestrator.dispose();
  delete process.env.ANTHROPIC_API_KEY;
  if (previousMockPath === undefined) delete process.env.MOCK_STORE_PATH;
  else process.env.MOCK_STORE_PATH = previousMockPath;
});

const turn = (conversationId: string, userMessage: string) =>
  orchestrator.handleTurn({ conversationId, channel: "text", userMessage });

describe("Claude phrasing keeps multi-turn flows working", () => {
  it("completes a full escalation with reworded replies", async () => {
    const first = await turn("c-esc", "My account was restricted and nobody is helping me.");
    expect(first.responder).toBe("claude");
    expect(first.response).toMatch(/^Absolutely, happy to help\./);
    // The model's own question is dropped; the required ask is appended verbatim.
    expect(first.response).not.toMatch(/phone/i);
    expect(first.response).toMatch(/Could I take your name and email/);

    const second = await turn("c-esc", "My name is Salman and my email is salman@example.com");
    expect(second.escalationId).toMatch(/^ESC-/);
    expect(second.response).toMatch(/book a callback/i);

    const third = await turn("c-esc", "Tomorrow afternoon");
    expect(third.response).toMatch(/tomorrow afternoon/i);
    const data = JSON.parse(readFileSync(storePath, "utf8")) as { escalations: Array<{ user_email: string; call_booked: boolean }> };
    expect(data.escalations).toHaveLength(1);
    expect(data.escalations[0]!.user_email).toBe("salman@example.com");
    expect(data.escalations[0]!.call_booked).toBe(true);
  });

  it("starts the escalation when 'yes please' follows a reworded decline", async () => {
    await turn("c-decline", "What is the airspeed velocity of an unladen swallow?");
    const second = await turn("c-decline", "yes please");
    expect(second.answerType).toBe("escalation");
    expect(second.awaiting).toBe("contact");
  });

  it("rejects a rewrite that changes a fact and uses the deterministic wording", async () => {
    runClaudeAgent.mockImplementation(async () => ({
      text: "I found transaction TXN-9001. It's a payout of 2500 USD and it has completed.",
      toolCalls: [],
      isError: false,
      errorMessage: null,
    }));
    const result = await turn("c-facts", "Can you check transaction TXN-9001?");
    expect(result.responder).toBe("rules");
    expect(result.response).toContain("2400 USD");
    expect(result.response).toMatch(/processing/);
  });

  it("falls back to the deterministic wording when the model errors", async () => {
    runClaudeAgent.mockImplementation(async () => ({ text: "", toolCalls: [], isError: true, errorMessage: "timed out" }));
    const result = await turn("c-error", "What fees does RelayPay charge for international payments?");
    expect(result.responder).toBe("rules");
    expect(result.response).toMatch(/fees vary/i);
  });
});
