"use client";

import { useEffect, useState } from "react";
import { DoctorCard, TestCard } from "@/components/rec-card";
import type { VoiceStatus } from "@/components/voice/voice-session";
import type { Question } from "@/lib/chat";
import type { BookingConfirmation } from "@/lib/booking";
import type { Msg, Pending, Urgency } from "./types";

/** Everything the chat panel renders per message. Presentational: state lives in ChatWidget. */

const THINKING = [
  "Reading what you have written",
  "Matching it against our departments",
  "Checking which tests are worth having ready",
  "Putting your options together",
];

/** Cycles while the request is in flight. The phases are real; the timing is not. */
export function Thinking() {
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
export const URGENCY: Record<Urgency, { label: string; note: string; cls: string }> = {
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

export const SpokenTag = () => (
  <p className="mt-0.5 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Spoken</p>
);

/** The way into voice, below the chat. Once it connects, the whole panel becomes the orb. */
export function VoiceBar({ status, note, onStart }: { status: VoiceStatus; note: string | null; onStart: () => void }) {
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

export function AssistantMessage({
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
