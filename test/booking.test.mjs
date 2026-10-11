import { test } from "node:test";
import assert from "node:assert/strict";

process.env.VOICE_SIGNING_SECRET = "test-secret";

const { book, checkBooking } = await import("../lib/booking.ts");
const { runAction } = await import("../lib/voice-actions.ts");
const { upcomingSlots, slotProblem, slotLabel } = await import("../lib/slots.ts");
const { signPending, verifyPending } = await import("../lib/pending.ts");

/**
 * A stand-in for Neon's tagged template, just smart enough to answer the queries the
 * booking service and voice actions make. Every call is recorded so a test can assert
 * what did NOT happen — no insert after a refusal is as important as the refusal.
 */
function fakeDb({ limited = false, slotTaken = false } = {}) {
  const doctors = [{ id: 1, name: "Dr. Anjali Rao", specialty: "Cardiology", department: "Heart & Vascular", consult_fee: 900, avail_days: "Mon, Tue, Thu" }];
  const tests = [
    { id: 1, code: "CBC", name: "Complete Blood Count", price: 350, prep_notes: "No preparation needed.", turnaround_hours: 6, ordered_for: "fever", lab_name: "Meridian In-House Diagnostics", lab_kind: "in_house", lab_address: "Block A" },
    { id: 18, code: "MRI-BR", name: "MRI Brain (plain)", price: 7500, prep_notes: "Declare any metal implants.", turnaround_hours: 48, ordered_for: "persistent headache", lab_name: "PathCore Advanced Imaging", lab_kind: "partner", lab_address: "Indiranagar" },
  ];
  const bookings = [];
  const calls = [];
  const limiter = [];

  const sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    calls.push(text);
    if (/INSERT INTO bookings/.test(text)) {
      if (slotTaken) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const [kind, ref_id, patient_name, phone, slot, ref_code, idem_key] = values;
      if (idem_key && bookings.some((b) => b.idem_key === idem_key)) return [];
      const row = { id: bookings.length + 1, kind, ref_id, patient_name, phone, slot, ref_code, idem_key };
      bookings.push(row);
      return [row];
    }
    if (/FROM bookings WHERE idem_key/.test(text)) return bookings.filter((b) => b.idem_key === values[0]);
    if (/FROM doctors WHERE id =/.test(text)) return doctors.filter((d) => d.id === values[0]);
    if (/SELECT slot FROM bookings/.test(text)) return bookings.filter((b) => b.kind === "doctor" && b.ref_id === values[0]).map((b) => ({ slot: b.slot }));
    if (/FROM doctors/.test(text)) return values[0] === "" ? doctors : doctors.filter((d) => `${d.specialty} ${d.name}`.toLowerCase().includes(values[0].toLowerCase()));
    if (/FROM specialties/.test(text)) return [{ name: "Cardiology" }, { name: "General Medicine" }];
    if (/WHERE t\.id =/.test(text)) return tests.filter((t) => t.id === values[0]);
    if (/WHERE t\.code =/.test(text)) return tests.filter((t) => t.code === values[0]);
    if (/FROM tests/.test(text)) return values[0] === "" ? tests : tests.filter((t) => t.name.toLowerCase().includes(values[0].toLowerCase()));
    throw new Error(`fake db: unhandled query ${text}`);
  };
  const overLimit = async (ip, route, limit) => {
    limiter.push({ ip, route, limit });
    return limited ? 1200 : false;
  };
  return { deps: { sql, overLimit }, bookings, calls, limiter };
}

const doctorSlot = () => upcomingSlots(1, "Mon, Tue, Thu")[0].value;
const anySlot = () => upcomingSlots(1)[0].value;
const patient = { patientName: "Asha Menon", phone: "+91 98765 43210" };

// --- slots -------------------------------------------------------------------

