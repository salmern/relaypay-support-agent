# Architecture

## The one-line version

Vapi handles sound; the backend thinks; the MCP server touches data;
Supabase remembers; the approved knowledge base keeps every answer honest.

## Components

### 1. Voice layer — Vapi (`vapi/assistant.json`, `web/`)

- The web app uses `@vapi-ai/web` with the **public** key and assistant ID.
- The assistant is a *voice router*: its single custom tool `support_agent`
  POSTs the customer's words to our backend (`POST /vapi/webhook`) and
  speaks the returned result verbatim. STT (Deepgram) and TTS (11labs)
  are Vapi's.
- Tool-call contract (per docs.vapi.ai/tools/custom-tools): Vapi sends
  `message.type: "tool-calls"` with a `toolCallList`; the backend answers
  `{ results: [{ toolCallId, result }] }`.
- `end-of-call-report` server events close the conversation record.
- The webhook verifies a shared server secret (`x-vapi-secret`, constant-time).

### 2. Backend API (`server/src/app.ts`)

Fastify. Responsibilities:

- **Text channel**: `POST /api/conversations`, `/turns`, `/end` — same
  orchestrator the voice path uses (that's why text mode is a real test).
- **Voice channel**: `/vapi/webhook` — `function-call` → one agent turn →
  `{ result }`; `end-of-call-report` → conversation closed.
- **Observability**: `/api/debug/*` read-only views (conversation detail,
  evaluations). No secrets, emails masked upstream by the MCP layer.
- **CORS**: explicit origin allowlist (`CORS_ORIGINS`); arbitrary origins
  are not reflected.

### 3. Decision engine (`server/src/agent/decision-engine.ts`)

The rules in `assets/support-decision-rules.md` and
`assets/escalation-rules.md` are **code, not prompt**:

1. Escalation triggers checked first (account restriction, dispute/refund/
   cancellation, compliance/verification, frustration/urgency) — regex
   patterns with categories, one canonical place.
2. Intent classification: payout / transaction / account / ticket /
   knowledge. Guarantee questions route to knowledge (the KB owns them).
3. `decide()` maps intent + available signals (reference? identity?) to
   `answer | clarify | lookup | ticket | escalate | decline`.
   - Missing reference on payment/payout → exactly one clarifying question.
   - Missing identity on account questions → one clarifying question.

The LLM never decides *what* to do — only *how to say it*.

### 4. Knowledge retrieval (`server/src/knowledge/retrieval-service.ts`, `packages/store/src/retrieval.ts`)

- The approved KB markdown is chunked by section (title + heading + body).
- Deterministic TF-IDF retrieval with stop-word filtering and an FAQ-title
  boost (multi-token title matches rank first — Scenario 8 depends on it).
- `relevant` threshold: below it, the agent declines instead of guessing.
- **Every** retrieval — hit or miss — is logged to `retrieval_logs` with
  query, chunk IDs, source title and summary.

### 5. Claude Agent SDK (`server/src/agent/claude-runner.ts`)

Each turn runs `query()` with:

- `systemPrompt`: identity + safety constraints only (no business rules).
- `mcpServers`: our MCP server spawned per-conversation via stdio with
  `RELAYPAY_CONVERSATION_ID` scoped in its environment.
- `allowedTools`: exactly the six MCP tools; no shell, no filesystem.
- The turn prompt carries: the decided action + rationale, retrieved
  approved knowledge, real tool results, the task ("ask exactly this
  clarifying question", "explain the handover"), and recent turns for
  continuity.

Failure of the LLM (missing key, timeout, error) degrades gracefully to
the deterministic responder — never to a fabricated answer.

### 6. MCP server (`mcp-server/`)

Custom, on the official TypeScript SDK, stdio transport. Tools are thin:
validate → call the Store → return spec-shaped JSON. The `withAudit`
wrapper writes every call to `tool_calls` (input summaries mask emails;
audit failure never breaks the tool). Two consumers — the Agent SDK loop
and the orchestrator's `RelayPayMcpClient` — so *nothing* bypasses MCP.

### 7. Data (`packages/store`, `supabase/migrations`)

One `Store` interface, two implementations:

- `SupabaseStore` — production. Service-role key, server-side only.
  RLS enabled on all 11 tables with no public policies.
- `MockFileStore` — tests/no-credential runs. Same behavior, backed by a
  JSON file that all processes re-read per operation so the API server
  and its MCP subprocesses stay consistent.

Tables: seed (`customers`, `transactions`, `payouts`), retrieval source
(`kb_chunks`), runtime (`conversations`, `conversation_turns`,
`retrieval_logs`, `tool_calls`, `conversation_events`, `support_tickets`,
`escalations`, `evaluations`).

## Conversation memory

Turns persist per conversation. The orchestrator reconstructs context:
references (`TXN-9005` alone) resolve against the current message first,
then history — so "It is TXN-9005" after a clarification works, and a new
reference in a later message wins over an old one. Pending escalations
are remembered via `conversation_events` (`escalation_pending_contact`),
so the next turn ("Efua, efua@…, tomorrow") completes the record.

## Safety model

- Fabrication: answers only from retrieved chunks; no relevant chunk → decline.
- Guarantees: never promised; guarantee questions answered from the KB policy.
- PII: spoken responses carry customer-safe fields only; emails masked in
  audit logs; voice responses never include emails or IDs beyond what the
  customer said.
- Compliance: internal decision logic never explained; restricted accounts
  and review-required payouts escalate automatically.
- Honesty: ticket/escalation confirmations only after the MCP write
  succeeded; failures produce explicit error answers.
