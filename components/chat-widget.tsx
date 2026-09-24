"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DoctorCard, TestCard, BOOKED_EVENT, remembered } from "./rec-card";
import { VoiceSession, type VoiceStatus } from "./voice-session";
import VoiceOrb from "./voice-orb";
import {
  emergencyAnswer,
  OUT_OF_SCOPE_REPLY,
  type Doctor,
  type Test,
  type Question,
} from "@/lib/chat";
import type { BookingConfirmation } from "@/lib/booking";
import { patientAgreed } from "@/lib/voice";

type Urgency = "routine" | "soon" | "urgent" | "emergency";

/** A booking the voice agent has proposed. Nothing is written until it is confirmed. */
type Pending = {
  pid: string;
  /** Server-signed; the model never sees it (see lib/pending.ts). */
  token: string;
  /** Patient speech heard after this point is what counts as agreeing to it. */
  heardAt: number;
  summary: {
    kind: "doctor" | "test" | "referral";
    itemName: string;
    specialty?: string;
    labName?: string;
    labAddress?: string;
    slotLabel: string;
    costRupees: number;
    patientName: string;
    phone: string;
  };
  state: "open" | "confirming" | "confirmed" | "cancelled" | "replaced" | "failed";
  error?: string;
  /** Set once confirmed: the booking this proposal became. */
  reference?: string;
};

type Msg = {
  /** Present on anything updated after it is first added — streaming, voice, cards. */
  id?: string;
  role: "user" | "assistant";
  content: string;
  assessment?: string;
  urgency?: Urgency;
  nextSteps?: string[];
  question?: Question | null;
  outOfScope?: boolean;
  streaming?: boolean;
  doctors?: Doctor[];
  tests?: Test[];
  emergency?: { why: string; line: string };
  /** Said aloud rather than typed. */
  via?: "voice";
  /** A spoken turn the medication gate withdrew. Kept as a record, never sent back to a model. */
  voided?: boolean;
  pending?: Pending;
  booking?: BookingConfirmation;
  /** Heard as speech but judged background noise: kept as a record, never treated as something said. */
  noise?: boolean;
  /** A divider in the transcript, e.g. where a voice conversation began and ended. */
  marker?: string;
};

const VOICE_STARTED = "Voice conversation started";
const VOICE_ENDED = "Voice conversation ended";

/**
 * What the model gets to see of its own past turns. The prose alone loses the department
 * and tests it settled on, so a follow-up would start from scratch and could contradict
 * itself; this folds those decisions back into the transcript it reads.
 */
function forModel({ role, content, urgency, doctors, tests }: Msg) {
  const decided = [
    doctors?.length ? `departments: ${[...new Set(doctors.map((d) => d.specialty))].join(", ")}` : "",
    tests?.length ? `tests: ${tests.map((t) => t.code).join(", ")}` : "",
    urgency && urgency !== "routine" ? `urgency: ${urgency}` : "",
  ].filter(Boolean);

  return {
    role,
    content:
      role === "assistant" && decided.length
        ? `${content}\n[previously recommended: ${decided.join("; ")}]`
        : content,
  };
}

/** Proposals, withdrawn turns and background noise are page furniture, not conversation. */
const conversational = (m: Msg) => !m.pending && !m.voided && !m.noise && !!m.content.trim();

/**
 * Posts the conversation to /api/chat and reads the NDJSON back. `onReply` gets the prose
 * as it streams; the promise resolves with the one `done` event every path ends in. Text
 * chat and the voice agent's assess_symptoms both come through here, so both get the
 * same red flags, medication voiding and DB-hydrated cards.
 */
async function askAssistant(history: Msg[], onReply?: (text: string) => void): Promise<Record<string, unknown>> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history.filter(conversational).map(forModel) }),
  });
  if (!res.body) throw new Error("no stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    // Hold the trailing fragment: an event can straddle two chunks.
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.t === "reply") onReply?.(String(e.v));
      if (e.t === "done") return e;
    }
  }
  throw new Error("stream ended without an answer");
}

function finished(e: Record<string, unknown>): Msg {
  return {
    role: "assistant",
    content: String(e.reply ?? "Something went wrong. Please try again."),
    assessment: e.assessment as string | undefined,
    urgency: e.emergency ? "emergency" : (e.urgency as Urgency | undefined),
    nextSteps: e.nextSteps as string[] | undefined,
    question: e.question as Question | null | undefined,
    outOfScope: e.outOfScope as boolean | undefined,
    doctors: e.doctors as Doctor[] | undefined,
    tests: e.tests as Test[] | undefined,
    emergency: e.emergency as Msg["emergency"],
    streaming: false,
  };
}

