"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BOOKED_EVENT, remembered } from "@/components/rec-card";
import { VoiceSession, type VoiceStatus } from "@/components/voice/voice-session";
import VoiceOrb from "@/components/voice/voice-orb";
import { emergencyAnswer, OUT_OF_SCOPE_REPLY } from "@/lib/chat";
import type { BookingConfirmation } from "@/lib/booking";
import { patientAgreed } from "@/lib/voice";
import { FRONT_DESK, OFF_TOPIC_LIMIT, OFF_TOPIC_REPLIES } from "@/lib/guard";
import type { Msg, Pending } from "./types";
import { askAssistant, bookingLine, conversational, finished, serverAction, speak } from "./assistant";
import { AssistantMessage, SpokenTag, Thinking, VoiceBar } from "./message-cards";
import { TranscriptSheet } from "./transcript-sheet";

const VOICE_STARTED = "Voice conversation started";
const VOICE_ENDED = "Voice conversation ended";

const OPENER: Msg = {
  role: "assistant",
  content:
    `Hello, you've reached ${FRONT_DESK}. Tell me what has been going on with your health and roughly how long for — I'll tell you what it could be, how soon you ought to be seen, and which doctor is the right person to check it.`,
};

/** What the agent does once a booking is made — and then voice closes itself. */
const BOOKED_NEXT =
  "Tell them it is booked, read the reference slowly, letter by letter, and say it is on their screen. Then say a short, warm goodbye. Ask nothing else — the call ends after this.";
/** Reading a reference out takes a while; this is only a floor under a goodbye that never comes. */
const BOOKED_GOODBYE_FLOOR_MS = 60_000;

const VOIDED =
  "Let me stop there — what to take is a question for the doctor, who can look at the whole picture. I can help you book them.";

const CHAT_KEY = "mhc.chat";

/**
 * The conversation lives in this browser and nowhere else — it is never persisted
 * server-side, and clearing it here is the only copy there is. Voice turns are kept as
 * text like any other; audio is never stored anywhere.
 */
function loadChat(): Msg[] {
  if (typeof window === "undefined") return [OPENER];
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "null");
    return Array.isArray(saved) && saved.length ? saved : [OPENER];
  } catch {
    return [OPENER];
  }
}

