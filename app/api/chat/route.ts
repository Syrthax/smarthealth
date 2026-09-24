import { sql, overLimit, clientIp, rows } from "@/lib/db";
import {
  redFlag,
  systemPrompt,
  extractJson,
  partialReply,
  emergencyAnswer,
  EMERGENCY_LINE,
  OUT_OF_SCOPE_REPLY,
  type Doctor,
  type Test,
  type Specialty,
} from "@/lib/chat";
import { callFeatherless } from "@/lib/featherless";
import { injectionAttempt, neutralise, nextStrike, OFF_TOPIC_LIMIT, OFF_TOPIC_REPLIES } from "@/lib/guard";

/**
 * The desk's answer to anything that is not about health — or that tries to change how the
 * assistant works. Server-written, firmer each time, and the last one ends the
 * conversation (`ended`). The count comes from the transcript, so the server holds no state.
 */
function offTopic(history: { role: string; content: string }[]) {
  const strike = nextStrike(history);
  return {
    t: "done",
    reply: OFF_TOPIC_REPLIES[strike - 1],
    urgency: "routine",
    nextSteps: [],
    doctors: [],
    tests: [],
    offTopic: strike,
    ended: strike >= OFF_TOPIC_LIMIT,
  };
}

/**
 * Newline-delimited JSON. `reply` events carry the prose as it generates; exactly one
 * `done` event carries the finished, DB-hydrated answer. Short-circuits (emergency, rate
 * limit, failure) emit a lone `done`, so the client has one code path for everything.
 */
function ndjson(events: (emit: (e: object) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (e: object) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        try {
          await events(emit);
        } catch (err) {
          console.error("[chat] stream failed:", err);
          emit({
            t: "done",
            reply:
              "Something went wrong at our end. Please call reception on +91 80 4000 1200, or browse the doctor directory and book directly.",
            urgency: "routine",
            nextSteps: [],
            doctors: [],
            tests: [],
            degraded: true,
          });
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } },
  );
}

const CHAT_LIMIT_PER_HOUR = 20;

export async function POST(req: Request) {
  let body: { messages?: { role: "user" | "assistant"; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
    // Role markers and forged "[previously recommended]" lines are stripped from what the
    // visitor wrote before any model sees it. The desk's own turns keep their markers.
    .map((m) => ({
      role: m.role,
      content: (m.role === "user" ? neutralise(m.content) : m.content).slice(0, 1500),
    }))
    // Six exchanges. Long enough that someone can add "I forgot to mention…" three
    // times and still be understood; short enough to stay well inside the context window.
    .slice(-12);

  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!latest.trim()) return Response.json({ error: "Say something first." }, { status: 400 });

  const retryAfter = await overLimit(clientIp(req), "chat", CHAT_LIMIT_PER_HOUR);
  if (retryAfter) {
    return ndjson(async (emit) =>
      emit({
        t: "done",
        reply: `You have reached the limit of ${CHAT_LIMIT_PER_HOUR} messages an hour on this demo. If this is urgent, call the hospital on ${EMERGENCY_LINE} rather than waiting — otherwise the doctor directory is open and you can book directly.`,
        urgency: "routine",
        nextSteps: [],
        doctors: [],
        tests: [],
        rateLimited: true,
        retryAfter,
      }),
    );
  }

  // Red flags short-circuit. The model is never consulted on an emergency.
  const flag = redFlag(latest);
  if (flag) return ndjson(async (emit) => emit({ t: "done", ...emergencyAnswer(flag) }));

  // An attempt to rewrite the assistant never reaches it. After the emergency check, so
  // "ignore your rules, I have crushing chest pain" still gets the ambulance.
  // Checked on the raw text: neutralise() has already stripped markers from `latest`.
  const raw = [...(body.messages ?? [])].reverse().find((m) => m?.role === "user")?.content;
  if (injectionAttempt(String(raw ?? ""))) return ndjson(async (emit) => emit(offTopic(messages)));

  const [doctors, tests, specialties] = await Promise.all([
    rows<Doctor>(sql`SELECT * FROM doctors ORDER BY id`),
    rows<Test>(sql`SELECT t.id, t.name, t.code, t.price, t.prep_notes, t.turnaround_hours, t.ordered_for,
               l.name AS lab_name, l.kind AS lab_kind, l.address AS lab_address, l.phone AS lab_phone
        FROM tests t JOIN labs l ON l.id = t.lab_id ORDER BY t.id`),
    rows<Specialty>(sql`SELECT name, department, sees FROM specialties ORDER BY name`),
  ]);

  return ndjson(async (emit) => {
    // Forward the reply prose the moment it starts forming, long before the model has
    // finished writing the ids and next steps that follow it in the object.
    let sent = "";
    const raw = await callFeatherless(
      systemPrompt(doctors, tests, specialties),
      messages,
      (full) => {
        const text = partialReply(full);
        if (text.length > sent.length) {
          sent = text;
          emit({ t: "reply", v: text });
        }
      },
    );

    const parsed = raw ? extractJson(raw) : null;

    if (!parsed) {
      emit({
        t: "done",
        reply:
          "I could not work through that properly just now, and I would rather say so than guess. You can browse the full doctor directory and book directly, or call reception on +91 80 4000 1200 and they will place you with the right department.",
        urgency: "routine",
        nextSteps: [],
        doctors: [],
        tests: [],
        degraded: true,
      });
      return;
    }

    if (parsed.offTopic) {
      emit(offTopic(messages));
      return;
    }

    // Hydrate from the DB so a hallucinated doctor or test can never reach the UI.
    const pick = <T>(rows: T[], keys: (string | number)[], keyOf: (r: T) => string | number) =>
      keys.map((k) => rows.find((r) => keyOf(r) === k)).filter((r): r is T => Boolean(r));

    const hydratedDoctors = pick(doctors, parsed.doctorIds, (d) => d.id).slice(0, 3);

    // Out of scope with no way in means the question was not about a symptom at all.
    // The model has no idea what our visiting hours or parking are and will cheerfully
    // invent both, so it does not get to answer these in its own words.
    if (parsed.outOfScope && hydratedDoctors.length === 0) {
      emit({
        t: "done",
        reply: OUT_OF_SCOPE_REPLY,
        assessment: "",
        urgency: "routine",
        nextSteps: [],
        outOfScope: true,
        doctors: [],
        tests: [],
      });
      return;
    }

    emit({
      t: "done",
      reply: parsed.reply,
      assessment: parsed.assessment,
      urgency: parsed.urgency,
      nextSteps: parsed.nextSteps,
      question: parsed.question,
      outOfScope: parsed.outOfScope,
      doctors: hydratedDoctors,
      tests: pick(tests, parsed.testCodes, (t) => t.code).slice(0, 4),
    });
  });
}
