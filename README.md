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

**Every costly or mutating route is rate limited** — per IP, counted in Postgres rather than
Redis so there is no second service to run: 20 chat messages, 5 bookings (dialog and voice
share the one budget), 6 voice sessions and 60 voice lookups an hour. Audio frames are never
counted; sessions and actions are. Refusals are a 429 with `Retry-After` and
`rateLimited: true` everywhere except the chat stream, which keeps its one `done` event.

**A consultation slot belongs to one patient.** A partial unique index on `(ref_id, slot)
WHERE kind = 'doctor'` lets the database arbitrate, rather than a check-then-insert that
would still let two simultaneous requests through. Labs run tests in parallel, so the
constraint is deliberately scoped to consultations and not to every booking.

## Voice mode

**Talk instead** in the widget starts a Gemini Live session: you speak, it answers aloud,
looks up tests and prices, and books — with the same card appearing on screen as it reads
the reference out. It is not speech-to-text glued to the chat. The model is an agent with
nine explicit tools, and none of them is "run a query".

**Gemini is the conversational interface. The server is the authority.** The model may ask
for an action; `/api/voice/action` decides whether it is valid; the database decides whether a
booking happened; the page and the voice both report that one result.

- **The key never reaches the browser.** `/api/voice/session` mints a single-use token with
  the model, the system instruction and the tool list *locked into it*. The browser then
  talks to Gemini directly (Next route handlers cannot hold a WebSocket, and proxying audio
  would add a hop to every word). A page edited in devtools can send a different system
  prompt; it is ignored — verified against the live API.
- **The voice model takes the history; it does not draw the conclusion.** It asks how long,
  when, and what else — conversationally, with no model round-trip per question — then calls
  `assess_symptoms`, which is `/api/chat` unchanged: red flags, medication voiding,
  ask-before-answer, DB-hydrated cards. It relays that answer; it does not form its own.
- **Facts come from rows.** Prices, fees, doctors, labs, prep notes and slots are only ever
  tool results. Unknown codes and ids are refused, never approximated. Hospital facts
  (hours, parking) get the same fixed reply as text chat.
- **One booking implementation.** `lib/booking.ts` is the only place a booking is validated
  and written; the dialog and the agent both call it, and both get back the same
  `BookingConfirmation`. Whether a test is a referral is decided by its lab, not by the caller.
- **Nothing is booked without a yes.** `prepare_booking` validates and returns a signed
  proposal but writes nothing; the card appears on screen. `confirm_booking` runs only if you
  press Confirm or say yes *in your own transcribed words, after the proposal was made* — the
  model reporting that you agreed is not agreement. The server re-checks everything at write
  time. The model never sees the signed token, only a short id, so it cannot swap the slot or
  phone number between the read-back and the booking.
- **Retries cannot double-book.** The proposal's nonce is stored as `bookings.idem_key`. A
  reconnect, a duplicated tool call or a second "yes" returns the booking already made, and
  does not spend another of the five an hour.
- **It talks like a person at the desk.** It answers in the language of your latest message
  (English, then Hindi, then English again if that is how you speak), in an Indian accent and
  a relaxed register, and it stops when you start talking. Background noise that cuts it off
  without anyone speaking is noticed in the page, which asks it to pick up where it left off.
- **It works things out.** "The earliest appointment with Dr. Rao" is one lookup: doctors can
  be found by name, and `get_slots` returns only slots that are still free for that doctor,
  soonest first, optionally narrowed to a day or a morning/afternoon. It then proposes that
  one slot — and still waits for your yes.
- **Advice is offered, not imposed.** Recommendations are phrased as suggestions the patient
  may take or leave; only an emergency is stated as an instruction. When it does not know
  something, it says so instead of filling the silence.
- **It never says "booked" unless the insert succeeded.** A taken slot, a rate limit or an
  error comes back as `ok: false` with a sentence to say aloud, and the card shows it too.

### What voice guarantees, and what it cannot

Text chat can promise that an emergency never reaches the model. A native-audio model hears
you directly, so voice cannot — and this README would rather say so than pretend. What holds:

