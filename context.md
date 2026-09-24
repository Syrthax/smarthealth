# smarthealth: codebase context

A demo hospital website for the fictional **Meridian Health City** (Bengaluru). The core feature
is a chat widget in the bottom-right corner, a *preliminary health assistant*. A visitor
describes symptoms. The assistant says what the pattern is commonly investigated for, how urgent
it looks, and which department and tests fit. The visitor can then book them in one click.

The README is the design doc and explains the *why* behind each safety decision. Read it before
changing anything in the chat pipeline.

## Stack

- **Next.js 16.3 (App Router) + React 19.2**, Tailwind v4, TypeScript. Next 16 differs from
  older versions. Check `node_modules/next/dist/docs/` before using a Next API (see `AGENTS.md`).
  - `searchParams` is a **Promise** (`await searchParams`). Pages use the global
    `PageProps<"/route">` / `LayoutProps<"/">` helper types.
  - `next.config.ts` sets `turbopack.root = __dirname` because the parent dir `~/projects`
    holds unrelated projects.
- **Neon Postgres** via `@neondatabase/serverless` tagged-template `sql`. No ORM.
- **Featherless AI** (OpenAI-compatible) through a hand-written streaming client. No AI SDK.
  Default model is `Qwen/Qwen2.5-14B-Instruct`. `meta-llama/*` returns 403 on this account
  (HF-gated).
- **Gemini Live** (`gemini-3.8-live`) for voice, over the browser's raw WebSocket with a
  server-minted single-use token. No Gemini SDK.
- Only three runtime deps: `next`, `react`, `@neondatabase/serverless`. Keep it that way. No
  component library, no state manager, no PDF library.
- `tsconfig` has `allowImportingTsExtensions`: lib modules import each other as `./x.ts` so
  `node --test` can load them directly. Use `import type` for type-only imports there, or Node's
  type stripping fails at runtime.

## Commands

```bash
npm run dev        # :3000
npm run build
npm run lint
npm test           # node --test, imports lib/chat.ts directly (needs Node with TS type-stripping; local is v25)
npm run db:reset   # DROPs and recreates every table, then seeds. Destructive.
npm run db:migrate # applies db/migrate.sql (additive, idempotent). Safe on live data.
```

Env (`.env.local`, see `.env.example`): `DATABASE_URL`, `FEATHERLESS_API_KEY`, `GEMINI_API_KEY`
(Vercel names it `Gemini_API`; both are read), `Password` (site gate), and optionally `FEATHERLESS_MODEL`, `GEMINI_LIVE_MODEL`, `VOICE_SIGNING_SECRET`.

## File map

