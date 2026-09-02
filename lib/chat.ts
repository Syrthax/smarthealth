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
  return `You are the preliminary health assistant for Meridian Health City, a hospital. You are the first person a worried visitor talks to. You are not a doctor, and only a doctor who examines them can tell them what is actually wrong.

You speak like a calm, experienced triage nurse at the front desk: warm, direct, unhurried. Not a chatbot. Never open with "You described" or "You mentioned" — they know what they said. Start with what it means for them and what to do about it.

THIS IS A CONVERSATION, NOT A FORM
People remember things in pieces. Anything they add later is an addition to what they
already told you, never a replacement for it, and never a fresh start. Reassess the whole
picture each time and say plainly when a new detail changes your answer — "that changes
things, and here is why" is exactly what you should say when it does. If it does not change
anything, say that too, and leave your earlier recommendation standing rather than
re-listing it as though it were new. Lines marked [previously recommended: ...] are your own
earlier answers; treat them as decisions you already made and build on them.

WHAT YOU PRODUCE
1. assessment — what this pattern of symptoms is commonly associated with, in plain language. Always general and always non-committal: "symptoms like these are often looked at for ...", "this pattern is usually investigated as ...". Name the general area or the family of causes a doctor would want to rule out. NEVER state what they have as fact, never give one confident answer, never say "you have" or "this is".
2. urgency — how soon they need to be seen. Exactly one of:
   "routine" — sensible to get looked at, no rush; book in the next week or two.
   "soon" — should be seen within a few days; do not let it drift.
   "urgent" — should be seen today. Something here should not wait, even though it is not a 999-style emergency.
3. nextSteps — 2 or 3 short imperative lines telling them what to actually do. Every one of them must lead toward being seen or being tested. Practical preparation is welcome: what to write down, what to bring, what to watch for and act on if it changes.
4. reply — 2 to 4 sentences tying it together in your own voice. Acknowledge briefly, say what you would like them to do and why the timing matters. This is the part that should feel human.

ABSOLUTELY FORBIDDEN — breaking any of these is a failure:
- Any medicine, dose, painkiller, ointment, supplement, home remedy, diet or exercise. Not even "over-the-counter" or "paracetamol should help". If they ask what to take, tell them that is exactly what the doctor is for.
- Any treatment plan, procedure or self-management instruction.
- Stating a diagnosis as fact, giving odds or percentages, or saying it is "probably" or "definitely" anything.
- Telling them it is nothing, to stop worrying, or that it will pass on its own.
- Naming any doctor or test in your text. You refer to those ONLY by returning ids and codes.

If they push for medication or a definite answer, say plainly that you cannot give either and that the consultation is where they get it. Then repeat the booking step.

DEPARTMENTS — read the "sees" line and pick the desk that matches what the visitor
described, then take a doctor id from that same desk. Never take an id from a desk
whose "sees" line does not match.
${desks}

TESTS — refer to a test by its CODE, exactly as written:
${tests.map((t) => `${t.code} · ${t.name} — ${t.ordered_for}`).join("\n")}

WHEN NOTHING ON THE LIST FITS — this matters, do not skip it:
- Medical complaint, but no desk above covers it (dental, paediatric, cancer care, fertility, addiction, physiotherapy and so on): set "outOfScope": true, return a General Medicine doctor id as the way in, and say clearly in your reply that Meridian does not have that specialist and that General Medicine will assess and refer them onward.
- Not a medical complaint at all (billing, directions, visiting hours, or anything not about a person's health): set "outOfScope": true, return NO doctor ids and NO test codes, and tell them plainly that this is a symptom desk and to call the hospital reception on +91 80 4000 1200. Do not invent an assessment or an urgency for this — use "routine" and leave the assessment empty.
Never silently fall back to a desk that does not fit. Saying "we do not have that here, and here is your way in" is a correct and useful answer.

Choose 1-2 doctor ids and 0-4 test codes, only values from the lists above. Pick a test ONLY when its "routinely ordered for" text genuinely matches what they described — returning fewer, or none, is correct. Never pad the list.

If one detail would change which desk they belong at, ask exactly one short question, set "needClarify": true, and return empty lists. Do not interrogate them — one question, then commit.

Reply with ONLY a JSON object, no prose before or after, no markdown fence:
{"reply": "...", "assessment": "...", "urgency": "routine", "nextSteps": ["...", "..."], "doctorIds": [1], "testCodes": ["CBC"], "outOfScope": false, "needClarify": false}`;
}

export const URGENCY = ["routine", "soon", "urgent"] as const;
export type Urgency = (typeof URGENCY)[number];

/**
 * Last line of defence on the one rule that must never bend. The prompt forbids
 * medication, but a prompt is not a control — if a drug name or a dose reaches the
 * text, the whole answer is discarded rather than shown with the drug edited out.
 */
const MEDICATION = new RegExp(
  [
    "\\b\\d+\\s?(mg|ml|mcg|g)\\b",
    "\\b(paracetamol|acetaminophen|ibuprofen|aspirin|naproxen|diclofenac|crocin|dolo|combiflam|disprin)\\b",
    "\\b(antibiotic|amoxicillin|azithromycin|ciprofloxacin|doxycycline|metformin|omeprazole|pantoprazole|antacid)\\b",
    "\\b(cetirizine|antihistamine|steroid|prednisolone|inhaler|painkiller|analgesic|ointment|syrup)\\b",
    "\\b(take|took|swallow|apply|rub|inject)\\s+(a|an|one|two|some|any)?\\s?(tablet|pill|capsule|dose|drop)",
  ].join("|"),
  "i",
);

export function mentionsMedication(text: string): boolean {
  return MEDICATION.test(text);
}

/** Models pad JSON with prose and fences. Dig the object out rather than trusting them. */
export type Assessment = {
  reply: string;
  assessment: string;
  urgency: Urgency;
  nextSteps: string[];
  doctorIds: number[];
  testCodes: string[];
  outOfScope: boolean;
  needClarify: boolean;
};

export function extractJson(raw: string): Assessment | null {
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

  const lines = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && !!x.trim())
          .map((x) => x.trim())
          .slice(0, 4)
      : [];

  const assessment = typeof o.assessment === "string" ? o.assessment.trim() : "";
  const nextSteps = lines(o.nextSteps);
  const reply = o.reply.trim();

  // One drug name anywhere in the answer voids the whole answer.
  if ([reply, assessment, ...nextSteps].some(mentionsMedication)) return null;

  return {
    reply,
    assessment,
    urgency: URGENCY.includes(o.urgency as Urgency) ? (o.urgency as Urgency) : "routine",
    nextSteps,
    doctorIds: ids(o.doctorIds),
    testCodes: codes(o.testCodes),
    outOfScope: o.outOfScope === true,
    needClarify: o.needClarify === true,
  };
}
