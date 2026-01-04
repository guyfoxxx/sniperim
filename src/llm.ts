import { buildSignalSystemPrompt, buildImagePromptForSignal } from "./prompts";
import type { SignalRequest, SignalOutput } from "./types";
import { safeJsonParse } from "./utils";

export async function analyzeChartWithVision(env: any, image: { mime: string; dataBase64: string }, symbol: string): Promise<{ summary: string; provider: string }> {
  // Order: OpenAI Vision → Cloudflare Vision → HuggingFace
  if (env.OPENAI_API_KEY) {
    const s = await openaiVision(env, image, symbol);
    if (s) return { summary: s, provider: "openai_vision" };
  }
  if (env.AI && env.CF_VISION_MODEL) {
    const s = await cfVision(env, image, symbol);
    if (s) return { summary: s, provider: "cloudflare_vision" };
  }
  if (env.HUGGINGFACE_TOKEN) {
    const s = await hfVision(env, image, symbol);
    if (s) return { summary: s, provider: "huggingface_vision" };
  }
  return { summary: "", provider: "none" };
}

export async function generateSignal(env: any, req: SignalRequest, memorySummary: string, visionSummary: string, newsBlock: string): Promise<{ signal: SignalOutput; provider: string; raw: string }> {
  const systemPrompt = buildSignalSystemPrompt(req, memorySummary, visionSummary, newsBlock);

  // Order: Cloudflare AI → OpenAI → Gemini
  if (env.AI && env.CF_TEXT_MODEL) {
    const r = await cfText(env, systemPrompt);
    if (r) return r;
  }
  if (env.OPENAI_API_KEY) {
    const r = await openaiText(env, systemPrompt);
    if (r) return r;
  }
  if (env.GEMINI_API_KEY) {
    const r = await geminiText(env, systemPrompt);
    if (r) return r;
  }

  // fallback
  const fallback: SignalOutput = {
    symbol: req.symbol,
    timeframe: req.timeframe || "H1",
    style: req.style || "swing",
    direction: "NEUTRAL",
    entry: "N/A",
    stopLoss: "N/A",
    takeProfits: [],
    confidence: 10,
    rationale: ["دسترسی به مدل‌ها ممکن نیست یا کلیدها تنظیم نشده‌اند."],
    keyLevels: [],
    newsSummary: [],
    newsScoreByGemma: 5,
    riskNotes: ["لطفاً کلیدهای API را در تنظیمات Worker اضافه کنید."],
    disclaimer: "این خروجی صرفاً آموزشی است و توصیه مالی نیست."
  };
  return { signal: fallback, provider: "none", raw: JSON.stringify(fallback) };
}

export async function generateSignalImage(env: any, symbol: string, direction: string, timeframe: string): Promise<{ dataBase64: string; mime: string; provider: string } | null> {
  const prompt = buildImagePromptForSignal(symbol, direction, timeframe);

  // Order: DALL·E/OpenAI Image → NanoBanana → Cloudflare image model
  if (env.OPENAI_API_KEY) {
    const img = await openaiImage(env, prompt);
    if (img) return { ...img, provider: "openai_image" };
  }
  if (env.NANOBANANA_API_URL && env.NANOBANANA_API_KEY) {
    const img = await nanoBananaImage(env, prompt);
    if (img) return { ...img, provider: "nanobanana" };
  }
  if (env.AI && env.CF_IMAGE_MODEL) {
    const img = await cfImage(env, prompt);
    if (img) return { ...img, provider: "cloudflare_image" };
  }
  return null;
}

// ---------------- Providers ----------------

async function cfText(env: any, prompt: string): Promise<{ signal: SignalOutput; provider: string; raw: string } | null> {
  try {
    const out: any = await env.AI.run(env.CF_TEXT_MODEL, { prompt });
    const text = String(out?.response || out?.result || "");
    const parsed = safeJsonParse<SignalOutput>(extractJson(text));
    if (!parsed) return null;
    return { signal: sanitizeSignal(parsed), provider: "cloudflare_ai", raw: text };
  } catch {
    return null;
  }
}

async function openaiText(env: any, prompt: string): Promise<{ signal: SignalOutput; provider: string; raw: string } | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a trading assistant. Return ONLY valid JSON." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || "");
    const parsed = safeJsonParse<SignalOutput>(extractJson(text));
    if (!parsed) return null;
    return { signal: sanitizeSignal(parsed), provider: "openai", raw: text };
  } catch {
    return null;
  }
}

