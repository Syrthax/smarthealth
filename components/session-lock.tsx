"use client";

import { useEffect, useState } from "react";
import { EXPIRY_COOKIE } from "@/lib/session";

/** The session's end, from the readable companion cookie. Null when there is no session (e.g. local dev without a password). */
function expiry(): number | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${EXPIRY_COOKIE}=(\\d+)`));
  return m ? Number(m[1]) : null;
}

/**
 * Locks the page the moment the 7-minute session ends. The server already refuses an
 * expired cookie on every request; this only makes sure a page left open does not sit
 * there looking usable until the next click fails. It re-checks when the tab comes back,
 * because browsers throttle timers in background tabs.
 */
export default function SessionLock() {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    // Remembered once seen. If the cookie later disappears, the session is over — the
    // earlier version read a missing cookie as "no session to time" and simply stopped,
    // so the page never locked.
    let deadline: number | null = null;
    const tick = () => {
      const exp = expiry() ?? deadline;
      if (exp === null) return setLeft(null); // never had a session (local dev without a password)
      deadline = exp;
      const ms = exp - Date.now();
      if (ms <= 0) {
        // A full navigation on purpose: it tears down any voice session and lets the proxy
        // serve the sign-in page. A client-side route change would keep the app running.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/api/logout?reason=expired");
        return;
      }
      setLeft(ms);
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  if (left === null) return null;
  const s = Math.ceil(left / 1000);
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="ml-3 flex shrink-0 items-center gap-2 text-[12px] text-muted">
      <span className="font-mono" aria-label={`Session locks in ${clock}`} title="Session locks automatically">
        {clock}
      </span>
      <a
        href="/api/logout"
        className="rounded-ctl border border-rule px-2 py-1 font-medium text-ink transition-colors hover:bg-surface active:translate-y-px"
      >
        Lock
      </a>
    </div>
  );
}
