import type { AssetCategory, AssetSymbol, SignalRequest, UserMemory, UserProfile } from "./types";
import {
  mainMenu,
  signalMenu,
  symbolsMenu,
  assetActionMenu,
  formatProfileText,
  formatReferralText,
  formatWalletText,
  formatSupportText,
  formatUsageBlocked,
  formatAskChart,
  formatAskPrompt
} from "./telegram";
import { makeReferralCode, nowISO, mdEscape, isAdmin, safeJsonParse, type Env } from "./utils";
import { analyzeChartWithVision, generateSignal, generateSignalImage } from "./llm";
import { fetchNewsBundle } from "./news";

type UserState = { profile: UserProfile; memory: UserMemory };

const USER_KEY = (id: number) => `user:${id}`;
const REF_KEY = (code: string) => `ref:${code}`;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    // Telegram webhook (protected by secret path)
    if (url.pathname === `/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const update = await req.json();
      ctx.waitUntil(
        handleTelegramUpdate(update, env).catch((err) => {
          console.error("handleTelegramUpdate failed:", err);
        })
      );
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function handleTelegramUpdate(update: any, env: Env): Promise<void> {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;

  // ---- messages ----
  if (msg) {
    const chatId = msg.chat?.id;
    const from = msg.from;
    if (!chatId || !from?.id) return;

    const userId = Number(from.id);
    const text: string = msg.text || "";

    if (!env.BOT_KV) {
      await tgSendMessage(env, chatId, "⚠️ تنظیمات ناقص است: KV با نام BOT_KV در Bindings ست نشده.", undefined, true);
      return;
    }

    const startPayload = text.startsWith("/start") ? (text.split(" ")[1] || "") : "";
    const state = await ensureUserKV(env, userId, from, startPayload);

    // commands
    if (text.startsWith("/start")) {
      await tgSendMessage(env, chatId, welcomeText(state.profile), mainMenu(), true);
      return;
    }
    if (text.startsWith("/help")) {
      await tgSendMessage(env, chatId, helpText(), mainMenu(), true);
      return;
    }

    // admin tools
    if (text.startsWith("/admin_add_balance") && isAdmin(env, userId)) {
      const parts = text.trim().split(/\s+/);
      const target = Number(parts[1]);
      const amount = Number(parts[2] || 0);
      if (!target || !amount) {
        await tgSendMessage(env, chatId, "فرمت: /admin_add_balance <userId> <amount>", undefined, true);
        return;
      }
      const st = await ensureUserKV(env, target, { id: target }, "");
      st.profile.walletBalance += amount;
      st.profile.plan = "wallet";
      await saveState(env, target, st);
      await tgSendMessage(env, chatId, `✅ شارژ شد: ${target} +${amount}`, undefined, true);
      return;
    }

    if (text.startsWith("/admin_grant_uses") && isAdmin(env, userId)) {
      const parts = text.trim().split(/\s+/);
      const target = Number(parts[1]);
      const uses = Number(parts[2] || 0);
      if (!target || !uses) {
        await tgSendMessage(env, chatId, "فرمت: /admin_grant_uses <userId> <uses>", undefined, true);
        return;
      }
      const st = await ensureUserKV(env, target, { id: target }, "");
      st.profile.bonusUsesRemaining += uses;
      st.profile.plan = "referral";
      await saveState(env, target, st);
      await tgSendMessage(env, chatId, `✅ استفاده بونوس اضافه شد: ${target} +${uses}`, undefined, true);
      return;
    }

    // pending actions
    const pending = state.memory.pendingAction || "none";

    // Photo chart flow
    if (pending === "awaiting_chart") {
      const sym = state.memory.pendingSymbol;
      const cat = state.memory.pendingCategory;
      if (!sym || !cat) {
        state.memory.pendingAction = "none";
        await saveState(env, userId, state);
        await tgSendMessage(env, chatId, "ابتدا از منو نماد را انتخاب کنید.", mainMenu(), true);
        return;
      }

      // must have photo
      const photoArr = msg.photo;
      const doc = msg.document;
      let fileId: string | null = null;
      let mime = "image/jpeg";
      if (Array.isArray(photoArr) && photoArr.length) {
        fileId = photoArr[photoArr.length - 1].file_id;
        mime = "image/jpeg";
      } else if (doc?.mime_type?.startsWith("image/") && doc?.file_id) {
        fileId = doc.file_id;
        mime = doc.mime_type;
      }

      if (!fileId) {
        await tgSendMessage(env, chatId, "لطفاً یک عکس چارت ارسال کنید.", undefined, true);
        return;
      }

      if (!consumeOneUse(state.profile)) {
        await tgSendMessage(env, chatId, formatUsageBlocked(), mainMenu(), true);
        return;
      }

      await tgSendMessage(env, chatId, "⏳ در حال تحلیل چارت و خبرها...", undefined, true);

      const tgFile = await tgGetFile(env, fileId);
      const filePath = tgFile?.result?.file_path;
      if (!filePath) {
        await tgSendMessage(env, chatId, "خطا در دریافت فایل از تلگرام.", mainMenu(), true);
        return;
      }
      const bytes = await tgDownloadFileBytes(env, filePath);

      const vision = await analyzeChartWithVision(env, bytes, mime);
      const news = await fetchNewsBundle(env, sym);

      const newsBlock = renderNewsBlock(news.headlines, news.gemmaScore, news.gemmaReasons);
      const memorySummary = buildMemorySummary(state.memory);

      const req: SignalRequest = {
        userId,
        chatId,
        symbol: sym,
        category: cat,
        timeframe: state.memory.lastTimeframe || env.DEFAULT_TIMEFRAME || "H1",
        style: state.memory.lastStyle || env.DEFAULT_STYLE || "swing",
        risk: state.memory.lastRisk || env.RISK_PROFILE || "medium",
        userPrompt: "تحلیل آموزشی بر اساس تصویر چارت"
      };

      const sig = await generateSignal(env, req, memorySummary, vision.summary, newsBlock);
      sig.signal.newsScoreByGemma = news.gemmaScore;
      if (news.gemmaSummary?.length) sig.signal.newsSummary = news.gemmaSummary;

      const textOut = formatSignalMessage(sig.signal, sig.provider, vision.provider);
      await tgSendMessage(env, chatId, textOut, mainMenu(), true);

      // optional image card
      const img = await generateSignalImage(env, sig.signal.symbol, sig.signal.direction, sig.signal.timeframe);
      if (img?.dataBase64) {
        await tgSendPhoto(env, chatId, img.dataBase64, img.mime, `🧾 کارت سیگنال (${img.provider})`);
      }

      // update memory
      state.memory.pendingAction = "none";
      state.memory.pendingSymbol = undefined;
      state.memory.pendingCategory = undefined;
      state.memory.lastSymbol = sym;
      state.memory.lastCategory = cat;
      addNote(state.memory, noteFromSignal(sig.signal));
      await saveState(env, userId, state);

      return;
    }

    // Prompt flow
    if (pending === "awaiting_prompt") {
      const sym = state.memory.pendingSymbol;
      const cat = state.memory.pendingCategory;
      if (!sym || !cat) {
        state.memory.pendingAction = "none";
        await saveState(env, userId, state);
        await tgSendMessage(env, chatId, "ابتدا از منو نماد را انتخاب کنید.", mainMenu(), true);
        return;
      }

      const userPrompt = (msg.text || "").trim();
      if (!userPrompt) {
        await tgSendMessage(env, chatId, "لطفاً یک متن/پرامپت ارسال کنید.", undefined, true);
        return;
      }

      if (!consumeOneUse(state.profile)) {
        await tgSendMessage(env, chatId, formatUsageBlocked(), mainMenu(), true);
        return;
      }

      await tgSendMessage(env, chatId, "⏳ در حال تحلیل خبرها و تولید سیگنال...", undefined, true);

      const news = await fetchNewsBundle(env, sym);
      const newsBlock = renderNewsBlock(news.headlines, news.gemmaScore, news.gemmaReasons);
      const memorySummary = buildMemorySummary(state.memory);

      const req: SignalRequest = {
        userId,
        chatId,
        symbol: sym,
        category: cat,
        timeframe: state.memory.lastTimeframe || env.DEFAULT_TIMEFRAME || "H1",
        style: state.memory.lastStyle || env.DEFAULT_STYLE || "swing",
        risk: state.memory.lastRisk || env.RISK_PROFILE || "medium",
        userPrompt
      };

      const sig = await generateSignal(env, req, memorySummary, "", newsBlock);
      sig.signal.newsScoreByGemma = news.gemmaScore;
      if (news.gemmaSummary?.length) sig.signal.newsSummary = news.gemmaSummary;

      const textOut = formatSignalMessage(sig.signal, sig.provider, "none");
      await tgSendMessage(env, chatId, textOut, mainMenu(), true);

      const img = await generateSignalImage(env, sig.signal.symbol, sig.signal.direction, sig.signal.timeframe);
      if (img?.dataBase64) {
        await tgSendPhoto(env, chatId, img.dataBase64, img.mime, `🧾 کارت سیگنال (${img.provider})`);
      }

      // update memory
      state.memory.pendingAction = "none";
      state.memory.pendingSymbol = undefined;
      state.memory.pendingCategory = undefined;
      state.memory.lastSymbol = sym;
      state.memory.lastCategory = cat;
      addNote(state.memory, noteFromSignal(sig.signal));
      await saveState(env, userId, state);

      return;
    }

    // If user sends random photo/text without pending state, show menu hint
    if ((Array.isArray(msg.photo) && msg.photo.length) || msg.document?.mime_type?.startsWith("image/")) {
      await tgSendMessage(env, chatId, "برای تحلیل، ابتدا از «📈 دریافت سیگنال» نماد را انتخاب کنید.", mainMenu(), true);
      return;
    }

    // default fallback
    await tgSendMessage(env, chatId, "از منو یکی از گزینه‌ها را انتخاب کنید.", mainMenu(), true);
    return;
  }

  // ---- callbacks ----
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const from = cb.from;
    const data = String(cb.data || "");
    if (!chatId || !from?.id) return;

    const userId = Number(from.id);

    if (!env.BOT_KV) {
      await tgAnswerCallback(env, cb.id);
      await tgSendMessage(env, chatId, "⚠️ KV با نام BOT_KV ست نشده.", undefined, true);
      return;
    }

    const state = await ensureUserKV(env, userId, from, "");

    // Ack callback to remove loading spinner
    await tgAnswerCallback(env, cb.id);

    if (data === "menu:home") {
      await tgEditMessage(env, chatId, cb.message.message_id, welcomeText(state.profile), mainMenu(), true);
      return;
    }

    if (data === "menu:signal") {
      await tgEditMessage(env, chatId, cb.message.message_id, "📈 یک دسته را انتخاب کنید:", signalMenu(), true);
      return;
    }

    if (data.startsWith("cat:")) {
      const cat = data.split(":")[1] as AssetCategory;
      state.memory.lastCategory = cat;
      await saveState(env, userId, state);
      await tgEditMessage(env, chatId, cb.message.message_id, "نماد را انتخاب کنید:", symbolsMenu(cat), true);
      return;
    }

    if (data.startsWith("sym:")) {
      const [, cat, sym] = data.split(":");
      state.memory.lastCategory = cat as AssetCategory;
      state.memory.lastSymbol = sym as AssetSymbol;
      await saveState(env, userId, state);
      await tgEditMessage(env, chatId, cb.message.message_id, `گزینه را انتخاب کنید: *${mdEscape(sym)}*`, assetActionMenu(cat as any, sym as any), true);
      return;
    }

    if (data.startsWith("act:chart:")) {
      const [, , cat, sym] = data.split(":");
      state.memory.pendingAction = "awaiting_chart";
      state.memory.pendingCategory = cat as AssetCategory;
      state.memory.pendingSymbol = sym as AssetSymbol;
      await saveState(env, userId, state);
      await tgSendMessage(env, chatId, formatAskChart(sym), undefined, true);
      return;
    }

    if (data.startsWith("act:prompt:")) {
      const [, , cat, sym] = data.split(":");
      state.memory.pendingAction = "awaiting_prompt";
      state.memory.pendingCategory = cat as AssetCategory;
      state.memory.pendingSymbol = sym as AssetSymbol;
      await saveState(env, userId, state);
      await tgSendMessage(env, chatId, formatAskPrompt(sym), undefined, true);
      return;
    }

    if (data.startsWith("act:news:")) {
      const [, , cat, sym] = data.split(":");
      const news = await fetchNewsBundle(env, sym as any);
      const text = [
        `📰 خبرهای مرتبط با *${mdEscape(sym)}*`,
        "",
        ...news.headlines.slice(0, 8).map((h, i) => `${i + 1}) ${mdEscape(h)}`),
        "",
        `⭐️ امتیاز Gemma: *${news.gemmaScore}/10*`,
        ...(news.gemmaReasons?.length ? ["دلایل:", ...news.gemmaReasons.map((r) => `• ${mdEscape(r)}`)] : [])
      ].join("\n");
      await tgEditMessage(env, chatId, cb.message.message_id, text, assetActionMenu(cat as any, sym as any), true);
      return;
    }

    if (data === "menu:profile") {
      await tgEditMessage(env, chatId, cb.message.message_id, formatProfileText(state.profile), mainMenu(), true);
      return;
    }
    if (data === "menu:wallet") {
      await tgEditMessage(env, chatId, cb.message.message_id, formatWalletText(state.profile), mainMenu(), true);
      return;
    }
    if (data === "menu:referral") {
      await tgEditMessage(env, chatId, cb.message.message_id, formatReferralText(state.profile, env.BOT_USERNAME), mainMenu(), true);
      return;
    }
    if (data === "menu:support") {
      await tgEditMessage(env, chatId, cb.message.message_id, formatSupportText(), mainMenu(), true);
      return;
    }
  }
}

// -------- KV user state --------

async function ensureUserKV(env: Env, userId: number, from: any, startPayload: string): Promise<UserState> {
  const existing = await loadState(env, userId);
  if (existing) {
    const username = from?.username;
    const firstName = from?.first_name;
    let changed = false;
    if (username && existing.profile.username !== username) { existing.profile.username = username; changed = true; }
    if (firstName && existing.profile.firstName !== firstName) { existing.profile.firstName = firstName; changed = true; }
    if (changed) await saveState(env, userId, existing);
    return existing;
  }

  const freeUses = Number(env.FREE_USES || "3");
  const profile: UserProfile = {
    id: userId,
    username: from?.username,
    firstName: from?.first_name,
    language: (env.BOT_LOCALE as any) || "fa",
    createdAt: nowISO(),
    freeUsesRemaining: freeUses,
    bonusUsesRemaining: 0,
    referralCode: makeReferralCode(userId),
    referrals: 0,
    walletBalance: 0,
    plan: "free"
  };

  const memory: UserMemory = {
    pendingAction: "none",
    recentNotes: []
  };

  const st: UserState = { profile, memory };

  // store referral code map
  await env.BOT_KV.put(REF_KEY(profile.referralCode), String(userId));

  // handle referral payload
  const code = (startPayload || "").trim().toUpperCase();
  if (code && code !== profile.referralCode) {
    const inviterIdStr = await env.BOT_KV.get(REF_KEY(code));
    const inviterId = inviterIdStr ? Number(inviterIdStr) : 0;
    if (inviterId && inviterId !== userId) {
      st.profile.referredBy = code;

      const inviterState = await loadState(env, inviterId);
      if (inviterState) {
        inviterState.profile.referrals += 1;
        const need = Number(env.REFERRALS_FOR_BONUS || "5");
        const bonus = Number(env.BONUS_USES || "3");
        if (inviterState.profile.referrals % need === 0) {
          inviterState.profile.bonusUsesRemaining += bonus;
          inviterState.profile.plan = "referral";
        }
        await saveState(env, inviterId, inviterState);
      }
    }
  }

  await saveState(env, userId, st);
  return st;
}

async function loadState(env: Env, userId: number): Promise<UserState | null> {
  const raw = await env.BOT_KV.get(USER_KEY(userId));
  if (!raw) return null;
  return safeJsonParse<UserState>(raw);
}

async function saveState(env: Env, userId: number, st: UserState): Promise<void> {
  await env.BOT_KV.put(USER_KEY(userId), JSON.stringify(st));
}

function consumeOneUse(p: UserProfile): boolean {
  if (p.freeUsesRemaining > 0) {
    p.freeUsesRemaining -= 1;
    return true;
  }
  if (p.bonusUsesRemaining > 0) {
    p.bonusUsesRemaining -= 1;
    return true;
  }
  if (p.walletBalance > 0) {
    p.walletBalance -= 1;
    p.plan = "wallet";
    return true;
  }
  return false;
}

function buildMemorySummary(m: UserMemory): string {
  const notes = (m.recentNotes || []).slice(-8);
  if (!notes.length) return "";
  return notes.map((x, i) => `${i + 1}. ${x}`).join("\n");
}

function addNote(m: UserMemory, note: string): void {
  if (!note) return;
  const arr = m.recentNotes || [];
  arr.push(note);
  m.recentNotes = arr.slice(-12);
}

// -------- Telegram helpers --------

async function tgApi(env: Env, method: string, payload: any): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const txt = await res.text();
  const json = safeJsonParse<any>(txt);
  if (!res.ok || !json?.ok) {
    console.error("Telegram API error", method, res.status, txt);
    throw new Error(`Telegram API failed: ${method}`);
  }
  return json;
}

async function tgSendMessage(env: Env, chatId: number, text: string, keyboard?: any, markdown = false): Promise<void> {
  await tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: markdown ? "MarkdownV2" : undefined,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    disable_web_page_preview: true
  });
}

async function tgEditMessage(env: Env, chatId: number, messageId: number, text: string, keyboard?: any, markdown = false): Promise<void> {
  await tgApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: markdown ? "MarkdownV2" : undefined,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    disable_web_page_preview: true
  });
}

async function tgAnswerCallback(env: Env, callbackQueryId: string): Promise<void> {
  await tgApi(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
}

async function tgGetFile(env: Env, fileId: string): Promise<any> {
  return tgApi(env, "getFile", { file_id: fileId });
}

async function tgDownloadFileBytes(env: Env, filePath: string): Promise<ArrayBuffer> {
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  return await res.arrayBuffer();
}

async function tgSendPhoto(env: Env, chatId: number, dataBase64: string, mime: string, caption: string): Promise<void> {
  const boundary = "----sniperlm" + Math.random().toString(16).slice(2);
  const crlf = "\r\n";

  const bin = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
  const filename = "signal." + (mime === "image/png" ? "png" : "jpg");

  const parts: Uint8Array[] = [];
  const pushStr = (s: string) => parts.push(new TextEncoder().encode(s));

  pushStr(`--${boundary}${crlf}`);
  pushStr(`Content-Disposition: form-data; name="chat_id"${crlf}${crlf}${chatId}${crlf}`);

  pushStr(`--${boundary}${crlf}`);
  pushStr(`Content-Disposition: form-data; name="caption"${crlf}${crlf}${caption}${crlf}`);

  pushStr(`--${boundary}${crlf}`);
  pushStr(`Content-Disposition: form-data; name="photo"; filename="${filename}"${crlf}`);
  pushStr(`Content-Type: ${mime}${crlf}${crlf}`);
  parts.push(bin);
  pushStr(crlf);

  pushStr(`--${boundary}--${crlf}`);

  const body = new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` });

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("sendPhoto failed", res.status, t);
  }
}

