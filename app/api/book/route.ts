import { clientIp, tooMany } from "@/lib/db";
import { book } from "@/lib/booking";

/**
 * The booking dialog's door into lib/booking.ts. All the rules live there, shared with
 * the voice agent; this only translates the dialog's `{ kind, refId }` into an item.
 * The kind the client sends is not trusted — whether a test is a referral is decided by
 * its lab, server-side.
 */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  const kind = String(b.kind ?? "");
  const refId = Number(b.refId);
  if (!["doctor", "test", "referral"].includes(kind))
    return Response.json({ error: "Unknown booking type." }, { status: 400 });

  const result = await book(clientIp(req), {
    item: kind === "doctor" ? { doctorId: refId } : { testId: refId },
    patientName: String(b.patientName ?? ""),
    phone: String(b.phone ?? ""),
    slot: String(b.slot ?? ""),
    // No idemKey: only server-signed voice proposals carry one. The dialog guards against
    // double submits by disabling its button; a key it made up would prove nothing.
  });

  if (!result.ok) {
    if (result.code === "rate_limited") return tooMany(result.error, result.retryAfter ?? 3600);
    return Response.json({ error: result.error, code: result.code }, { status: result.status });
  }
  // `refCode` stays for anything still reading the old shape; `booking` is the canonical one.
  return Response.json({ refCode: result.booking.reference, booking: result.booking });
}
