import { sql, rows } from "@/lib/db";
import type { Doctor } from "@/lib/chat";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [departments, doctors, counts] = await Promise.all([
    rows<{ department: string; specialty: string; n: number }>(
      sql`SELECT department, min(specialty) AS specialty, count(*)::int AS n
          FROM doctors GROUP BY department ORDER BY department`,
    ),
    rows<Doctor>(sql`SELECT * FROM doctors ORDER BY consult_fee DESC LIMIT 4`),
    rows<{ doctors: number; tests: number; in_house: number; partners: number }>(
      sql`SELECT (SELECT count(*) FROM doctors)::int AS doctors,
                 (SELECT count(*) FROM tests)::int AS tests,
                 (SELECT count(*) FROM tests t JOIN labs l ON l.id = t.lab_id
                   WHERE l.kind = 'in_house')::int AS in_house,
                 (SELECT count(*) FROM labs WHERE kind = 'partner')::int AS partners`,
    ),
  ]);
  const c = counts[0];

  return (
    <>
      {/* Hero — one action, stated plainly. No gradient, no stock photo. */}
      <section className="border-b border-rule">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent">
            Multi-speciality hospital · Bengaluru
          </p>
          <h1 className="mt-3 max-w-2xl text-[2rem] leading-[1.12] sm:text-[2.75rem]">
            Start with the right department.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] text-muted">
            Describe what you are feeling in the intake window at the bottom of this page. It
            suggests which specialist to see, how soon, and which tests to have ready — then books
            both, so your consultation starts with the right doctor.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="/doctors"
              className="rounded-ctl bg-accent px-4 py-2.5 text-[14px] font-medium text-paper transition-colors hover:bg-accent-hover active:translate-y-px"
            >
              Browse doctors
            </a>
            <a
              href="/labs"
              className="rounded-ctl border border-rule px-4 py-2.5 text-[14px] font-medium transition-colors hover:bg-surface active:translate-y-px"
            >
              Labs &amp; tests
            </a>
          </div>

          {/* Counts are queried, not claimed. */}
          <dl className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-rule bg-rule sm:grid-cols-4">
            {[
              ["Consultants", c.doctors],
              ["Tests catalogued", c.tests],
              ["Run in-house", c.in_house],
              ["Partner labs", c.partners],
            ].map(([label, n]) => (
              <div key={String(label)} className="bg-paper px-4 py-4">
                <dd className="font-mono text-[1.5rem] leading-none">{n}</dd>
                <dt className="mt-1.5 text-[13px] text-muted">{label}</dt>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="departments" className="border-b border-rule bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-[1.25rem]">Departments</h2>
          <ul className="mt-6 grid gap-px overflow-hidden rounded-card border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
            {departments.map((d) => (
              <li key={d.department} className="bg-paper px-4 py-4">
                <a href={`/doctors?specialty=${encodeURIComponent(d.specialty)}`} className="block">
                  <p className="text-[15px] font-medium">{d.department}</p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {d.n} consultant{d.n > 1 ? "s" : ""}
                  </p>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[1.25rem]">Senior consultants</h2>
          <a href="/doctors" className="text-[14px] text-accent hover:underline">
            All {c.doctors} doctors
          </a>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {doctors.map((d) => (
            <DoctorPreview key={d.id} doctor={d} />
          ))}
        </div>
      </section>
    </>
  );
}

function DoctorPreview({ doctor }: { doctor: Doctor }) {
  return (
    <a
      href={`/doctors?specialty=${encodeURIComponent(doctor.specialty)}`}
      className="rounded-card border border-rule bg-paper p-4 transition-colors hover:bg-surface"
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-accent">
        {doctor.specialty}
      </span>
      <p className="mt-1.5 text-[15px] font-semibold">{doctor.name}</p>
      <p className="text-[13px] text-muted">{doctor.qualification}</p>
      <p className="mt-3 border-t border-rule pt-3 font-mono text-[13px]">₹{doctor.consult_fee}</p>
    </a>
  );
}
