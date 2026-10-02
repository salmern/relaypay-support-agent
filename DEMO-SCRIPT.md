# Loom Demo Script (3–5 minutes)

Every ID below is real seed data from `assets/seed-data/`. Rehearse once,
then record. Have three tabs ready: the deployed app
(https://relaypay-support-agent-1.onrender.com), the Supabase table editor,
and a terminal.

## 0. Before recording (not in the video)

1. Deploy the latest commit (frontend + backend) and confirm
   `https://relaypay-support-agent.onrender.com/api/health` shows
   `"responder":"claude"` (needs `ANTHROPIC_API_KEY` on Render).
2. Apply `supabase/migrations/002_audit_fixes.sql` once.
3. Clean the tables so the evidence shows only the demo run:
   `npm run db:cleanup -- --all-runtime` (dry run), then add `--apply`.
4. Warm the backend: send one chat message in the app (Render free tier
   cold start is 30–60 s), then click **New conversation**.
5. Use the **deployed** site. The deployed backend only allows the deployed
   frontend origin, so `npm run dev:web` against it fails CORS.

## 1. Intro + knowledge question (0:00–0:45)

- Show the app. Say: "This is RelayPay's AI support assistant."
- Click **Agent activity** (it stays open), then **Start support call**.
- Ask: **"What fees does RelayPay charge for international payments?"**
- Expect: fees vary by transaction type, corridor and payment method, and
  are shown before you confirm.
- Point at the activity panel: knowledge retrieved `KB-018 — … How Does
  RelayPay Charge Fees?`, phrased by Claude (Agent SDK).

## 2. Transaction lookup (0:45–1:30)

- Ask: **"Can you check transaction TXN-9001?"**
- Expect: "outgoing payout of two thousand four hundred US dollars… status
  is processing… normal expected window."
- Activity panel: `lookup_transaction — success — found=true
  status=processing … transaction_id=TXN-9001` — the same row you will show
  in Supabase.
- (Optional) Ask: **"What is happening with payout PAY-7002?"** → pending
  review + handover.

## 3. Escalation (1:30–2:45)

- Say: **"My account was restricted and nobody is helping me."**
- Expect: empathy + handover + "Could I take your name and email…".
- Say your name and an email ("My name is … and my email is … at example
  dot com").
- Expect: confirmation + "Would you also like to book a callback?"
- Say: **"Tomorrow afternoon."** → "I've noted tomorrow afternoon for your
  callback…". The **Escalated to human support** badge appears.
- Say "No thank you" to close, then end the call.

## 4. Supabase evidence (2:45–4:00)

Show, in order:

- `conversations` — the voice conversation (channel `voice`,
  `final_status` `escalated`, summary filled, `ended_at` set).
- `conversation_turns` — each message, reply, `answer_type`, confidence.
- `tool_calls` — `lookup_transaction`, `create_escalation`,
  `log_conversation_event` rows with statuses (matching the panel).
- `escalations` — name, email, category `account`, `call_booked` true,
  `preferred_time` "tomorrow afternoon".
- `retrieval_logs` — the fee query with chunk ID KB-018.

## 5. Evaluation evidence (4:00–4:40)

```bash
npm run evaluate:supabase
```

Show the 11/11 table, then `evaluations` in Supabase filtered by the run's
`run_id` (printed at the end of the run).

## 6. Close (4:40–5:00)

"One decision engine, six MCP tools, Claude for natural wording, and every
action logged — the agent answers, clarifies, looks up, files tickets,
escalates with full contact details, and refuses to guess. What you see in
the activity panel is exactly what is in Supabase."

## Fallback (if Vapi audio misbehaves on the day)

Click **Use text chat instead** — it drives the identical backend
(decision engine, MCP tools, logging) and shows the same activity panel.
Say so explicitly on the recording.
