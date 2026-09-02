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

ASKING BEFORE YOU ANSWER
A real triage nurse asks before deciding, and you should too. Ask whenever an answer would
genuinely change the department, the urgency or which tests are worth doing — how long it
has been going on, whether something else came with it, what makes it worse. Do not ask
things you can already infer, and do not ask for the sake of asking.

When you ask, put the question in "question" and return NO doctor ids, NO test codes and no
assessment. Give 3 to 5 concrete options that between them cover the realistic answers. The
visitor can always type something else instead, so do not add "other" or "something else" as
an option yourself.

Symptoms travel together, and the options are where you show that you know it. Someone
reporting a bowel problem should be asked whether there has been vomiting, blood, or fever
alongside it; someone with a headache, whether there is vision change or nausea. Ask about
the companion symptom you would expect, not a generic follow-up.

Ask at most two rounds of questions, then commit to an answer with what you have. If you
have already asked twice in this conversation, do not ask again — decide.

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

Reply with ONLY a JSON object, no prose before or after, no markdown fence.

When answering:
{"reply": "...", "assessment": "...", "urgency": "routine", "nextSteps": ["...", "..."], "doctorIds": [1], "testCodes": ["CBC"], "outOfScope": false}

When asking:
{"reply": "one short line explaining why you need to know", "question": {"text": "How long has this been going on?", "options": ["Since today", "A few days", "A week or two", "Longer than a month"]}, "urgency": "routine", "doctorIds": [], "testCodes": [], "outOfScope": false}`;
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

/**
 * Pulls the value of "reply" out of JSON that is still being written. Streaming gives us
 * `{"reply":"You sho` and we want `You sho` on screen now rather than after the rest of
 * the object finishes generating. Returns "" until the field actually starts.
 */
export function partialReply(buffer: string): string {
  const key = buffer.indexOf('"reply"');
  if (key === -1) return "";
  const open = buffer.indexOf('"', buffer.indexOf(":", key + 7) + 1);
  if (open === -1) return "";

  let out = "";
  for (let i = open + 1; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === "\\") {
      const next = buffer[i + 1];
      if (next === undefined) break; // escape split across chunks — wait for the rest
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i++;
      continue;
    }
    if (ch === '"') break; // the string closed: this is the whole reply
    out += ch;
  }
  return out;
}

/** Models pad JSON with prose and fences. Dig the object out rather than trusting them. */
export type Question = { text: string; options: string[] };

export type Assessment = {
  reply: string;
  assessment: string;
  urgency: Urgency;
  nextSteps: string[];
  question: Question | null;
  doctorIds: number[];
  testCodes: string[];
  outOfScope: boolean;
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

  const q = o.question as { text?: unknown; options?: unknown } | undefined;
  const options = Array.isArray(q?.options)
    ? q.options.filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim())
        .slice(0, 5)
    : [];
  // A question with nothing to pick is just prose; drop it rather than render a dead widget.
  const question: Question | null =
    typeof q?.text === "string" && q.text.trim() && options.length >= 2
      ? { text: q.text.trim(), options }
      : null;

  const assessment = typeof o.assessment === "string" ? o.assessment.trim() : "";
  const nextSteps = lines(o.nextSteps);
  const reply = o.reply.trim();

  // One drug name anywhere in the answer voids the whole answer.
  if ([reply, assessment, ...nextSteps, ...(question?.options ?? [])].some(mentionsMedication))
    return null;

  return {
    reply,
    // While it is still asking, an assessment would be a guess dressed as a finding.
    assessment: question ? "" : assessment,
    urgency: URGENCY.includes(o.urgency as Urgency) ? (o.urgency as Urgency) : "routine",
    nextSteps: question ? [] : nextSteps,
    question,
    doctorIds: question ? [] : ids(o.doctorIds),
    testCodes: question ? [] : codes(o.testCodes),
    outOfScope: o.outOfScope === true,
  };
}
