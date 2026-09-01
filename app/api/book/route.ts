import { sql, overLimit, clientIp } from "@/lib/db";

const BOOK_LIMIT_PER_HOUR = 5;
const KINDS = ["doctor", "test", "referral"] as const;

const refCode = () =>
  "MHC-" + Math.random().toString(36).toUpperCase().slice(2, 6) + Date.now().toString(36).toUpperCase().slice(-3);

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  const kind = String(b.kind ?? "");
  const refId = Number(b.refId);
  const name = String(b.patientName ?? "").trim();
  const phone = String(b.phone ?? "").trim();
  const slot = String(b.slot ?? "").trim();

  if (!KINDS.includes(kind as (typeof KINDS)[number]))
    return Response.json({ error: "Unknown booking type." }, { status: 400 });
  if (!Number.isInteger(refId) || refId < 1)
    return Response.json({ error: "Unknown item." }, { status: 400 });
  if (name.length < 2 || name.length > 80)
    return Response.json({ error: "Please enter the patient's full name." }, { status: 400 });
  if (!/^[+\d][\d\s-]{7,17}$/.test(phone))
    return Response.json({ error: "Please enter a valid phone number." }, { status: 400 });
  if (!slot || slot.length > 40)
    return Response.json({ error: "Please choose a slot." }, { status: 400 });

  if (await overLimit(clientIp(req), "book", BOOK_LIMIT_PER_HOUR))
    return Response.json(
      { error: `This demo allows ${BOOK_LIMIT_PER_HOUR} bookings an hour. Please try later.` },
      { status: 429 },
    );

  // The referenced row must exist — never store a booking against a phantom id.
  const exists =
    kind === "doctor"
      ? await sql`SELECT 1 FROM doctors WHERE id = ${refId}`
      : await sql`SELECT 1 FROM tests WHERE id = ${refId}`;
  if (exists.length === 0) return Response.json({ error: "Unknown item." }, { status: 400 });

  const code = refCode();
  await sql`
    INSERT INTO bookings (kind, ref_id, patient_name, phone, slot, ref_code)
    VALUES (${kind}, ${refId}, ${name}, ${phone}, ${slot}, ${code})
  `;
  return Response.json({ refCode: code });
}