- Every fragment of your transcribed speech runs through the same `redFlag()` as text. A hit
  ends the session on the spot and shows the fixed emergency answer, read aloud by the
  browser's own speech synthesis — never by the model.
- The model's reply to each turn is held back until your words have been screened (or 700 ms
  pass, since transcription can lag). So what it would have said to an emergency is normally
  never played.
- Its own transcript is checked as it speaks. A medicine or dose the server did not say first
  stops playback, drops the rest of the turn and replaces it with a withdrawal note. A drug
  word the server *did* say — "stop antihistamines 72 hours before" is a real prep note —
  may be relayed. Audio that has already played cannot be unsaid; the gate bounds it to a
  fragment, not to zero.

- The red-flag, medication, injection and disclaimer patterns are written in English. When
  you speak another language the agent passes `assess_symptoms` an English account of what
  you said, so the server's red-flag check and the assessment still read it — but the
  in-browser gates on each transcript fragment do not match Hindi words. In another language
  an emergency is caught at the assessment step, or by the agent's own instruction to send
  you to the emergency line, not on the first syllable.

The transcript is text in `localStorage`, like typed chat. Audio is never stored.

## Staying on topic, and not being talked out of it

The assistant is a front desk and introduces itself as one — in text and in voice, the first
words are always "Hello, you've reached the front desk at Meridian Health City". It helps with
health and nothing else. Talk about your car and it says so, kindly; keep going and it says so
more firmly and warns; a third time in a row and it says goodbye and closes the conversation.
The three lines are server-written, never repeated, and counted in code — the transcript
carries the count, so the server holds no state. A health question in between resets it.

Prompt injection is handled without a library (the available ones are remote APIs that would
see every patient message, and are heuristic anyway). The layers, all code:

- `lib/guard.ts` refuses obvious override attempts — "ignore your instructions", "reveal your
  prompt", "you are now…", role markers like `system:` or `<|im_start|>`, forged
  `[previously recommended]` lines, spoken "notes from the page" — before any model sees
  them. They count as an off-topic strike. The emergency check still runs first.
- Role markers are stripped from every visitor message on its way to a model.
- A reply that recites the system prompt is voided, like one that names a drug.
- Both prompts treat the visitor's words as information, never instructions.
- Underneath, the structural limits hold whatever a model is talked into: a closed tool list,
  prices and bookings only from Postgres, output parsed against a schema.

## Access

The whole site sits behind one shared password (`Password` in Vercel). `proxy.ts` runs in
front of every request — pages, JavaScript bundles and APIs — and without a valid session it
serves a self-contained sign-in page instead, so none of the app is handed out beforehand.
A session lasts exactly 7 minutes from sign-in, enforced by a signed HttpOnly cookie on the
server; the page counts down in the nav and locks itself when time is up. Sign-in attempts
are rate limited, and changing the password signs everyone out.

## Project layout

```
app/                    Next.js App Router: pages and API routes
  api/chat/             symptom assessment, streamed as NDJSON
  api/book/             booking from the site's cards
  api/voice/            Gemini Live token minting + server tools for the voice agent
  api/login, logout/    the password gate
components/
  chat/                 the chat widget: state (chat-widget), wire (assistant), cards, print sheet
  voice/                Gemini Live browser engine and the voice-mode visualiser
  rec-card.tsx          doctor/test cards and the booking dialog, shared by pages and chat
  session-lock.tsx      nav countdown for the signed-in session
lib/                    pure server/shared logic, no React — this is where the safety rules live
  chat.ts               red flags, system prompt, model-output parsing and voiding
  guard.ts              injection screen, off-topic strikes
  booking.ts, slots.ts  the one booking implementation and slot rules
  voice.ts, voice-actions.ts, pending.ts   voice tool contract, server tools, signed proposals
  db.ts, featherless.ts, auth.ts, session.ts
db/                     schema.sql, seed.sql (fictional), migrate.sql
scripts/db.mjs          applies the SQL files
test/                   node --test suites; they import lib/*.ts directly
proxy.ts                Next 16 middleware: gates every path behind the password
```

