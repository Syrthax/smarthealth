import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionValid, sitePassword } from "@/lib/auth";

/**
 * Nothing of the site is served until the visitor has signed in — not the pages, not the
 * JavaScript bundles, not the APIs that spend money on model calls. An unauthenticated page
 * request gets a self-contained sign-in page (no app code, no layout, no chat widget); an
 * unauthenticated API call gets a 401.
 *
 * Runs on every path. Only the sign-in and sign-out endpoints are open.
 */

const OPEN = new Set(["/api/login", "/api/logout"]);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN.has(pathname)) return NextResponse.next();

  // With no password configured, production stays shut rather than open. Local dev without
  // one runs unlocked, so `npm run dev` works from a fresh clone.
  if (!sitePassword()) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return page("This site is not accepting sign-ins right now.", req, 503);
  }

  if (sessionValid(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/"))
    return NextResponse.json({ error: "Sign in first.", signedOut: true }, { status: 401 });

  const reason = req.nextUrl.searchParams.get("auth");
  return page(
    reason === "wrong"
      ? "That password is not right."
      : reason === "locked"
        ? "Too many attempts. Try again in a few minutes."
        : reason === "expired"
          ? "Your 7-minute session ended. Sign in again to continue."
          : null,
    req,
  );
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(message: string | null, req: NextRequest, status = 401) {
  const url = req.nextUrl.clone();
  url.searchParams.delete("auth");
  const next = url.pathname + url.search;
  const closed = status === 503;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Meridian Health City · Sign in</title>
<style>
  :root { --paper: oklch(99% 0.003 250); --surface: oklch(97% 0.006 250); --ink: oklch(22% 0.02 250);
    --muted: oklch(52% 0.015 250); --rule: oklch(91% 0.008 250); --accent: oklch(48% 0.15 255);
    --accent-hover: oklch(41% 0.15 255); --alert: oklch(52% 0.19 27); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: var(--surface); color: var(--ink); font: 15px/1.55 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; }
  main { width: min(24rem, 100%); background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 24px; }
  .mark { font: 500 11px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  h1 { margin: 8px 0 4px; font-size: 20px; font-weight: 600; letter-spacing: -0.021em; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
  label { display: block; margin-top: 20px; font-size: 13px; color: var(--muted); }
  input { display: block; width: 100%; margin-top: 4px; padding: 8px 12px; font: inherit; color: var(--ink);
    background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; outline: none; }
  input:focus { border-color: var(--accent); }
  button { margin-top: 16px; width: 100%; padding: 9px 12px; font: 500 14px/1.4 inherit; font-family: inherit;
    color: var(--paper); background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
  button:hover { background: var(--accent-hover); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .msg { margin-top: 16px; font-size: 13px; color: var(--alert); }
  .note { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--rule); font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="mark">Meridian Health City</div>
  <h1>${closed ? "Closed" : "Sign in to the demo"}</h1>
  <p>Sessions last 7 minutes.</p>
  ${message ? `<p class="msg" role="alert">${esc(message)}</p>` : ""}
  ${
    closed
      ? ""
      : `<form method="post" action="/api/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Enter</button>
  </form>`
  }
  <p class="note">In an emergency, call +91 80 4000 1000.</p>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Every path, including /_next assets: the site's code is not handed out before sign-in.
export const config = { matcher: "/:path*" };
