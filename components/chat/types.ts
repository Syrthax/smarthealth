import type { Doctor, Test, Question } from "@/lib/chat";
import type { BookingConfirmation } from "@/lib/booking";

/** The shape of the chat transcript, shared by the widget, its cards and the printable summary. */

export type Urgency = "routine" | "soon" | "urgent" | "emergency";

/** A booking the voice agent has proposed. Nothing is written until it is confirmed. */
export type Pending = {
  pid: string;
  /** Server-signed; the model never sees it (see lib/pending.ts). */
  token: string;
  /** Patient speech heard after this point is what counts as agreeing to it. */
  heardAt: number;
  summary: {
    kind: "doctor" | "test" | "referral";
    itemName: string;
    specialty?: string;
    labName?: string;
    labAddress?: string;
    slotLabel: string;
    costRupees: number;
    patientName: string;
    phone: string;
  };
  state: "open" | "confirming" | "confirmed" | "cancelled" | "replaced" | "failed";
  error?: string;
  /** Set once confirmed: the booking this proposal became. */
  reference?: string;
};

export type Msg = {
  /** Present on anything updated after it is first added — streaming, voice, cards. */
  id?: string;
  role: "user" | "assistant";
  content: string;
  assessment?: string;
  urgency?: Urgency;
  nextSteps?: string[];
  question?: Question | null;
  outOfScope?: boolean;
  streaming?: boolean;
  doctors?: Doctor[];
  tests?: Test[];
  emergency?: { why: string; line: string };
  /** Said aloud rather than typed. */
  via?: "voice";
  /** A spoken turn the medication gate withdrew. Kept as a record, never sent back to a model. */
  voided?: boolean;
  pending?: Pending;
  booking?: BookingConfirmation;
  /** Heard as speech but judged background noise: kept as a record, never treated as something said. */
  noise?: boolean;
  /** Words that tried to change how the assistant works. Shown struck out; never sent to a model. */
  blocked?: boolean;
  /** Which off-topic strike this reply was, if it was one. */
  offTopic?: number;
  /** The desk closed the conversation here; nothing more can be sent until it is cleared. */
  ended?: boolean;
  /** A divider in the transcript, e.g. where a voice conversation began and ended. */
  marker?: string;
};
