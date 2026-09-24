# smarthealth — Next Tasks / AI Agent Handoff

> **Purpose:** This file is the implementation specification for the next AI coding agent.  
> **Scope:** Extend the existing Meridian Health City demo with Gemini Live voice interaction, agentic voice actions, shared booking state between voice and web UI, and stronger API/site rate limiting.
>
> **Important:** This is a fictional hospital demo, not a medical device. Preserve the existing safety architecture and do not turn the voice layer into an independent medical decision-maker.

---

## 0. Read Before Changing Anything

Before writing code:

- [ ] Read `README.md` completely. It is the design document and explains the safety decisions.
- [ ] Read `AGENTS.md` completely.
- [ ] Inspect the current implementation of:
  - `lib/chat.ts`
  - `lib/featherless.ts`
  - `lib/db.ts`
  - `app/api/chat/route.ts`
  - `app/api/book/route.ts`
  - `components/chat-widget.tsx`
  - `components/rec-card.tsx`
  - `db/schema.sql`
  - `db/seed.sql`
  - `test/chat.test.mjs`
- [ ] Check Next.js 16.3 local documentation under `node_modules/next/dist/docs/` before using or changing a Next.js API.
- [ ] Do not replace the existing architecture with an AI SDK, ORM, component library, or state-management framework without an explicit reason.
- [ ] Keep the current dependency philosophy: small, focused, and understandable.

The current project is a Next.js 16.3 + React 19.2 + TypeScript application using Neon Postgres and a hand-written Featherless streaming client. The current chat/book routes already have server-side rate limiting. fileciteturn0file0L21-L49 fileciteturn0file0L85-L103

---

# 1. Current System Context

## Product

**Meridian Health City**, Bengaluru — fictional hospital demo.

The existing product is a preliminary health assistant:

1. Visitor describes symptoms.
2. Assistant explains what the pattern is commonly investigated for.
3. Assistant indicates urgency.
4. Assistant recommends relevant department and tests.
5. Visitor can book recommended doctors/tests.

The current system deliberately keeps important decisions and data grounding on the server rather than trusting model-generated prose. fileciteturn0file0L5-L11

## Existing stack

- Next.js 16.3 App Router
- React 19.2
- Tailwind v4
- TypeScript
- Neon Postgres via `@neondatabase/serverless`
- Featherless AI through a hand-written streaming client
- Default model: `Qwen/Qwen2.5-14B-Instruct`
- No ORM
- No AI SDK
- No component library
- No state manager

Keep this architecture unless a new dependency is genuinely required by Gemini Live.

## Existing important files

| File | Responsibility |
|---|---|
| `lib/chat.ts` | Safety logic, model prompt, extraction, shared chat types |
| `lib/featherless.ts` | Featherless streaming client |
| `lib/db.ts` | Postgres client, rate limiter, IP extraction, row helper |
| `app/api/chat/route.ts` | Chat API + NDJSON stream + 20/hr rate limit |
| `app/api/book/route.ts` | Booking API + 5/hr rate limit |
| `components/chat-widget.tsx` | Existing visual chat experience |
| `components/rec-card.tsx` | Doctor/test cards and booking dialog |
| `db/schema.sql` | Database schema |
| `db/seed.sql` | Fictional hospital data |
| `test/chat.test.mjs` | Existing safety/extraction tests |

The current database contains specialties, doctors, labs, tests, bookings, and `api_hits`. Bookings use a polymorphic `ref_id`; doctor booking slots have a uniqueness constraint. fileciteturn0file0L111-L139

---

# 2. New Product Goal

Add a **voice mode** that feels like an extension of the existing assistant rather than a separate product.

The visitor should be able to:

> Speak → receive spoken response → ask about tests/costs → ask for an appointment → confirm → agent performs the booking → website reflects the booking → agent verbally confirms the booking/reference.

Voice mode must be **agentic**.

It must not be implemented as:

> microphone → speech-to-text → existing chat → text-to-speech

That approach does not satisfy the requirement.

Instead, Gemini Live should participate in a controlled realtime interaction where the model can request explicitly defined application actions/tools, while the server remains authoritative over hospital data and booking mutations.

