import type { NextRequest } from "next/server";
import { EXPIRY_COOKIE, SESSION_COOKIE } from "@/lib/auth";

/**
 * Clears the session and returns to the sign-in page. The page calls this itself when the
 * 7 minutes run out (`?reason=expired`), as well as from the "Lock" button.
 */
function signOut(req: NextRequest) {
  const expired = req.nextUrl.searchParams.get("reason") === "expired";
  const headers = new Headers({ Location: expired ? "/?auth=expired" : "/", "Cache-Control": "no-store" });
  for (const name of [SESSION_COOKIE, EXPIRY_COOKIE])
    headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
}

export const GET = signOut;
export const POST = signOut;
