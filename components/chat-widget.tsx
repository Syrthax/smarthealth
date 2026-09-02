"use client";

import { useEffect, useRef, useState } from "react";
import { DoctorCard, TestCard } from "./rec-card";
import type { Doctor, Test } from "@/lib/chat";

type Urgency = "routine" | "soon" | "urgent" | "emergency";

type Msg = {
  role: "user" | "assistant";
  content: string;
  assessment?: string;
  urgency?: Urgency;
  nextSteps?: string[];
  outOfScope?: boolean;
  doctors?: Doctor[];
  tests?: Test[];
  emergency?: { why: string; line: string };
};

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

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([OPENER]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ block: "end" });
      inputRef.current?.focus();
    }
  }, [open, messages]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })).slice(1),
        }),
      });
      const data = await res.json();
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.reply ?? data.error ?? "Something went wrong. Please try again.",
          assessment: data.assessment,
          urgency: data.emergency ? "emergency" : data.urgency,
          nextSteps: data.nextSteps,
          outOfScope: data.outOfScope,
          doctors: data.doctors,
          tests: data.tests,
          emergency: data.emergency,
        },
      ]);
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
                <div key={i} className="rise-in space-y-3">
                  {m.urgency && <UrgencyBar urgency={m.urgency} />}

                  <p className="text-[14px]">{m.content}</p>

                  {m.assessment && (
                    <section className="rounded-card border border-rule bg-surface px-3 py-2.5">
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
                    <section>
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                        What to do now
                      </h3>
                      <ol className="mt-1.5 space-y-1.5">
                        {m.nextSteps.map((step, n) => (
                          <li key={n} className="flex gap-2.5 text-[14px]">
                            <span
                              aria-hidden
                              className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-wash font-mono text-[11px] text-accent"
                            >
                              {n + 1}
                            </span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}

                  {m.emergency && (
                    <a
                      href={`tel:${m.emergency.line.replace(/\s/g, "")}`}
                      className="block rounded-ctl bg-alert px-3 py-2.5 text-center text-[14px] font-medium text-paper active:translate-y-px"
                    >
                      Call {m.emergency.line}
                    </a>
                  )}

                  {m.outOfScope && !m.doctors?.length && (
                    <a
                      href="tel:+918040001200"
                      className="block rounded-ctl border border-rule px-3 py-2.5 text-center text-[14px] font-medium hover:bg-surface active:translate-y-px"
                    >
                      Call reception · +91 80 4000 1200
                    </a>
                  )}

                  {!!m.doctors?.length && (
                    <section className="space-y-2">
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                        {m.outOfScope ? "Your way in" : "Who to see"}
                      </h3>
                      {m.doctors.map((d) => (
                        <DoctorCard key={d.id} doctor={d} />
                      ))}
                    </section>
                  )}

                  {!!m.tests?.length && (
                    <section className="space-y-2">
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                        Worth having ready
                      </h3>
                      <p className="text-[12px] text-muted">
                        Having these done before the appointment often saves a second visit. The
                        doctor decides what is actually needed.
                      </p>
                      {m.tests.map((t) => (
                        <TestCard key={t.id} test={t} />
                      ))}
                    </section>
                  )}
                </div>
              ),
            )}
            {busy && (
              <p aria-live="polite" className="text-[14px] text-muted">
                Checking the directory…
              </p>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={send} className="shrink-0 border-t border-rule p-3">
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
              aria-label="Describe your symptoms"
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

function UrgencyBar({ urgency }: { urgency: Urgency }) {
  const u = URGENCY[urgency];
  return (
    <div className={`rounded-card border px-3 py-2 ${u.cls}`}>
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em]">{u.label}</p>
      <p className="mt-0.5 text-[13px] text-ink">{u.note}</p>
    </div>
  );
}