---

# 3. Non-Goals

Do **not** build these unless explicitly requested later:

- [ ] Patient accounts/authentication
- [ ] Full medical records
- [ ] Real hospital integrations
- [ ] Real appointment availability infrastructure
- [ ] Autonomous diagnosis
- [ ] Autonomous emergency triage beyond existing deterministic red-flag handling
- [ ] Long-term server-side conversation storage
- [ ] A general-purpose autonomous agent with arbitrary database access
- [ ] Direct client-side database access
- [ ] A second booking implementation specifically for voice
- [ ] A separate source of truth for test prices or doctor fees

The existing project explicitly describes itself as a fictional demo and deliberately does not have patient accounts, booking history, real availability, or server-side chat storage. fileciteturn0file0L285-L291

---

# 4. Core Architectural Principle

## Voice is another interface, not another backend

There must be **one authoritative application layer** for:

- doctor lookup
- test lookup
- test pricing
- doctor consultation fees
- booking validation
- booking creation
- booking confirmation/reference generation
- rate limiting

The Gemini Live model must never directly mutate Postgres.

Preferred flow:

```text
                   ┌─────────────────────┐
                   │   Gemini Live       │
                   │   realtime voice    │
                   └──────────┬──────────┘
                              │
                         tool request
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Voice/session API   │
                   │ validation boundary │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Application actions │
                   │ / booking service   │
                   └──────────┬──────────┘
                              │
                       validated DB query
                       or mutation
                              │
                              ▼
                   ┌─────────────────────┐
                   │    Neon Postgres    │
                   └─────────────────────┘
```

The browser UI should consume the same authoritative result:

```text
Gemini Live
     │
     └── action result ──► shared client state ──► booking/confirmation UI
                                      │
                                      └── voice confirmation
```

Do not create separate "voice booking logic".

---

# 5. Gemini Live Integration

## P0

Introduce Gemini Live using the project's approved Gemini Live API access.

### Secrets

- [ ] Add the Gemini API credential to server-side environment configuration.
- [ ] Never expose a long-lived Gemini API key in browser JavaScript.
- [ ] Add the variable to `.env.example` with a placeholder.
- [ ] Never commit `.env.local`.
- [ ] Search the codebase before implementation for existing environment/config conventions.
- [ ] Decide whether the browser receives an ephemeral/session-scoped credential or whether the server acts as the Gemini connection boundary.
- [ ] Document the chosen approach in the implementation.

The exact Gemini SDK/package should be chosen only after inspecting the current project and Gemini Live's current API requirements. Do not assume a package name or API shape without verification.

### Session lifecycle

The implementation must explicitly handle:

- connection establishment
- connection failure
- microphone permission denial
- reconnect
- disconnect
- session expiration
- user cancellation
- tool/action errors
- rate-limit errors
- Gemini/API errors

A failed voice connection must fall back cleanly to the existing text chat experience.

---

# 6. Agentic Voice Tool Contract

Gemini Live should have access only to explicit application actions.

It must **not** receive arbitrary SQL/database access.

## Required tools

### 6.1 `get_test_cost`

Purpose:

> Tell the visitor the authoritative cost of a specific test.

Input should identify a test using a stable test code where possible.

Example conceptual input:

```ts
{
  testCode: "MRI-BR"
}
```

Server behavior:

1. Validate input.
2. Look up the test by `code`.
3. Return DB-authoritative:
   - test name
   - code
   - price
   - lab
   - relevant preparation notes
   - turnaround time
4. Never invent a price.

The model may phrase the answer naturally, but the numeric price must originate from the server result.

---

### 6.2 `get_doctor_options`

Purpose:

> Provide available doctor options based on server data.

Input can include specialty/department constraints.

Server returns only real seeded doctors.

The model must not invent:

- doctor IDs
- doctor names
- fees
- specialties
- departments

Existing chat architecture already requires model output to use IDs/codes which are then hydrated from DB rows. Preserve that principle for voice. fileciteturn0file0L161-L165

---

### 6.3 `get_test_options`

Purpose:

