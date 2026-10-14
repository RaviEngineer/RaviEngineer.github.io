// Claude (translation, post kit) and ElevenLabs (dubbing) calls, made directly
// from the browser with the user's own keys.
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.130.0/+esm";
const MODEL = "claude-opus-5-5";

let sdkPromise = null;
function loadSdk() {
  sdkPromise ??= import(SDK_URL).then((m) => m.default);
  return sdkPromise;
}

async function askClaude({ apiKey, system, prompt, schema }) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    // Re-runs the request on a fallback model if a safety classifier declines it.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined this request. Try different content.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The response was cut off — try a shorter video.");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return JSON.parse(text);
}

export function describeError(err) {
  const status = err?.status;
  if (status === 401) return "That API key was rejected. Check it in Settings.";
  if (status === 429) return "Rate limited by the provider — wait a moment and try again.";
  if (status === 529 || status >= 500) return "The AI service is busy right now — try again shortly.";
  return err?.message ?? String(err);
}

export async function translateSegments({ apiKey, segments, language }) {
  const schema = {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "integer" }, text: { type: "string" } },
          required: ["id", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["segments"],
    additionalProperties: false,
  };
  const result = await askClaude({
    apiKey,
    schema,
    system:
      "You translate spoken video captions. Keep each segment's meaning, tone and approximate length " +
      "so it fits the same on-screen time. Write natural, conversational speech, not formal text. " +
      "Return every segment id exactly once.",
    prompt:
      `Translate these caption segments into ${language}.\n\n` +
      JSON.stringify(segments.map((s, id) => ({ id, text: s.text }))),
  });
  const byId = new Map(result.segments.map((s) => [s.id, s.text]));
  return segments.map((s, id) => ({ ...s, text: (byId.get(id) ?? s.text).trim() }));
}

export async function writePostKit({ apiKey, transcript }) {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      hook: { type: "string" },
      description: { type: "string" },
      hashtags: { type: "array", items: { type: "string" } },
      keywords: { type: "array", items: { type: "string" } },
    },
    required: ["title", "hook", "description", "hashtags", "keywords"],
    additionalProperties: false,
  };
  return askClaude({
    apiKey,
    schema,
    system:
      "You help creators publish short-form videos (Reels, Shorts, TikTok). Write in the video's own language.",
    prompt:
      "Here is the transcript of my video. Write:\n" +
      "- title: a punchy title under 70 characters\n" +
      "- hook: a stronger opening line I could say in the first 3 seconds\n" +
      "- description: 2-3 sentences for the post caption\n" +
      "- hashtags: 5-8 relevant hashtags without the # sign\n" +
      "- keywords: 4-10 single words copied exactly from the transcript that deserve visual emphasis\n\n" +
      `Transcript:\n${transcript}`,
  });
}

export async function synthesizeSpeech({ apiKey, voiceId, text }) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    },
  );
  if (!res.ok) {
    const err = new Error(`ElevenLabs error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.arrayBuffer();
}
