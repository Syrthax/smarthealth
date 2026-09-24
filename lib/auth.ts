import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The demo's front door: one shared password, and a session that lasts exactly seven
 * minutes from sign-in whatever the visitor does — an absolute limit, not an idle one, so
 * a tab left open cannot keep the site (and its paid model calls) unlocked indefinitely.
 *
 * The session cookie is `<expiry ms>.<hmac>`. The key is derived from the password, so
 * changing the password in Vercel signs everyone out at once.
 *
 * ponytail: a shared password, not accounts. Fine for gating a demo; not a user system.
 */

import { SESSION_MS } from "./session.ts";
export { SESSION_MS, SESSION_COOKIE, EXPIRY_COOKIE } from "./session.ts";

/** Vercel has it as `Password`; the upper-case spelling is accepted too. */
export function sitePassword(): string | null {
  return process.env.Password || process.env.PASSWORD || null;
}

const keyFor = (password: string) => createHmac("sha256", password).update("mhc-session-v1").digest();
const sign = (exp: string, password: string) => createHmac("sha256", keyFor(password)).update(exp).digest("base64url");

export function passwordMatches(given: string, password = sitePassword()): boolean {
  if (!password) return false;
  // Hash both so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}

export function newSession(now = Date.now(), password = sitePassword()): { value: string; expires: number } | null {
  if (!password) return null;
  const expires = now + SESSION_MS;
  return { value: `${expires}.${sign(String(expires), password)}`, expires };
}

export function sessionValid(value: string | undefined, now = Date.now(), password = sitePassword()): boolean {
  if (!value || !password) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d{13}$/.test(exp) || Number(exp) <= now) return false;
  const expected = Buffer.from(sign(exp, password));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Only same-site paths survive a sign-in redirect — never `//evil.com` or a full URL. */
export function safeNext(next: unknown): string {
  const n = typeof next === "string" ? next : "/";
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
}
