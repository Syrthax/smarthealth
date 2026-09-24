import { redFlag } from "@/lib/chat";
import { askedForName, medicationBreach, soundsLikeNoise, stripDisclaimer } from "@/lib/voice";

/**
 * One Gemini Live conversation: microphone in, model audio out, tool calls handed to the
 * page. Plain TypeScript rather than a hook, because a WebSocket, two AudioContexts and a
 * worklet have a lifecycle of their own that React renders should not be driving.
 *
 * Two safety gates run here on the transcripts, in code, whatever the model does:
 *
 * - Red flags. A native-audio model hears the patient directly, so "the model never sees
 *   an emergency" cannot be literally true for voice. What stays true is that the model
 *   never gets to *handle* one: every fragment of the patient's transcript goes through
 *   the same `redFlag()` as text chat, and a hit ends the session on the spot and hands
 *   over to the fixed emergency answer. The model's reply to that turn is held back until
 *   the patient's words have been screened (or a short timeout passes), so what it says
 *   in response to an emergency is normally never played at all.
 *
 * - Medication. The model's own transcript is checked as it arrives. A drug name or dose
 *   the server did not say first stops playback, drops the rest of the turn, and replaces
 *   its text with the fallback — the spoken form of extractJson's rule. Audio already
 *   played cannot be unsaid; see the README for what that does and does not guarantee.
 */

export type VoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";
export type VoiceFailure = "mic_denied" | "unavailable" | "rate_limited" | "dropped" | "expired";

export type VoiceHandlers = {
  status(s: VoiceStatus): void;
  /** Cumulative text of the patient's current turn. `turn` counts up within this session. */
  userSpeech(text: string, turn: number): void;
  modelSpeech(text: string, turn: number): void;
  /** `voided` is the offending term when the medication gate discarded the turn. */
  modelTurnEnd(turn: number, voided: string | null): void;
  /** The patient "turn" was background noise; the agent's reply to it was discarded unplayed. */
  noise(userTurn: number, modelTurn: number): void;
  toolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  emergency(why: string): void;
  failed(code: VoiceFailure, message: string): void;
};

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/** How long model audio waits for the patient's words to be screened before playing anyway. */
const SCREEN_WAIT_MS = 700;
/** When a reply looks like it answers noise, how long to let the transcript catch up before deciding. */
const NOISE_WAIT_MS = 600;

const NOISE_NOTE =
  "Note from the page, not the patient: what you just heard was background noise, not the patient answering. Do not thank them or move on. Say briefly that you did not quite catch that, and ask your last question again.";

const UNAVAILABLE = "Voice is not available right now. You can keep using the text assistant below.";

