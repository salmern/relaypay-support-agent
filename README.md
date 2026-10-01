# RelayPay Support Agent — Week 6 Capstone

A production-style **customer support voice agent** for RelayPay, a fictional
B2B cross-border payments and invoicing company.

Built to the Week 6 specification: **Vapi** for voice, **Claude Agent SDK**
for the support brain, a **custom MCP server** for support tools, **Supabase**
for data, and a retrieval layer grounded in the approved RelayPay knowledge
base.

```
Customer (voice / text)
   │
   ▼
Vapi voice interface  (voice only: STT / TTS / call events)
   │  function tool: support_agent(transcript)
   ▼
Backend API (Fastify)  ── text test mode: POST /api/conversations/:id/turns
   │
   ▼
Decision engine (deterministic rules)  →  Knowledge retrieval (approved KB)
   │                                            │
   ▼                                            ▼
Claude Agent SDK  ────── tool loop ────►  MCP server (custom, stdio)
                                            ├── lookup_customer
                                            ├── lookup_transaction
                                            ├── lookup_payout
                                            ├── create_support_ticket
                                            ├── create_escalation
                                            └── log_conversation_event
                                                 │
                                                 ▼
                                              Supabase
```

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/store` | Shared data layer: types, Store interface, Supabase + mock implementations, KB chunker, seed parser, retrieval |
| `mcp-server` | The custom MCP server (stdio) with the six required tools + audit logging |
| `server` | Backend API (Fastify): orchestrator, decision engine, Claude Agent SDK runner, Vapi webhook, debug endpoints, seed script |
| `web` | Voice-first React UI (Vapi web SDK) with text test mode and an agent-activity panel |
| `evaluation` | `npm run evaluate` — runs all Week 6 scenarios and stores evidence records |
| `supabase/migrations` | SQL schema (all 11 tables, RLS on) |
| `vapi` | Vapi assistant configuration + setup guide |
| `assets` | The provided, unmodified Week 6 specification and seed data |

## Quick start (local, no credentials)

```bash
npm install
npm run build        # store → mcp-server → server → evaluation
npm run seed         # loads seed data + knowledge chunks (mock store)
npm run dev:server   # backend on :8787  (rules responder, mock data)
npm run dev:web      # UI on http://localhost:5173
```

Without any API keys the system is fully runnable: the deterministic
responder phrases replies, and the mock file store replaces Supabase.
Every decision, lookup, ticket, escalation and log record is real.

## Environment variables

Copy `.env.example` → `.env` (backend) and `web/.env` for the Vite vars.
All variables, their classification and their purpose are documented in
[.env.example](.env.example). Summary:

| Variable | Required | Used for |
| --- | --- | --- |
| `DATA_PROVIDER` | yes | `supabase` (production) or `mock` (tests/local) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | when provider=supabase | server-side database access |
| `ANTHROPIC_API_KEY` | for Claude responses | Claude Agent SDK; without it the rules responder is used |
| `CLAUDE_MODEL` | optional | model override (default claude-sonnet-4-5) |
| `VITE_VAPI_PUBLIC_KEY`, `VITE_VAPI_ASSISTANT_ID` | for voice | browser Vapi config (public values only) |
| `VAPI_SERVER_SECRET`, `VAPI_SERVER_URL` | for voice | backend webhook verification; assistant server URL |
| `PORT`, `CORS_ORIGINS` | recommended | server config |
| `MOCK_STORE_PATH` | when provider=mock | shared JSON store file |

Secrets are never committed; the service-role key and server secret are
used server-side only.

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Apply the schema: SQL Editor → paste
   [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) → run.
   (Or `supabase link && supabase db push` with the CLI.)
3. Get the project URL and **service role** key
   (Settings → API) into `.env`:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
4. Seed:

```bash
DATA_PROVIDER=supabase npm run seed
```

Seeding is **idempotent**: customers/transactions/payouts/kb_chunks are
upserted by their stable IDs (CUS-1001…, TXN-9001…, PAY-7001…), so reruns
update in place and never duplicate. Verify by running it twice, then
checking row counts in the Supabase table editor.

Row Level Security is enabled on every table with **no public policies**:
the backend uses the service-role key server-side, so even a leaked anon
key reads nothing.

## MCP server

`mcp-server/` is a real MCP server (official TypeScript SDK, stdio
transport) implementing exactly the tools defined in
`assets/mcp-tool-requirements.md`:

`lookup_customer`, `lookup_transaction`, `lookup_payout`,
`create_support_ticket`, `create_escalation`, `log_conversation_event`.

- Every call is audited to the `tool_calls` table: name, purpose, input
  summary (emails masked), result summary, status, error, timestamp.
- Two consumers use it: the Claude Agent SDK tool loop
  (`server/src/agent/claude-runner.ts`) and the deterministic orchestrator
  (`server/src/agent/mcp-client.ts`). Nothing bypasses MCP for lookups,
  tickets, escalations or logging.
- Verify independently:

```bash
npm run mcp:smoke    # boots the server, calls all six tools over stdio
```

## Claude Agent SDK

`server/src/agent/claude-runner.ts` runs each turn through the Agent SDK
`query()` loop with:

- an explicit identity system prompt (no business logic in the prompt),
- our MCP server mounted per-conversation,
- only the six MCP tools allowed (`allowedTools`).

Business decisions come from the deterministic decision engine
(`server/src/agent/decision-engine.ts`); Claude interprets language and
phrases the customer-safe response. Without `ANTHROPIC_API_KEY` the
orchestrator falls back to the deterministic responder — same decisions,
same tools, template phrasing — so demos never break.

## Vapi voice setup

See [`vapi/README.md`](vapi/README.md). In short:

1. Import `vapi/assistant.json` into the Vapi dashboard.
2. Set its server URL to your backend `/vapi/webhook` and the server
   secret to the same value as `VAPI_SERVER_SECRET`.
3. Put the assistant ID + Vapi **public** key into `web/.env`.
4. For local voice testing, expose the backend (e.g. `ngrok http 8787`)
   and use the https URL as the assistant server URL.
5. Phone calling is optional per the PRD: import a phone number in Vapi
   and attach the same assistant — the backend contract is identical.

## Testing

```bash
npm test             # 120 tests: store, MCP stdio, decision engine, orchestrator, speech formatting, API
npm run evaluate     # 10/10 Week 6 scenarios → evidence table + stored records
npm run mcp:smoke    # MCP tool contract check over real stdio
```

Details, per-scenario expectations and the manual Vapi procedure:
[TESTING.md](TESTING.md). Architecture deep-dive: [ARCHITECTURE.md](ARCHITECTURE.md).

## Deployment

Deployed architecture (live):

- **Frontend** (`web/`): static build on Render (Static Site). Set
  `VITE_VAPI_PUBLIC_KEY`, `VITE_VAPI_ASSISTANT_ID`, `VITE_API_URL` at
  build time (Render → Environment, then clear-cache deploy — Vite bakes
  them during the build).
- **Backend + MCP** (`server/`, `mcp-server/`): one Node Web Service on
  Render. Build `npm install && npm run build`, start
  `node server/dist/index.js`, health check `/api/health`. The MCP server
  runs automatically as a stdio subprocess of the backend. Set
  `DATA_PROVIDER=supabase`, the Supabase vars, `VAPI_SERVER_SECRET`, a
  production `CORS_ORIGINS` allowlist, and `DEBUG_TOKEN` (see below).
  Optional: `ANTHROPIC_API_KEY` enables Claude phrasing; without it the
  deterministic responder is used.
- **Supabase**: apply the migration, seed once (`DATA_PROVIDER=supabase
  npm run seed`).
- **Vapi**: point the assistant server URL at the deployed backend URL;
  keep the secret in both places (`npm run vapi:setup` automates this).

### Debug endpoints & DEBUG_TOKEN

`/api/debug/*` expose conversation transcripts, tool-call summaries and
escalation contact details for observability. Set `DEBUG_TOKEN` in
production: every debug request must then present a matching
`x-debug-token` header, otherwise it is rejected with 401. Inspect the
live system with:

```bash
curl -H "x-debug-token: $DEBUG_TOKEN" https://<backend>/api/debug/conversations
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Could not locate assets/relaypay-knowledge-base.md` | run from inside the repo, or set `RELAYPAY_ASSETS_DIR` |
| `Could not locate mcp-server/dist/index.js` | run `npm run build` (or set `RELAYPAY_MCP_SERVER_PATH`) |
| MCP "Connection closed" in logs | the subprocess crashed — run `npm run mcp:smoke` to see the error |
| Lookups return `found:false` but data exists | with the mock provider, all processes must share `MOCK_STORE_PATH` |
| Voice button says not configured | add the two `VITE_VAPI_*` values to `web/.env` and restart Vite |
| Webhook 401 | `VAPI_SERVER_SECRET` in the dashboard must match the backend env |