> Find tests relevant to an existing recommendation or user request.

Return only tests that exist in the database.

Tests should continue to be addressed by **test code**, not arbitrary integer IDs, because the current architecture intentionally uses codes for reliable model grounding. fileciteturn0file0L161-L165

---

### 6.4 `book_doctor_appointment`

Purpose:

> Book a doctor consultation.

Input must contain enough information to identify:

- doctor
- slot
- patient name
- phone

Server must:

1. Validate every field.
2. Verify doctor exists.
3. Verify slot format.
4. Apply rate limiting.
5. Perform the same booking constraints as the existing `/api/book`.
6. Handle unique violation as "slot taken".
7. Generate/return the authoritative booking reference.
8. Return a canonical booking result.

Do not let Gemini directly insert a row.

---

### 6.5 `book_test`

Purpose:

> Book a test or referral.

Input must identify:

- test code
- patient name
- phone
- requested slot

Server must:

1. Resolve test code to DB row.
2. Determine the correct booking kind.
3. Apply existing validation.
4. Apply rate limiting.
5. Insert booking.
6. Return canonical confirmation/reference.

The existing data model uses `kind='referral'` for tests at partner labs. Preserve this behavior. fileciteturn0file0L135-L139

---

### 6.6 `get_booking_confirmation`

Purpose:

> Retrieve/format the result of the just-completed booking.

Prefer returning the booking result directly from mutation actions so the model does not need to infer it.

Canonical confirmation should contain, as applicable:

```ts
{
  success: true,
  bookingId: string,
  reference: string,
  kind: "doctor" | "test" | "referral",
  itemName: string,
  doctorName?: string,
  labName?: string,
  slot: string,
  patientName: string,
  phoneMasked?: string,
  cost?: number
}
```

The exact shape must be reconciled with the current schema and API implementation before coding.

---

# 7. Booking Confirmation Must Be Canonical

There must be one application-level booking result.

Do not make:

- text booking result
- voice booking result
- visual booking result

into three separate formats.

Use a shared type/service such as:

```ts
type BookingConfirmation = {
  bookingId: string
  reference: string
  kind: "doctor" | "test" | "referral"
  itemName: string
  slot: string
  cost?: number
  doctorName?: string
  labName?: string
}
```

This is illustrative; inspect the current code before finalising the type.

The website should render this same object.

Gemini should receive a serialisable action result derived from this object and verbally communicate the confirmation.

---

# 8. Voice ↔ Website State Synchronisation

## P0

The website must visibly update after a successful voice action.

Example:

```text
User:
"Book the MRI for tomorrow at 10."

Voice agent:
"I can book that. The MRI costs ₹X. Shall I confirm?"

User:
"Yes."

Server:
booking succeeds

Website:
┌────────────────────────────┐
│ Booking confirmed          │
│ MRI                        │
│ Tomorrow · 10:00           │
│ ₹X                         │
│ Ref: MHC-XXXX              │
└────────────────────────────┘

Voice:
"Your MRI is booked for tomorrow at 10 AM.
Your confirmation number is MHC-XXXX."
```

### Requirements

- [ ] Voice action completion emits a canonical client event/result.
- [ ] `ChatWidget` can render booking confirmations initiated by voice.
- [ ] Existing visual booking flow continues to work.
- [ ] A booking made visually is reflected in the current conversation state where appropriate.
- [ ] Do not duplicate bookings when the UI receives an action result.
- [ ] Confirmation must be idempotent on the client.
- [ ] Failed actions must not render as successful bookings.

---

# 9. Explicit Confirmation Before Mutations

The voice agent should not silently book merely because the user asked for information.

Use a confirmation step for consequential booking mutations.

Example:

```text
User:
"How much is the MRI?"

Agent:
"The MRI costs ₹X."

User:
"Book it."

Agent:
"The MRI costs ₹X and I have the next available slot at [slot].
Would you like me to confirm this booking?"

User:
"Yes."

Agent:
[book_test]
```

The exact conversation policy should be encoded in the agent/tool instructions and enforced as much as possible by the server.

Do not treat arbitrary model text such as "yes" as sufficient without preserving the pending-action/session context.

