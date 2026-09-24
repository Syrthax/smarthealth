import { book, checkBooking, findItem, type BookingDeps, type BookingConfirmation } from "./booking.ts";
import { sql as liveSql, overLimit as liveOverLimit } from "./db.ts";
import { signPending, verifyPending } from "./pending.ts";
import { upcomingSlots } from "./slots.ts";
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
      const specialty = String(args.specialty ?? "").trim().slice(0, 60);
      const like = `%${specialty.replace(/[%_\\]/g, "")}%`;
      const found = await typed<{ id: number; name: string; specialty: string; department: string; consult_fee: number; avail_days: string }>(sql`
        SELECT id, name, specialty, department, consult_fee, avail_days FROM doctors
        WHERE ${specialty}::text = '' OR specialty ILIKE ${like} OR department ILIKE ${like}
        ORDER BY id`);
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
      const doctorId = Number(args.doctorId);
      if (args.doctorId !== undefined && args.doctorId !== null && args.doctorId !== "") {
        const doctor = Number.isInteger(doctorId) ? await findItem({ doctorId }, deps) : null;
        if (!doctor) return deny("not_found", "That doctor is not in our directory.");
        return { ok: true, doctor: doctor.itemName, slots: upcomingSlots(6, doctor.availDays) };
      }
      return { ok: true, slots: upcomingSlots(6) };
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
