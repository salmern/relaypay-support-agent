/**
 * Vapi web SDK wrapper: connection, listening and speaking state,
 * live transcript events and the call id. Only the PUBLIC key is used here.
 */
import * as VapiNamespace from "@vapi-ai/web";

// @vapi-ai/web ships CommonJS only (main: dist/vapi.js, no ESM build).
// Vite's production build wraps CJS deps in an extra `{ default }`
// interop layer, which makes `new Vapi()` throw
// "rl.default is not a constructor" in the deployed bundle (dev works
// fine). Unwrap defensively so the constructor resolves correctly in
// every module-interop shape: dev (esbuild), prod (rollup commonjs),
// with or without a recognized __esModule marker.
type VapiConstructor = typeof VapiNamespace.default;
type VapiInstance = InstanceType<VapiConstructor>;

const VapiCtor = (
  (VapiNamespace as unknown as { default?: { default?: unknown } }).default
    ?.default ??
  (VapiNamespace as unknown as { default?: unknown }).default ??
  (VapiNamespace as unknown as VapiConstructor)
) as VapiConstructor;

export type CallState = "idle" | "connecting" | "connected" | "error";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  /** True while the sentence is still being spoken/transcribed. */
  partial?: boolean;
}

export interface VapiEvents {
  onCallState: (state: CallState) => void;
  onAssistantSpeaking: (speaking: boolean) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  /** The Vapi call id — the backend logs the voice conversation under it. */
  onCallId: (callId: string) => void;
  onError: (message: string) => void;
}

export class VapiVoiceClient {
  private vapi: VapiInstance | null = null;
  private readonly events: VapiEvents;

  constructor(events: VapiEvents) {
    this.events = events;
  }

  /** Starts a call with the configured assistant. Returns false when Vapi is not configured. */
  start(apiKey: string, assistantId: string): boolean {
    if (!apiKey || !assistantId) {
      this.events.onError("Voice support isn't available right now. Please use the text chat instead.");
      return false;
    }
    try {
      this.vapi = new VapiCtor(apiKey);
      this.wireEvents();
      this.events.onCallState("connecting");
      this.vapi
        .start(assistantId)
        .then((call) => {
          if (call?.id) this.events.onCallId(call.id);
        })
        .catch((error: unknown) => {
          this.events.onCallState("error");
          this.events.onError(describeError(error, "Could not start the call. Check your microphone permission and try again."));
        });
      return true;
    } catch (error) {
      this.events.onCallState("error");
      this.events.onError(describeError(error, "Could not start the call."));
      return false;
    }
  }

  stop(): void {
    try {
      this.vapi?.stop();
    } catch {
      // ignore — already stopped
    }
    this.vapi = null;
    this.events.onCallState("idle");
    this.events.onAssistantSpeaking(false);
  }

  private wireEvents(): void {
    if (!this.vapi) return;
    this.vapi.on("call-start", () => this.events.onCallState("connected"));
    this.vapi.on("call-end", () => {
      this.events.onCallState("idle");
      this.events.onAssistantSpeaking(false);
    });
    // speech-start/end describe the ASSISTANT's audio. (Note: the SDK's
    // `volume-level` event is the assistant's output level too, not the
    // microphone — it must not drive a "listening" indicator.)
    this.vapi.on("speech-start", () => this.events.onAssistantSpeaking(true));
    this.vapi.on("speech-end", () => this.events.onAssistantSpeaking(false));
    this.vapi.on("message", (message: { type: string; role?: string; transcriptType?: string; transcript?: string }) => {
      if (
        message.type === "transcript" &&
        (message.role === "user" || message.role === "assistant") &&
        message.transcript
      ) {
        // Interim results update the live bubble in place, like subtitles;
        // the final result commits it.
        this.events.onTranscript({
          role: message.role,
          text: message.transcript,
          partial: message.transcriptType !== "final",
        });
      }
    });
    this.vapi.on("error", (error: unknown) => {
      this.events.onCallState("error");
      this.events.onError(describeError(error, "The voice connection was interrupted. Please start the call again."));
    });
  }
}

function describeError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "errorMsg" in error) {
    const message = String((error as { errorMsg: unknown }).errorMsg);
    if (/permission|notallowed/i.test(message)) return "Microphone access was blocked. Allow the microphone in your browser and try again.";
  }
  if (error instanceof Error && /permission|notallowed/i.test(error.message)) {
    return "Microphone access was blocked. Allow the microphone in your browser and try again.";
  }
  return fallback;
}
