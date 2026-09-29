#!/usr/bin/env node
/**
 * One-command Vapi setup for the RelayPay support agent.
 *
 *   npm run vapi:setup            (interactive)
 *   node vapi/setup.mjs --yes     (use every default, no confirmations)
 *   node vapi/setup.mjs --dry-run (print what it would do, change nothing)
 *
 * What it does:
 *   1. Loads existing values from the repo-root .env and web/.env.
 *   2. Validates your Vapi PRIVATE key against the Vapi API.
 *   3. Creates the RelayPay assistant (or updates it if the ID is known),
 *      pointing the support_agent tool at your backend webhook and setting
 *      the shared server secret.
 *   4. Writes VAPI_PRIVATE_KEY / VAPI_SERVER_SECRET / VAPI_SERVER_URL into
 *      the root .env, and VITE_VAPI_PUBLIC_KEY / VITE_VAPI_ASSISTANT_ID /
 *      VITE_API_URL into web/.env.
 *   5. Health-checks the backend URL and prints next steps.
 *
 * Real environment variables and existing .env values are reused — the
 * script only fills in what is missing.
 */
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VAPI_API = "https://api.vapi.ai";
const DRY_RUN = process.argv.includes("--dry-run");
const ASSUME_YES = process.argv.includes("--yes") || !process.stdin.isTTY;
const INTERACTIVE = process.stdin.isTTY && !process.argv.includes("--yes");

// ---------- tiny env-file helpers ----------

function parseEnvVars(text) {
  const vars = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "") vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

function upsertEnvVar(text, key, value) {
  const lines = text.split("\n");
  const re = new RegExp(`^\\s*${key}\\s*=.*$`);
  const index = lines.findIndex((line) => re.test(line));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
    return lines.join("\n");
  }
  lines.push("", `# Added by vapi/setup.mjs`, `${key}=${value}`);
  return lines.join("\n");
}

function writeEnvFile(path, text, label) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would update ${label}`);
    return;
  }
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
  console.log(`  ✔ updated ${label}`);
}

// ---------- prompts ----------

function mask(value) {
  if (!value) return "(not set)";
  return value.length <= 10 ? "••••••" : `${value.slice(0, 6)}…`;
}

async function ask(rl, question, fallback = "", display = undefined) {
  const shown = display !== undefined ? display : fallback;
  const suffix = fallback || shown ? ` [${shown}]` : "";
  if (!INTERACTIVE) return fallback;
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer === "" ? fallback : answer;
}

async function confirm(rl, question, def = true) {
  if (!INTERACTIVE) return def;
  const answer = (await rl.question(`${question} ${def ? "(Y/n)" : "(y/N)"}: `))
    .trim()
    .toLowerCase();
  if (answer === "") return def;
  return answer === "y" || answer === "yes";
}

// ---------- Vapi API ----------

async function vapiFetch(method, path, privateKey, body) {
  const res = await fetch(`${VAPI_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${privateKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body
  }
  return { status: res.status, ok: res.ok, data };
}

function findSupportTool(assistant) {
  return (assistant?.model?.tools ?? []).find(
    (tool) => tool?.function?.name === "support_agent",
  );
}

// ---------- main ----------

