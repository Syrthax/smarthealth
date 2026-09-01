const URL = "https://api.featherless.ai/v1/chat/completions";
// meta-llama/* is HuggingFace-gated on this account (403). Qwen2.5-14B is ungated,
// holds the JSON contract reliably, and is the largest that stays responsive here.
const MODEL = process.env.FEATHERLESS_MODEL || "Qwen/Qwen2.5-14B-Instruct";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

/** Featherless is OpenAI-compatible. Returns null on any failure — callers degrade. */
export async function callFeatherless(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
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
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content) return String(content).trim();
      console.error(`[featherless] empty completion (attempt ${attempt}/${MAX_RETRIES})`);
    } catch (err) {
      const reason = err instanceof Error ? err.name : String(err);
      console.error(`[featherless] request failed: ${reason} (attempt ${attempt}/${MAX_RETRIES})`);
    }
  }
  return null;
}
