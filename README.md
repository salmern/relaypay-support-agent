# RelayPay Support Agent — Week 6 Capstone

A production-style **customer support voice agent** for RelayPay, a fictional
B2B cross-border payments and invoicing company.

Built to the Week 6 specification: **Vapi** for voice, **Claude Agent SDK**
for the support agent's language, a **custom MCP server** for support
tools, **Supabase** for data, and a retrieval layer grounded in the
approved RelayPay knowledge base.

```
Customer (voice / text)
   │
   ▼
Vapi voice interface  (voice only: STT / TTS / call events)
   │  function tool: support_agent(transcript)
   ▼
Backend API (Fastify)  ── text channel: POST /api/conversations/:id/turns
   │
   ▼
Conversation state (from the audit trail) → Decision engine (deterministic rules)
   │                                            │
   ▼                                            ▼
MCP server (custom, stdio) ◄── every lookup / write        Knowledge retrieval (approved KB)
   ├── lookup_customer                                       │
   ├── lookup_transaction                                    ▼
   ├── lookup_payout                        Claude Agent SDK — words the reply
   ├── create_support_ticket                (read-only lookups only; the required
   ├── create_escalation                     next step is appended verbatim)
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
| `server` | Backend API (Fastify): orchestrator, decision engine, Claude Agent SDK runner, Vapi webhook, activity + debug endpoints, seed script |
| `web` | Voice-first React UI (Vapi web SDK) with text chat and an agent-activity panel |
| `evaluation` | `npm run evaluate` — runs the 11 evaluation scenarios and stores evidence records |
| `supabase/migrations` | SQL schema (`001_init.sql`) + audit fixes (`002_audit_fixes.sql`), RLS on |
| `scripts` | `supabase-cleanup.mjs` — dry-run-by-default cleanup of test data |
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

> If your root `.env` sets `DATA_PROVIDER=supabase`, `npm run dev:server`
> uses Supabase. Override with `DATA_PROVIDER=mock npm run dev:server`.

## Environment variables

Copy `.env.example` → `.env` (backend) and `web/.env` for the Vite vars.
All variables are documented in [.env.example](.env.example). Summary:

| Variable | Required | Used for |
| --- | --- | --- |
| `DATA_PROVIDER` | yes | `supabase` (production) or `mock` (tests/local) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | when provider=supabase | server-side database access |
| `ANTHROPIC_API_KEY` | **yes in production** | Claude Agent SDK phrasing; without it the deterministic responder is used |
| `CLAUDE_MODEL` | optional | backend model (default `claude-sonnet-4-5`) |
| `CLAUDE_TIMEOUT_MS` | optional | per-turn model timeout before falling back (default 12000) |
| `CLAUDE_VOICE_TIMEOUT_MS` | optional | tighter model budget for voice turns (default 8000) |
| `CLAUDE_COOLDOWN_MS` | optional | after two consecutive model failures, skip Claude this long (default 5 min) |
| `CLAUDE_MOUNT_MCP` | optional | `false` skips mounting the read-only MCP lookups for Claude (saves memory) |
| `VITE_VAPI_PUBLIC_KEY`, `VITE_VAPI_ASSISTANT_ID` | for voice | browser Vapi config (public values only) |
| `VAPI_SERVER_SECRET`, `VAPI_SERVER_URL` | for voice | webhook verification; assistant server URL |
| `DEBUG_TOKEN` | production | required header for `/api/debug/*` (disabled on Render without it) |
| `CONVERSATION_TOKEN_SECRET` | recommended | HMAC secret for text-conversation tokens (falls back to DEBUG_TOKEN / VAPI_SERVER_SECRET) |
| `RATE_LIMIT_PER_MINUTE` | optional | text-channel requests per minute per client IP (default 30) |
| `MCP_IDLE_MS` | optional | idle MCP subprocesses are closed after this long (default 10 min) |
| `PORT`, `CORS_ORIGINS` | recommended | server config |
| `MOCK_STORE_PATH` | when provider=mock | shared JSON store file |

Secrets are never committed; the service-role key and server secret are
used server-side only and are never passed on any process command line.

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Apply the schema: SQL Editor → paste and run
   [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql),
   then [`002_audit_fixes.sql`](supabase/migrations/002_audit_fixes.sql)
   (adds the `closing` answer type, `evaluations.run_id`, and the `active`
   conversation status). The app tolerates a schema without 002, but the
   audit trail is only fully accurate with it.
3. Put the project URL and **service role** key (Settings → API) in `.env`:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
4. Seed:

```bash
DATA_PROVIDER=supabase npm run seed
```

Seeding is **idempotent**: customers/transactions/payouts/kb_chunks are
upserted by their stable IDs (CUS-1001…, TXN-9001…, PAY-7001…). It does
**not** clear runtime records — use the cleanup script for that:

```bash
npm run db:cleanup                          # dry run: what would change
npm run db:cleanup -- --apply               # remove eval/test data, close stale conversations
npm run db:cleanup -- --all-runtime --apply # wipe all runtime records before a recording
```

Row Level Security is enabled on every table with **no public policies**:
the backend uses the service-role key server-side, so a leaked anon key
reads nothing.

## MCP server

`mcp-server/` is a real MCP server (official TypeScript SDK, stdio
transport) implementing exactly the tools defined in
`assets/mcp-tool-requirements.md`:

`lookup_customer`, `lookup_transaction`, `lookup_payout`,
`create_support_ticket`, `create_escalation`, `log_conversation_event`.

- Every call is audited to the `tool_calls` table: name, purpose, input
  summary (emails masked), result summary, status, error, timestamp.
- Transaction summaries are customer-safe: staff instructions in the seed
  data ("Escalate account-specific questions.") are never returned.
- Duplicate protection: one open ticket per conversation + category (+
  transaction); one open escalation per conversation + category — a repeat
  call fills in missing contact details, callback time or customer link.
- The orchestrator performs every lookup and write through MCP; Claude may
  only call the three read-only lookups.

```bash
npm run mcp:smoke    # boots the server, calls all six tools over stdio
```

## Claude Agent SDK

`server/src/agent/claude-runner.ts` runs each reply through the Agent SDK
`query()` loop:

- identity + safety system prompt (no business rules in the prompt);
- our MCP server mounted per conversation with **only the read-only
  lookups allowed** — tickets, escalations and logging are orchestrator-only,
  so a model turn can never create or duplicate a record;
- all built-in Claude Code tools removed (`tools: []`), unlisted tools
  denied (`permissionMode: "dontAsk"`), no on-disk settings, no session
  persistence, an empty scratch working directory, and a hard timeout.

Business decisions come from the deterministic decision engine
(`server/src/agent/decision-engine.ts`). Claude rewords the statement of
each reply; the **required next step** (the exact clarifying question, the
name-and-email ask, the callback question, the follow-up offer, the source
citation) is appended verbatim, and a rewording that drops or changes any
reference, number or status is rejected in favour of the deterministic
wording. Conversation state lives in the audit trail, not in reply wording,
so multi-turn flows behave identically with and without Claude.

The activity panel shows which responder phrased each turn.

## Text channel API

```bash
curl -X POST $API/api/conversations
# → { "conversation_id": "conv-…", "conversation_token": "…" }
curl -X POST $API/api/conversations/$ID/turns \
  -H "x-conversation-token: $TOKEN" -H "content-type: application/json" \
  -d '{"message":"Can you check transaction TXN-9001?"}'
```

Each turn response includes `activity`: the `tool_calls` audit rows and the
retrieval record written for that turn. `GET /api/conversations/:id/activity`
returns per-turn activity (text: token required; voice: keyed by the Vapi
call id). Transcripts and contact details are never included.

## Vapi voice setup

See [`vapi/README.md`](vapi/README.md). In short:

1. `npm run vapi:setup` creates or updates the assistant from
   `vapi/assistant.json`, points it at `<backend>/vapi/webhook`, and sets the
   shared server secret.
2. Put the assistant ID + Vapi **public** key into `web/.env`.
3. For local voice testing, expose the backend (e.g. `ngrok http 8787`).
4. Phone calling is optional per the PRD: attach a Vapi phone number to the
   same assistant — the backend contract is identical.

## Testing

```bash
npm test                    # 196 tests: store, MCP stdio, decision engine, orchestrator, Claude phrasing (mocked), API, speech
npm run evaluate            # 11 scenarios against an isolated mock store
npm run evaluate:supabase   # same, persisted to Supabase with a run_id
npm run mcp:smoke           # MCP tool contract check over real stdio
```

`npm test` always uses the deterministic responder (a local
`ANTHROPIC_API_KEY` does not change results); the Claude path is tested with
a mocked model in `server/tests/claude-phrasing.test.ts`, and
`EVAL_RESPONDER=claude npm run evaluate` runs the scenarios with real
Claude phrasing. Details: [TESTING.md](TESTING.md). Architecture deep-dive:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Deployment

- **Frontend** (`web/`): static build on Render (Static Site). Set
  `VITE_VAPI_PUBLIC_KEY`, `VITE_VAPI_ASSISTANT_ID`, `VITE_API_URL` at
  build time (Render → Environment, then clear-cache deploy — Vite bakes
  them in during the build).
- **Backend + MCP** (`server/`, `mcp-server/`): one Node Web Service on
  Render. Build `npm install && npm run build`, start
  `node server/dist/index.js`, health check `/api/health`. The MCP server
  runs as stdio subprocesses of the backend. Set `DATA_PROVIDER=supabase`,
  the Supabase vars, **`ANTHROPIC_API_KEY`** (the Agent SDK is the PRD's
  backend agent), `VAPI_SERVER_SECRET`, `DEBUG_TOKEN`,
  `CONVERSATION_TOKEN_SECRET`, and a production `CORS_ORIGINS` allowlist
  (the frontend URL). Each live conversation holds one MCP subprocess
  (~80 MB, released when the conversation ends or after `MCP_IDLE_MS`); with
  Claude enabled each reply also runs the Claude CLI briefly — use an
  instance with at least 1 GB, or set `CLAUDE_MOUNT_MCP=false` on 512 MB.
- **Supabase**: apply both migrations, seed once.
- **Vapi**: point the assistant server URL at the deployed backend
  (`npm run vapi:setup` automates this).

`/api/health` reports the responder (`claude` or `rules`), the data
provider and the number of live MCP sessions. Each turn's decision event
records which responder actually phrased it, why Claude was skipped
(`claude_note`: timeout, error, cooldown, rejected rewrite) and timings
(`timings_ms`) — query `conversation_events` to diagnose latency. The Vapi
`support_agent` tool allows 40 s (`timeoutSeconds` in `vapi/assistant.json`).

### Debug endpoints & DEBUG_TOKEN

`/api/debug/*` expose transcripts, tool-call summaries and escalation
contact details for operators. Every request must present a matching
`x-debug-token` header; on Render without `DEBUG_TOKEN` they are disabled.
The customer UI never uses them — it reads the per-turn activity instead.

```bash
curl -H "x-debug-token: $DEBUG_TOKEN" https://<backend>/api/debug/conversations
curl -H "x-debug-token: $DEBUG_TOKEN" "https://<backend>/api/debug/evaluations?run=latest"
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Could not locate assets/relaypay-knowledge-base.md` | run from inside the repo, or set `RELAYPAY_ASSETS_DIR` |
| `Could not locate mcp-server/dist/index.js` | run `npm run build` (or set `RELAYPAY_MCP_SERVER_PATH`) |
| MCP "Connection closed" in logs | the subprocess crashed — the orchestrator respawns it once; run `npm run mcp:smoke` to see the error |
| Lookups return `found:false` but data exists | with the mock provider, all processes must share `MOCK_STORE_PATH` |
| Text chat says "This conversation has expired" | the token secret changed (e.g. a restart without `CONVERSATION_TOKEN_SECRET`) — start a new conversation |
| Activity panel says "not recorded" | the decision event for that turn was not logged (store outage) — the reply itself is still audited in `tool_calls` |
| Voice button says voice isn't available | add the two `VITE_VAPI_*` values to `web/.env` and rebuild/restart Vite |
| Webhook 401 | `VAPI_SERVER_SECRET` in the dashboard must match the backend env |
| Browser CORS error in local dev against the deployed backend | the deployed `CORS_ORIGINS` only allows the deployed frontend — run the backend locally too, or use the deployed site |
