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
    .slice(-8);

  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!latest.trim()) return Response.json({ error: "Say something first." }, { status: 400 });

  if (await overLimit(clientIp(req), "chat", CHAT_LIMIT_PER_HOUR)) {
    return Response.json(
      {
        reply: `You have reached the limit of ${CHAT_LIMIT_PER_HOUR} messages an hour on this demo. Please call the hospital on ${EMERGENCY_LINE} or browse the doctor directory.`,
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
      reply: `What you have described (${flag}) needs to be seen in person right now, not booked for later. Call ${EMERGENCY_LINE} or go to the Meridian emergency department immediately. I am not able to help further with this here.`,
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
        "I could not process that just now. You can browse the full doctor directory and book directly, or call the hospital reception.",
      doctors: [],
      tests: [],
      degraded: true,
    });
  }

  // Hydrate from the DB so a hallucinated doctor or test can never reach the UI.
  const pick = <T>(rows: T[], keys: (string | number)[], keyOf: (r: T) => string | number) =>
    keys.map((k) => rows.find((r) => keyOf(r) === k)).filter((r): r is T => Boolean(r));

  return Response.json({
    reply: parsed.reply,
    doctors: pick(doctors, parsed.doctorIds, (d) => d.id).slice(0, 3),
    tests: pick(tests, parsed.testCodes, (t) => t.code).slice(0, 4),
  });
}
