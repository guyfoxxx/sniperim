import { buildNewsScoringPrompt } from "./prompts";
import { safeJsonParse } from "./utils";

export async function fetchNewsBundle(env: any, symbol: string): Promise<{ headlines: string[]; sources: any[]; gemmaScore: number; gemmaReasons: string[]; gemmaSummary: string[]; }> {
  const q = symbolToQuery(symbol);

  const headlines: string[] = [];
  const sources: any[] = [];

  // 1) NewsAPI
  if (env.NEWSAPI_KEY) {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", q);
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "7");
    const res = await fetch(url.toString(), { headers: { "X-Api-Key": env.NEWSAPI_KEY } });
    if (res.ok) {
      const data: any = await res.json();
      for (const a of (data.articles || [])) {
        if (a?.title) {
          headlines.push(a.title);
          sources.push({ from: "newsapi", title: a.title, url: a.url, source: a.source?.name, publishedAt: a.publishedAt });
        }
      }
    }
  }

  // 2) Google CSE
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX) {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", env.GOOGLE_CSE_KEY);
    url.searchParams.set("cx", env.GOOGLE_CSE_CX);
    url.searchParams.set("q", q);
    url.searchParams.set("num", "5");
    const res = await fetch(url.toString());
    if (res.ok) {
      const data: any = await res.json();
      for (const it of (data.items || [])) {
        if (it?.title) {
          headlines.push(it.title);
          sources.push({ from: "google", title: it.title, url: it.link, snippet: it.snippet });
        }
      }
    }
  }

  const deduped = Array.from(new Set(headlines)).slice(0, 10);

  // 3) Gemma scoring (Workers AI)
  let gemmaScore = 5;
  let gemmaReasons: string[] = [];
  let gemmaSummary: string[] = [];
  if (deduped.length && env.AI && env.CF_GEMMA_MODEL) {
    const prompt = buildNewsScoringPrompt(deduped);
    try {
      const out: any = await env.AI.run(env.CF_GEMMA_MODEL, { prompt });
      // Workers AI returns { response } for text models
      const text = String(out?.response || out?.result || "");
      const parsed = safeJsonParse<any>(extractJson(text));
      if (parsed?.score) gemmaScore = Number(parsed.score);
      if (Array.isArray(parsed?.reasons)) gemmaReasons = parsed.reasons.map(String).slice(0, 5);
      if (Array.isArray(parsed?.summary)) gemmaSummary = parsed.summary.map(String).slice(0, 6);
    } catch {
      // ignore
    }
  }

  return { headlines: deduped, sources, gemmaScore: clamp10(gemmaScore), gemmaReasons, gemmaSummary };
}

function clamp10(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function extractJson(text: string): string {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : "{}";
}

function symbolToQuery(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("USDT")) return `${s.replace("USDT","")} crypto market news`;
  if (s === "XAUUSD") return "gold price news forex";
  if (s === "XAGUSD") return "silver price news forex";
  if (s === "US30") return "Dow Jones futures news";
  if (s === "NAS100") return "Nasdaq 100 futures news";
  if (s === "SPX500") return "S&P 500 futures news";
  // majors
  return `${s.slice(0,3)}/${s.slice(3)} forex news`;
}