test("slots skip Sundays, respect a doctor's days, and carry a readable label", () => {
  // Thursday 24 Sept 2026, mid-morning in Bengaluru.
  const now = new Date("2026-09-24T05:00:00Z");
  const all = upcomingSlots(12, undefined, now);
  assert.equal(all[0].value, "2026-09-25 09:30"); // starts tomorrow
  assert.ok(all.every((s) => !s.value.startsWith("2026-09-27")), "Sunday 27th is closed");
  assert.match(all[0].label, /25/);
  assert.equal(slotLabel(all[0].value), all[0].label);

  const rao = upcomingSlots(4, "Mon, Tue, Thu", now);
  assert.ok(rao.every((s) => ["2026-09-28", "2026-09-29", "2026-10-01"].includes(s.value.slice(0, 10))));
});

test("slotProblem refuses anything the generator would not offer", () => {
  const now = new Date("2026-09-24T05:00:00Z");
  assert.equal(slotProblem("2026-09-25 09:30", undefined, now), null);
  assert.ok(slotProblem("2026-09-25 10:00", undefined, now), "not a clinic time");
  assert.ok(slotProblem("2026-09-27 09:30", undefined, now), "Sunday");
  assert.ok(slotProblem("2026-09-24 17:00", undefined, now), "today is not bookable");
  assert.ok(slotProblem("2026-12-01 09:30", undefined, now), "beyond the horizon");
  assert.ok(slotProblem("2026-02-30 09:30", undefined, now), "no such date");
  assert.ok(slotProblem("Fri, 25 Sept, 09:30", undefined, now), "labels are not values");
  assert.ok(slotProblem("2026-09-25 09:30", "Mon, Tue, Thu", now), "doctor does not sit on Fridays");
});

// --- booking service -----------------------------------------------------------

test("a doctor booking returns the canonical confirmation, priced from the row", async () => {
  const db = fakeDb();
  const r = await book("1.1.1.1", { item: { doctorId: 1 }, slot: doctorSlot(), ...patient }, db.deps);
  assert.equal(r.ok, true);
  const b = r.booking;
  assert.equal(b.kind, "doctor");
  assert.equal(b.itemName, "Dr. Anjali Rao");
  assert.equal(b.cost, 900);
  assert.match(b.reference, /^MHC-[A-Z0-9]+$/);
  assert.equal(b.slot, doctorSlot());
  assert.equal(b.slotLabel, slotLabel(doctorSlot()));
  assert.equal(b.phoneMasked, "ending 3210");
  assert.ok(!JSON.stringify(b).includes("98765"), "the full phone number is never echoed back");
  assert.equal(db.bookings.length, 1);
});

test("the lab decides whether a test is a referral, not the caller", async () => {
  const db = fakeDb();
  const mri = await book("ip", { item: { testCode: "mri-br" }, slot: anySlot(), ...patient }, db.deps);
  const cbc = await book("ip", { item: { testId: 1 }, slot: anySlot(), ...patient }, db.deps);
  assert.equal(mri.booking.kind, "referral");
  assert.equal(mri.booking.cost, 7500);
  assert.equal(mri.booking.labName, "PathCore Advanced Imaging");
  assert.equal(cbc.booking.kind, "test");
  assert.deepEqual(db.bookings.map((b) => b.kind), ["referral", "test"]);
});

test("unknown doctors and tests are refused, never approximated", async () => {
  const db = fakeDb();
  const doc = await book("ip", { item: { doctorId: 99 }, slot: anySlot(), ...patient }, db.deps);
  const tst = await book("ip", { item: { testCode: "MRI-KNEE" }, slot: anySlot(), ...patient }, db.deps);
  assert.equal(doc.code, "unknown_item");
  assert.equal(tst.code, "unknown_item");
  assert.equal(db.bookings.length, 0);
});

