# Loom Demo Script (3–5 minutes)

Every ID below is real seed data from `assets/seed-data/`. Rehearse once,
then record. Have two browser tabs ready: the app and the Supabase table
editor. Run `npm run seed` before recording so the tables are clean.

## 0. Setup check (before recording, ~30s, can be cut from the video)

```bash
npm run build && npm run seed
npm run dev:server   # terminal 1
npm run dev:web      # terminal 2
```

## 1. Intro + knowledge question (0:00–0:45)

- Show the app. Say: "This is RelayPay's support voice agent."
- Click **Start support call**. The assistant greets you.
- Ask: **"What fees does RelayPay charge for international payments?"**
- Expect: variability answer + "fees are shown before you confirm".
- Click **Agent activity** → point at the retrieved knowledge (fee chunks)
  for this turn (text mode shows it; if recording voice-only, do step 3
  for the activity panel).

## 2. Transaction lookup (0:45–1:30)

- Ask: **"Can you check transaction TXN-9001?"**
- Expect: "outgoing payout of 2400 USD… status is processing… normal
  expected window."
- (Optional) Ask: **"What is happening with payout PAY-7002?"**
- Expect: pending review + "handing this to our specialist team".

## 3. Account lookup + escalation (1:30–2:45)

- Ask: **"My account was restricted and nobody is helping me."**
- Expect: empathy + handover + name/email question. Answer with your
  name, an email, and "tomorrow afternoon".
- Expect: confirmation that a specialist will follow up.

## 4. Supabase evidence (2:45–4:00)

Open the Supabase table editor and show, in order:

- `conversations` — the voice conversation rows (channel `voice`,
  `final_status` `escalated` on the escalated one, summary filled).
- `conversation_turns` — each user message + agent reply + `answer_type`.
- `tool_calls` — `lookup_transaction`, `lookup_payout`,
  `create_escalation`, `log_conversation_event` rows with statuses.
- `escalations` — the record with category, reason, call_booked.
- `retrieval_logs` — queries with chunk IDs and source titles.

## 5. Evaluation evidence (4:00–4:40)

```bash
npm run evaluate
```

Show the 10/10 table, then the `evaluations` table in Supabase
(if you ran with `DATA_PROVIDER=supabase`).

## 6. Close (4:40–5:00)

"One decision engine, six MCP tools, every action logged — the agent can
answer, clarify, look up, create tickets, escalate, and it refuses to
guess. Everything it did is auditable in Supabase."

## Fallback (if Vapi audio misbehaves on the day)

Use **Text test mode** in the app for steps 1–3 — it drives the identical
backend (decision engine, MCP tools, logging), so the demo stays honest;
say so explicitly on the recording.
