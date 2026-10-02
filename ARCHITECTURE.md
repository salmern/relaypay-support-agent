# Architecture

## The one-line version

Vapi handles sound; the backend decides; the MCP server touches data;
Claude chooses the words; Supabase remembers; the approved knowledge base
keeps every answer honest.

## Components

### 1. Voice layer — Vapi (`vapi/assistant.json`, `web/`)

- The web app uses `@vapi-ai/web` with the **public** key and assistant ID.
- The assistant is a *voice router*: its single custom tool `support_agent`
  POSTs the customer's words to our backend (`POST /vapi/webhook`) and
  speaks the returned result verbatim. STT (Deepgram) and TTS (11labs)
  are Vapi's. The greeting introduces the assistant as a virtual (AI)
  assistant.
- Tool-call contract (docs.vapi.ai/tools/custom-tools): Vapi sends
  `message.type: "tool-calls"` with a `toolCallList`; the backend answers
  `{ results: [{ toolCallId, result }] }`.
- `end-of-call-report` closes the conversation record and frees its MCP
  subprocess.
- The webhook verifies a shared server secret (`x-vapi-secret`, constant-time).
- The browser learns the Vapi call id from `vapi.start()` and reads
  per-turn activity (tool calls, retrieval, escalation) from
  `GET /api/conversations/:callId/activity`.

### 2. Backend API (`server/src/app.ts`)

Fastify. Responsibilities:

- **Text channel**: `POST /api/conversations` returns a conversation id and
  a **conversation token** (HMAC of the id). `/turns`, `/end` and
  `/activity` require `x-conversation-token`; text turns may only target
  text conversations (never a voice call). Per-IP rate limiting, body
  validation, and generic error messages (details go to server logs only).
- **Voice channel**: `/vapi/webhook` — `tool-calls` → one agent turn →
  `{ results }`; `end-of-call-report` → conversation closed.
- **Activity**: every turn response carries the `tool_calls` audit rows and
  the retrieval record written for that turn — the UI renders exactly
  these, so it cannot show more or less than the audit trail holds.
- **Observability**: `/api/debug/*` (operators only, `x-debug-token`;
  disabled on Render without `DEBUG_TOKEN`).
- **CORS**: explicit origin allowlist (`CORS_ORIGINS`).

### 3. Conversation state (`server/src/orchestrator.ts`)

Each turn ends with a `decision` event (written through the MCP
`log_conversation_event` tool). Its metadata records the decision, answer
type, confidence, linked customer/ticket/escalation, which responder phrased
the reply, the activity of the turn, and **what the agent is waiting for
next**: contact details, a callback time, a reference, a ticket reference,
or a yes/no to an offer. The next turn reads that state first. Because
state is structured data — not a regex over the previous reply — it is
unaffected by Claude rewording replies. (If the event is ever lost, the
canonical wording of the previous reply is a fallback.)

### 4. Decision engine (`server/src/agent/decision-engine.ts`)

The rules in `assets/support-decision-rules.md` and
`assets/escalation-rules.md` are **code, not prompt**:

0. Refusals first: rule-override attempts ("ignore previous instructions")
   and requests to disclose personal or internal data are declined.
1. Escalation triggers (account restriction, dispute/refund/cancellation,
   compliance/verification, balance, frustration/urgency) — regex patterns
   with categories.
2. Intent: greeting / general help / payout / transaction / account /
   ticket / knowledge. Guarantee and fee questions route to knowledge.
3. `decide()` maps intent + signals to
   `answer | clarify | lookup | ticket | escalate | decline`.