---

# 10. Test Costs and Other Hospital Facts

All prices must come from Postgres.

The voice agent may:

- explain a price
- repeat a price
- compare prices
- include a price in confirmation

But it must never fabricate a cost.

Current test records contain:

- test name
- code
- lab
- price
- preparation notes
- turnaround hours
- `ordered_for`

Use the DB as the source of truth. fileciteturn0file0L119-L125

---

# 11. Existing Safety Invariants — MUST NOT BREAK

These are hard requirements.

## 11.1 Emergency handling

Emergencies must never reach the model.

The existing `redFlag()` runs against the latest user message before an LLM call. Preserve this behavior for voice input.

The voice path must have an equivalent deterministic safety gate before normal agentic interaction.

Do not rely on Gemini's judgement to decide whether a red flag is an emergency.

Existing red-flag behavior is code-enforced and tested. fileciteturn0file0L145-L159

---

## 11.2 No invented doctors/tests

The model may request IDs/codes, but server-side DB hydration remains authoritative.

Unknown entities must be rejected/dropped rather than invented.

---

## 11.3 Medication mentions

The existing system voids the whole answer if medication mentions are detected in relevant generated content.

Do not bypass this safeguard simply because the response is spoken.

Review how `mentionsMedication()` and `extractJson()` interact with the new voice path before implementation. fileciteturn0file0L167-L171

---

## 11.4 Out-of-scope questions

Hospital facts such as hours/parking must remain server-written rather than model-invented.

Preserve the existing out-of-scope behavior. fileciteturn0file0L173-L179

---

## 11.5 Asking vs answering

The existing assistant treats questions and recommendations as mutually exclusive.

Do not allow the new voice agent to circumvent this safety/interaction invariant simply because voice feels conversational.

The current prompt caps questioning at two rounds. fileciteturn0file0L181-L185

---

## 11.6 One source of truth for booking

Voice must call the same validation/mutation path used by web booking.

Do not duplicate the SQL insertion logic.

---

# 12. Rate Limiting

The existing application already has:

- chat: **20 requests/hour**
- booking: **5 requests/hour**
- Postgres `api_hits` sliding-window limiter

The existing rate limiter is in `lib/db.ts`; the chat and booking routes use it. fileciteturn0file0L87-L93

Extend this infrastructure instead of introducing Redis or another rate-limit dependency unless there is a compelling project requirement.

## P0 rate-limit surfaces

Review and protect:

- [ ] `/api/chat`
- [ ] `/api/book`
- [ ] voice session creation/initialisation endpoint, if one exists
- [ ] voice action/tool endpoint, if exposed through HTTP
- [ ] any endpoint that can trigger a costly Gemini Live session
- [ ] any endpoint that can mutate bookings

## Suggested logical limits

Do not blindly copy these numbers into code; inspect current usage first.

| Surface | Initial policy |
|---|---|
| Chat | Existing 20/hour |
| Booking | Existing 5/hour |
| Voice session creation | Separate, stricter session-start window |
| Voice agent actions | Separate action/abuse budget if actions cross HTTP |
| Booking mutation | Existing booking limit remains authoritative |

### Important

A voice conversation can produce many realtime messages without each audio frame becoming an HTTP request.

Do **not** rate-limit every audio packet.

Rate-limit meaningful server actions:

- session creation
- tool/action invocation where appropriate
- booking mutation
- expensive model/session creation

---

# 13. Rate-Limit Identity

Current code uses `clientIp()`.

Preserve that as the baseline.

Possible dimensions:

1. IP
2. session identifier
3. authenticated user — only if accounts are introduced later
4. action-specific key

For the current unauthenticated demo:

```text
ip + route/action
```

is the minimum viable boundary.

Do not trust a client-supplied `userId` as an identity.

If a session ID is introduced, use it only as an additional signal, not as the sole abuse-prevention mechanism.

---

# 14. Rate-Limit Response Semantics

All rate-limited APIs should return a predictable structure.

For HTTP endpoints:

- appropriate HTTP status
- `Retry-After` where practical
- machine-readable `rateLimited`
- human-readable message

