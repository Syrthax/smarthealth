"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DoctorCard, TestCard } from "./rec-card";
import type { Doctor, Test, Question } from "@/lib/chat";

type Urgency = "routine" | "soon" | "urgent" | "emergency";

type Msg = {
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
};

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
    "Tell me what has been going on and roughly how long for. I will tell you what it is usually looked at for, how soon you ought to be seen, and which department to go to. I cannot diagnose you or tell you what to take — that is what the consultation is for.",
};

const CHAT_KEY = "mhc.chat";

/**
 * The conversation lives in this browser and nowhere else — it is never persisted
 * server-side, and clearing it here is the only copy there is.
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

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>(loadChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Called on every typed chunk as well as on every new message, so the panel keeps
  // pace with text that is still arriving.
  const stickToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  useEffect(() => {
    if (open) {
      stickToBottom();
      inputRef.current?.focus();
    }
  }, [open, messages, stickToBottom]);

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

  function clearChat() {
    setMessages([OPENER]);
    try {
      localStorage.removeItem(CHAT_KEY);
    } catch {
      /* nothing stored to begin with */
    }
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
    const slot = next.length;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(1).map(forModel) }),
      });
      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let started = false;

      const put = (patch: Partial<Msg>) =>
        setMessages((m) => {
          const copy = [...m];
          copy[slot] = { ...copy[slot], ...patch };
          return copy;
        });

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

          if (e.t === "reply") {
            if (!started) {
              started = true;
              setBusy(false);
              setMessages((m) => [
                ...m,
                { role: "assistant", content: String(e.v), streaming: true },
              ]);
            } else {
              put({ content: String(e.v), streaming: true });
            }
          }

          if (e.t === "done") {
            const finished: Msg = {
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
            if (started) put(finished);
            else {
              setBusy(false);
              setMessages((m) => [...m, finished]);
            }
            started = true;
          }
        }
      }
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "I could not reach the hospital system. Please try again." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="intake-panel"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-ctl bg-accent px-4 py-3 text-[14px] font-medium text-paper shadow-lg transition-colors hover:bg-accent-hover active:translate-y-px"
      >
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-paper/80" />
        {open ? "Close" : "Health intake"}
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
              Preliminary guidance only. Does not diagnose and never advises on medication.
            </p>
            {messages.length > 1 && (
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="rounded-ctl border border-rule px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-surface active:translate-y-px"
                >
                  Save for your doctor
                </button>
                <button
                  onClick={clearChat}
                  className="rounded-ctl px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-surface hover:text-ink active:translate-y-px"
                >
                  Clear
                </button>
                <span className="ml-auto text-[11px] text-muted">Kept on this device only</span>
              </div>
            )}
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <p
                  key={i}
                  className="rise-in ml-auto w-fit max-w-[85%] rounded-card bg-accent-wash px-3 py-2 text-[14px]"
                >
                  {m.content}
                </p>
              ) : (
                <AssistantMessage
                  key={i}
                  message={m}
                  // Only the newest question is still open; earlier ones are settled.
                  live={i === messages.length - 1}
                  onAnswer={send}
                />
              ),
            )}
            {busy && <Thinking />}
            <div ref={endRef} />
          </div>

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
        </section>
      )}
    </>
  );
}

/**
 * What the visitor hands the doctor. People forget in the waiting room what they managed
 * to describe clearly an hour earlier, so this is their own words back, with what the
 * assistant made of them — clearly labelled as neither a diagnosis nor a medical record.
 */
function TranscriptSheet({ messages }: { messages: Msg[] }) {
  const said = messages.filter((m) => m.role === "user");
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
        <strong>For the consultation, not a medical record.</strong> Everything below is what
        the patient reported to an automated assistant before their appointment, plus that
        assistant&rsquo;s preliminary suggestions. It contains no diagnosis, no examination and
        no medication advice, and none of it has been reviewed by a clinician.
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
}: {
  message: Msg;
  live: boolean;
  onAnswer: (text: string) => void;
}) {
  const done = !m.streaming;

  // Everything below the sentence waits for it to finish, then cascades in. Each
  // section is one step further down the stagger.
  let step = 0;
  const after = () => ({ animationDelay: `${step++ * 70}ms` });

  return (
    <div className="rise-in space-y-3">
      {m.urgency && <UrgencyBar urgency={m.urgency} />}

      <p className="text-[14px]">
        {m.content}
        {m.streaming && <span aria-hidden className="caret" />}
      </p>

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
                This is not a diagnosis. Only the doctor who examines you can give you one.
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

function UrgencyBar({ urgency }: { urgency: Urgency }) {
  const u = URGENCY[urgency];
  return (
    <div className={`rounded-card border px-3 py-2 ${u.cls}`}>
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em]">{u.label}</p>
      <p className="mt-0.5 text-[13px] text-ink">{u.note}</p>
    </div>
  );
}
