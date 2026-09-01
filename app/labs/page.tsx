import { sql, rows } from "@/lib/db";
import { TestCard } from "@/components/rec-card";
import type { Test } from "@/lib/chat";

export const dynamic = "force-dynamic";

type Lab = { id: number; name: string; kind: "in_house" | "partner"; address: string; phone: string };

export default async function LabsPage() {
  const [labs, tests] = await Promise.all([
    rows<Lab>(sql`SELECT * FROM labs ORDER BY kind DESC, name`),
    rows<Test>(
      sql`SELECT t.id, t.name, t.code, t.price, t.prep_notes, t.turnaround_hours, t.ordered_for,
                 l.name AS lab_name, l.kind AS lab_kind, l.address AS lab_address, l.phone AS lab_phone
          FROM tests t JOIN labs l ON l.id = t.lab_id
          ORDER BY l.kind DESC, t.name`,
    ),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-[1.75rem]">Labs &amp; tests</h1>
      <p className="mt-2 max-w-xl text-[15px] text-muted">
        Anything not run in our own lab is referred to a partner centre. You book it here either
        way; the referral is raised for you.
      </p>

      <ul className="mt-8 grid gap-px overflow-hidden rounded-card border border-rule bg-rule md:grid-cols-3">
        {labs.map((l) => (
          <li key={l.id} className="bg-paper px-4 py-4">
            <span
              className={`font-mono text-[11px] uppercase tracking-[0.08em] ${
                l.kind === "in_house" ? "text-accent" : "text-muted"
              }`}
            >
              {l.kind === "in_house" ? "In-house" : "Partner"}
            </span>
            <p className="mt-1.5 text-[15px] font-medium">{l.name}</p>
            <p className="mt-1 text-[13px] text-muted">{l.address}</p>
            <p className="mt-1 font-mono text-[13px] text-muted">{l.phone}</p>
          </li>
        ))}
      </ul>

      <h2 className="mt-12 text-[1.25rem]">Test catalogue</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tests.map((t) => (
          <TestCard key={t.id} test={t} />
        ))}
      </div>
    </div>
  );
}
