-- Additive changes for a live database, safe to run any number of times.
-- `npm run db:migrate`. A fresh `db:reset` already includes all of this via schema.sql.

-- Voice bookings carry an idempotency key so a retried confirmation returns the same row.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idem_key text UNIQUE;
