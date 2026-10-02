# RelayPay Customer Support Agent

**Owner:** Salman (salmanx550@gmail.com) · **Repo:** github.com/salmern/relaypay-support-agent · **Last Updated:** 2026-10-01

## 1. Purpose

RelayPay (B2B cross-border payments) gets repetitive support traffic: transaction statuses, payout delays, fee questions, account access. This agent answers those instantly over voice and chat, grounded strictly in the approved knowledge base, and hands account-specific, dispute, compliance, and frustration cases to human specialists with contact details captured. **Users:** RelayPay customers (voice or chat) and RelayPay support specialists (who receive escalations with full context). **Success:** correct grounded answers, zero fabricated information, complete audit trail, clean human handovers.

## 2. How It Works

Trigger: a customer message arrives via **Vapi** (voice, STT + TTS) or the text chat API.

1. Voice input is normalized ("TXN-nine thousand and 1" → TXN-9001); the raw transcript is kept for audit.
2. The previous turn's pending ask (contact details, callback time, reference, yes/no) is read from the audit trail; then a deterministic decision engine classifies: knowledge / clarify / lookup / ticket / escalate / decline.
3. Escalation triggers (restriction, dispute, refund, compliance, frustration) fire first and never guess.
4. Data access goes only through a custom **MCP server** with six allowlisted tools (`lookup_customer`, `lookup_transaction`, `lookup_payout`, `create_support_ticket`, `create_escalation`, `log_conversation_event`); the Claude Agent SDK may only use the three read-only lookups.
5. Answers are grounded in retrieval over 38 approved KB chunks; below-threshold questions are declined. The Claude Agent SDK words the reply; the required next step is appended verbatim.
6. Human decision: specialists receive escalations/tickets (category, reason, contact, callback time) and own the follow-up.
7. Final output: customer-safe reply (voice replies reformat amounts/references for speech), every turn, retrieval, tool call, and decision logged to **Supabase**.

## 3. Controls

- **Grounding:** retrieval cites approved chunk IDs; unsupported questions are declined, never answered from model memory.
- **Permissions:** browser gets only the Vapi public key; Supabase service-role key, DEBUG_TOKEN and conversation-token secret stay server-side and never appear on a process command line. `/api/debug/*` requires the `x-debug-token` header (disabled on Render without it). Text conversations require a per-conversation token; voice calls cannot be reached from the text channel; per-IP rate limiting.
- **Validation:** webhook verifies the Vapi shared secret; empty transcripts, unknown tool names, and missing arguments get safe replies without running a turn. Contact details are validated (real email, plausible name, valid callback time) before an escalation is filed; unreadable references are asked again, never replaced by an older one.
- **Idempotency/dedup:** one open ticket per conversation + category (+ transaction); one open escalation per conversation + category; repeat escalation calls fill in missing contact details or callback time instead of duplicating.
- **Retries/failure states:** Claude rewordings that change a fact, errors and timeouts fall back to the deterministic wording; a crashed MCP subprocess is respawned once; store/MCP failures produce an explicit error reply with an uncertainty note, never a fabricated result. MCP subprocesses are released when a conversation ends or goes idle.
- **Approval:** no automated action ever moves money or changes accounts; the only outputs are answers, tickets, and escalation records.

## 4. How to Use (How to Operate)

```bash
git clone https://github.com/salmern/relaypay-support-agent.git && cd relaypay-support-agent
npm install
cp .env.example .env        # fill: DATA_PROVIDER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                            # VITE_VAPI_PUBLIC_KEY, VITE_VAPI_ASSISTANT_ID, VAPI_SERVER_SECRET, DEBUG_TOKEN
npm run build
npm run dev:server          # backend on :8787 (seeds the store on first run in mock mode)
# Supabase: apply supabase/migrations/001_init.sql and 002_audit_fixes.sql, then DATA_PROVIDER=supabase npm run seed
npm run dev:web             # web app on :5173
```

