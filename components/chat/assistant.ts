import type { Doctor, Test, Question } from "@/lib/chat";
import type { BookingConfirmation } from "@/lib/booking";
import type { Msg, Urgency } from "./types";

/**
 * The widget's side of the wire: what it sends to /api/chat and /api/voice/action, and how
 * the replies become transcript messages. No React here.
 */

/**
 * What the model gets to see of its own past turns. The prose alone loses the department
 * and tests it settled on, so a follow-up would start from scratch and could contradict
 * itself; this folds those decisions back into the transcript it reads.
 */
export function forModel({ role, content, urgency, doctors, tests }: Msg) {
  const decided = [
    doctors?.length ? `departments: ${[...new Set(doctors.map((d) => d.specialty))].join(", ")}` : "",
    tests?.length ? `tests: ${tests.map((t) => t.code).join(", ")}` : "",
    urgency && urgency !== "routine" ? `urgency: ${urgency}` : "",
  ].filter(Boolean);

  return {
    role,
    content:
      role === "assistant" && decided.length
        ? `${content}\n[previously recommended: ${decided.join("; ")}]`
        : content,
  };
}

/** Proposals, withdrawn turns and background noise are page furniture, not conversation. */
export const conversational = (m: Msg) => !m.pending && !m.voided && !m.noise && !m.blocked && !!m.content.trim();

/**
 * Posts the conversation to /api/chat and reads the NDJSON back. `onReply` gets the prose
 * as it streams; the promise resolves with the one `done` event every path ends in. Text
 * chat and the voice agent's assess_symptoms both come through here, so both get the
 * same red flags, medication voiding and DB-hydrated cards.
 */
export async function askAssistant(history: Msg[], onReply?: (text: string) => void): Promise<Record<string, unknown>> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history.filter(conversational).map(forModel) }),
  });
  if (!res.body) throw new Error("no stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    // Hold the trailing fragment: an event can straddle two chunks.
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.t === "reply") onReply?.(String(e.v));
      if (e.t === "done") return e;
    }
  }
  throw new Error("stream ended without an answer");
}

export function finished(e: Record<string, unknown>): Msg {
  return {
    role: "assistant",
    content: String(e.reply ?? "Something went wrong. Please try again."),
    assessment: e.assessment as string | undefined,
    urgency: e.emergency ? "emergency" : (e.urgency as Urgency | undefined),
    nextSteps: e.nextSteps as string[] | undefined,
    question: e.question as Question | null | undefined,
    outOfScope: e.outOfScope as boolean | undefined,
    doctors: e.doctors as Doctor[] | undefined,
    tests: e.tests as Test[] | undefined,
    emergency: e.emergency as Msg["emergency"],
    offTopic: typeof e.offTopic === "number" ? e.offTopic : undefined,
    ended: e.ended === true,
    streaming: false,
  };
}

export const bookingLine = (b: BookingConfirmation) =>
  `Booked: ${b.itemName}, ${b.slotLabel}. Reference ${b.reference}.`;

/** The emergency answer is read aloud by the browser's own voice, never by the model. */
export function speak(text: string) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-IN";
    speechSynthesis.speak(u);
  } catch {
    /* no speech synthesis — the banner and the call button are on screen regardless */
  }
}

/** POSTs one tool call to the server. Always resolves to something the model can be told. */
export async function serverAction(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const res = await fetch("/api/voice/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    return await res.json();
  } catch {
    return { ok: false, code: "error", message: "I could not reach the hospital system just now." };
  }
}