const bookingLine = (b: BookingConfirmation) =>
  `Booked: ${b.itemName}, ${b.slotLabel}. Reference ${b.reference}.`;

/** The emergency answer is read aloud by the browser's own voice, never by the model. */
function speak(text: string) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-IN";
    speechSynthesis.speak(u);
  } catch {
    /* no speech synthesis — the banner and the call button are on screen regardless */
  }
}

/** POSTs one tool call to the server. Always resolves to something the model can be told. */
async function serverAction(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const res = await fetch("/api/voice/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    return await res.json();
  } catch {
    return { ok: false, code: "error", message: "I could not reach the hospital system just now." };
  }
}

const THINKING = [
  "Reading what you have written",
  "Matching it against our departments",
  "Checking which tests are worth having ready",
  "Putting your options together",
];

/** Cycles while the request is in flight. The phases are real; the timing is not. */
function Thinking() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => Math.min(n + 1, THINKING.length - 1)), 1600);
    return () => clearInterval(id);
  }, []);
  return (
    <p aria-live="polite" className="flex items-center gap-2.5 text-[14px] text-muted">
      <span
        aria-hidden
        className="spin inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-rule border-t-accent"
      />
      {THINKING[i]}…
    </p>
  );
}

/** How soon to be seen. Colour carries the same message as the words, never alone. */
const URGENCY: Record<Urgency, { label: string; note: string; cls: string }> = {
  routine: {
    label: "Routine",
    note: "Worth getting looked at, but there is no rush.",
    cls: "border-rule bg-surface text-muted",
  },
  soon: {
    label: "See a doctor soon",
    note: "Best seen within the next few days.",
    cls: "border-accent bg-accent-wash text-accent",
  },
  urgent: {
    label: "See a doctor today",
    note: "This should not wait until tomorrow.",
    cls: "border-warn bg-warn-wash text-warn",
  },
  emergency: {
    label: "Go to emergency now",
    note: "This needs to be seen in person immediately.",
    cls: "border-alert bg-alert-wash text-alert",
  },
};