For the existing chat NDJSON protocol, preserve the current event shape:

```json
{"t":"done", "...": "...", "rateLimited":true}
```

The client already depends on the `done` event and its flags. fileciteturn0file0L187-L195

For voice:

- agent should receive a structured rate-limit failure
- agent should verbally explain that the action cannot be completed right now
- UI should show the same rate-limit state
- never pretend that a booking succeeded

---

# 15. Voice Session State

Define an explicit session state rather than relying only on UI booleans.

Example conceptual state:

```ts
type VoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "awaiting_confirmation"
  | "executing_action"
  | "confirmed"
  | "rate_limited"
  | "error"
```

The exact state model can differ if the existing UI suggests a better abstraction.

Avoid having independent components each maintain contradictory voice state.

---

# 16. Pending Action / Confirmation State

For consequential operations, maintain an explicit pending action.

Example:

```ts
type PendingAction = {
  type: "book_doctor" | "book_test"
  payload: unknown
  confirmationRequired: true
}
```

The server should validate the action again at execution time.

Never assume:

> "The model asked for booking" = "booking is authorised."

The confirmation flow should make the user's intent explicit.

---

# 17. API / Server Boundaries

A likely structure is:

```text
app/api/
  chat/
    route.ts
  book/
    route.ts
  voice/
    session/
      route.ts        # if required
    action/
      route.ts        # if required
```

But do not create these routes mechanically.

First inspect the Gemini Live API's supported connection architecture.

Prefer the smallest boundary that gives:

- secure Gemini credentials
- server-authoritative actions
- rate limiting
- safe booking mutation
- clean browser integration

---

# 18. Application Service Extraction

If `app/api/book/route.ts` currently owns too much booking logic, extract the reusable business operation.

Possible direction:

```text
lib/
  booking.ts
  voice.ts
  rate-limit.ts   # only if extracting from db.ts improves separation
```

For example:

```ts
bookDoctor(...)
bookTest(...)
getTestCost(...)
getDoctorOptions(...)
getTestOptions(...)
```

Then both:

```text
/api/book
```

and voice actions call the same functions.

Do not create a second implementation of booking.

---

# 19. UI Requirements

## Voice control

Add a clear voice control to the existing chat experience.

States should be visually distinguishable:

- microphone available
- connecting
- listening
- assistant speaking
- processing
- action confirmation
- booking confirmed
- error

Do not rely on colour alone for state meaning.

The existing design system explicitly avoids colour-only meaning and uses clinical/calm styling. fileciteturn0file0L231-L239

## Transcript

Voice conversation should appear in the same conversation surface where practical.

The user should be able to see:

- what they said
- what the assistant said
- relevant tool/action result
- booking confirmation

Do not expose internal tool JSON to the user.

---

# 20. Accessibility

Voice is an additional interface, not the only interface.

Required:

- [ ] Existing text chat remains fully usable.
- [ ] Microphone permission denial does not break the chat.
- [ ] Keyboard users can access voice controls.
- [ ] Visible state labels accompany audio state.
- [ ] Booking confirmation is rendered visually even if voice confirmation succeeds.
- [ ] User can stop speaking/playback.
- [ ] User can continue the booking process through text if voice fails.

---

# 21. Client Storage

Current chat transcript lives in:

```text
localStorage
mhc.chat
```

Patient name/phone are stored in:

```text
localStorage
mhc.patient
```

The server does not store chat transcripts. fileciteturn0file0L197-L201

Do not silently introduce persistent server-side voice transcripts.

If voice transcript synchronisation uses local state, keep the privacy model consistent with the existing application.

Do not persist microphone audio.

---

# 22. Database Changes

Avoid schema changes unless required.

Current schema already supports:

```text
bookings
api_hits
```

and bookings contain:

```text
id
kind
ref_id
patient_name
phone
slot
ref_code
created_at
```

with a doctor-slot uniqueness rule. fileciteturn0file0L125-L129

## If schema changes become necessary