async function geminiText(env: any, prompt: string): Promise<{ signal: SignalOutput; provider: string; raw: string } | null> {
  try {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_TEXT_MODEL || "gemini-1.5-flash"}:generateContent`);
    url.searchParams.set("key", env.GEMINI_API_KEY);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }]}],
        generationConfig: { temperature: 0.2 }
      })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || "");
    const parsed = safeJsonParse<SignalOutput>(extractJson(text));
    if (!parsed) return null;
    return { signal: sanitizeSignal(parsed), provider: "gemini", raw: text };
  } catch {
    return null;
  }
}

async function openaiVision(env: any, image: { mime: string; dataBase64: string }, symbol: string): Promise<string | null> {
  try {
    const dataUrl = `data:${image.mime};base64,${image.dataBase64}`;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_VISION_MODEL || env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You analyze trading charts. Reply in Persian with a compact bullet list summary: trend, structure, key levels, patterns, indicators if visible." },
          { role: "user", content: [
            { type: "text", text: `این تصویر چارت مربوط به ${symbol} است. خلاصه تحلیل تکنیکال بده.` },
            { type: "image_url", image_url: { url: dataUrl } }
          ]}
        ],
        temperature: 0.2
      })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return String(data?.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}

async function cfVision(env: any, image: { mime: string; dataBase64: string }, symbol: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(image.dataBase64), (c) => c.charCodeAt(0));
    const out: any = await env.AI.run(env.CF_VISION_MODEL, {
      image: Array.from(bytes),
      prompt: `You are a trading chart analyst. Summarize trend/levels/patterns for ${symbol} in Persian.`
    });
    const text = String(out?.description || out?.response || out?.result || "");
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function hfVision(env: any, image: { mime: string; dataBase64: string }, symbol: string): Promise<string | null> {
  try {
    // Generic HF Inference endpoint for image-to-text, user can set their preferred model via env later.
    // We'll use a common captioning model by default.
    const model = "Salesforce/blip-image-captioning-large";
    const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.HUGGINGFACE_TOKEN}`,
        "Content-Type": image.mime
      },
      body: Uint8Array.from(atob(image.dataBase64), (c) => c.charCodeAt(0))
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const caption = Array.isArray(data) ? String(data?.[0]?.generated_text || "") : String(data?.generated_text || "");
    if (!caption) return null;
    return `کپشن/توضیح تصویر (HF): ${caption}\n(برای تحلیل دقیق‌تر، OpenAI/Cloudflare Vision را فعال کنید.)`;
  } catch {
    return null;
  }
}

async function openaiImage(env: any, prompt: string): Promise<{ dataBase64: string; mime: string } | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/images", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_IMAGE_MODEL || "gpt-image-1",
        prompt,
        size: "1024x1024"
      })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return null;
    return { dataBase64: String(b64), mime: "image/png" };
  } catch {
    return null;
  }
}

async function nanoBananaImage(env: any, prompt: string): Promise<{ dataBase64: string; mime: string } | null> {
  try {
    const res = await fetch(env.NANOBANANA_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NANOBANANA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    // expected: { b64: "...", mime: "image/png" }
    const b64 = data?.b64 || data?.dataBase64;
    if (!b64) return null;
    return { dataBase64: String(b64), mime: String(data?.mime || "image/png") };
  } catch {
    return null;
  }
}

async function cfImage(env: any, prompt: string): Promise<{ dataBase64: string; mime: string } | null> {
  try {
    const out: any = await env.AI.run(env.CF_IMAGE_MODEL, { prompt });
    // Many Workers AI image models return base64 in `image` or `result`
    const b64 = out?.image || out?.result || out?.response;
    if (!b64) return null;
    return { dataBase64: String(b64), mime: "image/png" };
  } catch {
    return null;
  }
}

// ---------------- Helpers ----------------

function extractJson(text: string): string {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : "{}";
}

function sanitizeSignal(s: any): SignalOutput {
  const takeProfits = Array.isArray(s.takeProfits) ? s.takeProfits.map(String).slice(0, 5) : [];
  const rationale = Array.isArray(s.rationale) ? s.rationale.map(String).slice(0, 8) : [];
  const keyLevels = Array.isArray(s.keyLevels) ? s.keyLevels.map(String).slice(0, 10) : [];
  const newsSummary = Array.isArray(s.newsSummary) ? s.newsSummary.map(String).slice(0, 8) : [];
  const riskNotes = Array.isArray(s.riskNotes) ? s.riskNotes.map(String).slice(0, 6) : [];
  const confidence = Number(s.confidence);
  const newsScore = Number(s.newsScoreByGemma);

  return {
    symbol: String(s.symbol || ""),
    timeframe: String(s.timeframe || "H1"),
    style: String(s.style || "swing"),
    direction: (String(s.direction || "NEUTRAL").toUpperCase() as any),
    entry: String(s.entry || "N/A"),
    stopLoss: String(s.stopLoss || "N/A"),
    takeProfits,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 0,
    rationale,
    keyLevels,
    newsSummary,
    newsScoreByGemma: Number.isFinite(newsScore) ? Math.max(1, Math.min(10, Math.round(newsScore))) : 5,
    riskNotes,
    disclaimer: String(s.disclaimer || "این خروجی صرفاً آموزشی است و توصیه مالی نیست.")
  };
}
