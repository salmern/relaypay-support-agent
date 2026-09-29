# Vapi voice layer

**One-command setup (recommended):**

```bash
npm run vapi:setup
```

The script asks you for your Vapi **private key** (dashboard.vapi.ai →
API Keys — the only value it needs from you), reuses everything already
saved in `.env` / `web/.env`, then:

1. Validates the private key against the Vapi API.
2. Creates the **RelayPay Support Agent** assistant — or updates your
   existing one if the assistant ID is already known.
3. Points the `support_agent` tool at your backend webhook
   (`<backend-url>/vapi/webhook`) and sets the shared **server secret**.
4. Writes `VAPI_PRIVATE_KEY` / `VAPI_SERVER_SECRET` / `VAPI_SERVER_URL`
   into `.env` and `VITE_VAPI_PUBLIC_KEY` / `VITE_VAPI_ASSISTANT_ID` /
   `VITE_API_URL` into `web/.env`.
5. Health-checks the backend and prints next steps.

Flags: `--dry-run` (change nothing) and `--yes` (skip confirmations).

Useful variants:

```bash
npm run vapi:setup -- --dry-run          # see what it would do
VAPI_SERVER_URL=https://relaypay-backend.onrender.com npm run vapi:setup -- --yes
# → repoints the assistant at your deployed backend in one command
```

---

## Manual setup (fallback)

`assistant.json` is the Vapi assistant configuration. Design: **Vapi is
the voice layer only** (STT, TTS, call management). The support brain is
our backend — the assistant's only tool, `support_agent`, POSTs the
customer's words to our `/vapi/webhook` endpoint, which runs the
decision engine + Claude Agent SDK + MCP server and returns the reply to
speak. Recording/artifacts/analysis are disabled for privacy.

1. Replace the two placeholders in `assistant.json`:
   - `{{VAPI_SERVER_URL}}` — your backend base URL (local dev: `http://localhost:8787`,
     but Vapi's cloud cannot reach localhost — use a tunnel, e.g.
     `ngrok http 8787`; production: your Render URL).
   - `{{VAPI_SERVER_SECRET}}` — the same value as `VAPI_SERVER_SECRET`
     in your backend `.env` (sent as `x-vapi-secret` and verified by
     the backend).
2. Create the assistant: `POST https://api.vapi.ai/assistant` with your
   private key as `Authorization: Bearer <key>` and the JSON as body.
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
