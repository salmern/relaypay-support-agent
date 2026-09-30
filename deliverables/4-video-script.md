# Deliverable 4: Video Walkthrough Script

Total runtime target: **5 minutes 30 seconds** (hard limit 6:00). Word budget assumes a calm pace of about 140 words per minute. Record the browser at 1080p; keep the RelayPay web app, Supabase table editor, and a terminal ready in tabs before recording. Warm the backend first by sending one chat message (Render free tier cold start is 30 to 60 seconds).

## Slide 1: Title and Purpose (0:00 to 0:40, about 90 words)

**On slide:** Project name "RelayPay Customer Support Agent", one-line problem statement, user list, success criteria.

**Say:** "RelayPay is a B2B cross-border payments company. Its support inbox fills with repetitive questions about transaction statuses, payout delays, fees, and account access. I built a production voice-and-text support agent that answers those questions instantly, grounds every claim in the approved knowledge base, and hands anything sensitive to a human with full context. It serves RelayPay customers over voice and chat. Success looks like three things: correct grounded answers, zero fabricated information, and a clean handover to human specialists with contact details captured."

## Slide 2: Architecture and How It Works (0:40 to 1:30, about 115 words)

**On slide:** Flow diagram: Customer (voice/chat) → Vapi (STT/TTS) → Fastify backend → decision engine → MCP server (6 tools) → Supabase → response; branch to Claude Agent SDK phrasing; branch to escalation.

**Say:** "Here is the actual path a support turn takes. The customer speaks or types. Vapi handles speech-to-text and text-to-speech and calls my backend webhook. A deterministic decision engine classifies the request: answer from knowledge, clarify, lookup, ticket, or escalate. Every data access goes through a custom MCP server exposing exactly six tools, so the agent cannot touch anything outside its allowlist. Answers are grounded in retrieval over the approved knowledge base, and every retrieval, tool call, and decision is logged to Supabase. If the request needs human judgment, like a dispute or a compliance review, the agent collects contact details and files an escalation. A Claude Agent SDK runner phrases responses when enabled, with a deterministic template fallback."

## Slide 3: Key Features and Edge Cases (1:30 to 2:10, about 90 words)

**On slide:** Bullets: grounded retrieval, no-fabrication decline, dedup, two-step escalation, speech formatting, audit trail, DEBUG_TOKEN guard.

**Say:** "A few things worth calling out. The agent refuses to guess: unsupported questions get an explicit decline. Duplicate tickets and escalations are deduplicated per conversation. Escalations run in two steps so contact details are always captured. Voice input normalizes spoken references like 'TXN nine thousand and one' into canonical IDs, and replies are reformatted for speech so the voice says 'two thousand four hundred US dollars' instead of reading digits. Debug endpoints are token-gated in production. And for edge cases: empty input, unknown references, store outages, and even concurrent writes are all handled and tested."

## Live Demo (2:10 to 5:00, spoken while clicking)

**Demo 1, knowledge answer (about 30 seconds):** In the web app, click **Start support call** and ask: "What fees does RelayPay charge for international payments?" Expect the variability answer with "fees are shown before you confirm". Then show the **Agent activity** panel: retrieval from the approved fee policy chunk.

**Demo 2, transaction lookup (about 30 seconds):** Ask: "Can you check transaction TXN-9001?" Expect: "an outgoing payout of two thousand four hundred US dollars, status processing". Point out the voice says the amount naturally, and references digit by digit, exactly how a human agent would.

**Demo 3, escalation (about 45 seconds):** Say: "My account was restricted and nobody is helping me." Expect empathy plus a request for name and email. Provide them, then "tomorrow afternoon" for the callback. Expect confirmation that a specialist will follow up.

**Demo 4, evidence in Supabase (about 50 seconds):** Open the Supabase table editor and show, quickly: `conversation_turns` (the transcript just created), `tool_calls` (lookup and escalation rows), `escalations` (record with contact and call booked), `retrieval_logs` (chunk IDs for the fee answer). Say: "Every action the agent took is auditable."

**Demo 5, evaluation run (about 35 seconds):** In the terminal, run `npm run evaluate`. Show the 10/10 scenario table. Say: "Ten scripted scenarios assert real behavior, including the decline path and logging completeness, and each run persists a record to Supabase."

## Closing Slide (5:00 to 5:30, about 70 words)

**On slide:** Limitations, assumptions, business value.

**Say:** "Limitations, honestly: the render backend sleeps on the free tier, so the first call needs a warm-up. Claude phrasing is credential-gated, so today the deterministic responder speaks, with identical decision logic. Phone calling is not provisioned on the Vapi free tier. Assumptions: seed data stands in for a production ERP. The business value is still clear: instant grounded answers, a complete audit trail, and clean human handovers, which deflect repetitive tickets while protecting trust."

---

**Recording notes:** Do not read the slides verbatim; the script above is the narration track. If a live moment fails (cold start, network), cut it in editing rather than narrating the failure, and keep the total under 6:00.
