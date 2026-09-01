// Applies db/schema.sql then db/seed.sql. Run: npm run db:reset
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add it to .env.local (see .env.example).");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ponytail: naive split on statement-terminating semicolons. Safe here because
// no seed string literal contains one. Reach for a real parser only if that changes.
const statements = (file) =>
  readFileSync(file, "utf8")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

for (const file of ["db/schema.sql", "db/seed.sql"]) {
  const stmts = statements(file);
  for (const stmt of stmts) await sql.query(stmt);
  console.log(`${file}: ${stmts.length} statements applied`);
}

const [{ doctors }] = await sql`SELECT count(*)::int AS doctors FROM doctors`;
const [{ tests }] = await sql`SELECT count(*)::int AS tests FROM tests`;
console.log(`ready — ${doctors} doctors, ${tests} tests`);
