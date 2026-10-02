# Deliverable 2: MCP Server Implementation

## Repository

https://github.com/salmern/relaypay-support-agent

The MCP server lives in the `mcp-server/` workspace of the monorepo. It runs over **stdio** (spawned per conversation by the backend, scoped with `--conversation-id`) and exposes exactly the six required tools. The orchestrator calls all six; the Claude Agent SDK loop may call only the three read-only lookups.

## The six tools

| Tool | Purpose |
| --- | --- |
| `lookup_customer` | Find a customer by `customer_id`, `email`, or `company_name` |
| `lookup_transaction` | Find a transaction by `TXN-####` reference (amount, currency, status, customer-safe summary — staff instructions in the seed data are stripped) |
| `lookup_payout` | Find a payout by `PAY-####` reference or linked transaction (status, schedule, reason, linked customer and transaction) |
| `create_support_ticket` | Persist a support ticket (deduplicated per conversation + category + transaction) |
| `create_escalation` | Persist a human escalation with contact details (one open record per conversation + category; a repeat call fills in missing contact details, callback time, customer or ticket link) |
| `log_conversation_event` | Append decision / escalation / retrieval events for the audit trail |

Every tool call is also written to a `tool_calls` audit table (tool name, purpose, input summary with emails masked, result summary, status, error, timestamp). The customer UI's activity panel shows exactly these rows for each turn.

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
npm test             # 185 tests across store (27), server (143), mcp-server (15)
```

`npm run mcp:smoke` is the fastest way to prove the server works without a call: it starts the stdio MCP client, lists tools, performs seeded lookups (TXN-9001, PAY-7002), creates and deduplicates a ticket and an escalation, and checks the audit rows.

## How the backend uses it

The backend (`server/`) spawns one MCP subprocess per active conversation (`RelayPayMcpClient.spawn(conversationId)`), shares it between concurrent turns, closes it when the conversation ends (or after `MCP_IDLE_MS` idle), and respawns it once if it dies. State is shared through `MOCK_STORE_PATH` (mock mode) or the Supabase project (supabase mode). The decision engine selects the tool calls; the MCP server is the only path to the data. The Agent SDK mounts the same server with only the read-only lookups allowed, and its MCP config carries no environment variables (the SDK places that config on a command line). Tool schemas are defined in `mcp-server/src/tools/`.