test("invalid payloads are refused before the rate limiter or the database", async () => {
  const db = fakeDb();
  for (const bad of [
    { item: { doctorId: 1 }, slot: doctorSlot(), patientName: "A", phone: "+91 98765 43210" },
    { item: { doctorId: 1 }, slot: doctorSlot(), patientName: "Asha", phone: "call me" },
    { item: {}, slot: doctorSlot(), ...patient },
    { item: { doctorId: 1 }, slot: "", ...patient },
  ]) {
    const r = await book("ip", bad, db.deps);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  assert.equal(db.limiter.length, 0);
  assert.equal(db.calls.length, 0);
});

test("a slot on a day the doctor does not sit is refused", async () => {
  const db = fakeDb();
  const friday = upcomingSlots(20).find((s) => new Date(s.value.slice(0, 10)).getUTCDay() === 5).value;
  const r = await checkBooking({ item: { doctorId: 1 }, slot: friday, ...patient }, db.deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /Mon, Tue, Thu/);
});

test("a taken consultation slot is reported as taken, not as a booking", async () => {
  const db = fakeDb({ slotTaken: true });
  const r = await book("ip", { item: { doctorId: 1 }, slot: doctorSlot(), ...patient }, db.deps);
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, "slot_taken"]);
  assert.equal(r.booking, undefined);
});

test("the booking limit returns a structured refusal and writes nothing", async () => {
  const db = fakeDb({ limited: true });
  const r = await book("ip", { item: { doctorId: 1 }, slot: doctorSlot(), ...patient }, db.deps);
  assert.deepEqual([r.ok, r.status, r.code, r.retryAfter], [false, 429, "rate_limited", 1200]);
  assert.deepEqual(db.limiter, [{ ip: "ip", route: "book", limit: 5 }]);
  assert.ok(!db.calls.some((c) => c.includes("INSERT")));
});

test("the same idempotency key always returns the same booking, once", async () => {
  const db = fakeDb();
  const req = { item: { doctorId: 1 }, slot: doctorSlot(), ...patient, idemKey: "abcdefgh12345678" };
  const first = await book("ip", req, db.deps);
  const again = await book("ip", req, db.deps);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.booking.reference, first.booking.reference);
  assert.equal(db.bookings.length, 1);
  // A replay is answered before the limiter: repeating "yes" must not spend a booking.
  assert.equal(db.limiter.length, 1);
});

// --- pending proposals ---------------------------------------------------------

test("a pending proposal round-trips, and rejects tampering and expiry", () => {
  const req = { item: { doctorId: 1 }, slot: "2026-09-28 09:30", ...patient };
  const token = signPending(req, 1_000, "k");
  const ok = verifyPending(token, 2_000, "k");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.req.item, { doctorId: 1 });
  assert.match(ok.req.idemKey, /^[A-Za-z0-9_-]{16}$/);

  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), r: { ...req, slot: "2026-09-29 09:30" } })).toString("base64url");
  assert.equal(verifyPending(`${forged}.${sig}`, 2_000, "k").ok, false);
  assert.equal(verifyPending(token, 2_000, "other-key").ok, false);
  assert.equal(verifyPending(token, 1_000 + 11 * 60_000, "k").ok, false, "expired");
  assert.equal(verifyPending("nonsense", 2_000, "k").ok, false);
  assert.equal(verifyPending(undefined, 2_000, "k").ok, false);
});

// --- voice actions -------------------------------------------------------------

test("test costs and doctor fees are exactly what the database says", async () => {
  const db = fakeDb();
  const cost = await runAction("get_test_cost", { testCode: "MRI-BR" }, "ip", db.deps);
  assert.equal(cost.test.priceRupees, 7500);
  assert.equal(cost.test.referral, true);
  const docs = await runAction("get_doctor_options", { specialty: "cardio" }, "ip", db.deps);
  assert.equal(docs.doctors[0].consultationFeeRupees, 900);
  assert.equal(docs.doctors[0].doctorId, 1);
});

test("voice actions refuse unknown tests and doctors", async () => {
  const db = fakeDb();
  assert.equal((await runAction("get_test_cost", { testCode: "XRAY-MOON" }, "ip", db.deps)).code, "not_found");
  assert.equal((await runAction("get_test_cost", { testCode: "" }, "ip", db.deps)).code, "invalid");
  assert.equal((await runAction("get_slots", { doctorId: 42 }, "ip", db.deps)).code, "not_found");
  const none = await runAction("get_doctor_options", { specialty: "Dentistry" }, "ip", db.deps);
  assert.equal(none.ok, false);
  assert.match(none.message, /General Medicine/);
});