const OPENER: Msg = {
  role: "assistant",
  content:
    "Tell me what has been going on and roughly how long for. I will tell you what it is usually looked at for, how soon you ought to be seen, and which doctor is the right person to get it properly checked.",
};

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
    endVoice();
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
    if (!text || busy) return;

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
        ? `Note from the page, not the patient: they pressed Confirm on screen and it is booked: ${JSON.stringify(r.booking)}. Tell them it is booked and read the reference slowly.`
        : `Note from the page, not the patient: they pressed Confirm on screen but it did not go through: ${String(r.message)} Tell them plainly.`,
    );
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

  /** Every tool the voice agent can call. Server tools pass straight through; the rest are here. */
  async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
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
        return confirmPending(pid, false);
      }

      default:
        return serverAction(name, args);
    }
  }

  function startVoice() {
    if (session.current && live) return;
    const sid = ++sessionNo.current;
    setVoiceNote(null);

    // After a drop or a time-out, a fresh session knows nothing. A short account of what is
    // on screen lets it pick up rather than start over.
    const prior = messagesRef.current.slice(1).filter(conversational).slice(-8);
    const note = prior.length
      ? `Note from the page, not the patient: voice is reconnecting mid-conversation. So far: ${prior
          .map((m) => `${m.role === "user" ? "Patient" : "Assistant"}: ${m.content.slice(0, 300)}`)
          .join(" | ")}. Do not repeat any of it. Say only that you are back and listening.`
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
                        m.noise ? "border border-dashed border-rule text-muted line-through" : "bg-accent-wash"
                      }`}
                    >
                      {m.content}
                    </p>
                    {m.noise ? (
                      <p className="mt-0.5 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                        Background noise · ignored
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
        </section>
      )}
    </>
  );
}

const SpokenTag = () => (
  <p className="mt-0.5 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Spoken</p>
);

/** The way into voice, below the chat. Once it connects, the whole panel becomes the orb. */
function VoiceBar({ status, note, onStart }: { status: VoiceStatus; note: string | null; onStart: () => void }) {
  return (
    <div className="shrink-0 border-t border-rule px-3 py-2">
      {note && (
        <p role="alert" className="mb-2 text-[12px] text-muted">
          {note}
        </p>
      )}
      <button
        onClick={onStart}
        className="w-full rounded-ctl border border-rule px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-surface active:translate-y-px"
      >
        {note || status === "ended" ? "Talk again" : "Talk instead"}
      </button>
    </div>
  );
}

/**
 * What the visitor hands the doctor. People forget in the waiting room what they managed
 * to describe clearly an hour earlier, so this is their own words back, with what the
 * assistant made of them — clearly labelled as neither a diagnosis nor a medical record.
 */
function TranscriptSheet({ messages }: { messages: Msg[] }) {
  const said = messages.filter((m) => m.role === "user" && !m.noise && m.content.trim());
  const booked = messages.flatMap((m) => (m.booking ? [m.booking] : []));
  if (!said.length) return null;

  const now = new Date().toLocaleString("en-IN", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <div className="print-sheet">
      <h1 style={{ fontSize: "16pt", margin: 0 }}>Symptom summary</h1>
      <p style={{ margin: "2pt 0 0", fontSize: "10pt" }}>
        Meridian Health City · prepared {now}
      </p>

      <p
        className="avoid-break"
        style={{
          margin: "12pt 0",
          padding: "8pt 10pt",
          border: "1pt solid currentColor",
          fontSize: "10pt",
        }}
      >
        <strong>Prepared for your consultation.</strong> Below is what you described before your
        appointment, in your own words, and the first suggestions the assistant made about
        where to start. Your doctor will take it from here.
      </p>

      <h2 style={{ fontSize: "12pt", marginTop: "16pt" }}>In the patient&rsquo;s own words</h2>
      <ol style={{ margin: "6pt 0 0", paddingLeft: "16pt" }}>
        {said.map((m, i) => (
          <li key={i} className="avoid-break" style={{ marginBottom: "5pt" }}>
            {m.content}
          </li>
        ))}
      </ol>

      {messages.map((m, i) =>
        m.role !== "assistant" || (!m.assessment && !m.doctors?.length && !m.nextSteps?.length) ? null : (
          <section key={i} className="avoid-break" style={{ marginTop: "14pt" }}>
            <h2 style={{ fontSize: "12pt", margin: 0 }}>
              Assistant&rsquo;s note
              {m.urgency ? ` · ${URGENCY[m.urgency].label.toLowerCase()}` : ""}
            </h2>
            {m.assessment && (
              <p style={{ margin: "4pt 0 0" }}>
                <strong>Commonly investigated for:</strong> {m.assessment}
              </p>
            )}
            {!!m.doctors?.length && (
              <p style={{ margin: "4pt 0 0" }}>
                <strong>Suggested department:</strong>{" "}
                {[...new Set(m.doctors.map((d) => d.specialty))].join(", ")}
              </p>
            )}
            {!!m.tests?.length && (
              <p style={{ margin: "4pt 0 0" }}>
                <strong>Tests suggested beforehand:</strong>{" "}
                {m.tests.map((t) => `${t.name} (${t.code})`).join(", ")}
              </p>
            )}
            {!!m.nextSteps?.length && (
              <ul style={{ margin: "4pt 0 0", paddingLeft: "16pt" }}>
                {m.nextSteps.map((step, n) => (
                  <li key={n}>{step}</li>
                ))}
              </ul>
            )}
          </section>
        ),
      )}

      {!!booked.length && (
        <section className="avoid-break" style={{ marginTop: "14pt" }}>
          <h2 style={{ fontSize: "12pt", margin: 0 }}>Booked</h2>
          <ul style={{ margin: "4pt 0 0", paddingLeft: "16pt" }}>
            {booked.map((b) => (
              <li key={b.reference}>
                {b.itemName} · {b.slotLabel} · ref {b.reference}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p style={{ marginTop: "18pt", fontSize: "9pt" }}>
        Meridian Health City · Reception +91 80 4000 1200 · Emergency +91 80 4000 1000.
        This summary was generated on the patient&rsquo;s own device and was not stored by the
        hospital.
      </p>
    </div>
  );
}

function AssistantMessage({
  message: m,
  live,
  onAnswer,
  onConfirm,
  onCancel,
}: {
  message: Msg;
  live: boolean;
  onAnswer: (text: string) => void;
  onConfirm: (pid: string) => void;
  onCancel: (pid: string) => void;
}) {
  const done = !m.streaming;

  if (m.pending) return <PendingCard pending={m.pending} onConfirm={onConfirm} onCancel={onCancel} />;
  if (m.booking) return <BookingCard booking={m.booking} />;

  // Everything below the sentence waits for it to finish, then cascades in. Each
  // section is one step further down the stagger.
  let step = 0;
  const after = () => ({ animationDelay: `${step++ * 70}ms` });

  return (
    <div className="rise-in space-y-3">
      {m.urgency && <UrgencyBar urgency={m.urgency} />}

      <p className={`text-[14px] ${m.voided ? "text-muted italic" : ""}`}>
        {m.content}
        {m.streaming && <span aria-hidden className="caret" />}
      </p>
      {m.via === "voice" && (
        <p className="-mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          {m.voided ? "Spoken · withdrawn" : "Spoken"}
        </p>
      )}

      {done && (
        <>
          {m.question && <QuestionCard question={m.question} live={live} onAnswer={onAnswer} />}

          {m.assessment && (
            <section
              style={after()}
              className="rise-in rounded-card border border-rule bg-surface px-3 py-2.5"
            >
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                What this is usually looked at for
              </h3>
              <p className="mt-1 text-[14px]">{m.assessment}</p>
              <p className="mt-2 text-[12px] text-muted">
                The doctor who examines you is the one who can tell you what it is.
              </p>
            </section>
          )}

          {!!m.nextSteps?.length && (
            <section style={after()} className="rise-in">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                What to do now
              </h3>
              <ol className="mt-1.5 space-y-1.5">
                {m.nextSteps.map((stepText, n) => (
                  <li key={n} className="flex gap-2.5 text-[14px]">
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-wash font-mono text-[11px] text-accent"
                    >
                      {n + 1}
                    </span>
                    <span>{stepText}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {m.emergency && (
            <a
              style={after()}
              href={`tel:${m.emergency.line.replace(/\s/g, "")}`}
              className="rise-in block rounded-ctl bg-alert px-3 py-2.5 text-center text-[14px] font-medium text-paper active:translate-y-px"
            >
              Call {m.emergency.line}
            </a>
          )}

          {m.outOfScope && !m.doctors?.length && (
            <a
              style={after()}
              href="tel:+918040001200"
              className="rise-in block rounded-ctl border border-rule px-3 py-2.5 text-center text-[14px] font-medium hover:bg-surface active:translate-y-px"
            >
              Call reception · +91 80 4000 1200
            </a>
          )}

          {!!m.doctors?.length && (
            <section style={after()} className="rise-in space-y-2">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                {m.outOfScope ? "Your way in" : "Who to see"}
              </h3>
              {m.doctors.map((d) => (
                <DoctorCard key={d.id} doctor={d} />
              ))}
            </section>
          )}

          {!!m.tests?.length && (
            <section style={after()} className="rise-in space-y-2">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                Worth having ready
              </h3>
              <p className="text-[12px] text-muted">
                Having these done before the appointment often saves a second visit. The doctor
                decides what is actually needed.
              </p>
              {m.tests.map((t) => (
                <TestCard key={t.id} test={t} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A clarifying question with its options. There is always a way out: anything the
 * options do not cover gets typed instead, so the widget never becomes a dead end.
 */
function QuestionCard({
  question,
  live,
  onAnswer,
}: {
  question: Question;
  live: boolean;
  onAnswer: (text: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");

  // Once answered the card stays as a record of what was asked, but nothing in it
  // can be clicked — re-answering a settled question would rewrite history.
  if (!live) {
    return (
      <section className="rounded-card border border-rule bg-surface px-3 py-3 opacity-70">
        <h3 className="text-[14px] font-medium">{question.text}</h3>
        <p className="mt-1 text-[12px] text-muted">Answered</p>
      </section>
    );
  }

  return (
    <section className="rise-in rounded-card border border-accent bg-accent-wash px-3 py-3">
      <h3 className="text-[14px] font-medium">{question.text}</h3>

      {typing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
          className="mt-2.5"
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={question.text}
            placeholder="Your answer…"
            className="w-full rounded-ctl border border-rule bg-paper px-3 py-2 text-[14px] outline-none focus:border-accent"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setTyping(false)}
              className="rounded-ctl border border-rule bg-paper px-3 py-1.5 text-[13px] hover:bg-surface active:translate-y-px"
            >
              Back to options
            </button>
            <button
              type="submit"
              disabled={!text.trim()}
              className="flex-1 rounded-ctl bg-accent px-3 py-1.5 text-[13px] font-medium text-paper hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      ) : (
        <ul className="mt-2.5 space-y-1.5">
          {question.options.map((o) => (
            <li key={o}>
              <button
                onClick={() => onAnswer(o)}
                className="w-full rounded-ctl border border-rule bg-paper px-3 py-2 text-left text-[14px] transition-colors hover:border-accent hover:bg-surface active:translate-y-px"
              >
                {o}
              </button>
            </li>
          ))}
          <li>
            <button
              onClick={() => setTyping(true)}
              className="w-full px-3 py-1.5 text-left text-[13px] text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Something else — let me type it
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}

/**
 * A booking the voice agent has put together, waiting for the patient. Confirm here is
 * the same as saying yes; either way the server re-checks everything before writing.
 * Nothing on this card ever says "booked" — that is BookingCard's job, and it only exists
 * once the server has returned a reference.
 */
function PendingCard({
  pending: p,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  onConfirm: (pid: string) => void;
  onCancel: (pid: string) => void;
}) {
  const s = p.summary;
  const actionable = p.state === "open" || p.state === "failed";
  const status: Record<Pending["state"], string> = {
    open: "Waiting for your confirmation",
    confirming: "Booking…",
    confirmed: "Confirmed — see below",
    cancelled: "Cancelled. Nothing was booked.",
    replaced: "Replaced by a newer proposal. Nothing was booked.",
    failed: "Not booked",
  };

  return (
    <section
      className={`rise-in rounded-card border px-3 py-3 ${
        actionable ? "border-accent bg-accent-wash" : "border-rule bg-surface opacity-80"
      }`}
    >
      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
        {s.kind === "referral" ? "Proposed referral" : "Proposed booking"}
      </h3>
      <p className="mt-1 text-[15px] font-semibold">{s.itemName}</p>
      <p className="text-[13px] text-muted">
        {s.kind === "doctor" ? s.specialty : s.labName}
        {s.kind === "referral" && s.labAddress ? ` — ${s.labAddress}` : ""}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule pt-2 text-[13px]">
        <dt className="text-muted">When</dt>
        <dd className="text-right">{s.slotLabel}</dd>
        <dt className="text-muted">{s.kind === "doctor" ? "Consultation" : "Price"}</dt>
        <dd className="text-right font-mono">₹{s.costRupees}</dd>
        <dt className="text-muted">Patient</dt>
        <dd className="text-right">{s.patientName}</dd>
        <dt className="text-muted">Phone</dt>
        <dd className="text-right font-mono">{s.phone}</dd>
      </dl>
      <p aria-live="polite" className="mt-2 text-[12px] font-medium">
        {status[p.state]}
      </p>
      {p.error && (
        <p role="alert" className="mt-1 text-[13px] text-alert">
          {p.error}
        </p>
      )}
      {actionable && (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => onCancel(p.pid)}
            className="flex-1 rounded-ctl border border-rule bg-paper px-3 py-1.5 text-[13px] hover:bg-surface active:translate-y-px"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(p.pid)}
            className="flex-1 rounded-ctl bg-accent px-3 py-1.5 text-[13px] font-medium text-paper hover:bg-accent-hover active:translate-y-px"
          >
            {p.state === "failed" ? "Try again" : "Confirm"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * A booking the server has made. Rendered from the canonical BookingConfirmation — the
 * same object the dialog shows and the voice agent reads the reference from.
 */
function BookingCard({ booking: b }: { booking: BookingConfirmation }) {
  return (
    <section className="rise-in rounded-card border border-success bg-success-wash px-3 py-3">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-success">
        {b.kind === "referral" ? "Referral confirmed" : "Booking confirmed"}
      </h3>
      <p className="mt-1 text-[15px] font-semibold">{b.itemName}</p>
      <p className="text-[13px] text-muted">
        {b.kind === "doctor" ? b.specialty : b.labName}
        {b.kind === "referral" && b.labAddress ? ` — ${b.labAddress}` : ""}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule pt-2 text-[13px]">
        <dt className="text-muted">When</dt>
        <dd className="text-right">{b.slotLabel}</dd>
        <dt className="text-muted">{b.kind === "doctor" ? "Consultation" : "Price"}</dt>
        <dd className="text-right font-mono">₹{b.cost}</dd>
        <dt className="text-muted">Patient</dt>
        <dd className="text-right">
          {b.patientName} · {b.phoneMasked}
        </dd>
        <dt className="text-muted">Reference</dt>
        <dd className="text-right font-mono font-medium">{b.reference}</dd>
      </dl>
      <p className="mt-2 text-[12px] text-muted">Keep the reference for the front desk.</p>
    </section>
  );
}

function UrgencyBar({ urgency }: { urgency: Urgency }) {
  const u = URGENCY[urgency];
  return (
    <div className={`rounded-card border px-3 py-2 ${u.cls}`}>
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em]">{u.label}</p>
      <p className="mt-0.5 text-[13px] text-ink">{u.note}</p>
    </div>
  );
}
