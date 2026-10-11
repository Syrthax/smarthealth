import { book, checkBooking, findItem, type BookingDeps, type BookingConfirmation } from "./booking.ts";
import { sql as liveSql, overLimit as liveOverLimit } from "./db.ts";
import { signPending, verifyPending } from "./pending.ts";
import { BOOKING_HORIZON_DAYS, SLOT_TIMES, upcomingSlots } from "./slots.ts";
import type { ServerTool } from "./voice.ts";

/**
 * What the voice agent's tools actually do. Every answer is read from Postgres at call
 * time and returned as data, so a price or a doctor's name the agent says aloud has a row
 * behind it. Unknown codes and ids are refused outright — never approximated.
 *
 * Results are `{ ok: true, ... }` or `{ ok: false, code, message }`. The message is
 * written to be said aloud as-is; the code is what the page branches on.
 */

export type ActionResult = { ok: true; [k: string]: unknown } | ActionFailure;
export type ActionFailure = { ok: false; code: string; message: string; retryAfter?: number };

const deny = (code: string, message: string): ActionFailure => ({ ok: false, code, message });

const typed = async <T>(query: PromiseLike<unknown>) => (await query) as T[];

type TestRow = {
  code: string;
  name: string;
  price: number;
  prep_notes: string;
  turnaround_hours: number;
  ordered_for: string;
  lab_name: string;
  lab_kind: "in_house" | "partner";
};

const testOut = (t: TestRow) => ({
  code: t.code,
  name: t.name,
  priceRupees: t.price,
  lab: t.lab_name,
  // Said out loud, "referral" explains why the address is somewhere else.
  referral: t.lab_kind === "partner",
  preparation: t.prep_notes,
  reportInHours: t.turnaround_hours,
  orderedFor: t.ordered_for,
});

