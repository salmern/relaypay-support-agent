# RelayPay Support Agent — One-Page System Overview

## What it is

A voice-first customer support agent for RelayPay (B2B cross-border
payments). Customers talk or type; the agent answers product/policy
questions **only** from approved knowledge, looks up real account,
transaction and payout data through tools, creates tickets and human
escalations when rules require, and logs everything for review.

## How it works (30 seconds)

1. **Vapi** (browser + dashboard assistant) converts speech ↔ text. Its
   only tool forwards what the customer said to our backend.
2. The **backend** runs a deterministic **decision engine**: answer,
   clarify, look up, create ticket, escalate, or decline.
3. For answers, it **retrieves** relevant sections of the approved
   RelayPay knowledge base (logged, with sources).
4. **Claude (Agent SDK)** phrases the reply from the decision, the
   retrieved knowledge, and real tool results — or a deterministic
   responder does, if no API key is configured.
5. Tool actions run through our custom **MCP server** (six tools:
   customer/transaction/payout lookup, ticket creation, escalation,
   event logging), which writes/reads **Supabase** and audits every call.

## How to use it

- **Voice:** open the web app → *Start support call* → speak normally.
  Status (listening/speaking), the transcript, and escalation/ticket
  badges are shown live. *End call* closes the conversation record.
- **Text:** the same agent is reachable in the app's *Text test mode* and
  via `POST /api/conversations/:id/turns`.
- **Review:** *Agent activity* in the app (or `GET /api/debug/conversations/:id`)
  shows the decision, retrieved knowledge, tool calls and their results.
- **Evidence:** `npm run evaluate` re-runs all Week 6 scenarios and
  stores pass/fail records.

## Major components

| Component | Technology | Role |
| --- | --- | --- |
| Voice interface | Vapi web SDK + assistant | STT/TTS, call state, webhook bridge |
| Backend | Fastify (Node 20+) | Decision engine, orchestration, webhook, debug API |
| Agent brain | Claude Agent SDK | Safe phrasing over decided actions |
| Support tools | Custom MCP server (stdio) | The only path to data & actions |
| Data | Supabase (11 tables, RLS on) | Seed data + all runtime records |

## Important safety behavior

- **No fabrication:** without relevant approved knowledge the agent
  declines and offers a callback instead of guessing.
- **No guarantees:** timelines/outcomes are never promised (e.g. the
  "guarantee by 9am" question is answered with the approved policy).
- **Privacy:** spoken replies contain customer-safe fields only; emails
  are masked in audit logs; secrets live in env vars, server-side only.
- **Honesty:** tickets/escalations are confirmed only if actually
  created; failures produce explicit error responses.
- **Escalation discipline:** account restrictions, disputes, refunds,
  cancellations, compliance/verification and frustration go to humans —
  the agent never diagnoses or explains internal decisions.
