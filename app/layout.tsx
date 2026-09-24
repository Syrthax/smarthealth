import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import ChatWidget from "@/components/chat-widget";
import SessionLock from "@/components/session-lock";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Meridian Health City",
  description:
    "Multi-speciality hospital. Find the right specialist, book consultations and lab tests.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-ctl focus:bg-accent focus:px-4 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        <SiteNav />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
        <ChatWidget />
      </body>
    </html>
  );
}

function SiteNav() {
  const links = [
    { href: "/doctors", label: "Find a doctor" },
    { href: "/labs", label: "Labs & tests" },
    { href: "/#departments", label: "Departments" },
  ];
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper/95 backdrop-blur-[2px]">
      <nav aria-label="Primary" className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex items-center gap-4 py-3">
          <Link href="/" className="flex shrink-0 items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight">Meridian</span>
            <span className="hidden text-[13px] text-muted sm:inline">Health City</span>
          </Link>
          <ul className="ml-auto hidden items-center gap-6 text-[14px] text-muted md:flex">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="whitespace-nowrap hover:text-ink">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/doctors"
            className="ml-auto whitespace-nowrap rounded-ctl bg-accent px-3.5 py-2 text-[14px] font-medium text-paper transition-colors hover:bg-accent-hover active:translate-y-px md:ml-6"
          >
            Book a consultation
          </Link>
          <SessionLock />
        </div>
        {/* Same destinations on small screens — scrolls inside itself, never the page. */}
        <ul className="-mx-4 flex gap-5 overflow-x-auto px-4 pb-2.5 text-[14px] text-muted md:hidden">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="whitespace-nowrap hover:text-ink">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-rule bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="text-[15px] font-semibold">Meridian Health City</p>
          <p className="mt-2 max-w-md text-[14px] text-muted">
            Multi-speciality hospital, Bengaluru. Outpatient desks open 08:00–20:00, Monday to
            Saturday. Emergency department open 24 hours.
          </p>
        </div>
        <div className="text-[14px]">
          <p className="font-medium">Emergency</p>
          <p className="mt-1 font-mono text-[14px] text-alert">+91 80 4000 1000</p>
          <p className="mt-3 font-medium">Reception</p>
          <p className="mt-1 font-mono text-[14px] text-muted">+91 80 4000 1200</p>
        </div>
      </div>
      <div className="border-t border-rule">
        <p className="mx-auto max-w-6xl px-4 py-4 text-[13px] text-muted sm:px-6">
          The health assistant helps you work out where to start — which department, how soon,
          and which tests to have ready — so the right doctor sees you sooner. In an emergency,
          call the number above.
        </p>
      </div>
    </footer>
  );
}