References: the current message always wins. An earlier reference is
reused only when the message contains nothing reference-like, and only for
the same kind of record. A reference that cannot be read ("payout ninety
oh one") produces "could you say the full reference again?" — never a
silent fallback to an older record. Spoken references are normalized on
the voice channel ("payout P A Y 7 0 0 3" → PAY-7003).

The LLM never decides *what* to do — only *how to say it*.

### 5. Knowledge retrieval (`packages/store/src/retrieval.ts`)

- The approved KB markdown is chunked by section (title + heading + body).
- Deterministic TF-IDF with stop-word filtering, light stemming and prefix
  matching ("crypto" ~ "cryptocurrency"), and an FAQ-title boost; exact
  KB questions route directly.
- Relevance threshold calibrated on a regression battery: off-topic
  queries decline; only chunks scoring close to the best one are used and
  cited.
- The answer is **extracted** from the best chunk: short FAQ answers whole,
  long sections → the sentence or list item that answers the question
  ("RelayPay does not support cryptocurrency payments.").
- Confidence reflects retrieval strength (exact FAQ 0.95; otherwise rising
  from 0.55 at the threshold).
- **Every** retrieval — hit or miss — is logged to `retrieval_logs`.

### 6. Claude Agent SDK (`server/src/agent/claude-runner.ts`)

Each reply's statement runs through `query()` with:

- `systemPrompt`: identity + safety constraints only.
- `mcpServers`: our MCP server, per conversation; **only the three
  read-only lookups are allowed**, the write tools are disallowed.
- `tools: []` (no built-in tools), `permissionMode: "dontAsk"`,
  `settingSources: []`, `strictMcpConfig`, `persistSession: false`, an
  empty scratch `cwd`, `maxTurns: 3`, and a timeout (`CLAUDE_TIMEOUT_MS`).
- The MCP config passes **no environment**: the SDK serializes it onto the
  CLI command line, so secrets would be visible in the process list. The
  CLI inherits the environment instead; the conversation id is passed as
  `--conversation-id`.

The prompt carries the decided action, the approved knowledge, the real
tool results, the deterministic DRAFT, and the exact closing the system
will append. Claude's rewording is accepted only if every reference,
number and status word of the draft survives and it adds no question of
its own; otherwise — and on any error or timeout — the deterministic
wording is used. Never a fabricated answer.

### 7. MCP server (`mcp-server/`)

Custom, on the official TypeScript SDK, stdio transport. Tools are thin:
validate → call the Store → return spec-shaped JSON. The `withAudit`
wrapper writes every call to `tool_calls` (input summaries mask emails;
audit failure never breaks the tool). Two consumers — the orchestrator's
`RelayPayMcpClient` (all six tools) and the Agent SDK loop (read-only
lookups) — so nothing bypasses MCP.

Subprocess lifecycle: one per active conversation, shared by concurrent
turns, closed when the conversation ends (`/end` or `end-of-call-report`)
or after `MCP_IDLE_MS` of inactivity, and respawned once if it dies.

### 8. Data (`packages/store`, `supabase/migrations`)

One `Store` interface, two implementations:

- `SupabaseStore` — production. Service-role key, server-side only.
  RLS enabled on all tables with no public policies. Conversations are
  insert-if-missing (a later turn never rewrites `started_at` or the
  caller id); company-name lookups escape LIKE wildcards.
- `MockFileStore` — tests/no-credential runs. Same behavior, backed by a
  JSON file that all processes re-read per operation.

Tables: seed (`customers`, `transactions`, `payouts`), retrieval source
(`kb_chunks`), runtime (`conversations`, `conversation_turns`,
`retrieval_logs`, `tool_calls`, `conversation_events`, `support_tickets`,
`escalations`, `evaluations` — with `run_id`).

## Escalation flow

1. A trigger (or a record needing review: restricted account,
   review-required payout or transaction) logs `escalation_pending_contact`
   and asks for **name and email**.
2. Replies are slot-filled across turns: a name alone → "what email should
   the specialist use?"; an unreadable email → asked again; an email alone
   → "what name should I put on the request?". Questions or new requests
   asked instead are answered normally; "never mind" cancels (audited).
3. With name + valid email, `create_escalation` runs, linked to the
   customer and ticket known in the conversation.
4. The agent then offers a callback; a valid time ("tomorrow afternoon",
   "Monday at 10am") updates the same record (`call_booked`), an invalid
   one ("25pm") is asked again, "no" keeps email follow-up.
5. Repeating the problem later answers "already with our specialist team"
   instead of asking again.

## Safety model

- Fabrication: answers only from retrieved chunks; no relevant chunk → decline.
- Wrong record: never answers about a reference other than the one asked.
- Guarantees: never promised; guarantee questions answered from the KB policy.
- PII: spoken responses carry customer-safe fields only; personal-data
  requests are refused; emails masked in audit logs; staff notes never read out.
- Compliance: internal decision logic never explained; restricted accounts
  and review-required records escalate.
- Honesty: ticket/escalation confirmations only after the MCP write
  succeeded; the activity panel shows the audit rows themselves.
