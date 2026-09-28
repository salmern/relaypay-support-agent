/**
 * RelayPay custom MCP server (stdio transport).
 *
 * Implements the six tools required by assets/mcp-tool-requirements.md:
 *   lookup_customer, lookup_transaction, lookup_payout,
 *   create_support_ticket, create_escalation, log_conversation_event
 *
 * Every call is audited to the tool_calls table. The conversation scope
 * is provided by the orchestrator via RELAYPAY_CONVERSATION_ID.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStore } from "@relaypay/store";
import { type ToolContext } from "./context.js";
import {
  lookupCustomerTool,
  lookupCustomerInputSchema,
  handleLookupCustomer,
} from "./tools/lookup-customer.js";
import {
  lookupTransactionTool,
  lookupTransactionInputSchema,
  handleLookupTransaction,
} from "./tools/lookup-transaction.js";
import {
  lookupPayoutTool,
  lookupPayoutInputSchema,
  handleLookupPayout,
} from "./tools/lookup-payout.js";
import {
  createTicketTool,
  createTicketInputSchema,
  handleCreateTicket,
} from "./tools/create-ticket.js";
import {
  createEscalationTool,
  createEscalationInputSchema,
  handleCreateEscalation,
} from "./tools/create-escalation.js";
import {
  logEventTool,
  logEventInputSchema,
  handleLogEvent,
} from "./tools/log-event.js";

const conversationId = process.env.RELAYPAY_CONVERSATION_ID ?? "";

const store = createStore();

const ctx: ToolContext = {
  store,
  getConversationId: () => process.env.RELAYPAY_CONVERSATION_ID ?? conversationId,
};

const server = new McpServer({
  name: "relaypay-support-mcp",
  version: "1.0.0",
});

// Register the six required tools with explicit zod schemas.
server.tool(
  lookupCustomerTool.name,
  lookupCustomerTool.description,
  lookupCustomerInputSchema,
  async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleLookupCustomer(ctx, input)) }] }),
);

server.tool(
  lookupTransactionTool.name,
  lookupTransactionTool.description,
  lookupTransactionInputSchema,
  async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleLookupTransaction(ctx, input)) }] }),
);

server.tool(
  lookupPayoutTool.name,
  lookupPayoutTool.description,
  lookupPayoutInputSchema,
  async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleLookupPayout(ctx, input)) }] }),
);

server.tool(
  createTicketTool.name,
  createTicketTool.description,
  createTicketInputSchema,
  async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleCreateTicket(ctx, input)) }] }),
);

server.tool(
  createEscalationTool.name,
  createEscalationTool.description,
  createEscalationInputSchema,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await handleCreateEscalation(ctx, input, conversationId)) }],
  }),
);

server.tool(
  logEventTool.name,
  logEventTool.description,
  logEventInputSchema,
  async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleLogEvent(ctx, input)) }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[mcp] relaypay-support-mcp listening on stdio\n");
