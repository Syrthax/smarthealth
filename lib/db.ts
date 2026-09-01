import { neon } from "@neondatabase/serverless";

// ponytail: the placeholder keeps `next build` able to import this module when the
// env isn't present (all pages are force-dynamic, so nothing queries at build time).
// Any real query against it fails loudly, which is the behaviour we want.
export const sql = neon(process.env.DATABASE_URL || "postgresql://unset:unset@unset/unset");

/**
 * Sliding-window rate limit backed by the `api_hits` table.
 * One round trip: prune expired rows, record this hit, count what remains.
 * Returns true when the caller is over budget.
 *
 * ponytail: Postgres instead of Redis — no second provider to provision.
 * Move to Upstash if chat volume makes the per-request round trip hurt.
 */
export async function overLimit(
  ip: string,
  route: string,
  limit: number,
  windowMinutes = 60,
): Promise<boolean> {
  const rows = await sql`
    WITH pruned AS (
      DELETE FROM api_hits
      WHERE at < now() - make_interval(mins => ${windowMinutes})
    ), inserted AS (
      INSERT INTO api_hits (ip, route) VALUES (${ip}, ${route})
    )
    SELECT count(*)::int AS n FROM api_hits
    WHERE ip = ${ip} AND route = ${route}
      AND at >= now() - make_interval(mins => ${windowMinutes})
  `;
  // The main SELECT runs on the pre-CTE snapshot, so `n` counts the PRIOR hits and
  // excludes the one just inserted. Request number `limit + 1` is therefore the first
  // to see n === limit, which is exactly where it should be refused.
  return (rows[0]?.n ?? 0) >= limit;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0].trim() || "unknown";
}

/** Neon's tagged template returns untyped rows; this is the single place we name them. */
export function rows<T>(q: PromiseLike<unknown>): Promise<T[]> {
  return q as unknown as Promise<T[]>;
}
