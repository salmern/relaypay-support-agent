import { useCallback, useEffect, useRef, useState } from "react";
import { VapiVoiceClient, type CallState, type TranscriptEntry } from "./vapi";
import { textTurn, endTextConversation, type TextTurnResponse } from "./api";

const VAPI_PUBLIC_KEY = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined;
const VAPI_ASSISTANT_ID = import.meta.env.VITE_VAPI_ASSISTANT_ID as string | undefined;
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8787";

type UiStatus = "Ready" | "Connecting…" | "Listening" | "Speaking" | "In call" | "Error";

function App() {
  const [callState, setCallState] = useState<CallState>("idle");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [voiceConfigured] = useState(Boolean(VAPI_PUBLIC_KEY && VAPI_ASSISTANT_ID));

  // Text test mode state (same backend + agent as the voice path).
  const [textMode, setTextMode] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [answerMeta, setAnswerMeta] = useState<TextTurnResponse | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<VapiVoiceClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new VapiVoiceClient({
      onCallState: setCallState,
      onListeningChange: setListening,
      onSpeakingChange: setSpeaking,
      onTranscript: (entry) => setTranscript((prev) => [...prev, entry]),
      onError: (message) => setError(message),
    });
  }

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, answerMeta]);

  const startCall = useCallback(() => {
    setError(null);
    setTranscript([]);
    setEscalated(false);
    setTicketId(null);
    if (!clientRef.current) return;
    clientRef.current.start(VAPI_PUBLIC_KEY ?? "", VAPI_ASSISTANT_ID ?? "");
  }, []);

  const endCall = useCallback(() => {
    clientRef.current?.stop();
    setListening(false);
    setSpeaking(false);
  }, []);

  const status: UiStatus =
    callState === "error"
      ? "Error"
      : callState === "connecting"
        ? "Connecting…"
        : callState === "idle"
          ? "Ready"
          : speaking
            ? "Speaking"
            : listening
              ? "Listening"
              : "In call";

  // ---------- Text test mode ----------

  async function sendText() {
    const message = input.trim();
    if (message === "" || pending) return;
    setInput("");
    setPending(true);
    setError(null);
    setTranscript((prev) => [...prev, { role: "user", text: message }]);
    try {
      let convId = conversationId;
      if (!convId) {
        const created = await fetch(`${API_BASE}/api/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: "text" }),
        }).then((r) => r.json() as Promise<{ conversation_id: string }>);
        convId = created.conversation_id;
        setConversationId(convId);
      }
      const turn = await textTurn(API_BASE, convId, message);
      setAnswerMeta(turn);
      if (turn.escalation_id) setEscalated(true);
      if (turn.ticket_id) setTicketId(turn.ticket_id);
      setTranscript((prev) => [...prev, { role: "assistant", text: turn.response }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  async function endText() {
    if (!conversationId) return;
    await endTextConversation(API_BASE, conversationId).catch(() => undefined);
    setConversationId(null);
  }

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">R</span>
          <div>
            <div className="brand-name">RelayPay Support</div>
            <div className="brand-sub">Customer support voice agent</div>
          </div>
        </div>
        <button className="link-button" onClick={() => setShowDebug((v) => !v)}>
          {showDebug ? "Hide agent activity" : "Agent activity"}
        </button>
      </header>

      <main className="card">
        <div className="status-row">
          <span className={`status-dot ${callState === "connected" ? (speaking ? "speaking" : listening ? "listening" : "on") : callState === "error" ? "error" : callState === "connecting" ? "connecting" : ""}`} />
          <span className="status-text">{status}</span>
          {escalated && <span className="badge badge-escalated">Escalated to human support</span>}
          {ticketId && <span className="badge">Ticket {ticketId}</span>}
        </div>

        {!textMode && (
          <div className="call-area">
            <button
              className={`call-button ${callState === "connected" || callState === "connecting" ? "end" : ""}`}
              onClick={callState === "connected" || callState === "connecting" ? endCall : startCall}
              disabled={callState === "connecting"}
            >
              {callState === "connected" ? "End call" : callState === "connecting" ? "Connecting…" : "Start support call"}
            </button>
            {!voiceConfigured && (
              <p className="hint">
                Voice keys not configured — add VITE_VAPI_PUBLIC_KEY and VITE_VAPI_ASSISTANT_ID to web/.env.
                You can try the agent in text mode below; it runs the exact same backend.
              </p>
            )}
          </div>
        )}

        <div className="transcript" aria-live="polite">
          {transcript.length === 0 && answerMeta === null ? (
            <p className="hint">
              Start a call, or switch to text mode, and your conversation with the RelayPay support agent will appear here.
            </p>
          ) : (
            transcript.map((entry, i) => (
              <div key={i} className={`bubble ${entry.role}`}>
                {entry.text}
              </div>
            ))
          )}
          {textMode && pending && <div className="bubble assistant pending">…</div>}
          <div ref={transcriptEndRef} />
        </div>

        {error && <div className="error-box">{error}</div>}

        {textMode ? (
          <div className="text-controls">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendText()}
              placeholder="Type your question…"
              disabled={pending}
            />
            <button onClick={sendText} disabled={pending || input.trim() === ""}>
              Send
            </button>
            <button className="secondary" onClick={endText} disabled={!conversationId}>
              End conversation
            </button>
            <button className="secondary" onClick={() => setTextMode(false)}>
              Voice mode
            </button>
          </div>
        ) : (
          <div className="text-controls">
            <button className="secondary" onClick={() => setTextMode(true)}>
              Text test mode
            </button>
          </div>
        )}

        {showDebug && answerMeta && (
          <DebugPanel meta={answerMeta} apiBase={API_BASE} />
        )}
        {showDebug && !answerMeta && (
          <p className="hint">Agent activity appears here after your first message in text mode.</p>
        )}
      </main>

      <footer className="footer">
        RelayPay is a fictional B2B payments product. This support agent answers only from approved knowledge and logs all activity for review.
      </footer>
    </div>
  );
}

function DebugPanel({ meta, apiBase }: { meta: TextTurnResponse; apiBase: string }) {
  const [detail, setDetail] = useState<string>("Loading…");
  useEffect(() => {
    fetch(`${apiBase}/api/debug/conversations/${meta.conversation_id}`)
      .then((r) => r.json())
      .then((d) => {
        const toolCalls = (d.tool_calls ?? []).map(
          (c: { tool_name: string; status: string; result_summary: string }) =>
            `${c.tool_name} — ${c.status} — ${c.result_summary}`,
        );
        const retrievals = (d.retrieval_logs ?? []).map(
          (r: { query: string; knowledge_chunks: string[]; source_title: string }) =>
            `"${r.query}" → [${r.knowledge_chunks.join(", ")}] ${r.source_title}`,
        );
        setDetail(
          [
            `Answer type: ${meta.answer_type} (confidence ${meta.confidence})`,
            meta.uncertainty_note ? `Note: ${meta.uncertainty_note}` : null,
            retrievals.length ? `Knowledge retrieved:\n- ${retrievals.join("\n- ")}` : "Knowledge retrieved: none",
            toolCalls.length ? `Tool calls:\n- ${toolCalls.join("\n- ")}` : "Tool calls: none",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      })
      .catch(() => setDetail("Could not load agent activity."));
  }, [meta, apiBase]);
  return <pre className="debug-panel">{detail}</pre>;
}

export default App;