async function main() {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RelayPay — Vapi setup (voice layer)
  Public key + assistant live in Vapi; the secret is shared
  with your backend. This script wires it all up in one go.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (DRY_RUN) console.log("(dry-run: no API writes, no file changes)\n");

  // ---- 1. Load current state ----
  const rootEnvPath = resolve(ROOT, ".env");
  const webEnvPath = resolve(ROOT, "web", ".env");

  if (!existsSync(rootEnvPath)) {
    const example = readFileSync(resolve(ROOT, ".env.example"), "utf8");
    if (!DRY_RUN) writeFileSync(rootEnvPath, example);
    console.log("  ✔ created .env from .env.example (fill SUPABASE_* when ready)");
  }
  const rootText = existsSync(rootEnvPath) ? readFileSync(rootEnvPath, "utf8") : "";
  const webText = existsSync(webEnvPath) ? readFileSync(webEnvPath, "utf8") : "";
  // Real environment variables win over .env-file values (e.g.
  // `VAPI_SERVER_URL=https://… npm run vapi:setup` must override the URL
  // saved in .env from a previous run).
  const root = {
    ...parseEnvVars(rootText),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""),
    ),
  };
  const web = parseEnvVars(webText);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // ---- 2. Private key (only value that may be missing) ----
  console.log("\n① Private key — dashboard.vapi.ai → API Keys (the PRIVATE one)");
  let privateKey = root.VAPI_PRIVATE_KEY ?? "";
  if (privateKey) {
    console.log("  using the private key saved in .env (VAPI_PRIVATE_KEY)");
  } else {
    privateKey = await ask(rl, "  paste your Vapi private key");
  }
  if (!privateKey) {
    console.error("\n✖ No private key available. Paste it when prompted, or add");
    console.error("  VAPI_PRIVATE_KEY=<key> to .env and re-run npm run vapi:setup");
    rl.close();
    process.exit(1);
  }

  const check = await vapiFetch("GET", "/assistant?limit=1", privateKey);
  if (check.status === 401) {
    console.error("\n✖ Vapi rejected that private key (401). Copy the PRIVATE key from");
    console.error("  dashboard.vapi.ai → API Keys and re-run npm run vapi:setup");
    rl.close();
    process.exit(1);
  }
  if (!check.ok) {
    console.error(`\n✖ Could not reach the Vapi API (HTTP ${check.status}). Try again.`);
    rl.close();
    process.exit(1);
  }
  console.log("  ✔ private key accepted");

  // ---- 3. Public key ----
  console.log("\n② Public key — the browser needs it to start calls");
  let publicKey = web.VITE_VAPI_PUBLIC_KEY ?? root.VITE_VAPI_PUBLIC_KEY ?? "";
  if (publicKey) {
    console.log(`  using saved public key (${mask(publicKey)})`);
  } else {
    publicKey = await ask(rl, "  paste your Vapi public key");
    if (!publicKey) {
      console.error("\n✖ Public key is required for voice calls from the web app.");
      rl.close();
      process.exit(1);
    }
  }

  // ---- 4. Backend URL the assistant should call ----
  console.log("\n③ Backend URL — where Vapi delivers the customer's words");
  const defaultBackend = root.VAPI_SERVER_URL || "http://localhost:8787";
  const backendUrl = (
    await ask(rl, "  backend base URL", defaultBackend)
  ).replace(/\/+$/, "");
  if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(backendUrl)) {
    console.log("  ⚠ Vapi's cloud cannot reach http://localhost — for live voice");
    console.log("    calls use a tunnel (ngrok http 8787) or your Render URL.");
    console.log("    The text channel works fine locally either way.");
  }

  // ---- 5. Shared secret (reuse or generate) ----
  const secret = root.VAPI_SERVER_SECRET || randomBytes(32).toString("hex");
  console.log(
    root.VAPI_SERVER_SECRET
      ? "  ✔ reusing VAPI_SERVER_SECRET from .env"
      : "  ✔ generated a new VAPI_SERVER_SECRET",
  );

  // ---- 6. Create or update the assistant ----
  console.log("\n④ Assistant — RelayPay Support Agent");
  const template = readFileSync(resolve(ROOT, "vapi", "assistant.json"), "utf8")
    .replaceAll("{{VAPI_SERVER_URL}}", backendUrl)
    .replaceAll("{{VAPI_SERVER_SECRET}}", secret);
  const assistantConfig = JSON.parse(template);

  const knownId = web.VITE_VAPI_ASSISTANT_ID || root.VITE_VAPI_ASSISTANT_ID || "";
  let assistantId = knownId;

  if (knownId) {
    const existing = await vapiFetch("GET", `/assistant/${knownId}`, privateKey);
    if (existing.ok) {
      const tool = findSupportTool(existing.data);
      const currentUrl = tool?.server?.url ?? "(none)";
      console.log(`  found existing assistant ${knownId}`);
      console.log(`  current tool URL: ${currentUrl}`);
      if (currentUrl !== `${backendUrl}/vapi/webhook`) {
        console.log(`  will update it to: ${backendUrl}/vapi/webhook`);
      }
      if (DRY_RUN) {
        console.log("  [dry-run] would PATCH /assistant/:id with updated config");
      } else if (await confirm(rl, "  update this assistant?", true)) {
        const updated = await vapiFetch(
          "PATCH",
          `/assistant/${knownId}`,
          privateKey,
          assistantConfig,
        );
        if (!updated.ok) {
          console.error(`✖ Assistant update failed (HTTP ${updated.status}):`);
          console.error(JSON.stringify(updated.data, null, 2));
          rl.close();
          process.exit(1);
        }
        console.log("  ✔ assistant updated");
      } else {
        console.log("  left the assistant unchanged");
      }
    } else {
      console.log(`  assistant ${knownId} not found in this account — creating a new one`);
      assistantId = "";
    }
  }

  if (!assistantId) {
    if (DRY_RUN) {
      assistantId = "<new-assistant-id>";
      console.log("  [dry-run] would POST /assistant (create RelayPay Support Agent)");
    } else {
      const created = await vapiFetch("POST", "/assistant", privateKey, assistantConfig);
      if (!created.ok) {
        console.error(`✖ Assistant creation failed (HTTP ${created.status}):`);
        console.error(JSON.stringify(created.data, null, 2));
        rl.close();
        process.exit(1);
      }
      assistantId = created.data.id;
      console.log(`  ✔ assistant created (${assistantId})`);
    }
  }

  // ---- 7. Write the env files ----
  console.log("\n⑤ Writing credentials");
  let rootOut = rootText;
  rootOut = upsertEnvVar(rootOut, "VAPI_PRIVATE_KEY", privateKey);
  rootOut = upsertEnvVar(rootOut, "VAPI_SERVER_SECRET", secret);
  rootOut = upsertEnvVar(rootOut, "VAPI_SERVER_URL", backendUrl);
  writeEnvFile(rootEnvPath, rootOut, ".env (private key, secret, server URL)");

  let webOut = webText || "# Vapi voice — browser-side values (added by vapi/setup.mjs)\n";
  webOut = upsertEnvVar(webOut, "VITE_VAPI_PUBLIC_KEY", publicKey);
  webOut = upsertEnvVar(webOut, "VITE_VAPI_ASSISTANT_ID", assistantId);
  webOut = upsertEnvVar(webOut, "VITE_API_URL", backendUrl);
  writeEnvFile(webEnvPath, webOut, "web/.env (public key, assistant ID, API URL)");

  // ---- 8. Backend health check ----
  console.log("\n⑥ Verifying the backend");
  let healthy = false;
  try {
    const res = await fetch(`${backendUrl}/api/health`, {
      signal: AbortSignal.timeout(2_500),
    });
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  if (healthy) {
    console.log(`  ✔ backend is up at ${backendUrl}`);
  } else {
    console.log(`  ✖ backend not reachable at ${backendUrl}`);
    console.log("    start it with: npm run dev:server");
  }

  rl.close();

  // ---- Summary ----
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Vapi setup ${DRY_RUN ? "(dry-run) " : ""}complete

  assistant : RelayPay Support Agent (${assistantId})
  tool URL  : ${backendUrl}/vapi/webhook
  secret    : shared between the assistant and .env (VAPI_SERVER_SECRET)
  web/.env  : VITE_VAPI_PUBLIC_KEY, VITE_VAPI_ASSISTANT_ID, VITE_API_URL

  Next steps:
    1. npm run dev:server        # backend on :8787
    2. npm run dev:web           # UI on :5173 → press Start call
  Re-run any time: npm run vapi:setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch((error) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
