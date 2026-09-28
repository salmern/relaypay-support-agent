# Vapi voice layer

`assistant.json` is the Vapi assistant configuration for RelayPay support.

Design: **Vapi is the voice layer only** (STT, TTS, call management). The
support brain is our backend — the assistant's only tool,
`support_agent`, POSTs the customer's words to our `/vapi/webhook`
endpoint, which runs the decision engine + Claude Agent SDK + MCP server
and returns the reply to speak. Recording/artifacts/analysis are
disabled for privacy.

## Setup

1. In the Vapi dashboard (or via `POST /assistants`), import this JSON.
2. Replace the two placeholders:
   - `{{VAPI_SERVER_URL}}` — your deployed backend base URL, e.g.
     `https://your-backend.fly.dev` (local dev: use a tunnel, e.g.
     `ngrok http 8787`, and set it to the https URL).
   - `{{VAPI_SERVER_SECRET}}` — the same value as `VAPI_SERVER_SECRET`
     in your backend `.env` (sent as `x-vapi-secret` and verified by
     the backend).
3. Copy the assistant ID into `VITE_VAPI_ASSISTANT_ID` and your Vapi
   **public** key into `VITE_VAPI_PUBLIC_KEY` for the web app.
4. Call the assistant from the web app (Start call button).

Notes:
- The outer Anthropic model in this config is only the voice router —
  it is instructed to delegate every message to `support_agent` and
  repeat the result verbatim. All decisions, retrieval, and tool calls
  happen in our backend through the Claude Agent SDK.
- `end-of-call-report` server messages close the conversation record in
  Supabase.
