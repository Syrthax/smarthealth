import { overLimit, clientIp } from "@/lib/db";
import { runAction } from "@/lib/voice-actions";
import { SERVER_TOOLS, type ServerTool } from "@/lib/voice";

/**
 * Where the voice agent's tool calls land. Only the tools in SERVER_TOOLS exist here;
 * there is no generic query path. Each call gets its own abuse budget, and bookings are
 * additionally held to the same 5-an-hour limit as the dialog, inside lib/booking.ts.
 *
 * Failures come back as 200 `{ ok: false, code, message }` rather than HTTP errors,
 * because the result goes straight back to the model as a tool response and the model
 * needs the message to say aloud. A rate limit is the exception: it is also a 429 with
 * Retry-After, so it reads the same as every other limited endpoint.
 */

const ACTIONS_PER_HOUR = 60;

export async function POST(req: Request) {
  let body: { name?: unknown; args?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, code: "invalid", message: "Malformed request." }, { status: 400 });
  }

  const name = body.name as ServerTool;
  if (!SERVER_TOOLS.includes(name))
    return Response.json({ ok: false, code: "unknown_tool", message: "I cannot do that." }, { status: 400 });
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};

  const ip = clientIp(req);
  const retryAfter = await overLimit(ip, "voice-action", ACTIONS_PER_HOUR);
  if (retryAfter)
    return Response.json(
      {
        ok: false,
        code: "rate_limited",
        message: "I cannot look anything else up right now — this demo has an hourly limit. Please try again later.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );

  try {
    const result = await runAction(name, args, ip);
    const status = !result.ok && result.code === "rate_limited" ? 429 : 200;
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (status === 429 && !result.ok && result.retryAfter) headers["Retry-After"] = String(result.retryAfter);
    return Response.json(result, { status, headers });
  } catch (err) {
    console.error(`[voice] action ${name} failed:`, err);
    // An error is never reported as a booking — but it is not reported as "not booked"
    // either, since we cannot know. Asking again is safe: the idempotency key means a
    // retry returns the booking if one landed, and makes it if not.
    return Response.json(
      {
        ok: false,
        code: "error",
        message:
          name === "confirm_booking"
            ? "Something went wrong at our end and I could not confirm the booking. Nothing is booked until you have a reference number — I can try once more if you like."
            : "I could not look that up just now.",
      },
      { status: 500 },
    );
  }
}