- [ ] Explain why the existing schema cannot support the requirement.
- [ ] Update `db/schema.sql`.
- [ ] Update `db/seed.sql` if necessary.
- [ ] Update reset/seed behavior.
- [ ] Add tests for the new constraint.
- [ ] Do not destroy existing booking compatibility unnecessarily.

---

# 23. Booking Concurrency

The current booking route protects doctor double-booking with a unique constraint.

Do not replace this with a client-side "check then insert" race-prone flow.

Expected pattern:

```text
validate
   ↓
attempt authoritative insert
   ↓
23505?
 ┌─ yes → slot taken
 └─ no  → success
```

The existing project explicitly converts unique violation `23505` into a `409 "slot taken"` response. fileciteturn0file0L91-L93

Voice must expose this failure accurately:

> "That slot was just taken. I couldn't complete the booking."

Never say:

> "You're booked."

unless the DB mutation succeeded.

---

# 24. Idempotency

Voice interactions can reconnect or retry.

Prevent duplicate bookings caused by:

- network retries
- Gemini reconnects
- duplicated tool calls
- user repeating confirmation
- UI event replay

Before implementing a new idempotency mechanism:

1. inspect the existing booking route
2. inspect `ref_code`
3. inspect current constraints
4. determine the smallest safe addition

If a new idempotency key is needed, it should be generated/validated server-side and persisted atomically with the booking.

Do not solve this with a client-only boolean.

---

# 25. Error Handling

Voice must distinguish:

### Informational failure

Example:

> "I couldn't retrieve the test price."

### Validation failure

Example:

> "I need the patient's name before I can book this."

### Booking conflict

Example:

> "That doctor slot is no longer available."

### Rate limit

Example:

> "I can't perform another booking action right now. Please try again later."

### Gemini failure

Example:

> "Voice service is temporarily unavailable. You can continue using the text assistant."

### Emergency

Use the existing deterministic emergency response and emergency line.

Do not allow a generic Gemini error handler to override emergency handling.

---

# 26. Testing Plan

## P0 automated tests

### Existing safety regression

- [ ] Existing `npm test` remains green.
- [ ] Red-flag positive cases remain positive.
- [ ] Red-flag negative cases remain negative.
- [ ] Medication mentions still void responses.
- [ ] Question/answer exclusivity remains intact.
- [ ] `extractJson()` behavior remains intact.

The existing test suite covers red flags, extraction robustness, medication voiding, partial streaming, and question-vs-answer behavior. fileciteturn0file0L107-L107

### Voice action tests

- [ ] Unknown test code rejected.
- [ ] Unknown doctor ID rejected.
- [ ] Test cost always equals DB price.
- [ ] Doctor fee always equals DB value.
- [ ] Invalid booking payload rejected.
- [ ] Successful doctor booking returns canonical confirmation.
- [ ] Successful test booking returns canonical confirmation.
- [ ] Partner lab booking uses `referral`.
- [ ] Slot conflict returns failure.
- [ ] Rate limit returns structured failure.
- [ ] Failed booking never produces a successful confirmation event.

### Confirmation tests

- [ ] Booking requires explicit confirmation where policy requires it.
- [ ] Duplicate action does not create duplicate booking.
- [ ] Voice confirmation and UI confirmation use the same booking result.
- [ ] UI does not show success before server success.

---

# 27. Manual Voice Test Matrix

Test with a real Gemini Live session because realtime model behaviour cannot be treated as deterministic unit-test output.

### Basic

- [ ] "What does this symptom pattern usually get investigated for?"
- [ ] "How much is the MRI?"
- [ ] "Which doctors are available for this specialty?"
- [ ] "What preparation is needed?"

### Booking

- [ ] Ask for test cost.
- [ ] Ask to book.
- [ ] Confirm.
- [ ] Verify DB booking.
- [ ] Verify website confirmation.
- [ ] Verify spoken confirmation.
- [ ] Verify reference matches UI.

### Failure

- [ ] Reject microphone permission.
- [ ] Disconnect network.
- [ ] Reconnect.
- [ ] Force Gemini failure.
- [ ] Attempt a taken slot.
- [ ] Hit rate limit.
- [ ] Try invalid/unknown test.
- [ ] Try invalid/unknown doctor.

