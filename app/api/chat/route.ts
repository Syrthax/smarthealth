import { sql, overLimit, clientIp, rows } from "@/lib/db";
import {
  redFlag,
  systemPrompt,
  extractJson,
  EMERGENCY_LINE,
  type Doctor,
  type Test,
  type Specialty,
} from "@/lib/chat";
import { callFeatherless } from "@/lib/featherless";

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
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
    // Six exchanges. Long enough that someone can add "I forgot to mention…" three
    // times and still be understood; short enough to stay well inside the context window.
    .slice(-12);

  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!latest.trim()) return Response.json({ error: "Say something first." }, { status: 400 });

  if (await overLimit(clientIp(req), "chat", CHAT_LIMIT_PER_HOUR)) {
    return Response.json(
      {
        reply: `You have reached the limit of ${CHAT_LIMIT_PER_HOUR} messages an hour on this demo. If this is urgent, call the hospital on ${EMERGENCY_LINE} rather than waiting — otherwise the doctor directory is open and you can book directly.`,
        urgency: "routine",
        nextSteps: [],
        doctors: [],
        tests: [],
      },
      { status: 429 },
    );
  }

  // Red flags short-circuit. The model is never consulted on an emergency.
  const flag = redFlag(latest);
  if (flag) {
    return Response.json({
      emergency: { why: flag, line: EMERGENCY_LINE },
      reply: `What you have described (${flag}) needs to be seen in person right now, not booked for later. Call ${EMERGENCY_LINE} or go straight to the Meridian emergency department. Please do not wait for a booking, and do not drive yourself.`,
      urgency: "emergency",
      nextSteps: [
        `Call ${EMERGENCY_LINE} now, or have someone take you to the emergency department.`,
        "Do not drive yourself. If you are alone, stay on the line with the operator.",
        "Take any medicines you already use, and a list of your conditions, if they are within reach.",
      ],
      doctors: [],
      tests: [],
    });
  }

  const [doctors, tests, specialties] = await Promise.all([
    rows<Doctor>(sql`SELECT * FROM doctors ORDER BY id`),
    rows<Test>(sql`SELECT t.id, t.name, t.code, t.price, t.prep_notes, t.turnaround_hours, t.ordered_for,
               l.name AS lab_name, l.kind AS lab_kind, l.address AS lab_address, l.phone AS lab_phone
        FROM tests t JOIN labs l ON l.id = t.lab_id ORDER BY t.id`),
    rows<Specialty>(sql`SELECT name, department, sees FROM specialties ORDER BY name`),
  ]);

  const raw = await callFeatherless(systemPrompt(doctors, tests, specialties), messages);
  const parsed = raw ? extractJson(raw) : null;

  if (!parsed) {
    return Response.json({
      reply:
        "I could not work through that properly just now, and I would rather say so than guess. You can browse the full doctor directory and book directly, or call reception on +91 80 4000 1200 and they will place you with the right department.",
      urgency: "routine",
      nextSteps: [],
      doctors: [],
      tests: [],
      degraded: true,
    });
  }

  // Hydrate from the DB so a hallucinated doctor or test can never reach the UI.
  const pick = <T>(rows: T[], keys: (string | number)[], keyOf: (r: T) => string | number) =>
    keys.map((k) => rows.find((r) => keyOf(r) === k)).filter((r): r is T => Boolean(r));

  const hydratedDoctors = pick(doctors, parsed.doctorIds, (d) => d.id).slice(0, 3);

  // Out of scope with no way in means the question was not about a symptom at all.
  // The model has no idea what our visiting hours or parking are and will cheerfully
  // invent both, so it does not get to answer these in its own words.
  if (parsed.outOfScope && hydratedDoctors.length === 0) {
    return Response.json({
      reply:
        "This desk only handles symptoms — I am not the right place for that, and I would rather send you to someone who actually knows than guess. Reception can help you on +91 80 4000 1200, or tell me what you have been feeling and I will pick up from there.",
      assessment: "",
      urgency: "routine",
      nextSteps: [],
      outOfScope: true,
      doctors: [],
      tests: [],
    });
  }

  return Response.json({
    reply: parsed.reply,
    assessment: parsed.assessment,
    urgency: parsed.urgency,
    nextSteps: parsed.nextSteps,
    outOfScope: parsed.outOfScope,
    doctors: hydratedDoctors,
    tests: pick(tests, parsed.testCodes, (t) => t.code).slice(0, 4),
  });
}
