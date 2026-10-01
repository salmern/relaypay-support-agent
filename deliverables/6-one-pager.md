# RelayPay Customer Support Agent

**Owner:** Salman (salmanx550@gmail.com) · **Repo:** github.com/salmern/relaypay-support-agent · **Last Updated:** 2026-09-30

## 1. Purpose

RelayPay (B2B cross-border payments) gets repetitive support traffic: transaction statuses, payout delays, fee questions, account access. This agent answers those instantly over voice and chat, grounded strictly in the approved knowledge base, and hands account-specific, dispute, compliance, and frustration cases to human specialists with contact details captured. **Users:** RelayPay customers (voice or chat) and RelayPay support specialists (who receive escalations with full context). **Success:** correct grounded answers, zero fabricated information, complete audit trail, clean human handovers.

## 2. How It Works

Trigger: a customer message arrives via **Vapi** (voice, STT + TTS) or the text chat API.

1. Voice input is normalized ("TXN-nine thousand and 1" → TXN-9001); the raw transcript is kept for audit.
2. A deterministic decision engine classifies: knowledge / clarify / lookup / ticket / escalate.
3. Escalation triggers (restriction, dispute, refund, compliance, frustration) fire first and never guess.
4. Data access goes only through a custom **MCP server** with six allowlisted tools (`lookup_customer`, `lookup_transaction`, `lookup_payout`, `create_support_ticket`, `create_escalation`, `log_conversation_event`).
5. Answers are grounded in retrieval over 38 approved KB chunks; below-threshold questions are declined.
6. Human decision: specialists receive escalations/tickets (category, reason, contact, callback time) and own the follow-up.
7. Final output: customer-safe reply (voice replies reformat amounts/references for speech), every turn, retrieval, tool call, and decision logged to **Supabase**.

## 3. Controls

- **Grounding:** retrieval cites approved chunk IDs; unsupported questions are declined, never answered from model memory.
- **Permissions:** browser gets only the Vapi public key; Supabase service-role key and DEBUG_TOKEN stay server-side. `/api/debug/*` requires the `x-debug-token` header in production.
- **Validation:** webhook verifies the Vapi shared secret; empty transcripts, unknown tool names, and missing arguments get safe replies without running a turn.
- **Idempotency/dedup:** one open ticket per conversation + category (+ transaction); one open escalation per conversation + category; repeat escalations enrich contact details instead of duplicating.
- **Retries/failure states:** Claude phrasing failures fall back to the deterministic responder; store/MCP failures produce an explicit error reply with an uncertainty note, never a fabricated result. Mock-store writes are atomic (temp file + rename) behind a cross-process lock.
- **Approval:** no automated action ever moves money or changes accounts; the only outputs are answers, tickets, and escalation records.

## 4. How to Use (How to Operate)

```bash
git clone https://github.com/salmern/relaypay-support-agent.git && cd relaypay-support-agent
npm install
cp .env.example .env        # fill: DATA_PROVIDER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                            # VITE_VAPI_PUBLIC_KEY, VITE_VAPI_ASSISTANT_ID, VAPI_SERVER_SECRET, DEBUG_TOKEN
npm run build
npm run dev:server          # backend on :8787 (seeds the store on first run in mock mode)
npm run dev:web             # web app on :5173
```

To operate: open the web app → **Start support call**, or POST to `/api/conversations/:id/turns` for text. To reconfigure the voice assistant: `npm run vapi:setup`. To verify a deployment: `curl https://<backend>/api/health` (expect 200) and `curl https://<backend>/api/debug/conversations` without the header (expect 401 when DEBUG_TOKEN is set). To investigate a conversation: `GET /api/debug/conversations/:id` with the `x-debug-token` header, or the Supabase tables (`conversations`, `conversation_turns`, `tool_calls`, `escalations`, `retrieval_logs`, `conversation_events`). To re-run behavior checks: `npm run evaluate` (10 scenarios) and `npm test` (131 tests).

## 5. Artefacts

- Repository: https://github.com/salmern/relaypay-support-agent
- Voice interface: https://relaypay-support-agent-1.onrender.com (phone calling not supported on this account)
- Backend endpoint: https://relaypay-support-agent.onrender.com (`/vapi/webhook`, `/api/health`)
- Test evidence: `deliverables/3-testing-evidence.md` (131 automated tests, evaluate 10/10)
- Video walkthrough: `deliverables/4-video-script.md` (record per script)
- Data documents: seed data in `assets/seed-data/*.csv` and KB in `assets/relaypay-knowledge-base.md` (unchanged this cycle; schema in `assets/supabase-schema-and-seed-data.md`)

## 6. Limitations

- **Claude phrasing is credential-gated:** without `ANTHROPIC_API_KEY` the deterministic responder speaks (same decisions, template wording). Decisions are identical; wording is plainer.
- **Render free tier sleeps:** first request after ~15 minutes idle takes 30–60 s. Warm with one chat message before a live call or recording.
- **No phone (PSTN) number:** Vapi free tier, web voice only.
- **Seed data stands in for a live ERP:** transactions and payouts are seeded fixtures, not live payment-system reads.
- **Knowledge is static:** the 38 KB chunks change only when `assets/relaypay-knowledge-base.md` changes and the store is re-seeded.
- **Escalation follow-up is manual:** the agent files the record; a human must own the inbox and callbacks.

## 7. Troubleshooting Guide (Appendix)

| Symptom | Cause | Fix |
| --- | --- | --- |
| First call hangs ~30–60 s | Render free-tier cold start | Send one chat message to warm the service, then call |
| `/api/debug/*` returns 401 | DEBUG_TOKEN set (correct behavior) | Pass `x-debug-token: <DEBUG_TOKEN>` header |
| `/api/debug/*` open in production | DEBUG_TOKEN unset | Set it in Render env and redeploy |
| Voice says "did not catch that" repeatedly | Mic permission denied, or backend asleep/failed | Check mic permission; hit `/api/health`; warm the service |
| Voice reads amounts oddly | Response not going through the speech formatter | Confirm the deploy includes `server/src/agent/speech.ts`; text channel is unaffected by design |
| "I had trouble checking that..." | Store or MCP tool failure (e.g. Supabase unreachable) | Check backend logs and Supabase status; retry; the reply is intentionally safe, no data was fabricated |
| `npm test` failures about JSON/EISDIR in mock store | Another process holds a stale `.lock` or a stale process points at the same `MOCK_STORE_PATH` | Remove the `*.lock` file next to the store path; ensure each run uses its own store path (tests do this automatically) |
| Webhook returns 401/403 | Missing or wrong `x-vapi-secret` | Set the same secret in the Vapi dashboard and `VAPI_SERVER_SECRET` |
| CORS error in browser | Origin not allowlisted | Add the site origin to `CORS_ORIGINS` and redeploy |

**Notifications:** the system's "notification" surface is the audit trail itself: `conversation_events` (decision, escalation, escalation_pending_contact), `tool_calls` (every MCP call with status), and `retrieval_logs` (every grounding query with chunk IDs). Failures surface to customers as safe error replies and to operators in these tables plus backend logs; there is no email/Slack alerting (see Limitations).