test("a doctor can be found by name, and an unknown name is refused", async () => {
  const db = fakeDb();
  const rao = await runAction("get_doctor_options", { name: "Dr. Rao" }, "ip", db.deps);
  assert.equal(rao.doctors[0].doctorId, 1);
  const nobody = await runAction("get_doctor_options", { name: "Dr. Strange" }, "ip", db.deps);
  assert.equal(nobody.code, "not_found");
  assert.match(nobody.message, /Strange/);
});

test("get_slots offers only free slots, earliest first, and honours a day or time preference", async () => {
  const db = fakeDb();
  const open = await runAction("get_slots", { doctorId: 1 }, "ip", db.deps);
  assert.equal(open.earliest.value, doctorSlot());
  assert.equal(open.slots.length, 6);

  // The earliest slot gets booked: it is no longer the earliest on offer.
  db.bookings.push({ kind: "doctor", ref_id: 1, slot: open.earliest.value });
  const next = await runAction("get_slots", { doctorId: 1 }, "ip", db.deps);
  assert.equal(next.earliest.value, open.slots[1].value);
  assert.ok(next.slots.every((s) => s.value !== open.earliest.value));

  const afternoon = await runAction("get_slots", { doctorId: 1, partOfDay: "afternoon" }, "ip", db.deps);
  assert.ok(afternoon.matched && afternoon.slots.every((s) => s.value.slice(11) >= "12:00"));

  const day = open.slots[5].value.slice(0, 10);
  const onDay = await runAction("get_slots", { doctorId: 1, date: day }, "ip", db.deps);
  assert.ok(onDay.matched && onDay.slots.every((s) => s.value.startsWith(day)));

  // A day the doctor does not sit: said plainly, with the nearest free slots instead.
  const friday = upcomingSlots(20).find((s) => new Date(s.value.slice(0, 10)).getUTCDay() === 5).value.slice(0, 10);
  const off = await runAction("get_slots", { doctorId: 1, date: friday }, "ip", db.deps);
  assert.equal(off.matched, false);
  assert.ok(off.earliest.value.slice(0, 10) > friday || off.slots.length > 0);
  assert.equal((await runAction("get_slots", { date: "Friday" }, "ip", db.deps)).code, "invalid");
});

test("prepare_booking writes nothing; only a signed confirm books, and only once", async () => {
  const db = fakeDb();
  const prep = await runAction("prepare_booking", { doctorId: 1, slot: doctorSlot(), ...patient }, "ip", db.deps);
  assert.equal(prep.ok, true);
  assert.equal(prep.summary.costRupees, 900);
  assert.equal(db.bookings.length, 0, "a proposal is not a booking");

  const both = await runAction("prepare_booking", { doctorId: 1, testCode: "CBC", slot: doctorSlot(), ...patient }, "ip", db.deps);
  assert.equal(both.code, "invalid");

  const forged = await runAction("confirm_booking", { token: "made.up" }, "ip", db.deps);
  assert.equal(forged.ok, false);
  assert.equal(db.bookings.length, 0);

  const first = await runAction("confirm_booking", { token: prep.token }, "ip", db.deps);
  const dup = await runAction("confirm_booking", { token: prep.token }, "ip", db.deps);
  assert.equal(first.ok, true);
  assert.equal(first.booking.cost, 900);
  assert.equal(dup.booking.reference, first.booking.reference);
  assert.equal(db.bookings.length, 1);
});

test("a failed confirm carries no booking", async () => {
  for (const opts of [{ slotTaken: true }, { limited: true }]) {
    const db = fakeDb(opts);
    const prep = await runAction("prepare_booking", { testCode: "CBC", slot: anySlot(), ...patient }, "ip", db.deps);
    const r = await runAction("confirm_booking", { token: prep.token }, "ip", db.deps);
    assert.equal(r.ok, false);
    assert.equal(r.booking, undefined);
    assert.ok(r.message);
  }
});
