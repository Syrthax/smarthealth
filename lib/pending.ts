import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BookingRequest } from "./booking.ts";

/**
 * A booking the voice agent has proposed but the patient has not yet agreed to.
 *
 * `prepare_booking` validates everything and hands back one of these instead of writing
 * anything. `confirm_booking` accepts nothing but the token, so the agent cannot quietly
 * change the doctor, the slot or the phone number between the patient hearing the summary
 * and the booking being made — whatever was read out is exactly what gets booked. The
 * nonce inside becomes the booking's idempotency key: a reconnect, a duplicated tool call
 * or a second "yes" all land on the same row.
 *
 * The token lives in the browser; the model only ever sees a short pending id. Long opaque
 * strings are exactly what a speech model garbles when it copies them into arguments.
 *
 * ponytail: stateless HMAC rather than a pending_actions table. Replay is bounded by the
 * expiry and made harmless by the idempotency key, which is all a demo needs.
 */

export const PENDING_TTL_MS = 10 * 60_000;

type Payload = { r: Omit<BookingRequest, "idemKey">; n: string; e: number };

function secret(): string | null {
  // A dedicated secret if one is set; otherwise one derived from the Gemini key, so voice
  // needs no extra configuration. Derived, never the key itself, and never sent anywhere.
  if (process.env.VOICE_SIGNING_SECRET) return process.env.VOICE_SIGNING_SECRET;
  const key = process.env.GEMINI_API_KEY || process.env.Gemini_API;
  return key ? createHmac("sha256", key).update("mhc-voice-pending-v1").digest("hex") : null;
}

const mac = (body: string, key: string) => createHmac("sha256", key).update(body).digest("base64url");

export function signPending(req: BookingRequest, now = Date.now(), key = secret()): string {
  if (!key) throw new Error("no signing secret configured");
  const payload: Payload = {
    r: { item: req.item, patientName: req.patientName, phone: req.phone, slot: req.slot },
    n: randomBytes(12).toString("base64url"),
    e: now + PENDING_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, key)}`;
}

/** The request the token was issued for, with its nonce as the idempotency key — or why not. */
export function verifyPending(
  token: unknown,
  now = Date.now(),
  key = secret(),
): { ok: true; req: BookingRequest } | { ok: false; error: string } {
  if (!key) return { ok: false, error: "Voice booking is not configured." };
  if (typeof token !== "string" || token.length > 2000) return { ok: false, error: "No booking is waiting for confirmation." };
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "No booking is waiting for confirmation." };

  const expected = Buffer.from(mac(body, key));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, error: "That confirmation could not be verified." };

  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "That confirmation could not be verified." };
  }
  if (typeof p.e !== "number" || p.e < now)
    return { ok: false, error: "That booking summary has expired. Let me put it together again." };
  return { ok: true, req: { ...p.r, idemKey: p.n } };
}
