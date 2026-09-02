const URL = "https://api.featherless.ai/v1/chat/completions";
// meta-llama/* is HuggingFace-gated on this account (403). Qwen2.5-14B is ungated,
// holds the JSON contract reliably, and is the largest that stays responsive here.
const MODEL = process.env.FEATHERLESS_MODEL || "Qwen/Qwen2.5-14B-Instruct";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

/**
 * Featherless is OpenAI-compatible. Streams the completion, handing each delta to
 * `onDelta` so the caller can forward prose while the rest of the object is still
 * generating. Resolves with the whole raw completion, or null on any failure.
 */
export async function callFeatherless(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  onDelta?: (full: string) => void,
): Promise<string | null> {
  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) {
    console.error("[featherless] FEATHERLESS_API_KEY missing");
    return null;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "system", content: system }, ...messages],
          max_tokens: 500,
          temperature: 0.3,
          response_format: { type: "json_object" },
          stream: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(
          `[featherless] HTTP ${res.status} (attempt ${attempt}/${MAX_RETRIES}) ${body.slice(0, 200)}`,
        );
        continue;
      }
      const content = await readStream(res, onDelta);
      if (content) return content.trim();
      console.error(`[featherless] empty completion (attempt ${attempt}/${MAX_RETRIES})`);
    } catch (err) {
      const reason = err instanceof Error ? err.name : String(err);
      console.error(`[featherless] request failed: ${reason} (attempt ${attempt}/${MAX_RETRIES})`);
    }
  }
  return null;
}

/** Server-sent events, OpenAI style: `data: {json}` lines terminated by `data: [DONE]`. */
async function readStream(res: Response, onDelta?: (full: string) => void): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffered = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    // Keep the trailing fragment: an event can be split across two network chunks.
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(full);
        }
      } catch {
        /* a malformed event is not worth abandoning the whole completion for */
      }
    }
  }
  return full;
}
