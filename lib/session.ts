/** Shared by the server (lib/auth.ts) and the page's lock timer, which cannot import node:crypto. */
export const SESSION_MS = 7 * 60_000;
export const SESSION_COOKIE = "mhc_session";
/** Readable by the page, only so it can lock itself on time. Grants nothing on its own. */
export const EXPIRY_COOKIE = "mhc_session_exp";
