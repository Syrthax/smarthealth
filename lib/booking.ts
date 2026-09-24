import { sql as liveSql, overLimit as liveOverLimit } from "./db.ts";
import { slotLabel, slotProblem } from "./slots.ts";

/**
 * The one booking implementation. `/api/book` (the dialog) and `/api/voice/action`
 * (the voice agent) both come through here, so there is exactly one set of validation
 * rules, one rate limit, one insert and one shape of confirmation — the object the
 * website renders is the same object the voice agent reads the reference out of.
 */

export type BookingKind = "doctor" | "test" | "referral";

export type BookingConfirmation = {
  bookingId: number;
  reference: string;
  kind: BookingKind;
  /** The doctor's name for a consultation, the test's name otherwise. */
  itemName: string;
  doctorName?: string;
  specialty?: string;
  testCode?: string;
  labName?: string;
  labAddress?: string;
  /** Canonical slot value as stored; `slotLabel` is what people read. */
  slot: string;
  slotLabel: string;
  /** Rupees, straight from the row — consult_fee or price. */
  cost: number;
  patientName: string;
  phoneMasked: string;
};

export type BookingRequest = {
  item: { doctorId: number } | { testId: number } | { testCode: string };
  patientName: string;
  phone: string;
  slot: string;
  /** Server-issued nonce (see lib/pending.ts). The same key always yields the same booking. */
  idemKey?: string;
};

export type BookingFailure = {
  ok: false;
  status: number;
  code: "invalid" | "unknown_item" | "slot_taken" | "rate_limited";
  error: string;
  retryAfter?: number;
};

/** What a booking is for, resolved from the database — never from what the caller claimed. */
export type BookableItem = {
  kind: BookingKind;
  refId: number;
  itemName: string;
  cost: number;
  availDays?: string;
  doctorName?: string;
  specialty?: string;
  testCode?: string;
  labName?: string;
  labAddress?: string;
};

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;
export type BookingDeps = {
  sql: Sql;
  overLimit: (ip: string, route: string, limit: number) => Promise<false | number>;
};
const live: BookingDeps = { sql: liveSql as unknown as Sql, overLimit: liveOverLimit };

export const BOOK_LIMIT_PER_HOUR = 5;

const refCode = () =>
  "MHC-" + Math.random().toString(36).toUpperCase().slice(2, 6) + Date.now().toString(36).toUpperCase().slice(-3);

const fail = (status: number, code: BookingFailure["code"], error: string): BookingFailure => ({
  ok: false,
  status,
  code,
  error,
});

/** Neon's tagged template returns untyped rows; name them at the call. */
const typed = async <T>(query: PromiseLike<unknown>) => (await query) as T[];

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `ending ${digits.slice(-4)}`;
}

/** Field checks that need no database. Returns the cleaned request, or why it is unusable. */
export function validateFields(req: Partial<BookingRequest>): BookingFailure | BookingRequest {
  const patientName = String(req.patientName ?? "").trim();
  const phone = String(req.phone ?? "").trim();
  const slot = String(req.slot ?? "").trim();
  const item = req.item as Record<string, unknown> | undefined;

  const doctorId = Number(item?.doctorId);
  const testId = Number(item?.testId);
  const testCode = typeof item?.testCode === "string" ? item.testCode.trim().toUpperCase() : "";
  const cleanItem: BookingRequest["item"] | null =
    Number.isInteger(doctorId) && doctorId > 0
      ? { doctorId }
      : Number.isInteger(testId) && testId > 0
        ? { testId }
        : /^[A-Z0-9-]{2,16}$/.test(testCode)
          ? { testCode }
          : null;

  if (!cleanItem) return fail(400, "unknown_item", "I could not tell which doctor or test this is for.");
  if (patientName.length < 2 || patientName.length > 80)
    return fail(400, "invalid", "Please give the patient's full name.");
  if (!/^[+\d][\d\s-]{7,17}$/.test(phone)) return fail(400, "invalid", "Please give a valid phone number.");
  if (!slot || slot.length > 40) return fail(400, "invalid", "Please choose a slot.");
  if (req.idemKey !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(req.idemKey))
    return fail(400, "invalid", "Malformed request.");

  return { item: cleanItem, patientName, phone, slot, idemKey: req.idemKey };
}

export async function findItem(
  item: BookingRequest["item"],
  deps: BookingDeps = live,
): Promise<BookableItem | null> {
  if ("doctorId" in item) {
    const [d] = await typed<{ id: number; name: string; specialty: string; consult_fee: number; avail_days: string }>(
      deps.sql`SELECT id, name, specialty, consult_fee, avail_days FROM doctors WHERE id = ${item.doctorId}`,
    );
    if (!d) return null;
    return {
      kind: "doctor",
      refId: d.id,
      itemName: d.name,
      doctorName: d.name,
      specialty: d.specialty,
      cost: d.consult_fee,
      availDays: d.avail_days,
    };
  }

  type Row = { id: number; name: string; code: string; price: number; lab_name: string; lab_kind: string; lab_address: string };
  const [t] = await typed<Row>(
    "testId" in item
      ? deps.sql`SELECT t.id, t.name, t.code, t.price, l.name AS lab_name, l.kind AS lab_kind, l.address AS lab_address
          FROM tests t JOIN labs l ON l.id = t.lab_id WHERE t.id = ${item.testId}`
      : deps.sql`SELECT t.id, t.name, t.code, t.price, l.name AS lab_name, l.kind AS lab_kind, l.address AS lab_address
          FROM tests t JOIN labs l ON l.id = t.lab_id WHERE t.code = ${item.testCode}`,
  );
  if (!t) return null;
  return {
    // The lab decides the kind, not the caller: a partner-lab test is a referral.
    kind: t.lab_kind === "partner" ? "referral" : "test",
    refId: t.id,
    itemName: t.name,
    testCode: t.code,
    cost: t.price,
    labName: t.lab_name,
    labAddress: t.lab_address,
  };
}

