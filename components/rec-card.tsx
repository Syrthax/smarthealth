"use client";

import { useEffect, useRef, useState } from "react";
import type { Doctor, Test } from "@/lib/chat";
import type { BookingConfirmation } from "@/lib/booking";
import { upcomingSlots } from "@/lib/slots";

type Target = {
  kind: "doctor" | "test" | "referral";
  refId: number;
  title: string;
  context: string;
  availDays?: string;
};

/**
 * Fired on window after any booking succeeds, from wherever it was made. The chat widget
 * listens so a booking made from a card shows up in the conversation — and, if a voice
 * session is open, so the agent knows about it too. The detail is the canonical
 * BookingConfirmation the server returned, never something assembled here.
 */
export const BOOKED_EVENT = "mhc:booked";

const STORE_KEY = "mhc.patient";

/** Whatever we saved last time. Storage can be blocked or empty; both mean "start fresh". */
export function remembered(): { name: string; phone: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return { name: saved.name ?? "", phone: saved.phone ?? "" };
  } catch {
    return { name: "", phone: "" };
  }
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-accent">{children}</span>
);

const btn =
  "rounded-ctl px-3 py-2 text-[13px] font-medium transition-colors active:translate-y-px disabled:opacity-50";

export function DoctorCard({ doctor }: { doctor: Doctor }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="flex flex-col rounded-card border border-rule bg-paper p-4">
      <Label>{doctor.specialty}</Label>
      <h3 className="mt-1.5 text-[15px] font-semibold">{doctor.name}</h3>
      <p className="text-[13px] text-muted">{doctor.qualification}</p>
      <p className="mt-2 text-[13px] text-muted">{doctor.bio}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule pt-3 text-[13px]">
        <dt className="text-muted">Consultation</dt>
        <dd className="text-right font-mono">₹{doctor.consult_fee}</dd>
        <dt className="text-muted">Available</dt>
        <dd className="text-right">{doctor.avail_days}</dd>
      </dl>
      <button
        onClick={() => setOpen(true)}
        className={`${btn} mt-3 bg-accent text-paper hover:bg-accent-hover`}
      >
        Book consultation
      </button>
      {open && (
        <BookingDialog
          target={{
            kind: "doctor",
            refId: doctor.id,
            title: doctor.name,
            context: `${doctor.specialty} · ₹${doctor.consult_fee}`,
            availDays: doctor.avail_days,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </article>
  );
}

export function TestCard({ test }: { test: Test }) {
  const [open, setOpen] = useState(false);
  const partner = test.lab_kind === "partner";
  return (
    <article className="flex flex-col rounded-card border border-rule bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <Label>{test.code}</Label>
        <span
          className={`shrink-0 rounded-ctl px-2 py-0.5 text-[11px] font-medium ${
            partner ? "bg-surface-2 text-muted" : "bg-accent-wash text-accent"
          }`}
        >
          {partner ? "Partner lab" : "In-house"}
        </span>
      </div>
      <h3 className="mt-1.5 text-[15px] font-semibold">{test.name}</h3>
      <p className="mt-1 text-[13px] text-muted">Ordered for {test.ordered_for}.</p>
      <p className="mt-2 text-[13px] text-muted">{test.prep_notes}</p>
      {partner && (
        <p className="mt-2 rounded-ctl border border-rule bg-surface p-2 text-[13px] text-muted">
          Not performed in-house. Meridian raises a referral to{" "}
          <span className="text-ink">{test.lab_name}</span> — {test.lab_address}.
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule pt-3 text-[13px]">
        <dt className="text-muted">Price</dt>
        <dd className="text-right font-mono">₹{test.price}</dd>
        <dt className="text-muted">Report in</dt>
        <dd className="text-right">{test.turnaround_hours} h</dd>
      </dl>
      <button
        onClick={() => setOpen(true)}
        className={`${btn} mt-3 ${
          partner
            ? "border border-rule bg-paper text-ink hover:bg-surface"
            : "bg-accent text-paper hover:bg-accent-hover"
        }`}
      >
        {partner ? "Request referral" : "Book test"}
      </button>
      {open && (
        <BookingDialog
          target={{
            kind: partner ? "referral" : "test",
            refId: test.id,
            title: test.name,
            context: `${test.lab_name} · ₹${test.price}`,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </article>
  );
}

function BookingDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Shared with the server's validator and the voice agent (lib/slots.ts), so all three
  // agree on what a slot is. A doctor is only offered on the days they sit.
  const [slots] = useState(() => upcomingSlots(6, target.availDays));
  // Read once during the first render. The dialog only ever mounts on the client
  // (it is behind an open flag), so there is no server/client mismatch to worry about.
  const [name, setName] = useState(() => remembered().name);
  const [phone, setPhone] = useState(() => remembered().phone);
  const [slot, setSlot] = useState(slots[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingConfirmation | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: target.kind, refId: target.refId, patientName: name, phone, slot }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not complete the booking.");
        return;
      }
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ name, phone }));
      } catch {
        /* storage blocked — the booking still went through */
      }
      setBooking(data.booking);
      window.dispatchEvent(new CustomEvent(BOOKED_EVENT, { detail: data.booking }));
    } catch {
      setError("Network problem. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "mt-1 w-full rounded-ctl border border-rule bg-paper px-3 py-2 text-[14px] outline-none focus:border-accent";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      className="panel-in m-auto w-[min(26rem,calc(100vw-2rem))] rounded-card border border-rule bg-paper p-0 text-ink shadow-lg backdrop:bg-ink/25"
    >
      <div className="border-b border-rule px-5 py-4">
        <h2 className="text-[15px] font-semibold">
          {booking ? "Booking confirmed" : target.kind === "referral" ? "Request referral" : "Confirm booking"}
        </h2>
        <p className="mt-0.5 text-[13px] text-muted">
          {target.title} · {target.context}
        </p>
      </div>

      {booking ? (
        <div className="px-5 py-5">
          <p className="text-[14px]">
            Your reference number is{" "}
            <span className="font-mono font-medium text-success">{booking.reference}</span>. Keep
            it for the front desk.
          </p>
          <p className="mt-2 text-[13px] text-muted">{booking.slotLabel}</p>
          <button
            onClick={() => ref.current?.close()}
            className={`${btn} mt-4 w-full bg-accent text-paper hover:bg-accent-hover`}
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="px-5 py-5">
          <label className="block text-[13px] text-muted">
            Patient name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className={`${field} text-ink`}
            />
          </label>
          <label className="mt-3 block text-[13px] text-muted">
            Phone
            <input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              placeholder="+91 98765 43210"
              className={`${field} text-ink`}
            />
          </label>
          <label className="mt-3 block text-[13px] text-muted">
            Slot
            <select
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
              className={`${field} text-ink`}
            >
              {slots.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p role="alert" className="mt-3 text-[13px] text-alert">
              {error}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className={`${btn} flex-1 border border-rule bg-paper hover:bg-surface`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`${btn} flex-1 bg-accent text-paper hover:bg-accent-hover`}
            >
              {busy ? "Booking…" : "Confirm"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
