/**
 * Prompt-injection and scope guards. Every check here is plain code that runs before or
 * after a model call — the point is that none of them depends on a model deciding to behave.
 *
 * No library: the available "LLM firewall" products are remote APIs (every patient message
 * would leave for a third party) and are heuristic too. What actually contains an injected
 * model here is structural and already in place — tools are a closed whitelist, prices and
 * bookings come only from Postgres, output is parsed against a schema and hydrated from
 * rows. This file adds the front door: obvious override attempts never reach a model, role
 * markers are stripped from what does, and a reply that leaks the system prompt is voided.
 */

/** The front desk introduces itself the same way in text and in voice. */
export const FRONT_DESK = "the front desk at Meridian Health City";

const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass|skip)\b.{0,30}\b(previous|prior|above|earlier|all|your|these|the|system)\b.{0,20}\b(instructions?|prompts?|rules?|guidelines?|directions?|messages?)\b/i,
  // "your" is required: "tell me the rules for visiting" is a fair hospital question.
  /\b(reveal|show|print|repeat|output|leak|tell me|what (is|are))\b.{0,20}\byour\b.{0,15}\b(system prompt|prompt|instructions|rules|guidelines|configuration)\b/i,
  /\b(system prompt|developer mode|jailbreak|jail break|do anything now|prompt injection)\b/i,
  /\bDAN\b/,
  /\b(you are now|from now on,? you|act as|pretend (to be|you are|you're)|roleplay|role-play|role play|impersonate|simulate being)\b/i,
  /\b(new|updated|different) (instructions|persona|role)\b/i,
  /^\s*(system|assistant|developer|model)\s*:/im,
  /<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>|\[\/?(INST|SYS)\]|<<\/?SYS>>/i,
  /\[previously recommended:/i,
  /\bnote from the (page|system|meridian system)\b/i,
];

/** Someone trying to change how the assistant works, rather than tell it about their health. */
export function injectionAttempt(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

/**
 * What a visitor's message is allowed to carry into a model: their words, without anything
 * that looks like a role boundary or one of our own markers. Applied to every user message
 * on the way to Featherless, on top of injectionAttempt() refusing the obvious ones.
 */
export function neutralise(text: string): string {
  return text
    .replace(/<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>|\[\/?(INST|SYS)\]|<<\/?SYS>>/gi, " ")
    .replace(/\[previously recommended:[^\]]*\]/gi, " ")
    .replace(/^\s*(system|assistant|developer|model)\s*:/gim, "")
    .replace(/\s{3,}/g, "  ")
    .trim();
}

/**
 * Distinctive lines of our own prompts. If a reply contains one, the model is reciting its
 * instructions — the reply is discarded, whatever else it says.
 */
const PROMPT_FRAGMENTS = [
  "ABSOLUTELY FORBIDDEN",
  "WHAT YOU PRODUCE",
  "TAKE A HISTORY BEFORE YOU ANSWER",
  "doctor ids:",
  "routinely ordered for",
  "Reply with ONLY a JSON object",
  "FACTS COME FROM TOOLS",
  "Note from the page",
];

export function leaksPrompt(text: string): boolean {
  const t = text.toLowerCase();
  return PROMPT_FRAGMENTS.some((f) => t.includes(f.toLowerCase()));
}

/**
 * What the desk says when the conversation strays from health — three different lines, so
 * it never repeats itself, and each firmer than the last. The third ends the conversation.
 * Server-written, never a model's improvisation. Counted in a row: talking about a symptom
 * in between starts the count again.
 */
export const OFF_TOPIC_REPLIES = [
  `I understand that can be a problem, but I'm ${FRONT_DESK}, so I can only help with health-related things. Is there something about your health I can help you with?`,
  `I'm only able to help with health concerns here — a symptom, a doctor or a test. If there's something like that on your mind, tell me; otherwise I'll have to end our conversation.`,
  `As this isn't something I can help with, I'll end our conversation here. If you need help with your health, you're welcome to start a new one at any time.`,
] as const;

export const OFF_TOPIC_LIMIT = OFF_TOPIC_REPLIES.length;

/**
 * Which strike this would be, from the conversation so far: one more than the number of
 * off-topic replies the desk has just given in a row. The count lives in the transcript,
 * so the server needs no session state to enforce it.
 */
export function nextStrike(history: { role: string; content: string }[]): number {
  let run = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    if ((OFF_TOPIC_REPLIES as readonly string[]).includes(m.content.trim())) run++;
    else break;
  }
  return Math.min(run + 1, OFF_TOPIC_LIMIT);
}
