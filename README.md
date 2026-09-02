# Meridian Health City

A demo hospital website with a preliminary health assistant in the bottom-right corner. You
describe what you have been feeling; it tells you what that pattern is commonly investigated
for, how soon you ought to be seen, what to do next, and which department to go to — then
books the consultation and any useful tests in one click.

**It advises, but it does not practise medicine.** It will tell you the general area a
doctor would want to rule out and how urgent it looks. It will never name a medication or a
dose, never hand you a treatment plan, and never state a diagnosis as fact. Every piece of
advice it gives ends at the same place: see the right doctor.

## How the safety envelope is enforced

The interesting part of this project is that the guarantees are structural, not
prompt-shaped. A model told to behave is not a safety control.

**Emergencies never reach the model.** `lib/chat.ts` matches red flags in code before any
network call — chest pain together with breathlessness, stroke signs, bleeding that will not
stop, seizures, self-harm. Those short-circuit straight to an emergency banner. Each pattern
requires several independent signals to match, so "my gums bleed when I brush" does not trip
the alarm.

**A hallucinated doctor cannot reach the UI.** The model never writes a doctor or test name
in prose. It returns doctor ids and test codes; `app/api/chat/route.ts` resolves them against
Postgres and silently drops anything that does not exist.

**Medication advice voids the answer.** The prompt forbids it, but a prompt is not a control.
`mentionsMedication()` scans the reply, the assessment and every next step for drug names and
doses; one hit and the entire response is discarded rather than shown with the drug edited
out. The user gets the degraded fallback instead.

**The model does not get to invent hospital facts.** Ask about parking or visiting hours and
an early version confidently made up both. Questions that are not about symptoms now return a
fixed, server-written reply pointing at reception. The model is trusted with judgement about
symptoms, never with facts it has no source for.

**Nothing is silently forced into a department that does not fit.** Dental, paediatric and
other complaints with no desk in the hospital are marked out of scope: the reply says so
plainly and routes through General Medicine for an onward referral, rather than pretending an
Orthopaedics booking was the answer.

**The model is given meanings, not just names.** `specialties.sees` and `tests.ordered_for`
describe in plain language what each desk handles and what each test is routinely ordered
for. Without them a small model picks by vibe — an early version suggested Gynaecology for a
headache. Tests are chosen by code (`MRI-BR`, `CBC`) rather than row number, because small
models ground poorly on bare integers.

**Both API routes are rate limited** — 20 chat messages and 5 bookings per hour per IP,
counted in Postgres rather than Redis so there is no second service to run.

**A consultation slot belongs to one patient.** A partial unique index on `(ref_id, slot)
WHERE kind = 'doctor'` lets the database arbitrate, rather than a check-then-insert that
would still let two simultaneous requests through. Labs run tests in parallel, so the
constraint is deliberately scoped to consultations and not to every booking.

## Stack

Next.js 16 (App Router) · Neon Postgres · Featherless AI · Tailwind v4.
Three runtime dependencies: `next`, `react`, `@neondatabase/serverless`.

No AI SDK — Featherless is OpenAI-compatible and the client is 50 lines. No ORM, no
component library, no state manager.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL and FEATHERLESS_API_KEY
npm run db:reset               # applies db/schema.sql then db/seed.sql
npm run dev
```

`DATABASE_URL` comes from any Postgres; on Vercel, `vercel integration add neon` provisions
one and writes it for you. `FEATHERLESS_API_KEY` comes from
[featherless.ai](https://featherless.ai).

The default model is `Qwen/Qwen2.5-14B-Instruct` — ungated and reliable at holding the JSON
contract. Override with `FEATHERLESS_MODEL`. Note that `meta-llama/*` models are
HuggingFace-gated and return 403 unless your Featherless organisation is linked.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build |
| `npm run db:reset` | Drop, recreate and reseed every table |
| `npm test` | Red-flag matching and model-output parsing |

## Schema

```
specialties(name, department, sees)          -- what each desk actually handles
doctors(id, name, specialty → specialties, qualification, consult_fee, avail_days, bio)
labs(id, name, kind 'in_house'|'partner', address, phone)
tests(id, name, code, lab_id → labs, price, prep_notes, turnaround_hours, ordered_for)
bookings(id, kind 'doctor'|'test'|'referral', ref_id, patient_name, phone, slot, ref_code)
api_hits(ip, route, at)                      -- rate-limit window
```

Anything the in-house lab does not run is referred to a partner centre. Those tests book as
`kind='referral'` and the card says where you are being sent, so the external fallback is
visible rather than a dead end.

## Testing

`npm test` covers the parts that must not break: that red flags fire on real emergencies, that
they stay quiet on ordinary complaints, that medication advice is caught wherever it hides in
the response, and that model output survives markdown fences, prose padding and malformed id
lists.

The rate-limit boundary is verified by hand against a live database rather than in `npm test`
— it needs real Postgres, and the off-by-one it once had is now documented at the query
itself in `lib/db.ts`.

## It asks before it answers

A triage nurse asks questions, so the assistant does too. When an answer would genuinely
change the department, the urgency or which tests are worth doing, it returns a `question`
instead of a recommendation — three to five concrete options, rendered as buttons, with a
**Something else — let me type it** escape hatch so the widget is never a dead end.

The options are where it shows it knows how symptoms travel: a bowel complaint gets asked
about blood, vomiting and fever; a headache gets asked about vision changes and duration.
`extractJson` enforces that asking and answering are mutually exclusive — a response that
tries to do both has its recommendation stripped, because recommending while still asking is
a contradiction. It commits after two rounds. Answered questions stay on screen as a record
but stop being clickable.

## The reply streams

The route returns newline-delimited JSON: `reply` events carrying the prose as it generates,
then one `done` event with the finished, DB-hydrated answer. Because the model writes
`reply` first, text starts appearing at ~3s instead of ~7s, and the cards arrive when the
rest of the object finishes.

`partialReply()` pulls the reply out of JSON that is still being written — it handles escaped
quotes, newlines, and a backslash that arrives as the last byte of a chunk. Every path,
including the emergency short-circuit and the rate limiter, emits the same event shape, so
the client has one code path for all of them.

## The conversation stays on the device

People remember symptoms in pieces — "I forgot to say the vision goes blurry too" is the
normal case, not the exception. Follow-ups are treated as additions to the picture rather
than a fresh start: the last six exchanges go back to the model, and each of its own turns
carries a `[previously recommended: ...]` line so it builds on the department and tests it
already settled on instead of quietly contradicting them.

The transcript is held in `localStorage` and nowhere else. `app/api/chat/route.ts` writes
nothing to the database — the only rows a chat produces are rate-limit counters keyed by IP.
**Clear** removes the stored key outright, and a conversation of one greeting is never
written at all, so clearing genuinely leaves nothing behind.

**Save for your doctor** produces a one-page summary: the patient's own words in order, then
what the assistant made of them, headed by a notice that it is patient-reported, unreviewed
by any clinician, and not a medical record. It is the browser's own print-to-PDF — a
`.print-sheet` element and a `@media print` block that hides its siblings, no PDF library.

## Not built

No patient accounts, no booking history page, no real availability calendar (slots are
generated), no server-side chat storage, no streaming. This is a demo; each of those is a
deliberate omission rather than an oversight.

## Disclaimer

Fictional hospital, fictional doctors, seeded data. This is a demonstration of a triage and
booking flow, not a medical device. Its urgency ratings and assessments are illustrative and
should not be relied on by anyone deciding whether to seek care.