// -------- Rendering --------

function welcomeText(profile: any): string {
  return [
    "🤖 *SniperLM* آماده است.",
    "",
    "از منوی زیر یک گزینه را انتخاب کنید:",
    "",
    `• سهمیه باقی‌مانده: رایگان *${profile.freeUsesRemaining}* | بونوس *${profile.bonusUsesRemaining}* | کیف‌پول *${profile.walletBalance}*`
  ].join("\n");
}

function helpText(): string {
  return [
    "ℹ️ *راهنما*",
    "1) «دریافت سیگنال» → دسته و نماد را انتخاب کنید",
    "2) سپس «ارسال چارت» یا «نوشتن پرامپت» را بزنید",
    "",
    "دستورها:",
    "• /start",
    "• /help"
  ].join("\n");
}

function noteFromSignal(sig: any): string {
  const dir = sig.direction || "";
  const tf = sig.timeframe || "";
  const conf = sig.confidence || "";
  const entry = sig.entry ?? "";
  return `${sig.symbol} ${tf} ${dir} (conf ${conf}%) entry ${entry}`;
}

function formatSignalMessage(sig: any, llmProvider: string, visionProvider: string): string {
  const lines: string[] = [];
  lines.push(`📌 *سیگنال آموزشی* برای *${mdEscape(sig.symbol)}*`);
  lines.push(`⏱ تایم‌فریم: *${mdEscape(sig.timeframe)}* | سبک: *${mdEscape(sig.style)}*`);
  lines.push(`🧭 جهت: *${mdEscape(sig.direction)}* | اطمینان: *${sig.confidence}%*`);
  lines.push("");
  lines.push(`🎯 Entry: \`${mdEscape(String(sig.entry))}\``);
  lines.push(`🛑 SL: \`${mdEscape(String(sig.stopLoss))}\``);
  if (sig.takeProfits?.length) {
    lines.push(`✅ TP ها:`);
    for (const tp of sig.takeProfits) lines.push(`• \`${mdEscape(String(tp))}\``);
  }
  if (sig.keyLevels?.length) {
    lines.push("");
    lines.push("🧱 سطوح کلیدی:");
    for (const lv of sig.keyLevels) lines.push(`• \`${mdEscape(String(lv))}\``);
  }
  if (sig.rationale) {
    lines.push("");
    lines.push("📝 دلیل:");
    lines.push(mdEscape(String(sig.rationale)));
  }
  if (sig.newsSummary) {
    lines.push("");
    lines.push(`📰 خلاصه خبر: ${mdEscape(String(sig.newsSummary))}`);
    lines.push(`⭐️ امتیاز خبر (Gemma): *${sig.newsScoreByGemma}/10*`);
  }
  lines.push("");
  lines.push(`🤖 مدل متن: *${mdEscape(llmProvider)}*`);
  lines.push(`👁️ مدل ویژن: *${mdEscape(visionProvider)}*`);
  lines.push("");
  lines.push(`📎 ${mdEscape(sig.disclaimer || "این خروجی صرفاً آموزشی است و توصیه مالی نیست.")}`);
  return lines.join("\n");
}

function renderNewsBlock(headlines: string[], score: number, reasons: string[]): string {
  const h = (headlines || []).slice(0, 8).map((x, i) => `${i + 1}. ${x}`).join("\n");
  const r = reasons?.length ? "\nدلایل:\n" + reasons.slice(0, 4).map((x) => `- ${x}`).join("\n") : "";
  return `امتیاز Gemma: ${score}/10\nخبرها:\n${h}${r}`;
}
