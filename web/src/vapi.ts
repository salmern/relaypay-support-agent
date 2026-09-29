/**
 * Vapi web SDK wrapper: connection, listening and speaking state,
 * live transcript events. Only the PUBLIC key is used here.
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
}

export interface VapiEvents {
  onCallState: (state: CallState) => void;
  onListeningChange: (listening: boolean) => void;
  onSpeakingChange: (speaking: boolean) => void;
  onTranscript: (entry: TranscriptEntry) => void;
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
      this.events.onError(
        "Voice is not configured yet. Set VITE_VAPI_PUBLIC_KEY and VITE_VAPI_ASSISTANT_ID (see README), or use the text test mode below.",
      );
      return false;
    }
    try {
      this.vapi = new VapiCtor(apiKey);
      this.wireEvents();
      this.events.onCallState("connecting");
      void this.vapi.start(assistantId);
      return true;
    } catch (error) {
      this.events.onCallState("error");
      this.events.onError(error instanceof Error ? error.message : "Failed to start the call");
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
    this.events.onListeningChange(false);
    this.events.onSpeakingChange(false);
  }

  private wireEvents(): void {
    if (!this.vapi) return;
    this.vapi.on("call-start", () => {
      this.events.onCallState("connected");
    });
    this.vapi.on("call-end", () => {
      this.events.onCallState("idle");
      this.events.onListeningChange(false);
      this.events.onSpeakingChange(false);
    });
    this.vapi.on("speech-start", () => {
      this.events.onSpeakingChange(true);
      this.events.onListeningChange(false);
    });
    this.vapi.on("speech-end", () => {
      this.events.onSpeakingChange(false);
      this.events.onListeningChange(true);
    });
    this.vapi.on("volume-level", (level: number) => {
      // While the customer speaks (mic input), Vapi reports volume levels.
      if (level > 0.05) this.events.onListeningChange(true);
    });
    this.vapi.on("message", (message: { type: string; role?: string; transcriptType?: string; transcript?: string }) => {
      if (
        message.type === "transcript" &&
        (message.role === "user" || message.role === "assistant") &&
        message.transcriptType === "final" &&
        message.transcript
      ) {
        this.events.onTranscript({ role: message.role, text: message.transcript });
      }
    });
    this.vapi.on("error", (error: unknown) => {
      this.events.onCallState("error");
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "errorMsg" in error
            ? String((error as { errorMsg: unknown }).errorMsg)
            : "Voice connection error";
      this.events.onError(message);
    });
  }
}