/**
 * Everything short of writing: fields, the item, and whether the slot suits it. The voice
 * agent calls this to build the summary the patient confirms; `book` runs it again at
 * execution time, because a confirmation is never proof that the request is still valid.
 */
export async function checkBooking(
  raw: Partial<BookingRequest>,
  deps: BookingDeps = live,
): Promise<BookingFailure | { ok: true; req: BookingRequest; item: BookableItem; slotLabel: string }> {
  const req = validateFields(raw);
  if ("ok" in req) return req;
  const item = await findItem(req.item, deps);
  if (!item) return fail(400, "unknown_item", "That doctor or test is not in our directory.");
  const problem = slotProblem(req.slot, item.availDays);
  if (problem) return fail(400, "invalid", problem);
  return { ok: true, req, item, slotLabel: slotLabel(req.slot) };
}

function confirmation(
  row: { id: number; ref_code: string; patient_name: string; phone: string; slot: string },
  item: BookableItem,
): BookingConfirmation {
  return {
    bookingId: row.id,
    reference: row.ref_code,
    kind: item.kind,
    itemName: item.itemName,
    doctorName: item.doctorName,
    specialty: item.specialty,
    testCode: item.testCode,
    labName: item.labName,
    labAddress: item.labAddress,
    slot: row.slot,
    slotLabel: slotLabel(row.slot),
    cost: item.cost,
    patientName: row.patient_name,
    phoneMasked: maskPhone(row.phone),
  };
}

type BookingRow = { id: number; kind: BookingKind; ref_id: number; ref_code: string; patient_name: string; phone: string; slot: string };

async function byIdemKey(key: string, deps: BookingDeps): Promise<BookingConfirmation | null> {
  const [row] = await typed<BookingRow>(
    deps.sql`SELECT id, kind, ref_id, ref_code, patient_name, phone, slot FROM bookings WHERE idem_key = ${key}`,
  );
  if (!row) return null;
  const item = await findItem(row.kind === "doctor" ? { doctorId: row.ref_id } : { testId: row.ref_id }, deps);
  return item ? confirmation(row, item) : null;
}

export async function book(
  ip: string,
  raw: Partial<BookingRequest>,
  deps: BookingDeps = live,
): Promise<BookingFailure | { ok: true; booking: BookingConfirmation; replayed: boolean }> {
  const fields = validateFields(raw);
  if ("ok" in fields) return fields;

  // A retried or duplicated confirmation is answered with the booking it already made,
  // before the rate limiter sees it — repeating "yes" must not cost the patient a booking.
  if (fields.idemKey) {
    const existing = await byIdemKey(fields.idemKey, deps);
    if (existing) return { ok: true, booking: existing, replayed: true };
  }

  const retryAfter = await deps.overLimit(ip, "book", BOOK_LIMIT_PER_HOUR);
  if (retryAfter)
    return {
      ...fail(429, "rate_limited", `This demo allows ${BOOK_LIMIT_PER_HOUR} bookings an hour. Please try again later.`),
      retryAfter,
    };

  const checked = await checkBooking(fields, deps);
  if (!checked.ok) return checked;
  const { req, item } = checked;

  let inserted: BookingRow[];
  try {
    // ON CONFLICT names only idem_key, so a clash on the one-patient-per-consultation
    // index still raises 23505 below instead of being silently swallowed.
    inserted = await typed<BookingRow>(deps.sql`
      INSERT INTO bookings (kind, ref_id, patient_name, phone, slot, ref_code, idem_key)
      VALUES (${item.kind}, ${item.refId}, ${req.patientName}, ${req.phone}, ${req.slot}, ${refCode()}, ${req.idemKey ?? null})
      ON CONFLICT (idem_key) DO NOTHING
      RETURNING id, kind, ref_id, ref_code, patient_name, phone, slot
    `);
  } catch (err) {
    // Let the unique index be the arbiter rather than a check-then-insert, which
    // would still let two requests through if they raced.
    if ((err as { code?: string })?.code === "23505")
      return fail(409, "slot_taken", "Someone has just taken that slot. Please choose another one.");
    throw err;
  }

  if (!inserted[0]) {
    // Lost a race against an identical request carrying the same key: that one won.
    const existing = req.idemKey ? await byIdemKey(req.idemKey, deps) : null;
    if (existing) return { ok: true, booking: existing, replayed: true };
    throw new Error("booking insert returned no row");
  }
  return { ok: true, booking: confirmation(inserted[0], item), replayed: false };
}
