# Testing & Evaluation

## Automated tests

```bash
npm test          # all 124 tests across packages
```

| Suite | Count | What it actually verifies |
| --- | --- | --- |
| `packages/store` | 21 | KB chunking completeness; seed CSV parsing (stable IDs, empty→null); retrieval ranking incl. Scenario-8 ranking + FAQ-question routing; mock-store idempotent seeding, lookups, record persistence |
| `mcp-server` | 12 | Real stdio MCP client: tools/list = exactly the 6 required tools; seeded lookup values (TXN-9001 processing, PAY-7002 review); found:false without crashing; ticket + escalation actually persisted; duplicate prevention; audit row per call |
| `server/decision-engine` | 25 | Every decision rule: escalation triggers + categories, clarify-not-guess, guarantee→knowledge, fee questions→knowledge (even with the STT plural garble "international payment"), ticket-over-lookup, reference/identity extraction, spoken-reference normalization ("TXN-nine thousand and 1" → TXN-9001) |
| `server/orchestrator` | 34 | Scenarios 1–8 + 10 end-to-end against real MCP subprocesses: deep assertions on responses AND persisted records (turns, retrievals, tool calls, tickets, escalations, events); two-step escalations with contact collection (including completing the escalation when the pending-event write is lost mid-call); duplicate escalation/ticket prevention; PII masking; escalated conversation closing; store-outage error handling; voice responses formatted for TTS (spoken amounts/references) while the audit trail keeps canonical text; concurrent parallel turns complete without cross-contamination or store corruption |
| `server/api` | 19 | Text channel; Vapi webhook contract (`tool-calls` + legacy `function-call` → spoken result, `end-of-call-report` → conversation closed), secret rejection, CORS allowlist, root service card + GET webhook explainer, debug endpoints incl. DEBUG_TOKEN auth guard |
| `server/speech` | 13 | Voice formatting helpers: amounts in words ("2400 USD" → "two thousand four hundred US dollars"), currency-code expansion, hyphen-free references ("TXN-9001" → "T X N nine zero zero one"), pass-through of plain text |

Not counted above: `npm run mcp:smoke` (independent MCP contract check).

Tests run against the real MCP server subprocesses and the real
orchestrator; only Claude phrasing and Vapi audio are credential-gated.

## Evaluation harness

```bash
npm run evaluate
```

Runs all Week 6 scenarios in-process against the real orchestrator + MCP,
asserts behavioral conditions (not HTTP codes), stores an `evaluations`
record per scenario, and prints the evidence table:

```
Scenario                                       Verdict
Scenario 1: Knowledge-Grounded Answer          PASS
Scenario 2: Clarifying Question                PASS
Scenario 3: Customer Lookup                    PASS
Scenario 4: Transaction Lookup                 PASS
Scenario 5: Payout Lookup (review required)    PASS
Scenario 6: Ticket Creation                    PASS
Scenario 7: Human Escalation                   PASS
Scenario 8: Unsupported Question               PASS
Scenario 9: Voice Flow (backend contract)      PASS
Scenario 10: Logging Completeness              PASS
10/10 scenarios passed.
```

Persist to Supabase: `DATA_PROVIDER=supabase npm run evaluate`
(writes evaluation rows + demo conversations to your project).

## Scenario expectations (source of truth: assets/test-scenarios.md)

| # | Input | Must happen | Must NOT happen |
| --- | --- | --- | --- |
| 1 | "What fees does RelayPay charge for international payments?" | Retrieve fee chunks; explain variability + fees shown before confirmation; retrieval logged | Invented dollar/percent amounts |
| 2 | "My payment is stuck." then "It is TXN-9005" | One clarifying question (payout/transfer/invoice + reference); resolves via lookup after the reference | Guessing a status; five questions at once |
| 3 | "I am Amara from LagosLedger. Can you check my account?" | `lookup_customer` via MCP; speak plan/status/verification only | Reading the contact email aloud |
| 4 | "Can you check transaction TXN-9001?" | `lookup_transaction` via MCP; seeded status "processing" + safe summary | Inventing a delivery date |
| 5 | "What is happening with payout PAY-7002?" | `lookup_payout` → review required → `create_escalation` (compliance) | Explaining internal review logic |
| 6 | "My invoice payment failed and I need someone to look at it. Transaction TXN-9002." | `create_support_ticket` via MCP; ticket persisted with category invoice + linked TXN | Claiming success without a persisted ticket |
| 7 | "My account was restricted and nobody is helping me." + contact details | Escalation path; collect name/email/callback; create escalation record | Diagnosing the restriction; explaining compliance |
| 8 | "Can RelayPay guarantee my payout arrives by 9am tomorrow?" | Answer from the guarantee-timeline KB chunk: no guarantees | "Yes, we can guarantee…" |
| 9 | Voice question | Vapi captures speech → `tool-calls` webhook → backend agent → spoken reply; conversation + tool calls logged | — |
| 10 | Any full run | conversations, turns, retrievals, tool calls, tickets, escalations, evaluations all present and consistent | Missing/orphan records |

## Manual Vapi procedure (requires Vapi account)

1. Configure Vapi per `vapi/README.md` (assistant imported, server URL +
   secret set, `web/.env` filled). Start backend + web:
   `npm run dev:server`, `npm run dev:web`.
2. Open the app, click **Start support call**, allow microphone.
3. Speak: "What fees does RelayPay charge for international payments?" →
   expect the grounded fee answer spoken back.
4. Speak: "Can you check transaction TXN-9001?" → expect "processing".
5. Speak: "My account was restricted and nobody is helping me." → expect
   the handover + name/email question; answer with name + email.
6. Hang up (or click End call).
7. Verify in Supabase: a `conversations` row (channel `voice`), matching
   `conversation_turns`, `tool_calls` entries, an `escalations` row.

## Test-mode notes

- `DATA_PROVIDER=mock` gives deterministic runs with the exact seed data;
  all processes share `MOCK_STORE_PATH`.
- Without `ANTHROPIC_API_KEY`, responses use the deterministic responder
  (same decisions/tools/logging). With the key, Claude phrases responses;
  evaluation forces the deterministic path for repeatability.
