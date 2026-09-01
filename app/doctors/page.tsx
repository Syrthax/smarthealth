import { sql, rows } from "@/lib/db";
import { DoctorCard } from "@/components/rec-card";
import type { Doctor } from "@/lib/chat";

export const dynamic = "force-dynamic";

export default async function DoctorsPage({ searchParams }: PageProps<"/doctors">) {
  const { specialty } = await searchParams;
  const active = typeof specialty === "string" ? specialty : null;

  const [doctors, specialties] = await Promise.all([
    rows<Doctor>(
      active
        ? sql`SELECT * FROM doctors WHERE specialty = ${active} ORDER BY name`
        : sql`SELECT * FROM doctors ORDER BY specialty, name`,
    ),
    rows<{ specialty: string }>(sql`SELECT DISTINCT specialty FROM doctors ORDER BY specialty`),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-[1.75rem]">Find a doctor</h1>
      <p className="mt-2 max-w-xl text-[15px] text-muted">
        {doctors.length} consultant{doctors.length === 1 ? "" : "s"}
        {active ? ` in ${active}` : " across all departments"}. Booking takes a name, a phone number
        and a slot.
      </p>

      <nav aria-label="Filter by specialty" className="mt-6 flex flex-wrap gap-2">
        <Chip href="/doctors" active={!active}>
          All
        </Chip>
        {specialties.map((s) => (
          <Chip
            key={s.specialty}
            href={`/doctors?specialty=${encodeURIComponent(s.specialty)}`}
            active={active === s.specialty}
          >
            {s.specialty}
          </Chip>
        ))}
      </nav>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {doctors.map((d) => (
          <DoctorCard key={d.id} doctor={d} />
        ))}
      </div>
    </div>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap rounded-ctl border px-3 py-1.5 text-[13px] transition-colors ${
        active
          ? "border-accent bg-accent text-paper"
          : "border-rule bg-paper text-muted hover:bg-surface hover:text-ink"
      }`}
    >
      {children}
    </a>
  );
}
