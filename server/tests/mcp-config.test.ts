/**
 * Security regressions for the Agent SDK wiring.
 */
import { describe, expect, it } from "vitest";
import { MCP_READ_ONLY_TOOLS, MCP_WRITE_TOOLS, stdioServerConfig } from "../src/agent/mcp-client.js";

describe("Agent SDK MCP config", () => {
  it("never carries environment variables (the SDK puts the config on a command line)", () => {
    const config = stdioServerConfig("conv-1")["relaypay-support"] as unknown as Record<string, unknown>;
    expect(config.env).toBeUndefined();
    expect(JSON.stringify(config)).not.toMatch(/KEY|SECRET|TOKEN/);
    expect(config.args).toContain("--conversation-id");
  });

  it("lets Claude call only the read-only lookup tools", () => {
    expect(MCP_READ_ONLY_TOOLS).toEqual([
      "mcp__relaypay-support__lookup_customer",
      "mcp__relaypay-support__lookup_transaction",
      "mcp__relaypay-support__lookup_payout",
    ]);
    expect(MCP_WRITE_TOOLS).toHaveLength(3);
  });
});
