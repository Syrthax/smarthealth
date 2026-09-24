/**
 * Outpatient slots, shared by the booking dialog, the voice agent and the server that
 * validates both. A slot is stored as a machine value ("2026-09-25 09:30", hospital
 * time) and only ever displayed through `slotLabel`, so the browser's locale data and
 * the server's can never disagree about what string was booked — the unique index on
 * (ref_id, slot) depends on the value being canonical.
 *
 * ponytail: generated, not a real availability table. The only things it knows are the
 * four clinic times, that Sunday is closed and which weekdays a doctor sits. Double
 * booking is still prevented by the database, not by this file.
 */
export const SLOT_TIMES = ["09:30", "11:00", "15:30", "17:00"] as const;

/** How far ahead a slot may be booked. Wide enough that a dialog left open overnight still submits. */
export const BOOKING_HORIZON_DAYS = 14;

export type Slot = { value: string; label: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const VALUE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/;

/** Today's date in Bengaluru, whatever timezone the browser or the server happens to run in. */
function hospitalToday(now: Date): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
    .format(now)
    .split("-")
    .map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const iso = (day: Date) => day.toISOString().slice(0, 10);

/** "Mon, Tue, Thu" → weekday numbers. Anything unreadable means "no restriction". */
function weekdays(availDays?: string): Set<number> | null {
  if (!availDays) return null;
  const found = availDays
    .split(/[,\s]+/)
    .map((d) => DAYS.findIndex((n) => n.toLowerCase() === d.slice(0, 3).toLowerCase()))
    .filter((n) => n >= 0);
  return found.length ? new Set(found) : null;
}

export function slotLabel(value: string): string {
  const m = VALUE.exec(value);
  if (!m) return value;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const date = day.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${date}, ${m[4]}`;
}

/** The next `count` bookable slots, starting tomorrow. Pass a doctor's `avail_days` to respect it. */
export function upcomingSlots(count = 6, availDays?: string, now = new Date()): Slot[] {
  const allowed = weekdays(availDays);
  const today = hospitalToday(now);
  const out: Slot[] = [];
  for (let i = 1; i <= BOOKING_HORIZON_DAYS && out.length < count; i++) {
    const day = new Date(today.getTime() + i * 864e5);
    const wd = day.getUTCDay();
    if (wd === 0 || (allowed && !allowed.has(wd))) continue;
    for (const t of SLOT_TIMES) {
      if (out.length < count) out.push({ value: `${iso(day)} ${t}`, label: slotLabel(`${iso(day)} ${t}`) });
    }
  }
  return out;
}

/** Why a slot is not bookable, or null when it is. */
export function slotProblem(value: string, availDays?: string, now = new Date()): string | null {
  const m = VALUE.exec(value);
  if (!m || !(SLOT_TIMES as readonly string[]).includes(m[4])) return "That is not one of the clinic's slot times.";
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (iso(day) !== value.slice(0, 10)) return "That date does not exist.";
  const ahead = Math.round((day.getTime() - hospitalToday(now).getTime()) / 864e5);
  if (ahead < 1 || ahead > BOOKING_HORIZON_DAYS)
    return `Slots can be booked from tomorrow up to ${BOOKING_HORIZON_DAYS} days ahead.`;
  if (day.getUTCDay() === 0) return "The clinic is closed on Sundays.";
  const allowed = weekdays(availDays);
  if (allowed && !allowed.has(day.getUTCDay())) return `This doctor is only in on ${availDays}.`;
  return null;
}