`context.md` has a file-by-file map and the invariants the chat pipeline must keep. Read it,
and the safety sections above, before changing anything under `lib/` or `app/api/`.

## Contributing

1. `npm install`, then set up `.env.local` as in [Running it](#running-it). Never commit it;
   `.env*` is git-ignored apart from `.env.example`.
2. Work on a branch and open a pull request against `main`.
3. Before pushing: `npm run lint`, `npx tsc --noEmit` and `npm test` should all be clean.
4. Safety rules are enforced in code, not by the prompt. If you add a red-flag pattern, add a
   positive *and* a negative test case. Keep the runtime dependencies at three.
5. This is Next.js 16: `searchParams` is a Promise and middleware lives in `proxy.ts`. Check
   `node_modules/next/dist/docs/` before reaching for a Next API from memory.

## Stack

Next.js 16 (App Router) · Neon Postgres · Featherless AI · Gemini Live · Tailwind v4.
Three runtime dependencies: `next`, `react`, `@neondatabase/serverless`.

No AI SDK — Featherless is OpenAI-compatible and the client is 50 lines. Gemini Live is spoken
to over the browser's own WebSocket with an AudioWorklet for the microphone; the protocol is
JSON frames and did not justify a package. No ORM, no component library, no state manager.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL, FEATHERLESS_API_KEY, GEMINI_API_KEY
npm run db:reset               # applies db/schema.sql then db/seed.sql
npm run dev
```

Upgrading a database that already holds bookings? `npm run db:migrate` applies the additive,
repeatable changes in `db/migrate.sql` (currently the `idem_key` column) without dropping anything.

`GEMINI_API_KEY` comes from [Google AI Studio](https://aistudio.google.com). Voice is optional:
without the key the widget says voice is unavailable and text chat works as before.

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
| `npm run db:migrate` | Apply `db/migrate.sql` to an existing database, dropping nothing |
| `npm test` | Red flags, model-output parsing, the booking service, voice tools and consent |

## Schema

```
specialties(name, department, sees)          -- what each desk actually handles
doctors(id, name, specialty → specialties, qualification, consult_fee, avail_days, bio)
labs(id, name, kind 'in_house'|'partner', address, phone)
tests(id, name, code, lab_id → labs, price, prep_notes, turnaround_hours, ordered_for)
bookings(id, kind 'doctor'|'test'|'referral', ref_id, patient_name, phone, slot, ref_code, idem_key)
api_hits(ip, route, at)                      -- rate-limit window
```

Anything the in-house lab does not run is referred to a partner centre. Those tests book as
`kind='referral'` and the card says where you are being sent, so the external fallback is
visible rather than a dead end.

## Testing

`npm test` covers the parts that must not break: that red flags fire on real emergencies, that
they stay quiet on ordinary complaints, that medication advice is caught wherever it hides in
the response, and that model output survives markdown fences, prose padding and malformed id
lists. The booking service and the voice tools run against a fake `sql` tag: prices and fees
equal the row, unknown items are refused, partner labs become referrals, a taken slot or a
rate limit never yields a confirmation, and one idempotency key makes exactly one booking.

Voice itself is tested by hand in a real session (realtime model behaviour is not a unit
test): ask a price, book, confirm, check the row, the card and the spoken reference agree;
deny the microphone; drop the network; try a taken slot; say a red-flag phrase.

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
a contradiction. It takes a short history first — how long, when it happens or what sets it
off, and the companion symptoms that travel with the complaint — skips anything already said,
and commits after three rounds. The answer then names what it *could* be, why (in the
visitor's own details, never invented ones), who to see, how soon, and what to prepare. Answered questions stay on screen as a record
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
generated — though a doctor is now only offered on the days they sit), no server-side chat
or voice storage, no Gemini session resumption (a reconnect starts a fresh session and hands
it a short summary of what is on screen). This is a demo; each of those is a
deliberate omission rather than an oversight.

## Disclaimer

Fictional hospital, fictional doctors, seeded data. This is a demonstration of a triage and
booking flow, not a medical device. Its urgency ratings and assessments are illustrative and
should not be relied on by anyone deciding whether to seek care.