| Path | Role |
|---|---|
| `lib/chat.ts` | The brain, all pure functions. `redFlag()` emergency regexes, `systemPrompt()`, `mentionsMedication()`, `extractJson()` (parses and sanitises model output), `partialReply()` (pulls the `reply` string out of half-streamed JSON), shared types `Doctor`/`Test`/`Specialty`/`Question`/`Assessment`, `EMERGENCY_LINE`. |
| `lib/featherless.ts` | `callFeatherless(system, messages, onDelta)` streams SSE with a 20s timeout, 2 attempts, `response_format: json_object`, temp 0.3, 500 max tokens. Returns the raw string or `null`. |
| `lib/db.ts` | `sql` client (placeholder URL so `next build` works without env), `overLimit()` Postgres sliding-window limiter (returns `false` or seconds until retry), `tooMany()` 429 helper, `clientIp()`, `rows<T>()`. |
| `lib/booking.ts` | **The only booking implementation.** `validateFields`, `findItem` (lab decides test vs referral), `checkBooking` (no write), `book` (idem replay → rate limit 5/hr → check → insert, `23505` → slot_taken). Returns canonical `BookingConfirmation`. Deps injectable for tests. |
| `lib/slots.ts` | Slot values `"YYYY-MM-DD HH:MM"` in Asia/Kolkata, `upcomingSlots(n, availDays)`, `slotProblem()`, `slotLabel()`. Shared by dialog, server and voice. |
| `lib/pending.ts` | HMAC-signed voice booking proposals; the nonce becomes `bookings.idem_key`. 10-minute expiry. |
| `lib/voice.ts` | Voice agent contract: `TOOL_DECLARATIONS`, `SERVER_TOOLS`, `voiceInstruction()`, `patientAgreed()` (consent from the patient's transcript), `medicationBreach()`. Pure. |
| `lib/guard.ts` | Injection screen (`injectionAttempt`, run on raw text after the red-flag check), `neutralise()` for user messages, `leaksPrompt()` (voids a reply in `extractJson`), off-topic strikes: `OFF_TOPIC_REPLIES` (3 lines, the third ends the conversation) and `nextStrike(history)` counted from the transcript. `FRONT_DESK` intro. |
| `lib/voice-actions.ts` | `runAction()` for server tools: test options/cost, doctor options, slots, prepare/confirm booking. DB-authoritative, `{ok:false, code, message}` failures. |
| `app/api/voice/session/route.ts` | Rate limit 6/hr, mints an ephemeral token via REST `auth_tokens` with `bidiGenerateContentSetup` (the REST name; `liveConnectConstraints` is rejected) locking model, instruction and tools. Returns `{token, setup}`. |
| `proxy.ts` | Next 16's middleware. Gates **every** path (incl. `/_next`) behind the `Password` env; unauthenticated pages get an inline HTML sign-in page, APIs a 401. Open: `/api/login`, `/api/logout`. No password → prod locked, dev unlocked. |
| `lib/auth.ts`, `lib/session.ts` | Signed 7-minute absolute session cookie (`mhc_session`, HttpOnly) + readable `mhc_session_exp` for the page timer. Key derived from the password. |
| `app/api/login/route.ts`, `app/api/logout/route.ts` | Form POST sign-in (10 tries / 15 min per IP, 303 back with `?auth=wrong|locked`), sign-out clears both cookies. |
| `components/session-lock.tsx` | Nav countdown + Lock button; full-page navigation to `/api/logout?reason=expired` at expiry. |
| `app/api/voice/action/route.ts` | Whitelisted server tools only, 60/hr, 429 + Retry-After when limited. |
| `components/voice-session.ts` | Browser engine: WebSocket, AudioWorklet mic capture (16 kHz), 24 kHz playback, red-flag gate on input transcript, playback hold until screened, medication gate on output transcript, tool dispatch. |
| `app/api/chat/route.ts` | POST handler that responds with **NDJSON**. Order: validate, rate limit (20/hr), red-flag short-circuit, load doctors/tests/specialties, stream the model, `extractJson`, hydrate ids/codes from DB, emit `done`. |
| `app/api/book/route.ts` | Thin adapter: maps the dialog's `{kind, refId}` to an item and calls `book()`. Returns `{refCode, booking}`; failures `{error, code}`, 409 slot taken, 429 via `tooMany()`. |
| `app/page.tsx`, `app/doctors/page.tsx`, `app/labs/page.tsx` | Server components (`force-dynamic`) that query Postgres directly. `/doctors?specialty=X` filters. |
| `app/layout.tsx` | Nav, footer, and `<ChatWidget/>` mounted on every page. IBM Plex fonts. |
| `components/chat-widget.tsx` | Client. Chat panel, `askAssistant()` stream reader (used by text *and* voice's `assess_symptoms`), id-based `upsert`, `localStorage` transcript (`mhc.chat`), question cards, urgency bar, `PendingCard`/`BookingCard`, `VoiceBar`, voice tool dispatch (`runTool`), consent-checked `confirmPending`, print-to-PDF `TranscriptSheet`. |
| `components/rec-card.tsx` | Client. `DoctorCard`, `TestCard`, `BookingDialog` (native `<dialog>`, slots from `lib/slots.ts`, doctor's days only). Dispatches `mhc:booked` (`BOOKED_EVENT`) with the canonical confirmation. Remembers name/phone in `localStorage` (`mhc.patient`). |
| `db/schema.sql`, `db/seed.sql` | Schema plus fictional seed data (12 specialties, 14 doctors, 3 labs, 22 tests). |
| `scripts/db.mjs` | Applies schema then seed (or `migrate` → `db/migrate.sql` only) by naively splitting on `;\n`. Seed strings must never contain `;` followed by a newline. |
| `test/chat.test.mjs` | Tests for red flags (positive and negative), extractJson robustness, medication voiding, partialReply streaming edge cases, question-vs-answer exclusivity. |
| `test/booking.test.mjs` | Slots, booking service and voice actions against a fake `sql` tag; pending token tamper/expiry. |
| `test/voice.test.mjs` | Consent parsing, spoken medication gate, closed tool contract, shared emergency answer. |

## Data model

```
specialties(name PK, department, sees)       -- `sees` = plain-language scope, fed to the model
doctors(id, name, specialty→specialties, qualification, department, consult_fee, avail_days, bio)
labs(id, name, kind 'in_house'|'partner', address, phone)
tests(id, name, code, lab_id→labs, price, prep_notes, turnaround_hours, ordered_for)
bookings(id, kind 'doctor'|'test'|'referral', ref_id, patient_name, phone, slot, ref_code UNIQUE, idem_key UNIQUE NULL, created_at)
  UNIQUE (ref_id, slot) WHERE kind='doctor'  -- one patient per consultation slot; labs are parallel
api_hits(ip, route, at)                      -- rate-limit log
```

- `bookings.ref_id` is polymorphic: a doctor id, or a test id for `test`/`referral`. It has no
  FK, so the booking route checks that the row exists.
- Tests at partner labs book as `kind='referral'`. The server decides this from the lab; the
  client's `kind` is not trusted.
- `slot` holds the canonical value (`2026-09-25 09:30`), never a display label.
- `doctors.department` duplicates `specialties.department`. Keep them in sync when seeding.

## Chat pipeline invariants (do not break these)

These guarantees are enforced **in code, not by the prompt**. That is the point of the project.

1. **Emergencies never reach the model.** `redFlag()` runs on the latest user message before any
   LLM call. Each entry needs *every* regex in `all` to match, which avoids false alarms (e.g.
   "gums bleed when I brush"). When adding a pattern, add both a positive and a negative case to
   the tests.
2. **The model never names doctors or tests in prose.** It returns `doctorIds` and `testCodes`.
   The route hydrates them from DB rows and silently drops unknown ones. Tests are chosen by
   **code** (e.g. `MRI-BR`), not id, because small models ground poorly on integers.
3. **Any medication mention voids the whole answer.** `extractJson` returns `null` when
   `mentionsMedication` hits the reply, assessment, next steps, or question options. The user
   then gets the degraded fallback. Never "redact and show" instead.
4. **Non-medical questions get a fixed server-written reply.** The condition is
   `outOfScope && no doctors`. The model is never trusted with hospital facts such as hours or
   parking. For a medical complaint with no matching desk (dental, paediatric, ...), the model
   sets `outOfScope` and routes via General Medicine.
5. **Asking and answering are mutually exclusive.** If `question` is present (with at least 2
   valid options), `extractJson` blanks assessment, nextSteps, doctorIds, and testCodes. The
   prompt takes a history first — how long, when/triggers, companion symptoms — skipping what
   is already known, and caps questioning at 3 rounds. The conclusion names 1–3 conditions it
   *could* be (always hedged), with reasons drawn only from what the visitor said. In voice,
   Gemini asks those three history questions itself (no model round-trip per question), then
   calls `assess_symptoms` once; Featherless still makes the call.
10. **Health only, and the visitor's words are never instructions.** Non-health talk (`offTopic`
   from the model, or an `injectionAttempt`) gets a server-written line; three in a row ends the
   conversation (`done.ended`, the widget swaps the composer for "Start a new conversation").
   In voice the count lives in the widget (`off_topic` tool, and the injection gate in
   `voice-session.ts` that drops the reply unplayed); `endAfterReply()` closes the session once
   the goodbye has been heard. Both modes open with the front-desk introduction.
6. **One event shape for every path.** The route emits `{"t":"reply","v":<text so far>}`
   (cumulative, not a delta) and then exactly one `{"t":"done", reply, urgency, nextSteps,
   doctors, tests, ...}`. Emergency, rate-limit, degraded, and error paths emit a lone `done`.
   The client depends on this. Flags on `done` include `emergency`, `degraded`, `rateLimited`,
   `outOfScope`, and `question`.
7. **The server stores no chat.** The chat route writes only `api_hits` rows. The transcript
   lives only in the browser's `localStorage`. "Clear" removes the key, and a lone opener is
   never persisted.
8. **Urgency** from the model is `routine|soon|urgent` (anything else coerces to `routine`).
   `emergency` exists only on the client and is set by the red-flag path.

9. **Voice: Gemini is the interface, the server is the authority.** Medical judgement only via
   `assess_symptoms` → `/api/chat`. Facts only from tool results. Bookings are two-phase
   (`prepare_booking` writes nothing; `confirm_booking` needs a Confirm press or a "yes" in the
   patient's own transcript after the proposal, and a valid signed token). The model sees a
   short pending id, never the token. Red flags are screened on every input transcript
   fragment in the browser and end the session; the fixed emergency answer is spoken by
   `speechSynthesis`, not the model.

Conversation memory: the client sends the last 12 messages (6 exchanges, each truncated to 1500
chars). Assistant turns are rewritten by `forModel()` to append
`[previously recommended: departments…; tests…; urgency…]` so the model builds on earlier
decisions. The system prompt refers to this marker. Change both together.

## Conventions

- **`ponytail:` comments** mark deliberate shortcuts that come with an upgrade path (Postgres
  rate limiter instead of Redis, generated slots, naive SQL split, placeholder DB URL). Respect
  them, and use the same tag for new intentional shortcuts.
- Comments explain *why*. They are prose-y and opinionated. Match that density.
- Styling uses Tailwind v4 `@theme` tokens in `app/globals.css`: `paper`, `surface`, `ink`,
  `muted`, `rule`, `accent`, `alert`, `warn`, `success` (+ `-wash`), and radii `rounded-ctl`
  (6px) / `rounded-card` (8px). Use tokens, not raw colours. The look is clinical and calm: no
  gradients, and colour never carries meaning alone. Custom animation classes are `rise-in`,
  `panel-in`, `spin`, and `caret`. Print styles are `.print-sheet` and `.avoid-break`.
- Copy uses British/Indian English ("paediatric", "practise"), a calm triage-nurse voice, and ₹
  prices.
- Phone numbers: Emergency `+91 80 4000 1000` (`EMERGENCY_LINE` in `lib/chat.ts`) and Reception
  `+91 80 4000 1200`. The reception number is **hardcoded** in several places (chat route,
  prompt, widget, layout footer). Update all of them if it changes.
- Pages count things by querying the DB, never with hardcoded claims.

## Known rough edges

- If a Featherless attempt fails mid-stream and retries, the route's `sent` guard only emits text
  longer than what was already sent. The retried reply therefore won't visibly restart until it
  outgrows the first partial.
- Slots are validated against the generator's rules (clinic times, no Sundays, the doctor's
  days, 14-day horizon), not real availability. Double-booking is prevented only by the unique index.
- Rate limiting is verified by hand against live Postgres, not in `npm test`. See the off-by-one
  note in `lib/db.ts`. `book()`'s use of the limiter is covered with a fake.
- Voice red-flag and medication gates are best-effort in realtime: the native-audio model hears
  the patient directly, and audio already played cannot be recalled. See README "What voice
  guarantees". Consent/emergency flows need a manual browser test; they have no automated
  end-to-end coverage.
- No Gemini session resumption. A reconnect is a fresh session seeded with a text summary.

## Deliberately not built

Patient accounts, booking history, a real availability calendar, and server-side chat storage.
All data is fictional. This is a demo, not a medical device.
