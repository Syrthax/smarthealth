import type { NextRequest } from "next/server";
import { overLimit, clientIp } from "@/lib/db";
import {
  EXPIRY_COOKIE,
  SESSION_COOKIE,
  SESSION_MS,
  newSession,
  passwordMatches,
  safeNext,
} from "@/lib/auth";

/**
 * Receives the sign-in form (a plain HTML POST — the page before sign-in ships no
 * JavaScript) and answers with a redirect either way, so the back button never re-submits.
 * Guesses are rate limited per IP, counted in the same Postgres window as everything else.
 */

const ATTEMPTS = 10;
const WINDOW_MINUTES = 15;

export async function POST(req: NextRequest) {
  let password = "";
  let next = "/";
  try {
    const form = await req.formData();
    password = String(form.get("password") ?? "");
    next = safeNext(form.get("next"));
  } catch {
    /* not a form — falls through as a wrong password */
  }

  const back = (auth?: string) => {
    const url = new URL(next, req.nextUrl.origin);
    if (auth) url.searchParams.set("auth", auth);
    return Response.redirect(url, 303);
  };

  if (await overLimit(clientIp(req), "login", ATTEMPTS, WINDOW_MINUTES)) return back("locked");
  if (!passwordMatches(password)) return back("wrong");

  const session = newSession();
  if (!session) return back("wrong");

  const secure = req.nextUrl.protocol === "https:" ? "; Secure" : "";
  const maxAge = Math.floor(SESSION_MS / 1000);
  const res = back();
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", `${SESSION_COOKIE}=${session.value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
  // Outlives the session by a minute so the page can still read its deadline at the
  // moment it passes. It only carries a timestamp; the HttpOnly cookie is the credential.
  headers.append("Set-Cookie", `${EXPIRY_COOKIE}=${session.expires}; Path=/; Max-Age=${maxAge + 60}; SameSite=Lax${secure}`);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 303, headers });
}