### Safety

- [ ] Test an existing red-flag phrase through voice.
- [ ] Confirm it does not proceed into normal agentic booking/medical conversation.
- [ ] Confirm emergency response remains deterministic.
- [ ] Confirm no medication-related safeguard is bypassed.

---

# 28. Rate-Limit Test Matrix

At minimum test:

```text
chat:
  request 1..20 → allowed
  request 21    → limited

booking:
  request 1..5 → allowed according to existing window semantics
  next request → limited

voice:
  repeated session creation → limited
  repeated expensive action → limited if configured
  booking → still subject to booking limit
```

The exact boundary semantics must match the existing `overLimit()` implementation. The current project already notes an off-by-one detail that should be inspected before changing the limiter. fileciteturn0file0L275-L281

Do not "fix" the rate limiter based on assumption. Read the current implementation and tests/manual verification first.

---

# 29. Environment Variables

Expected new configuration should follow the existing `.env.local` / `.env.example` convention.

Likely concept:

```text
GEMINI_API_KEY=...
```

Do not assume the exact variable name if the selected Gemini integration has a project convention.

Rules:

- [ ] Server-only secrets remain server-only.
- [ ] Never log API keys.
- [ ] Never return API keys in JSON.
- [ ] Never put a permanent secret in a client bundle.
- [ ] Document every new variable in `.env.example`.

---

# 30. Dependency Policy

Before adding a package:

1. Determine whether the Gemini Live integration requires it.
2. Check whether the current platform/API can support the requirement without it.
3. Prefer an official/current Gemini integration.
4. Avoid adding an AI orchestration framework merely to implement a few explicit tools.
5. Do not add Redux/Zustand/etc. solely for voice state unless the existing component architecture genuinely cannot support it.

The current project intentionally has only three runtime dependencies. fileciteturn0file0L43-L49

If a dependency must be added, document:

```text
why it is needed
what it replaces
why native/browser/Next functionality is insufficient
```

---

# 31. Suggested Implementation Order

## P0 — Foundation

- [ ] Read README + AGENTS.md + current relevant source.
- [ ] Verify current booking/chat/rate-limit behavior.
- [ ] Verify current Gemini Live API integration requirements.
- [ ] Decide secure client/server Gemini session architecture.
- [ ] Add environment configuration.
- [ ] Extract shared booking/application actions if necessary.
- [ ] Define canonical `BookingConfirmation`.
- [ ] Define tool/action contracts.
- [ ] Ensure voice actions use existing server validation.

## P0 — Agentic Voice

- [ ] Implement Gemini Live session.
- [ ] Implement voice input/output.
- [ ] Implement explicit tool calling.
- [ ] Implement test-cost lookup.
- [ ] Implement doctor/test lookup.
- [ ] Implement booking actions.
- [ ] Implement explicit booking confirmation.
- [ ] Implement structured tool errors.
- [ ] Preserve emergency/safety gates.

## P0 — UI Synchronisation

- [ ] Add voice control.
- [ ] Add listening/speaking/processing states.
- [ ] Synchronise voice transcript with chat.
- [ ] Render booking confirmations in the existing UI.
- [ ] Handle voice errors and fallback to text.

## P1 — Rate Limiting

- [ ] Reuse existing Postgres sliding-window limiter.
- [ ] Apply appropriate limits to new voice/session/action boundaries.
- [ ] Return consistent rate-limit semantics.
- [ ] Add `Retry-After` where appropriate.
- [ ] Test boundary conditions.
- [ ] Prevent expensive session abuse.

## P1 — Reliability

- [ ] Handle reconnect.
- [ ] Handle duplicate action/tool calls.
- [ ] Add idempotency if required after inspecting current booking guarantees.
- [ ] Verify concurrency behavior.
- [ ] Ensure UI cannot display false booking success.

## P2 — Polish

- [ ] Accessibility refinement.
- [ ] Voice UX refinement.
- [ ] Better fallback messages.
- [ ] Improved error telemetry if appropriate.
- [ ] Documentation.
- [ ] Manual regression checklist.

---

# 32. Likely Files to Create/Modify

