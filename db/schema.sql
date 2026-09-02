DROP TABLE IF EXISTS bookings, api_hits, tests, labs, doctors, specialties CASCADE;

CREATE TABLE specialties (
  name       text PRIMARY KEY,
  department text NOT NULL,
  -- Plain-language list of what this desk actually sees. Fed to the model so a
  -- complaint maps to a department by meaning, not by guessing from the name.
  sees       text NOT NULL
);

CREATE TABLE doctors (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  specialty     text NOT NULL REFERENCES specialties(name),
  qualification text NOT NULL,
  department    text NOT NULL,
  consult_fee   integer NOT NULL,
  avail_days    text NOT NULL,
  bio           text NOT NULL
);

CREATE TABLE labs (
  id      serial PRIMARY KEY,
  name    text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('in_house', 'partner')),
  address text NOT NULL,
  phone   text NOT NULL
);

CREATE TABLE tests (
  id                serial PRIMARY KEY,
  name              text NOT NULL,
  code              text NOT NULL,
  lab_id            integer NOT NULL REFERENCES labs(id),
  price             integer NOT NULL,
  prep_notes        text NOT NULL,
  turnaround_hours  integer NOT NULL,
  -- What the test is routinely ordered for. Fed to the model so it can match a
  -- complaint to a test instead of guessing from the name alone.
  ordered_for       text NOT NULL
);

CREATE TABLE bookings (
  id           serial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('doctor', 'test', 'referral')),
  ref_id       integer NOT NULL,
  patient_name text NOT NULL,
  phone        text NOT NULL,
  slot         text NOT NULL,
  ref_code     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A doctor sees one patient per slot. Labs run several tests in parallel, so the
-- constraint is deliberately scoped to consultations rather than every booking.
CREATE UNIQUE INDEX one_patient_per_consultation
  ON bookings (ref_id, slot) WHERE kind = 'doctor';

CREATE TABLE api_hits (
  ip    text NOT NULL,
  route text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_hits_lookup ON api_hits (ip, route, at);
