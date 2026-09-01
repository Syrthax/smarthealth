# Meridian Health City

A demo hospital website with an intake assistant in the bottom-right corner. You describe
what you have been feeling; it works out which department you belong at and which tests are
worth having ready, then books both in one click.

**It never gives medical advice.** No diagnosis, no condition names, no medication, no
severity judgements. It routes and it books — that is the whole job.

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

**The model is given meanings, not just names.** `specialties.sees` and `tests.ordered_for`
describe in plain language what each desk handles and what each test is routinely ordered
for. Without them a small model picks by vibe — an early version suggested Gynaecology for a
headache. Tests are chosen by code (`MRI-BR`, `CBC`) rather than row number, because small
models ground poorly on bare integers.

**Both API routes are rate limited** — 20 chat messages and 5 bookings per hour per IP,
counted in Postgres rather than Redis so there is no second service to run.

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

`npm test` covers the parts that must not break: that red flags fire on real emergencies,
that they stay quiet on ordinary complaints, and that model output survives markdown fences,
prose padding and malformed id lists.

The rate-limit boundary is verified by hand against a live database rather than in `npm test`
— it needs real Postgres, and the off-by-one it once had is now documented at the query
itself in `lib/db.ts`.

## Not built

No patient accounts, no booking history page, no real availability calendar (slots are
generated), no chat transcript persistence, no streaming. This is a demo; each of those is a
deliberate omission rather than an oversight.

## Disclaimer

Fictional hospital, fictional doctors, seeded data. Not a medical device and not a source of
medical advice.
