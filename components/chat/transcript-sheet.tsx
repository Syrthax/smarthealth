import type { Msg } from "./types";
import { URGENCY } from "./message-cards";

/**
 * What the visitor hands the doctor. People forget in the waiting room what they managed
 * to describe clearly an hour earlier, so this is their own words back, with what the
 * assistant made of them — clearly labelled as neither a diagnosis nor a medical record.
 */
export function TranscriptSheet({ messages }: { messages: Msg[] }) {
  const said = messages.filter((m) => m.role === "user" && !m.noise && !m.blocked && m.content.trim());
  const booked = messages.flatMap((m) => (m.booking ? [m.booking] : []));
  if (!said.length) return null;

  const now = new Date().toLocaleString("en-IN", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <div className="print-sheet">
      <h1 style={{ fontSize: "16pt", margin: 0 }}>Symptom summary</h1>
      <p style={{ margin: "2pt 0 0", fontSize: "10pt" }}>
        Meridian Health City · prepared {now}
      </p>

      <p
        className="avoid-break"
        style={{
          margin: "12pt 0",
          padding: "8pt 10pt",
          border: "1pt solid currentColor",
          fontSize: "10pt",
        }}
      >
        <strong>Prepared for your consultation.</strong> Below is what you described before your
        appointment, in your own words, and the first suggestions the assistant made about
        where to start. Your doctor will take it from here.
      </p>

      <h2 style={{ fontSize: "12pt", marginTop: "16pt" }}>In the patient&rsquo;s own words</h2>
      <ol style={{ margin: "6pt 0 0", paddingLeft: "16pt" }}>
        {said.map((m, i) => (
          <li key={i} className="avoid-break" style={{ marginBottom: "5pt" }}>
            {m.content}
          </li>
        ))}
      </ol>

      {messages.map((m, i) =>
        m.role !== "assistant" || (!m.assessment && !m.doctors?.length && !m.nextSteps?.length) ? null : (
          <section key={i} className="avoid-break" style={{ marginTop: "14pt" }}>
            <h2 style={{ fontSize: "12pt", margin: 0 }}>
              Assistant&rsquo;s note
              {m.urgency ? ` · ${URGENCY[m.urgency].label.toLowerCase()}` : ""}
            </h2>
            {m.assessment && (
              <p style={{ margin: "4pt 0 0" }}>
                <strong>Commonly investigated for:</strong> {m.assessment}
              </p>
            )}
            {!!m.doctors?.length && (
              <p style={{ margin: "4pt 0 0" }}>
                <strong>Suggested department:</strong>{" "}
                {[...new Set(m.doctors.map((d) => d.specialty))].join(", ")}
              </p>
            )}
            {!!m.tests?.length && (
              <p style={{ margin: "4pt 0 0" }}>
                <strong>Tests suggested beforehand:</strong>{" "}
                {m.tests.map((t) => `${t.name} (${t.code})`).join(", ")}
              </p>
            )}
            {!!m.nextSteps?.length && (
              <ul style={{ margin: "4pt 0 0", paddingLeft: "16pt" }}>
                {m.nextSteps.map((step, n) => (
                  <li key={n}>{step}</li>
                ))}
              </ul>
            )}
          </section>
        ),
      )}

      {!!booked.length && (
        <section className="avoid-break" style={{ marginTop: "14pt" }}>
          <h2 style={{ fontSize: "12pt", margin: 0 }}>Booked</h2>
          <ul style={{ margin: "4pt 0 0", paddingLeft: "16pt" }}>
            {booked.map((b) => (
              <li key={b.reference}>
                {b.itemName} · {b.slotLabel} · ref {b.reference}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p style={{ marginTop: "18pt", fontSize: "9pt" }}>
        Meridian Health City · Reception +91 80 4000 1200 · Emergency +91 80 4000 1000.
        This summary was generated on the patient&rsquo;s own device and was not stored by the
        hospital.
      </p>
    </div>
  );
}