let nextId = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextId++}`;

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>(loadChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Tool calls arrive on the socket's schedule, not React's; they read the latest
  // transcript from here rather than from a render that may already be stale.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const [voice, setVoice] = useState<VoiceStatus>("idle");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const session = useRef<VoiceSession | null>(null);
  // The same session, as state, for the visualiser to read from during render.
  const [orbSession, setOrbSession] = useState<VoiceSession | null>(null);
  const sessionNo = useRef(0);
  /** Every patient voice turn, numbered in the order heard, across sessions. */
  const heard = useRef(new Map<string, { seq: number; text: string }>());
  const heardSeq = useRef(0);
  const confirming = useRef(new Map<string, Promise<Record<string, unknown>>>());
  /** Off-topic replies in a row during voice. Any health-related tool call resets it. */
  const offTopicRun = useRef(0);
  const ended = messages.some((m) => m.ended);
  const live = voice === "connecting" || voice === "listening" || voice === "thinking" || voice === "speaking";

  // Called on every typed chunk as well as on every new message, so the panel keeps
  // pace with text that is still arriving.
  const stickToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  useEffect(() => {
    if (open) stickToBottom();
  }, [open, messages, stickToBottom]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    try {
      // A lone opener is not a conversation. Not writing it keeps "Clear" honest:
      // afterwards there is genuinely nothing in storage.
      if (messages.length > 1) localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
      else localStorage.removeItem(CHAT_KEY);
    } catch {
      /* private window or storage full — the conversation just will not outlive the tab */
    }
  }, [messages]);

  /** Patch the message with this id, or add it if `create` is given and it does not exist yet. */
  const upsert = useCallback((id: string, patch: Partial<Msg>, create?: Omit<Msg, "id">) => {
    setMessages((m) => {
      const i = m.findIndex((x) => x.id === id);
      if (i === -1) return create ? [...m, { ...create, ...patch, id }] : m;
      const copy = [...m];
      copy[i] = { ...copy[i], ...patch };
      return copy;
    });
  }, []);

  const append = useCallback((msg: Msg) => setMessages((m) => [...m, { id: newId("m"), ...msg }]), []);

  /** One card per booking reference, however many times it is reported. */
  const addBooking = useCallback((b: BookingConfirmation) => {
    setMessages((m) =>
      m.some((x) => x.booking?.reference === b.reference)
        ? m
        : [...m, { id: `bk-${b.reference}`, role: "assistant", content: bookingLine(b), booking: b }],
    );
  }, []);

  const setPending = useCallback((pid: string, patch: Partial<Pending>) => {
    setMessages((m) =>
      m.map((x) => (x.pending?.pid === pid ? { ...x, pending: { ...x.pending, ...patch } } : x)),
    );
  }, []);

  // A booking made from any card on the site appears in the conversation, and the
  // voice agent is told, so it does not offer to book the same thing again.
  useEffect(() => {
    const onBooked = (e: Event) => {
      const b = (e as CustomEvent<BookingConfirmation>).detail;
      if (!b?.reference) return;
      addBooking(b);
      session.current?.sendText(
        `Note from the page, not the patient: they just booked ${b.itemName} for ${b.slotLabel} on screen, reference ${b.reference}. Acknowledge it in one sentence.`,
      );
    };
    window.addEventListener(BOOKED_EVENT, onBooked);
    return () => window.removeEventListener(BOOKED_EVENT, onBooked);
  }, [addBooking]);

  useEffect(() => () => session.current?.stop(), []);

  // Clearing asks twice: the first tap arms it for a few seconds, the second does it.
  // There is no other copy of the conversation, so a stray tap should not be able to lose it.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  /**
   * Wipes everything the conversation left on this device: the stored transcript, any
   * booking proposals still waiting, what voice heard, and any half-typed message. Bookings
   * already made are real and stay booked; the saved name and phone for the booking form
   * are kept, as a convenience rather than history.
   */
  function clearChat() {
    if (!armed) return setArmed(true);
    setArmed(false);
    resetChat();
  }

  function resetChat() {
    endVoice();
    offTopicRun.current = 0;
    try {
      speechSynthesis.cancel();
    } catch {
      /* nothing speaking */
    }
    heard.current.clear();
    confirming.current.clear();
    setVoiceNote(null);
    setInput("");
    setMessages([OPENER]);
    try {
      localStorage.removeItem(CHAT_KEY);
    } catch {
      /* nothing stored to begin with */
    }
    inputRef.current?.focus();
  }

  // Called with no argument from the composer, or with the text of a chosen option.
  async function send(answer?: string) {
    const text = (answer ?? input).trim();
    if (!text || busy || ended) return;

    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    if (!answer) setInput("");
    setBusy(true);

    // One placeholder that fills in as the stream arrives, rather than a spinner that
    // is replaced by a finished block.
    const id = newId("a");
    let started = false;
    try {
      const e = await askAssistant(next.slice(1), (v) => {
        if (!started) setBusy(false);
        started = true;
        upsert(id, { content: v, streaming: true }, { role: "assistant", content: "" });
      });
      upsert(id, finished(e), { role: "assistant", content: "" });
    } catch {
      upsert(
        id,
        { content: "I could not reach the hospital system. Please try again.", streaming: false },
        { role: "assistant", content: "" },
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Makes a proposed booking real. The patient must have agreed — by pressing Confirm, or
   * by saying yes in their own transcribed words *after* the proposal was made. The model
   * saying they agreed is not agreement. The server then re-checks everything at write time.
   */
  async function confirmPending(pid: string, pressed: boolean): Promise<Record<string, unknown>> {
    const inFlight = confirming.current.get(pid);
    if (inFlight) return inFlight; // a duplicated call gets the same answer, not a second booking

    const p = messagesRef.current.find((m) => m.pending?.pid === pid)?.pending;
    if (!p)
      return { ok: false, code: "not_pending", message: "There is no booking waiting for confirmation. Let me put it together again." };
    if (p.state === "confirmed") {
      const b = messagesRef.current.find((m) => m.booking?.reference === p.reference)?.booking;
      if (b) return { ok: true, booking: b, replayed: true };
    }
    if (p.state !== "open" && p.state !== "failed")
      return { ok: false, code: "not_pending", message: "That proposal was cancelled or replaced. Let me put it together again." };

    if (!pressed) {
      const since = [...heard.current.values()].filter((h) => h.seq > p.heardAt).map((h) => h.text).join(" ");
      if (!patientAgreed(since))
        return {
          ok: false,
          code: "not_confirmed",
          message: "The patient has not said yes to this yet. Read the summary back and ask them to confirm — they can also press Confirm on screen.",
        };
    }

    const run = (async () => {
      setPending(pid, { state: "confirming", error: undefined });
      const r = await serverAction("confirm_booking", { token: p.token });
      if (r.ok && r.booking) {
        const b = r.booking as BookingConfirmation;
        setPending(pid, { state: "confirmed", reference: b.reference });
        addBooking(b);
        try {
          localStorage.setItem("mhc.patient", JSON.stringify({ name: p.summary.patientName, phone: p.summary.phone }));
        } catch {
          /* storage blocked — the booking still went through */
        }
      } else {
        setPending(pid, { state: "failed", error: String(r.message ?? "The booking did not go through.") });
      }
      return r;
    })();
    confirming.current.set(pid, run);
    try {
      return await run;
    } finally {
      confirming.current.delete(pid);
    }
  }

  async function pressConfirm(pid: string) {
    const r = await confirmPending(pid, true);
    session.current?.sendText(
      r.ok
        ? `Note from the page, not the patient: they pressed Confirm on screen and it is booked: ${JSON.stringify(r.booking)}. ${BOOKED_NEXT}`
        : `Note from the page, not the patient: they pressed Confirm on screen but it did not go through: ${String(r.message)} Tell them plainly.`,
    );
    if (r.ok) session.current?.endAfterReply(BOOKED_GOODBYE_FLOOR_MS);
  }

  function pressCancel(pid: string) {
    setPending(pid, { state: "cancelled" });
    session.current?.sendText(
      "Note from the page, not the patient: they cancelled that booking proposal on screen. Nothing was booked. Ask what they would like instead.",
    );
  }

  function emergencyFromVoice(why: string) {
    const e = emergencyAnswer(why);
    append({ ...finished(e) });
    speak(e.reply);
    setVoiceNote(null);
  }

  /**
   * One more off-topic turn in voice. The line to say and whether it ends the conversation
   * are decided here, in code — the agent only reads the line out.
   */
  function strike(): { say: string; end: boolean } {
    const n = Math.min(++offTopicRun.current, OFF_TOPIC_LIMIT);
    const end = n >= OFF_TOPIC_LIMIT;
    if (end) append({ role: "assistant", content: "", marker: "Conversation ended", ended: true });
    return { say: OFF_TOPIC_REPLIES[n - 1], end };
  }

  /** Every tool the voice agent can call. Server tools pass straight through; the rest are here. */
  async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name !== "off_topic") offTopicRun.current = 0; // back on topic: the count starts again
    switch (name) {
      case "off_topic": {
        const { say, end } = strike();
        if (end) session.current?.endAfterReply();
        return { ok: true, sayExactly: say, conversationEnds: end };
      }

      case "assess_symptoms": {
        // The patient's own transcribed words are the input, so redFlag() on the server
        // reads what they said rather than the model's paraphrase of it.
        const history = messagesRef.current.slice(1).filter(conversational);
        while (history.length && history[history.length - 1].role === "assistant") history.pop();
        const last = history[history.length - 1]?.content ?? "";
        if (last.trim().length < 3 && typeof args.description === "string")
          history.push({ role: "user", content: args.description.slice(0, 1500) });
        if (!history.length) return { ok: false, code: "invalid", message: "Ask the patient what they have been feeling." };

        let e: Record<string, unknown>;
        try {
          e = await askAssistant(history);
        } catch {
          return { ok: false, code: "error", message: "I could not reach the assessment just now. Offer the doctor directory or reception." };
        }
        const card = finished(e);
        append(card);
        if (card.emergency) {
          endVoice();
          speak(card.content);
          return { ok: false, code: "emergency", message: card.content };
        }
        return {
          ok: true,
          // Instructions travel with the result, right where the model composes its answer —
          // a rule only in the system prompt was not enough to stop it adding a disclaimer.
          howToSayIt: card.question
            ? "Ask exactly this question, then wait for the answer. Do not recommend anything yet."
            : "Say what it could be, who to see and how soon, and what to prepare for. Then offer to book, and stop. Add no disclaimer: do not say this is not medical advice or to see a healthcare professional — naming the doctor already is that.",
          reply: card.content,
          urgency: card.urgency,
          assessment: card.assessment,
          nextSteps: card.nextSteps,
          question: card.question,
          outOfScope: card.outOfScope,
          degraded: e.degraded === true,
          rateLimited: e.rateLimited === true,
          doctors: card.doctors?.map((d) => ({
            doctorId: d.id,
            name: d.name,
            specialty: d.specialty,
            consultationFeeRupees: d.consult_fee,
            sits: d.avail_days,
          })),
          tests: card.tests?.map((t) => ({
            code: t.code,
            name: t.name,
            priceRupees: t.price,
            lab: t.lab_name,
            referral: t.lab_kind === "partner",
          })),
        };
      }

      case "get_saved_patient": {
        const p = remembered();
        return p.name && p.phone ? { ok: true, saved: true, name: p.name, phone: p.phone } : { ok: true, saved: false };
      }

      case "hospital_info":
        append({ role: "assistant", content: OUT_OF_SCOPE_REPLY, outOfScope: true });
        return { ok: true, answer: OUT_OF_SCOPE_REPLY };

      case "prepare_booking": {
        const r = await serverAction("prepare_booking", args);
        if (!r.ok) return r;
        const pid = `P${Date.now().toString(36).slice(-4).toUpperCase()}`;
        // Only the newest proposal can be confirmed; anything older is superseded.
        setMessages((m) =>
          m.map((x) => (x.pending?.state === "open" ? { ...x, pending: { ...x.pending, state: "replaced" } } : x)),
        );
        append({
          role: "assistant",
          content: "",
          pending: {
            pid,
            token: String(r.token),
            heardAt: heardSeq.current,
            summary: r.summary as Pending["summary"],
            state: "open",
          },
        });
        return { ok: true, pendingId: pid, summary: r.summary, next: "Read this back and ask the patient to confirm." };
      }

      case "confirm_booking": {
        let pid = String(args.pendingId ?? "");
        const open = messagesRef.current.filter((m) => m.pending?.state === "open");
        // A garbled id with exactly one open proposal still means that proposal. Consent is checked either way.
        if (!messagesRef.current.some((m) => m.pending?.pid === pid) && open.length === 1) pid = open[0].pending!.pid;
        const r = await confirmPending(pid, false);
        if (!r.ok) return r;
        // Booked: the call has done its job. The agent reads the reference and says goodbye,
        // then voice closes itself and the page shows the transcript with the booking card.
        session.current?.endAfterReply(BOOKED_GOODBYE_FLOOR_MS);
        return { ...r, next: BOOKED_NEXT };
      }

      default:
        return serverAction(name, args);
    }
  }

  function startVoice() {
    if ((session.current && live) || ended) return;
    const sid = ++sessionNo.current;
    setVoiceNote(null);

    // After a drop or a time-out, a fresh session knows nothing. A short account of what is
    // on screen lets it pick up rather than start over.
    const prior = messagesRef.current.slice(1).filter(conversational).slice(-8);
    const note = prior.length
      ? `Note from the page, not the patient: voice is reconnecting mid-conversation. So far: ${prior
          .map((m) => `${m.role === "user" ? "Patient" : "Assistant"}: ${m.content.slice(0, 300)}`)
          .join(" | ")}. Do not repeat any of it. Say only: "Hello again, you're back with ${FRONT_DESK}. I'm listening."`
      : undefined;

    // Markers bracket the conversation in the transcript — but only once it actually
    // connected, so a denied microphone does not leave an empty "started/ended" pair.
    let opened = false;
    let closed = false;
    const s = new VoiceSession({
      status: (st) => {
        if (session.current !== s) return;
        setVoice(st);
        if (st === "listening" && !opened) {
          opened = true;
          append({ role: "assistant", content: "", marker: VOICE_STARTED });
        }
        if ((st === "ended" || st === "error") && opened && !closed) {
          closed = true;
          append({ role: "assistant", content: "", marker: VOICE_ENDED });
        }
      },
      userSpeech: (text, turn) => {
        const key = `${sid}:${turn}`;
        const seen = heard.current.get(key);
        heard.current.set(key, { seq: seen?.seq ?? ++heardSeq.current, text });
        upsert(`vu-${sid}-${turn}`, { content: text }, { role: "user", content: "", via: "voice" });
      },
      modelSpeech: (text, turn) =>
        upsert(`vm-${sid}-${turn}`, { content: text, streaming: true }, { role: "assistant", content: "", via: "voice" }),
      modelTurnEnd: (turn, voided) =>
        upsert(`vm-${sid}-${turn}`, voided ? { content: VOIDED, voided: true, streaming: false } : { streaming: false }),
      noise: (userTurn, modelTurn) => {
        // Not something the patient said: it must not count as consent, nor reach triage.
        heard.current.delete(`${sid}:${userTurn}`);
        setMessages((m) =>
          m
            .filter((x) => x.id !== `vm-${sid}-${modelTurn}`)
            .map((x) => (x.id === `vu-${sid}-${userTurn}` ? { ...x, noise: true } : x)),
        );
      },
      injection: (userTurn, modelTurn) => {
        heard.current.delete(`${sid}:${userTurn}`);
        setMessages((m) =>
          m
            .filter((x) => x.id !== `vm-${sid}-${modelTurn}`)
            .map((x) => (x.id === `vu-${sid}-${userTurn}` ? { ...x, blocked: true } : x)),
        );
        return strike();
      },
      toolCall: runTool,
      emergency: emergencyFromVoice,
      failed: (_code, message) => {
        if (session.current === s) setVoiceNote(message);
      },
    });
    session.current = s;
    setOrbSession(s);
    setVoice("connecting");
    s.start(note);
  }

  function endVoice() {
    session.current?.stop();
    session.current = null;
    setOrbSession(null);
    setVoice("idle");
  }

  const awaitingYes = live && messages.some((m) => m.pending?.state === "open");

  // In voice mode the chat is replaced by the visualiser. The one thing kept on screen is
  // the booking in play — the proposal to confirm, or the confirmation with its reference —
  // because a booking must be visible, not only heard.
  const voiceFrom = messages.findLastIndex((m) => m.marker === VOICE_STARTED);
  const stageCard = live
    ? messages
        .slice(voiceFrom + 1)
        .findLast((m) => m.booking || (m.pending && m.pending.state !== "replaced"))
    : undefined;

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="intake-panel"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-ctl bg-accent px-4 py-3 text-[14px] font-medium text-paper shadow-lg transition-colors hover:bg-accent-hover active:translate-y-px"
      >
        <span aria-hidden className={`inline-block h-2 w-2 rounded-full bg-paper/80 ${live ? "breathe" : ""}`} />
        {open ? "Close" : live ? "Voice on · Health intake" : "Health intake"}
      </button>

      {open && <TranscriptSheet messages={messages} />}

      {open && (
        <section
          id="intake-panel"
          aria-label="Health intake assistant"
          className="panel-in fixed inset-x-3 bottom-20 top-3 z-40 flex flex-col overflow-hidden rounded-card border border-rule bg-paper shadow-xl sm:inset-x-auto sm:right-4 sm:top-auto sm:h-[min(38rem,calc(100vh-7rem))] sm:w-[24rem]"
        >
          <header className="shrink-0 border-b border-rule px-4 py-3">
            <h2 className="text-[14px] font-semibold">Meridian health assistant</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              A first look at your symptoms, and the right doctor to see next.
            </p>
            {messages.length > 1 && !live && (
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="rounded-ctl border border-rule px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-surface active:translate-y-px"
                >
                  Save for your doctor
                </button>
                <button
                  onClick={clearChat}
                  aria-live="polite"
                  className={`rounded-ctl border px-2.5 py-1 text-[12px] font-medium transition-colors active:translate-y-px ${
                    armed ? "border-alert bg-alert-wash text-alert" : "border-rule hover:bg-surface"
                  }`}
                >
                  {armed ? "Tap again to clear everything" : "Clear chat"}
                </button>
                <span className="ml-auto text-[11px] text-muted">Kept on this device only</span>
              </div>
            )}
          </header>

          {live ? (
            <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 py-6">
              <VoiceOrb
                session={orbSession}
                status={voice}
                awaitingYes={awaitingYes}
                onInterrupt={() => session.current?.hush()}
                onEnd={endVoice}
              />
              {stageCard && (
                <div className="mt-6 w-full">
                  <AssistantMessage
                    message={stageCard}
                    live={false}
                    onAnswer={send}
                    onConfirm={pressConfirm}
                    onCancel={pressCancel}
                  />
                </div>
              )}
            </div>
          ) : (
            <>
            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {messages.map((m, i) =>
                m.marker ? (
                  <p
                    key={m.id ?? i}
                    className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted before:h-px before:flex-1 before:bg-rule after:h-px after:flex-1 after:bg-rule"
                  >
                    {m.marker}
                  </p>
                ) : m.role === "user" ? (
                  <div key={m.id ?? i} className="rise-in ml-auto w-fit max-w-[85%]">
                    <p
                      className={`rounded-card px-3 py-2 text-[14px] ${
                        m.noise || m.blocked ? "border border-dashed border-rule text-muted line-through" : "bg-accent-wash"
                      }`}
                    >
                      {m.content}
                    </p>
                    {m.noise || m.blocked ? (
                      <p className="mt-0.5 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                        {m.blocked ? "Not a health question · ignored" : "Background noise · ignored"}
                      </p>
                    ) : (
                      m.via === "voice" && <SpokenTag />
                    )}
                  </div>
                ) : (
                  <AssistantMessage
                    key={m.id ?? i}
                    message={m}
                    // Only the newest question is still open; earlier ones are settled.
                    live={i === messages.length - 1}
                    onAnswer={send}
                    onConfirm={pressConfirm}
                    onCancel={pressCancel}
                  />
                ),
              )}
              {busy && <Thinking />}
              <div ref={endRef} />
            </div>

            {ended ? (
              <div className="shrink-0 border-t border-rule p-3 text-center">
                <p className="text-[13px] text-muted">This conversation has ended.</p>
                <button
                  onClick={resetChat}
                  className="mt-2 w-full rounded-ctl bg-accent px-3 py-2 text-[14px] font-medium text-paper transition-colors hover:bg-accent-hover active:translate-y-px"
                >
                  Start a new conversation
                </button>
              </div>
            ) : (
              <>
            <VoiceBar status={voice} note={voiceNote} onStart={startVoice} />

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="shrink-0 border-t border-rule p-3"
            >
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="What have you been feeling, and for how long?"
                aria-label="What have you been feeling, and for how long?"
                className="w-full resize-none rounded-ctl border border-rule bg-paper px-3 py-2 text-[14px] outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="mt-2 w-full rounded-ctl bg-accent px-3 py-2 text-[14px] font-medium text-paper transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
              >
                Send
              </button>
            </form>
              </>
            )}
            </>
          )}
        </section>
      )}
    </>
  );
}
