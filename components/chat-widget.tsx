"use client";

import { useEffect, useRef, useState } from "react";
import { DoctorCard, TestCard } from "./rec-card";
import type { Doctor, Test } from "@/lib/chat";

type Msg = {
  role: "user" | "assistant";
  content: string;
  doctors?: Doctor[];
  tests?: Test[];
  emergency?: { why: string; line: string };
};

const OPENER: Msg = {
  role: "assistant",
  content:
    "Tell me what you have been feeling and roughly how long it has been going on. I will point you to the right department and any tests worth doing first. I cannot tell you what is wrong or what to take — only a doctor can.",
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
            <h2 className="text-[14px] font-semibold">Meridian intake assistant</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Recommends a department and tests. Does not diagnose or prescribe.
            </p>
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.map((m, i) => (
              <div key={i} className="rise-in">
                <p
                  className={
                    m.role === "user"
                      ? "ml-auto w-fit max-w-[85%] rounded-card bg-accent-wash px-3 py-2 text-[14px]"
                      : m.emergency
                        ? "rounded-card border border-alert bg-alert-wash px-3 py-2 text-[14px] text-ink"
                        : "text-[14px]"
                  }
                >
                  {m.emergency && (
                    <strong className="mb-1 block font-mono text-[11px] uppercase tracking-[0.08em] text-alert">
                      Go to emergency now
                    </strong>
                  )}
                  {m.content}
                </p>

                {m.emergency && (
                  <a
                    href={`tel:${m.emergency.line.replace(/\s/g, "")}`}
                    className="mt-2 block rounded-ctl bg-alert px-3 py-2 text-center text-[14px] font-medium text-paper active:translate-y-px"
                  >
                    Call {m.emergency.line}
                  </a>
                )}

                {!!m.doctors?.length && (
                  <div className="mt-3 space-y-2">
                    <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                      Suggested department
                    </p>
                    {m.doctors.map((d) => (
                      <DoctorCard key={d.id} doctor={d} />
                    ))}
                  </div>
                )}

                {!!m.tests?.length && (
                  <div className="mt-3 space-y-2">
                    <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                      Tests to have ready
                    </p>
                    {m.tests.map((t) => (
                      <TestCard key={t.id} test={t} />
                    ))}
                  </div>
                )}
              </div>
            ))}
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
              placeholder="Describe your symptoms…"
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
