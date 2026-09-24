import { overLimit, clientIp, tooMany } from "@/lib/db";
import { TOOL_DECLARATIONS, voiceInstruction } from "@/lib/voice";

/**
 * Starts a voice session by minting a single-use, short-lived Gemini Live token.
 *
 * The browser talks to Gemini directly over a WebSocket — Next route handlers cannot hold
 * one open, and relaying 16 kHz audio through the server would add a hop to every word.
 * So the server is the boundary in a different way: the long-lived GEMINI_API_KEY never
 * leaves it, and the token it hands out has the model, the system instruction and the
 * tool list locked in, so a page edited in devtools can open a
 * session but cannot make it a different agent. Everything the tools do still goes back
 * through /api/voice/action, where the server decides.
 *
 * This is the expensive call — each session is minutes of realtime model time — so it has
 * its own, much smaller budget than chat. Audio frames are not rate limited; sessions are.
 */

const MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const SESSIONS_PER_HOUR = 6;
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

export async function POST(req: Request) {
  // `Gemini_API` is how it is named in Vercel; GEMINI_API_KEY is the conventional name.
  const apiKey = process.env.GEMINI_API_KEY || process.env.Gemini_API;
  if (!apiKey) {
    console.error("[voice] GEMINI_API_KEY missing");
    return Response.json(
      { error: "Voice is not available right now. You can keep using the text assistant.", code: "unavailable" },
      { status: 503 },
    );
  }

  const retryAfter = await overLimit(clientIp(req), "voice-session", SESSIONS_PER_HOUR);
  if (retryAfter)
    return tooMany(
      `This demo allows ${SESSIONS_PER_HOUR} voice sessions an hour. The text assistant is still open.`,
      retryAfter,
    );

  // One object serves twice: locked into the token here, and sent verbatim by the browser
  // as the first frame on the socket. Being identical, the two can never disagree.
  const setup = {
    model: `models/${MODEL}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: voiceInstruction() }] },
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    // Background noise was being taken for the patient barging in, cutting the agent off
    // mid-question. Speech now has to be clearly speech (low start sensitivity, 300 ms of
    // it) before it counts, and it never interrupts the agent: interrupting is deliberate —
    // a tap on the orb. Whatever is heard meanwhile is still answered afterwards.
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        prefixPaddingMs: 300,
        silenceDurationMs: 700,
      },
      activityHandling: "NO_INTERRUPTION",
    },
    // Both transcripts are what the page shows, and the input one is what the red-flag
    // and consent checks read. Without them the browser would be flying blind.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  const now = Date.now();
  let token: string | undefined;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        uses: 1,
        // The WebSocket must open within two minutes; the session may then run up to 30.
        newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        // The REST name for what the SDKs call liveConnectConstraints (verified against the
        // live endpoint — the SDK name is rejected here as an unknown field).
        bidiGenerateContentSetup: setup,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ");
      console.error(`[voice] token HTTP ${res.status} ${body.slice(0, 300)}`);
    } else {
      token = (await res.json())?.name;
    }
  } catch (err) {
    console.error("[voice] token request failed:", err instanceof Error ? err.name : err);
  }

  if (!token)
    return Response.json(
      { error: "Voice is not available right now. You can keep using the text assistant.", code: "unavailable" },
      { status: 502 },
    );

  return Response.json({ token, setup }, { headers: { "Cache-Control": "no-store" } });
}
