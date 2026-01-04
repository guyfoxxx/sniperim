export function nowISO(): string {
  return new Date().toISOString();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function base36(n: number): string {
  return n.toString(36);
}

// simple referral code: base36(userId) + "-" + 4 hex checksum
export function makeReferralCode(userId: number): string {
  const core = base36(userId);
  const chk = checksumHex(core).slice(0, 4);
  return `${core}-${chk}`.toUpperCase();
}

export function checksumHex(input: string): string {
  // no crypto module guaranteed; use subtle digest if available, else fallback
  // NOTE: checksum does not need to be cryptographically strong
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // unsigned
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function isAdmin(env: Env, userId: number): boolean {
  const ids = (env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  return ids.includes(String(userId));
}

export function mdEscape(s: string): string {
  // escape Telegram MarkdownV2 special chars
  // https://core.telegram.org/bots/api#markdownv2-style
  return s.replace(/([_\*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type Env = {
  BOT_LOCALE: string;
  BOT_USERNAME: string;

  DEFAULT_TIMEFRAME: string;
  DEFAULT_STYLE: string;
  RISK_PROFILE: string;

  FREE_USES: string;
  REFERRALS_FOR_BONUS: string;
  BONUS_USES: string;

  ADMIN_IDS: string;

  CF_TEXT_MODEL: string;
  CF_GEMMA_MODEL: string;
  CF_VISION_MODEL: string;
  CF_IMAGE_MODEL: string;

  OPENAI_TEXT_MODEL: string;
  OPENAI_VISION_MODEL: string;
  OPENAI_IMAGE_MODEL: string;

  GEMINI_TEXT_MODEL: string;

  NANOBANANA_API_URL: string;
  NANOBANANA_API_KEY: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;

  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  NEWSAPI_KEY?: string;
  GOOGLE_CSE_KEY?: string;
  GOOGLE_CSE_CX?: string;
  HUGGINGFACE_TOKEN?: string;

  AI: Ai;
  BOT_KV: KVNamespace;
};

export interface Ai {
  run(model: string, input: any): Promise<any>;
}

