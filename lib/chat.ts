export type Doctor = {
  id: number;
  name: string;
  specialty: string;
  qualification: string;
  department: string;
  consult_fee: number;
  avail_days: string;
  bio: string;
};

export type Test = {
  id: number;
  name: string;
  code: string;
  price: number;
  prep_notes: string;
  turnaround_hours: number;
  ordered_for: string;
  lab_name: string;
  lab_kind: "in_house" | "partner";
  lab_address: string;
  lab_phone: string;
};

export const EMERGENCY_LINE = "+91 80 4000 1000";

/**
 * Red flags are matched in code, before the model is ever called. An 8B model is
 * not a triage nurse and must not be the thing standing between a stroke and an
 * ambulance. Each entry needs every regex in `all` to hit, so single innocuous
 * words ("pain", "bleeding after shaving") don't fire the banner on their own.
 */
const RED_FLAGS: { all: RegExp[]; why: string }[] = [
  {
    all: [/chest (pain|pressure|tightness|discomfort)|crushing.{0,15}chest/, /breath|breathe|breathless|sweat|jaw|left arm|nausea|faint|collaps/],
    why: "chest pain together with breathing difficulty, sweating or arm/jaw pain",
  },
  { all: [/face.{0,20}droop|slurred speech|sudden.{0,20}(weakness|numbness).{0,20}(one side|left side|right side)|can.?t (speak|move one)/], why: "possible stroke signs" },
  { all: [/(severe|heavy|won.?t stop|can.?t stop|uncontrolled).{0,20}bleed|bleeding.{0,20}(won.?t|will not) stop/], why: "bleeding that will not stop" },
  { all: [/(can.?t|cannot|unable to|difficulty) breath|gasping|choking|turning blue|blue lips/], why: "difficulty breathing" },
  { all: [/unconscious|unresponsive|passed out|not waking|seizure|fitting|convuls/], why: "loss of consciousness or a seizure" },
  { all: [/suicid|kill myself|end my life|self.?harm|want to die|harm myself/], why: "thoughts of self-harm" },
  { all: [/coughing (up )?blood|vomiting blood|blood in vomit/], why: "coughing or vomiting blood" },
  { all: [/(worst|thunderclap).{0,20}headache|sudden.{0,20}severe.{0,20}headache/], why: "a sudden, severe headache" },
  { all: [/poison|overdose|swallowed.{0,20}(pills|chemical)/], why: "a possible poisoning or overdose" },
  { all: [/(severe|allergic).{0,25}(swelling|reaction)|anaphyla|throat.{0,15}(closing|swelling)/], why: "a possible severe allergic reaction" },
];

export function redFlag(text: string): string | null {
  const t = text.toLowerCase();
  for (const f of RED_FLAGS) if (f.all.every((re) => re.test(t))) return f.why;
  return null;
}

export type Specialty = { name: string; department: string; sees: string };

export function systemPrompt(
  doctors: Doctor[],
  tests: Test[],
  specialties: Specialty[],
): string {
  // Each doctor id sits directly under the description of what that desk sees, so
  // matching a complaint to an id is a local lookup rather than a guess across a flat list.
  const desks = specialties
    .map((s) => {
      const ids = doctors.filter((d) => d.specialty === s.name).map((d) => d.id);
      return `${s.name} (${s.department}) — sees: ${s.sees}\n    doctor ids: ${ids.join(", ")}`;
    })
    .join("\n");
  return `You are the intake assistant for Meridian Health City, a hospital. You are NOT a doctor and you do NOT practise medicine.

YOUR ONLY JOB: listen to what the visitor describes, then point them at the right specialist and the right pre-consultation tests from the hospital's own lists below.

ABSOLUTELY FORBIDDEN — breaking any of these is a failure:
- Naming, guessing or hinting at any condition, illness, disease or diagnosis.
- Suggesting any medicine, dose, remedy, supplement, diet, exercise or home treatment.
- Saying how serious, urgent, likely, mild or dangerous anything is.
- Telling the visitor what their symptoms "could be" or "might mean".
- Reassuring them that something is or isn't a problem.
- Writing any doctor's name or any test name in your reply text. You refer to them ONLY by returning IDs.

WHAT YOU DO: acknowledge what they told you in one short sentence. If you genuinely need one more detail to pick the right department, ask exactly one short question and return empty ID lists. Otherwise pick the specialist and tests and tell them the options are shown below the message.

DEPARTMENTS — read the "sees" line and pick the desk that matches what the visitor
described, then take a doctor id from that same desk. Never take an id from a desk
whose "sees" line does not match. If nothing matches, use General Medicine.
${desks}

TESTS — refer to a test by its CODE, exactly as written:
${tests.map((t) => `${t.code} · ${t.name} — ${t.ordered_for}`).join("\n")}

Choose 1-2 doctor ids and 0-4 test codes. Only values that appear in the lists above. If nothing fits, use the General Medicine doctors.
Pick a test ONLY when the "routinely ordered for" text actually matches what the visitor described. Returning fewer tests, or none, is correct and expected — never pad the list.
Your reply text must not interpret the symptoms. Do not write "your symptoms suggest", "this could be", "it sounds like" or anything similar. Say what you heard and which desk it belongs to, nothing more.

Reply with ONLY a JSON object, no prose before or after, no markdown fence:
{"reply": "...", "doctorIds": [1], "testCodes": ["CBC","LFT"], "needClarify": false}`;
}

/** Models pad JSON with prose and fences. Dig the object out rather than trusting them. */
export function extractJson(raw: string): {
  reply: string;
  doctorIds: number[];
  testCodes: string[];
  needClarify: boolean;
} | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const o = parsed as Record<string, unknown>;
  if (typeof o.reply !== "string" || !o.reply.trim()) return null;

  const ids = (v: unknown) =>
    Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 6) : [];
  const codes = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((c): c is string => typeof c === "string" && !!c.trim())
          .map((c) => c.trim().toUpperCase())
          .slice(0, 6)
      : [];

  return {
    reply: o.reply.trim(),
    doctorIds: ids(o.doctorIds),
    testCodes: codes(o.testCodes),
    needClarify: o.needClarify === true,
  };
}