// Runs on the audio thread. Box-filter downsample from the device rate to 16 kHz PCM16,
// posted in 100 ms chunks. Averaging each window is a crude low-pass, which is plenty
// for speech recognition and avoids shipping a resampler.
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.acc = 0; this.sum = 0; this.cnt = 0; this.buf = new Int16Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.cnt++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.sum / this.cnt));
        this.sum = 0; this.cnt = 0;
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(1600); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("mhc-capture", Capture);
`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function pcm16ToFloat(b64: string): Float32Array<ArrayBuffer> {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length & ~1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = raw.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

type ServerMessage = {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
};

export class VoiceSession {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  // Tap for the visualiser: the patient's microphone.
  private micTap: AnalyserNode | null = null;
  private tapBuf: Uint8Array<ArrayBuffer> | null = null;
  private playing = new Set<AudioBufferSourceNode>();
  private playhead = 0;
  private over = false;
  private inbox: Promise<void> = Promise.resolve();

  // Turn bookkeeping. A patient turn opens with the first input transcript after the
  // model has spoken; a model turn opens with its first audio or transcript.
  private userTurn = 0;
  private userText = "";
  private userOpen = false;
  private modelTurn = 0;
  private modelText = "";
  private modelOpen = false;

  // The playback gate for the current model turn.
  private screened = false;
  private released = false;
  private held: Float32Array<ArrayBuffer>[] = [];
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private dropping = false;

  // The noise gate. Every patient turn is judged once, before the reply to it plays.
  private judgedTurn = 0;
  private noiseTimer: ReturnType<typeof setTimeout> | null = null;
  /** The agent's last complete utterance — what the patient is supposed to be answering. */
  private lastAsked = "";

  // What the page is showing. Every change goes through setStatus(), which smooths out the
  // flickers a raw event stream produces: a tool result sent back is followed by silence
  // and an empty turnComplete before the model speaks, and audio arrives in chunks with
  // gaps between them. Neither should flash "Listening" at the patient.
  private shown: VoiceStatus = "idle";
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** A tool result has gone back and the model has not started answering yet. */
  private awaitingModel = false;
  private awaitTimer: ReturnType<typeof setTimeout> | null = null;
  private turnHadOutput = false;

  /** Everything the server has told the model this session. Medication words in here may be repeated. */
  private grounded = "";
  private cancelled = new Set<string>();

  constructor(private readonly on: VoiceHandlers) {}

  /** `note` is sent once the session is up — used to carry the conversation across a reconnect. */
  async start(note?: string): Promise<void> {
    this.setStatus("connecting");

    // Ask for the microphone before spending a session on someone who will say no.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      return this.fail(
        denied ? "mic_denied" : "unavailable",
        denied
          ? "Microphone access was blocked, so voice cannot start. You can keep typing below, or allow the microphone in your browser and try again."
          : "No microphone could be opened. You can keep typing below.",
      );
    }
    if (this.over) return this.teardown();

    let session: { token?: string; setup?: object; error?: string };
    let res: Response;
    try {
      res = await fetch("/api/voice/session", { method: "POST" });
      session = await res.json();
    } catch {
      return this.fail("unavailable", UNAVAILABLE);
    }
    if (res.status === 429) return this.fail("rate_limited", session.error ?? UNAVAILABLE);
    if (!res.ok || !session.token) return this.fail("unavailable", session.error ?? UNAVAILABLE);
    if (this.over) return this.teardown();

    // Output runs at the model's 24 kHz. Input uses the device's own rate: some browsers
    // refuse to join a microphone to a context at a different rate, so the worklet resamples.
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    this.micCtx = new AudioContext();

    const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(session.token)}`);
    this.ws = ws;
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      ws.onopen = () => ws.send(JSON.stringify({ setup: session.setup }));
      ws.onmessage = (e) => {
        // Frames can arrive as text or as Blobs. Chain them so a slow Blob read never
        // lets a later message overtake an earlier one.
        this.inbox = this.inbox.then(async () => {
          const text = typeof e.data === "string" ? e.data : await (e.data as Blob).text();
          let msg: ServerMessage;
          try {
            msg = JSON.parse(text);
          } catch {
            return;
          }
          if (msg.setupComplete) {
            clearTimeout(timer);
            resolve(true);
          }
          await this.handle(msg);
        });
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        resolve(false);
        if (this.over) return;
        console.warn(`[voice] socket closed ${e.code} ${e.reason}`);
        this.fail("dropped", "The voice connection dropped. Your conversation is still here — reconnect, or carry on typing.");
      };
    });

    if (!(await ready)) {
      if (!this.over) this.fail("unavailable", UNAVAILABLE);
      return;
    }
    await this.startCapture();
    if (this.over) return;
    this.setStatus("listening");
    if (note) this.sendText(note);
  }

  /**
   * How loud the patient is right now, as `n` bands from 0 to 1 across the speech range.
   * Read every animation frame by the visualiser.
   */
  levels(n = 32): { mic: number[] } {
    return { mic: this.bands(this.micTap, n) };
  }

  private bands(tap: AnalyserNode | null, n: number): number[] {
    if (!tap) return new Array(n).fill(0);
    this.tapBuf ??= new Uint8Array(tap.frequencyBinCount);
    tap.getByteFrequencyData(this.tapBuf);
    // The lower half of the spectrum is where a voice lives; the top is mostly hiss.
    const span = Math.floor(this.tapBuf.length / 2 / n) || 1;
    const out: number[] = [];
    for (let b = 0; b < n; b++) {
      let sum = 0;
      for (let i = b * span; i < (b + 1) * span; i++) sum += this.tapBuf[i];
      out.push(sum / span / 255);
    }
    return out;
  }

  /** A note for the model, from the page rather than the patient. */
  sendText(text: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ realtimeInput: { text } }));
  }

  /** Silence the rest of the current answer. The patient can always cut it short. */
  hush() {
    this.stopPlayback();
    this.dropping = true;
    this.awaitingModel = false;
    this.setStatus("listening", true);
  }

  private setStatus(next: VoiceStatus, now = false) {
    if (next === "listening" && this.awaitingModel) next = "thinking";
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (next === this.shown) return;
    // Coming back to "listening" waits a beat: if the model carries on within it, the
    // patient never sees the state blink.
    if (next === "listening" && !now && (this.shown === "speaking" || this.shown === "thinking")) {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.shown = "listening";
        this.on.status("listening");
      }, 400);
      return;
    }
    this.shown = next;
    this.on.status(next);
  }

  /** Terminal states skip the smoothing: the session is over the moment it says so. */
  private finalStatus(s: "ended" | "error") {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.shown = s;
    this.on.status(s);
  }

  private stopAwaiting() {
    this.awaitingModel = false;
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    this.awaitTimer = null;
  }

  stop() {
    if (this.over) return;
    this.over = true;
    this.teardown();
    this.finalStatus("ended");
  }

  private fail(code: VoiceFailure, message: string) {
    if (this.over) return;
    this.over = true;
    this.teardown();
    this.on.failed(code, message);
    this.finalStatus("error");
  }

  private teardown() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.noiseTimer) clearTimeout(this.noiseTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.stopAwaiting();
    this.stopPlayback();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
    this.micCtx?.close().catch(() => {});
    this.outCtx?.close().catch(() => {});
    this.micCtx = this.outCtx = null;
    this.micTap = null;
  }

  private async startCapture() {
    const ctx = this.micCtx;
    if (!ctx || !this.stream) return;
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(this.stream);
    this.micTap = ctx.createAnalyser();
    this.micTap.fftSize = 256;
    this.micTap.smoothingTimeConstant = 0.6;
    source.connect(this.micTap);
    const node = new AudioWorkletNode(ctx, "mhc-capture");
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(
        JSON.stringify({ realtimeInput: { audio: { data: toBase64(e.data), mimeType: "audio/pcm;rate=16000" } } }),
      );
    };
    // A silent path to the speakers keeps the node in the rendered graph in every browser.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
  }

  private async handle(msg: ServerMessage) {
    const sc = msg.serverContent;
    if (sc?.inputTranscription?.text) this.heard(sc.inputTranscription.text);
    if (this.over) return;

    if (sc?.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData?.data && p.inlineData.mimeType?.startsWith("audio/")) this.audio(pcm16ToFloat(p.inlineData.data));
      }
    }
    if (sc?.outputTranscription?.text) this.said(sc.outputTranscription.text);
    if (sc?.interrupted) {
      // The patient spoke over it. Whatever was queued is now stale.
      this.stopPlayback();
      this.endModelTurn(null);
    }
    if (sc?.turnComplete) this.endModelTurn(null);

    if (msg.toolCallCancellation?.ids) msg.toolCallCancellation.ids.forEach((id) => this.cancelled.add(id));
    if (msg.toolCall?.functionCalls?.length) await this.tools(msg.toolCall.functionCalls);

    if (msg.goAway) {
      // The server is about to end the session. Finish on our terms, with the reason on screen.
      this.fail("expired", "The voice session reached its time limit. Your conversation is still here — reconnect to keep talking.");
    }
  }

  private heard(fragment: string) {
    if (!this.userOpen) {
      this.userOpen = true;
      this.userTurn++;
      this.userText = "";
    }
    this.userText += fragment;
    this.on.userSpeech(this.userText.trim(), this.userTurn);

    const flag = redFlag(this.userText);
    if (flag) {
      this.over = true;
      this.teardown();
      this.on.emergency(flag);
      this.finalStatus("ended");
      return;
    }
    this.screened = true;
    this.release();
  }

  private said(fragment: string) {
    this.openModelTurn();
    this.turnHadOutput = true;
    if (this.dropping) return;
    this.modelText += fragment;

    // A disclaimer tacked on the end: cut it from the transcript and stop the rest of the
    // turn's audio. Whatever it said before that has already been said.
    const cleaned = stripDisclaimer(this.modelText);
    if (cleaned.found) {
      this.modelText = cleaned.text;
      this.on.modelSpeech(this.modelText, this.modelTurn);
      this.stopPlayback();
      this.dropping = true;
      this.on.modelTurnEnd(this.modelTurn, null);
      return;
    }
    this.on.modelSpeech(this.modelText.trim(), this.modelTurn);

    const term = medicationBreach(this.modelText, this.grounded);
    if (term) {
      this.stopPlayback();
      this.dropping = true;
      this.on.modelTurnEnd(this.modelTurn, term);
      this.sendText(
        "Note from the Meridian system, not from the patient: your last answer was withdrawn because it mentioned a medicine or a dose. Never mention any medicine. Tell the patient briefly that the doctor will sort out what to take once they have examined them, and offer to book.",
      );
    }
  }

  private openModelTurn() {
    if (this.modelOpen) return;
    this.modelOpen = true;
    this.userOpen = false;
    this.modelTurn++;
    this.modelText = "";
  }

  private endModelTurn(voided: string | null) {
    // An empty turn (the model handing over to a tool) is not the model finishing.
    if (this.turnHadOutput) this.stopAwaiting();
    this.turnHadOutput = false;
    if (this.modelText.trim() && !this.dropping) this.lastAsked = this.modelText;
    if (this.noiseTimer) clearTimeout(this.noiseTimer);
    this.noiseTimer = null;
    if (this.modelOpen && !this.dropping) this.on.modelTurnEnd(this.modelTurn, voided);
    this.modelOpen = false;
    this.dropping = false;
    this.screened = false;
    this.released = false;
    this.held = [];
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (!this.over && !this.playing.size) this.setStatus("listening");
  }

  private audio(pcm: Float32Array<ArrayBuffer>) {
    this.openModelTurn();
    this.turnHadOutput = true;
    this.stopAwaiting();
    if (this.dropping) return;
    if (this.released) return this.play(pcm);
    this.held.push(pcm);
    // Held back while the patient's words are screened: from their side it is still thinking.
    this.setStatus("thinking");
    if (this.screened) return this.release();
    // No transcript of the patient yet (it can lag the audio). Wait briefly, then play:
    // a gate that never opens would make voice unusable whenever transcription stalls.
    this.releaseTimer ??= setTimeout(() => {
      this.releaseTimer = null;
      this.release(true);
    }, SCREEN_WAIT_MS);
  }

  private release(force = false) {
    if (this.released || this.over || (!this.screened && !force) || !this.held.length) return;

    // A patient turn nobody has judged yet: is the reply about to play answering words, or
    // a TV in the next room? Give a noisy-looking transcript a moment to grow (it can lag
    // the audio), and let a real answer through the instant one arrives.
    if (this.userTurn > this.judgedTurn) {
      if (this.isNoise()) {
        this.noiseTimer ??= setTimeout(() => {
          this.noiseTimer = null;
          if (this.over || this.released) return;
          if (this.isNoise()) this.rejectNoise();
          else {
            this.judgedTurn = this.userTurn;
            this.release(true);
          }
        }, NOISE_WAIT_MS);
        return;
      }
      this.judgedTurn = this.userTurn;
      if (this.noiseTimer) clearTimeout(this.noiseTimer);
      this.noiseTimer = null;
    }

    this.released = true;
    for (const pcm of this.held) this.play(pcm);
    this.held = [];
  }

  private isNoise() {
    return !askedForName(this.lastAsked) && soundsLikeNoise(this.userText);
  }

  /**
   * The reply was to noise. It is dropped unplayed, the transcript marks the "answer" as
   * background noise, and the agent is told to ask again — so the history it is taking
   * never fills up with words nobody said.
   */
  private rejectNoise() {
    this.judgedTurn = this.userTurn;
    this.held = [];
    this.dropping = true;
    this.stopPlayback();
    this.on.noise(this.userTurn, this.modelTurn);
    this.sendText(NOISE_NOTE);
    this.setStatus("listening", true);
  }

  private play(pcm: Float32Array<ArrayBuffer>) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.playhead = Math.max(this.playhead, ctx.currentTime);
    src.start(this.playhead);
    this.playhead += buf.duration;
    this.playing.add(src);
    this.setStatus("speaking");
    src.onended = () => {
      this.playing.delete(src);
      // Mid-turn gaps between chunks keep "Speaking"; only a finished turn hands back.
      if (!this.playing.size && !this.over && !this.modelOpen) this.setStatus("listening");
    };
  }

  private stopPlayback() {
    for (const src of this.playing) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already finished */
      }
    }
    this.playing.clear();
    this.playhead = 0;
    this.held = [];
  }

  private async tools(calls: { id: string; name: string; args?: Record<string, unknown> }[]) {
    // From here until the model's voice comes back, the patient is waiting on us. The
    // timer is a floor under a model that never answers, not an expected path.
    this.stopAwaiting();
    this.awaitingModel = true;
    this.awaitTimer = setTimeout(() => {
      this.awaitTimer = null;
      this.awaitingModel = false;
      if (!this.playing.size) this.setStatus("listening");
    }, 15_000);
    this.setStatus("thinking");
    // In order, one at a time: a confirm must never overtake the prepare it depends on.
    const functionResponses = [];
    for (const call of calls) {
      let response: Record<string, unknown>;
      try {
        response = await this.on.toolCall(call.name, call.args ?? {});
      } catch {
        response = { ok: false, code: "error", message: "That did not work just now." };
      }
      if (this.over) return;
      if (this.cancelled.has(call.id)) continue;
      this.grounded += JSON.stringify(response);
      functionResponses.push({ id: call.id, name: call.name, response });
    }
    if (functionResponses.length && this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
    else {
      // Nothing went back (every call was cancelled), so there is no answer to wait for.
      this.stopAwaiting();
      if (!this.playing.size) this.setStatus("listening");
    }
  }
}
