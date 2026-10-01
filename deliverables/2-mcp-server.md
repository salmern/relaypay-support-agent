# Deliverable 2: MCP Server Implementation

## Repository

https://github.com/salmern/relaypay-support-agent

The MCP server lives in the `mcp-server/` workspace of the monorepo. It runs locally over **stdio** (spawned per conversation by the backend) and exposes exactly the six tools the orchestrator is allowed to call.

## The six tools

| Tool | Purpose |
| --- | --- |
| `lookup_customer` | Find a customer by `customer_id`, `email`, or `company_name` |
| `lookup_transaction` | Find a transaction by `TXN-####` reference (amount, currency, status, support summary) |
| `lookup_payout` | Find a payout by `PAY-####` reference or linked transaction |
| `create_support_ticket` | Persist a support ticket (deduplicated per conversation + category) |
| `create_escalation` | Persist a human escalation with contact details (deduplicated per conversation + category) |
| `log_conversation_event` | Append decision / escalation / retrieval events for the audit trail |

Every tool call is also written to a `tool_calls` audit table (tool name, input summary, status, timestamps).

## Prerequisites

- Node.js >= 20 (developed on Node 22/24)
- npm (workspaces; no global installs needed)
- No API keys required to run the MCP server itself

## Setup

```bash
git clone https://github.com/salmern/relaypay-support-agent.git
cd relaypay-support-agent
npm install
```

Create a `.env` in the repo root (see `.env.example` for the full annotated list). For a credential-free run:

```bash
DATA_PROVIDER=mock
MOCK_STORE_PATH=./data/mock-store.json
```

For the real database:

```bash
DATA_PROVIDER=supabase
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side only, never in the browser
```

## Run and verify

```bash
npm run build        # compiles all workspaces (store, mcp-server, server, evaluation)
npm run mcp:smoke    # spawns the MCP server over stdio, calls the 6 tools, prints PASS/FAIL per check
npm test             # 123 tests across store (21), server (90), mcp-server (12)
```

`npm run mcp:smoke` is the fastest way to prove the server works without a call: it starts the stdio MCP client, lists tools, performs seeded lookups (TXN-9001, PAY-7002), creates and deduplicates a ticket and an escalation, and checks the audit rows.

## How the backend uses it

The backend (`server/`) spawns one MCP subprocess per conversation (`RelayPayMcpClient.spawn(conversationId)`) and shares state through `MOCK_STORE_PATH` (mock mode) or the Supabase project (supabase mode). The orchestrator's decision engine selects the tool calls; the MCP server is the only path to the data. Tool schemas are defined in `mcp-server/src/tools/`.