Do not modify all of these automatically. Inspect first.

### Existing files likely to change

```text
lib/db.ts
lib/chat.ts
app/api/book/route.ts
components/chat-widget.tsx
components/rec-card.tsx
db/schema.sql              # only if actually required
test/chat.test.mjs
.env.example
README.md
```

### Possible new files

```text
lib/booking.ts
lib/voice.ts
lib/voice-actions.ts
lib/rate-limit.ts          # only if extraction improves separation
app/api/voice/...          # only if required by chosen Live architecture
components/voice-control.tsx
components/voice-state.tsx # only if useful
test/booking.test.mjs
test/voice-actions.test.mjs
test/rate-limit.test.mjs
```

Do not create a large framework-like folder structure for a small demo.

---

# 33. Existing Protocol Invariants

The current chat client expects:

```text
reply events
    ↓
exactly one done event
```

and uses flags including:

```text
emergency
degraded
rateLimited
outOfScope
question
```

Do not break the existing NDJSON protocol while adding voice. fileciteturn0file0L187-L195

If voice uses a different realtime protocol, keep its protocol separate rather than contaminating the existing chat stream format.

---

# 34. Existing Intentional Shortcuts

The project uses `ponytail:` comments to mark deliberate shortcuts with known upgrade paths.

Existing examples include:

- Postgres rate limiter instead of Redis
- generated client-side slots
- naive SQL seed splitting
- placeholder DB URL

Respect this convention. Add a `ponytail:` comment when intentionally introducing another demo-grade shortcut.

Do not silently convert a demo shortcut into a production claim.

The project explicitly notes that the current booking route does not check true availability because slots are client-generated. fileciteturn0file0L275-L281

---

# 35. Definition of Done

The work is complete only when all applicable boxes are true.

## Voice

- [ ] User can start voice mode.
- [ ] User can speak naturally.
- [ ] Assistant responds vocally.
- [ ] Assistant can invoke controlled application actions.
- [ ] Test costs come from DB.
- [ ] Doctor/test choices come from DB.
- [ ] Voice can book a doctor.
- [ ] Voice can book a test/referral.
- [ ] Booking requires appropriate user confirmation.
- [ ] Successful booking produces an authoritative reference.
- [ ] Agent verbally states the confirmation.
- [ ] Website displays the same confirmation.

## Safety

- [ ] Emergency red flags are handled before normal model interaction.
- [ ] Existing medication safeguard remains intact.
- [ ] Model cannot invent DB entities.
- [ ] Model cannot directly mutate DB.
- [ ] Existing chat invariants remain intact.

## Rate limiting

- [ ] Existing chat limit still works.
- [ ] Existing booking limit still works.
- [ ] Voice/session endpoints have appropriate protection.
- [ ] Expensive voice abuse has a server-side boundary.
- [ ] Rate-limit errors are machine-readable.
- [ ] UI and voice do not claim success after rate limiting.

## Reliability

- [ ] Gemini disconnects are handled.
- [ ] Microphone denial is handled.
- [ ] Booking conflicts are handled.
- [ ] Duplicate tool calls are handled safely.
- [ ] UI state cannot drift into false success.
- [ ] Text chat remains available as fallback.

## Quality

- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] Manual voice test matrix passes.
- [ ] No secret is exposed client-side.
- [ ] No unnecessary dependency was introduced.
- [ ] README/documentation reflects the new architecture.
- [ ] Existing fictional/demo limitations remain clearly stated.

---

# 36. Final Agent Rule

**Do not start by coding the voice UI.**

First understand:

```text
existing data
    ↓
existing booking constraints
    ↓
existing safety invariants
    ↓
existing rate limiter
    ↓
Gemini Live capabilities
    ↓
secure session architecture
    ↓
shared application actions
    ↓
voice UI
```

Architecture should follow the existing data and application boundaries, not precede understanding of them.

The most important invariant is:

> **Gemini is the conversational interface. The server is the authority.**

The model may ask the application to perform an action.

The application decides whether that action is valid.

The database decides whether the mutation succeeds.

The UI and voice layer report the authoritative result.