To operate: open the web app → **Start support call** (or **Use text chat instead**), or `POST /api/conversations` then `POST /api/conversations/:id/turns` with the returned `x-conversation-token`. To reconfigure the voice assistant: `npm run vapi:setup`. To verify a deployment: `curl https://<backend>/api/health` (expect 200) and `curl https://<backend>/api/debug/conversations` without the header (expect 401 when DEBUG_TOKEN is set). To investigate a conversation: `GET /api/debug/conversations/:id` with the `x-debug-token` header, or the Supabase tables (`conversations`, `conversation_turns`, `tool_calls`, `escalations`, `retrieval_logs`, `conversation_events`). To re-run behavior checks: `npm run evaluate` (11 scenarios, isolated store; `npm run evaluate:supabase` to persist) and `npm test` (199 tests). To clean demo data: `npm run db:cleanup` (dry run; `--apply` to change).

## 5. Artefacts

- Repository: https://github.com/salmern/relaypay-support-agent
- Voice interface: https://relaypay-support-agent-1.onrender.com (phone calling not supported on this account)
- Backend endpoint: https://relaypay-support-agent.onrender.com (`/vapi/webhook`, `/api/health`)
- Test evidence: `deliverables/3-testing-evidence.md` (199 automated tests, evaluate 11/11)
- Video walkthrough: `deliverables/4-video-script.md` (record per script)
- Data documents: seed data in `assets/seed-data/*.csv` and KB in `assets/relaypay-knowledge-base.md` (unchanged this cycle; schema in `assets/supabase-schema-and-seed-data.md`)

## 6. Limitations

- **Claude phrasing needs `ANTHROPIC_API_KEY` on the backend:** without it the deterministic responder speaks (same decisions and tools, template wording). `/api/health` reports which responder is active. Claude adds a few seconds per reply.
- **Render free tier sleeps:** first request after ~15 minutes idle takes 30–60 s. Warm with one chat message before a live call or recording.
- **No phone (PSTN) number:** Vapi free tier, web voice only.
- **Seed data stands in for a live ERP:** transactions and payouts are seeded fixtures, not live payment-system reads.
- **Knowledge is static and keyword-retrieved:** the 38 KB chunks change only when `assets/relaypay-knowledge-base.md` changes; unusual phrasings may be declined rather than answered.
- **Reference-based access:** anyone with a transaction or payout reference hears its status and amount (as the test scenarios require); there is no customer authentication.
- **Escalation follow-up is manual:** the agent files the record; a human must own the inbox and callbacks.

## 7. Troubleshooting Guide (Appendix)

| Symptom | Cause | Fix |
| --- | --- | --- |
| First call hangs ~30–60 s | Render free-tier cold start | Send one chat message to warm the service, then call |
| `/api/debug/*` returns 401 | DEBUG_TOKEN set (correct behavior) | Pass `x-debug-token: <DEBUG_TOKEN>` header |
| `/api/debug/*` returns 404 in production | DEBUG_TOKEN unset (endpoints disabled) | Set it in Render env and redeploy |
| Text chat says the conversation expired | Token secret changed (restart without `CONVERSATION_TOKEN_SECRET`) | Set `CONVERSATION_TOKEN_SECRET`; start a new conversation |
| Voice says "did not catch that" repeatedly | Mic permission denied, or backend asleep/failed | Check mic permission; hit `/api/health`; warm the service |
| Voice reads amounts oddly | Response not going through the speech formatter | Confirm the deploy includes `server/src/agent/speech.ts`; text channel is unaffected by design |
| "I had trouble checking that..." | Store or MCP tool failure (e.g. Supabase unreachable) | Check backend logs and Supabase status; retry; the reply is intentionally safe, no data was fabricated |
| `npm test` failures about JSON/EISDIR in mock store | Another process holds a stale `.lock` or a stale process points at the same `MOCK_STORE_PATH` | Remove the `*.lock` file next to the store path; ensure each run uses its own store path (tests do this automatically) |
| Webhook returns 401/403 | Missing or wrong `x-vapi-secret` | Set the same secret in the Vapi dashboard and `VAPI_SERVER_SECRET` |
| CORS error in browser | Origin not allowlisted | Add the site origin to `CORS_ORIGINS` and redeploy |

**Notifications:** the system's "notification" surface is the audit trail itself: `conversation_events` (decision, escalation, escalation_pending_contact), `tool_calls` (every MCP call with status), and `retrieval_logs` (every grounding query with chunk IDs). Failures surface to customers as safe error replies and to operators in these tables plus backend logs; there is no email/Slack alerting (see Limitations).