export async function runAction(
  name: ServerTool,
  args: Record<string, unknown>,
  ip: string,
  deps: BookingDeps = { sql: liveSql as unknown as BookingDeps["sql"], overLimit: liveOverLimit },
): Promise<ActionResult> {
  const { sql } = deps;
  switch (name) {
    case "get_test_options": {
      const search = String(args.search ?? "").trim().slice(0, 60);
      const like = `%${search.replace(/[%_\\]/g, "")}%`;
      const found = await typed<TestRow>(sql`
        SELECT t.code, t.name, t.price, t.prep_notes, t.turnaround_hours, t.ordered_for, l.name AS lab_name, l.kind AS lab_kind
        FROM tests t JOIN labs l ON l.id = t.lab_id
        WHERE ${search}::text = '' OR t.name ILIKE ${like} OR t.code ILIKE ${like} OR t.ordered_for ILIKE ${like}
        ORDER BY t.price LIMIT 8`);
      if (!found.length) return deny("not_found", `We do not have a test matching "${search}".`);
      return { ok: true, tests: found.map(testOut) };
    }

    case "get_test_cost": {
      const code = String(args.testCode ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9-]{2,16}$/.test(code)) return deny("invalid", "I need the test's code to look up its price.");
      const [t] = await typed<TestRow>(sql`
        SELECT t.code, t.name, t.price, t.prep_notes, t.turnaround_hours, t.ordered_for, l.name AS lab_name, l.kind AS lab_kind
        FROM tests t JOIN labs l ON l.id = t.lab_id WHERE t.code = ${code}`);
      if (!t) return deny("not_found", `There is no test with the code ${code} in our catalogue.`);
      return { ok: true, test: testOut(t) };
    }

    case "get_doctor_options": {
      // A name wins over a specialty: "Dr. Rao" is a more specific ask than "a heart doctor".
      const name = String(args.name ?? "").replace(/^\s*(dr|doctor)\b\.?\s*/i, "").trim().slice(0, 60);
      const specialty = name || String(args.specialty ?? "").trim().slice(0, 60);
      const like = `%${specialty.replace(/[%_\\]/g, "")}%`;
      const found = await typed<{ id: number; name: string; specialty: string; department: string; consult_fee: number; avail_days: string }>(sql`
        SELECT id, name, specialty, department, consult_fee, avail_days FROM doctors
        WHERE ${specialty}::text = '' OR specialty ILIKE ${like} OR department ILIKE ${like} OR name ILIKE ${like}
        ORDER BY id`);
      if (!found.length && name)
        return deny("not_found", `I cannot find a doctor called ${name} here. I can look by department instead.`);
      if (!found.length) {
        const desks = await typed<{ name: string }>(sql`SELECT name FROM specialties ORDER BY name`);
        return deny(
          "not_found",
          `We have no ${specialty} desk. The departments here are: ${desks.map((d) => d.name).join(", ")}. General Medicine can assess and refer onward.`,
        );
      }
      return {
        ok: true,
        doctors: found.map((d) => ({
          doctorId: d.id,
          name: d.name,
          specialty: d.specialty,
          department: d.department,
          consultationFeeRupees: d.consult_fee,
          sits: d.avail_days,
        })),
      };
    }

    case "get_slots": {
      const date = String(args.date ?? "").trim();
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return deny("invalid", "I need the day as a date to look that up.");
      const part = String(args.partOfDay ?? "").trim().toLowerCase();
      const suits = (value: string) =>
        (!date || value.startsWith(date)) &&
        (part === "morning" ? value.slice(11) < "12:00" : part === "afternoon" || part === "evening" ? value.slice(11) >= "12:00" : true);

      let doctor: string | undefined;
      let availDays: string | undefined;
      const taken = new Set<string>();
      if (args.doctorId !== undefined && args.doctorId !== null && args.doctorId !== "") {
        const doctorId = Number(args.doctorId);
        const found = Number.isInteger(doctorId) ? await findItem({ doctorId }, deps) : null;
        if (!found) return deny("not_found", "That doctor is not in our directory.");
        doctor = found.itemName;
        availDays = found.availDays;
        // "Earliest" has to mean earliest *free*: a consultation slot holds one patient, so
        // the ones already booked are left out here rather than discovered at confirm time.
        // Labs run in parallel and have no such limit.
        const booked = await typed<{ slot: string }>(sql`SELECT slot FROM bookings WHERE kind = 'doctor' AND ref_id = ${doctorId}`);
        for (const b of booked) taken.add(b.slot);
      }

      const free = upcomingSlots(BOOKING_HORIZON_DAYS * SLOT_TIMES.length, availDays).filter((s) => !taken.has(s.value));
      if (!free.length)
        return deny("no_slots", `${doctor ?? "The lab"} has nothing free in the next ${BOOKING_HORIZON_DAYS} days. Reception can help with a later date.`);

      const fits = free.filter((s) => suits(s.value));
      if (fits.length) return { ok: true, doctor, matched: true, earliest: fits[0], slots: fits.slice(0, 6) };
      // Nothing when they asked for: say so, and hand over the nearest free slots from then on.
      const after = free.filter((s) => !date || s.value.slice(0, 10) >= date);
      const nearest = after.length ? after : free;
      return {
        ok: true,
        doctor,
        matched: false,
        note: "Nothing is free at the time they asked for. Say so plainly, then offer the nearest free slot below.",
        earliest: nearest[0],
        slots: nearest.slice(0, 6),
      };
    }

    case "prepare_booking": {
      const doctorId = Number(args.doctorId);
      const testCode = typeof args.testCode === "string" ? args.testCode : "";
      const wantsDoctor = Number.isInteger(doctorId) && doctorId > 0;
      if (wantsDoctor === Boolean(testCode.trim()))
        return deny("invalid", "I need either a doctor or a test to book — one, not both.");

      const checked = await checkBooking({
        item: wantsDoctor ? { doctorId } : { testCode },
        patientName: String(args.patientName ?? ""),
        phone: String(args.phone ?? ""),
        slot: String(args.slot ?? ""),
      }, deps);
      if (!checked.ok) return deny(checked.code, checked.error);

      const { item, req } = checked;
      return {
        ok: true,
        // The browser keeps this and swaps it in at confirm time; the model sees a short id.
        token: signPending(req),
        summary: {
          kind: item.kind,
          itemName: item.itemName,
          specialty: item.specialty,
          testCode: item.testCode,
          labName: item.labName,
          labAddress: item.labAddress,
          slot: req.slot,
          slotLabel: checked.slotLabel,
          costRupees: item.cost,
          patientName: req.patientName,
          phone: req.phone,
        },
      };
    }

    case "confirm_booking": {
      const pending = verifyPending(args.token);
      if (!pending.ok) return deny("not_pending", pending.error);
      const result = await book(ip, pending.req, deps);
      if (!result.ok) return { ...deny(result.code, result.error), retryAfter: result.retryAfter };
      return { ok: true, booking: result.booking satisfies BookingConfirmation, replayed: result.replayed };
    }
  }
}
