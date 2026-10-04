import { useCallback, useEffect, useRef, useState } from "react";
import { VapiVoiceClient, type CallState, type TranscriptEntry } from "./vapi";
import {
  endTextConversation,
  fetchActivity,
  startTextConversation,
  textTurn,
  type TextSession,
  type TurnActivity,
} from "./api";

const VAPI_PUBLIC_KEY = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined;
const VAPI_ASSISTANT_ID = import.meta.env.VITE_VAPI_ASSISTANT_ID as string | undefined;
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8787";

type UiStatus = "Ready" | "Connecting…" | "Listening" | "Speaking" | "Error";

/** Latest turn's activity, as recorded by the backend's audit trail. */
interface ActivityView extends TurnActivity {
  channel: "voice" | "text";
}

function App() {
  const [callState, setCallState] = useState<CallState>("idle");
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<ActivityView | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const voiceConfigured = Boolean(VAPI_PUBLIC_KEY && VAPI_ASSISTANT_ID);

  // Text mode: same backend + agent as the voice path.
  const [textMode, setTextMode] = useState(!voiceConfigured);
  const [session, setSession] = useState<TextSession | null>(null);
  const [ended, setEnded] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<VapiVoiceClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new VapiVoiceClient({
      onCallState: setCallState,
      onAssistantSpeaking: setAssistantSpeaking,
      onCallId: setCallId,
      // Live captions: an interim transcript updates the bubble in place;
      // the final result commits it.
      onTranscript: (entry) =>
        setTranscript((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === entry.role && last.partial) {
            return [...prev.slice(0, -1), entry];
          }
          return [...prev, entry];
        }),
      onError: (message) => setError(message),
    });
  }

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, pending]);

  // Voice: after each final assistant reply, read the call's activity
  // (tool calls, retrieval, escalation) from the backend audit trail.
  // Only poll after the user has spoken at least once — the backend
  // creates the conversation row only when Vapi's tool-calls webhook
  // fires (which happens in response to user speech, not the greeting).
  const finalAssistantCount = transcript.filter((t) => t.role === "assistant" && !t.partial).length;
  const userHasSpoken = transcript.some((t) => t.role === "user" && !t.partial);
  useEffect(() => {
    if (!callId || finalAssistantCount === 0 || !userHasSpoken) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const view = await fetchActivity(API_BASE, callId);
      if (cancelled || !view) return;
      const latest = view.turns[view.turns.length - 1];
      if (latest) setActivity({ ...latest, channel: "voice" });
      setEscalated(view.escalated);
      setTicketId(view.ticket_ids[view.ticket_ids.length - 1] ?? null);
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [callId, finalAssistantCount]);

  const resetConversation = useCallback(() => {
    setTranscript([]);
    setEscalated(false);
    setTicketId(null);
    setActivity(null);
    setError(null);
    setEnded(false);
    setInput("");
  }, []);

  const startCall = useCallback(() => {
    resetConversation();
    setCallId(null);
    clientRef.current?.start(VAPI_PUBLIC_KEY ?? "", VAPI_ASSISTANT_ID ?? "");
  }, [resetConversation]);

  const endCall = useCallback(() => {
    clientRef.current?.stop();
    setAssistantSpeaking(false);
  }, []);

  const inCall = callState === "connected" || callState === "connecting";
  const status: UiStatus =
    callState === "error"
      ? "Error"
      : callState === "connecting"
        ? "Connecting…"
        : callState === "idle"
          ? "Ready"
          : assistantSpeaking
            ? "Speaking"
            : "Listening";

  // ---------- Text mode ----------

  async function sendText() {
    const message = input.trim();
    if (message === "" || pending) return;
    setInput("");
    setPending(true);
    setError(null);
    setTranscript((prev) => [...prev, { role: "user", text: message }]);
    try {
      let current = session;
      if (!current || ended) {
        current = await startTextConversation(API_BASE);
        setSession(current);
        setEnded(false);
      }
      const turn = await textTurn(API_BASE, current, message);
      setActivity({
        channel: "text",
        answer_type: turn.answer_type,
        confidence: turn.confidence,
        uncertainty_note: turn.uncertainty_note,
        responder: turn.responder,
        tool_calls: turn.activity.tool_calls,
        retrieval: turn.activity.retrieval,
      });
      if (turn.escalation_id) setEscalated(true);
      if (turn.ticket_id) setTicketId(turn.ticket_id);
      setTranscript((prev) => [...prev, { role: "assistant", text: turn.response }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      // The message was not answered: let the customer edit and resend it.
      setTranscript((prev) => prev.slice(0, -1));
      setInput(message);
    } finally {
      setPending(false);
    }
  }

  async function endText() {
    if (!session || ended) return;
    await endTextConversation(API_BASE, session);
    setEnded(true);
  }

  function newConversation() {
    if (session && !ended) void endTextConversation(API_BASE, session);
    setSession(null);
    resetConversation();
  }

  function switchToVoice() {
    newConversation();
    setTextMode(false);
  }

  function switchToText() {
    if (inCall) endCall();
    setCallId(null);
    resetConversation();
    setTextMode(true);
  }

  const dotClass =
    callState === "connected"
      ? assistantSpeaking ? "speaking" : "listening"
      : callState === "error" ? "error" : callState === "connecting" ? "connecting" : "";

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">R</span>
          <div>
            <div className="brand-name">RelayPay Support</div>
            <div className="brand-sub">Virtual support assistant (AI) — voice and chat</div>
          </div>
        </div>
        <button className="link-button" onClick={() => setShowActivity((v) => !v)} aria-expanded={showActivity}>
          {showActivity ? "Hide agent activity" : "Agent activity"}
        </button>
      </header>

      <main className="card">
        <div className="status-row" role="status" aria-live="polite">
          {!textMode && <span className={`status-dot ${dotClass}`} aria-hidden="true" />}
          <span className="status-text">{textMode ? (ended ? "Conversation ended" : "Text chat") : status}</span>
          {escalated && <span className="badge badge-escalated">Escalated to human support</span>}
          {ticketId && <span className="badge">Ticket {ticketId}</span>}
        </div>

        {!textMode && (
          <div className="call-area">
            <button
              className={`call-button ${inCall ? "end" : ""}`}
              onClick={inCall ? endCall : startCall}
              disabled={callState === "connecting"}
            >
              {callState === "connected" ? "End call" : callState === "connecting" ? "Connecting…" : "Start support call"}
            </button>
            <p className="hint">You'll be asked to allow your microphone. You're speaking with an AI assistant; specialists handle anything it can't.</p>
          </div>
        )}

        <div className="transcript" aria-live="polite" aria-label="Conversation">
          {transcript.length === 0 ? (
            <p className="hint">
              {textMode
                ? "Type a question below — for example, “What fees does RelayPay charge for international payments?”"
                : "Start a call and your conversation with the RelayPay support assistant will appear here."}
            </p>
          ) : (
            transcript.map((entry, i) => (
              <div key={i} className={`bubble ${entry.role}${entry.partial ? " partial" : ""}`}>
                <span className="visually-hidden">{entry.role === "user" ? "You: " : "Assistant: "}</span>
                {entry.text}
              </div>
            ))
          )}
          {textMode && pending && <div className="bubble assistant pending" aria-label="Assistant is typing">…</div>}
          <div ref={transcriptEndRef} />
        </div>

        {error && <div className="error-box" role="alert">{error}</div>}

        {textMode ? (
          <div className="text-controls">
            <label htmlFor="message" className="visually-hidden">Your message</label>
            <input
              id="message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void sendText()}
              placeholder={ended ? "Type to start a new conversation…" : "Type your question…"}
              maxLength={2000}
              disabled={pending}
            />
            <button onClick={() => void sendText()} disabled={pending || input.trim() === ""}>
              Send
            </button>
            {session && !ended ? (
              <button className="secondary" onClick={() => void endText()} disabled={pending}>
                End conversation
              </button>
            ) : (
              <button className="secondary" onClick={newConversation} disabled={pending || transcript.length === 0}>
                New conversation
              </button>
            )}
            {voiceConfigured && (
              <button className="secondary" onClick={switchToVoice} disabled={pending}>
                Voice mode
              </button>
            )}
          </div>
        ) : (
          <div className="text-controls">
            <button className="secondary" onClick={switchToText}>
              Use text chat instead
            </button>
          </div>
        )}

        {showActivity && <ActivityPanel activity={activity} textMode={textMode} />}
      </main>

      <footer className="footer">
        RelayPay is a fictional B2B payments product. This AI support assistant answers only from approved knowledge, and every
        lookup, ticket and escalation is logged for review.
      </footer>
    </div>
  );
}

/**
 * Renders the latest turn's activity exactly as the backend audit trail
 * recorded it — it never infers or invents activity.
 */
function ActivityPanel({ activity, textMode }: { activity: ActivityView | null; textMode: boolean }) {
  if (!activity) {
    return (
      <p className="hint">
        {textMode ? "Agent activity appears here after your first message." : "Agent activity appears here after the assistant's first reply."}
      </p>
    );
  }
  const toolCalls = activity.tool_calls;
  return (
    <section className="debug-panel" aria-label="Agent activity for the latest turn">
      <div className="debug-row"><strong>Latest turn:</strong> {activity.answer_type} · confidence {activity.confidence}
        {activity.responder ? ` · phrased by ${activity.responder === "claude" ? "Claude (Agent SDK)" : "deterministic responder"}` : ""}</div>
      {activity.uncertainty_note && <div className="debug-row"><strong>Note:</strong> {activity.uncertainty_note}</div>}
      <div className="debug-row">
        <strong>Knowledge retrieved:</strong>{" "}
        {activity.retrieval
          ? activity.retrieval.knowledge_chunks.length > 0
            ? `${activity.retrieval.knowledge_chunks.join(", ")} — ${activity.retrieval.source_title}`
            : "searched, no approved knowledge matched"
          : "not used for this turn"}
      </div>
      <div className="debug-row">
        <strong>MCP tool calls (from the audit log):</strong>
        {toolCalls === null ? (
          " not recorded for this turn"
        ) : toolCalls.length === 0 ? (
          " none"
        ) : (
          <ul>
            {toolCalls.map((call, i) => (
              <li key={i}>
                {call.tool_name}
                {call.event_type ? ` (${call.event_type.replace(/_/g, " ")})` : ""} — {call.status} — {call.result_summary}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default App;
