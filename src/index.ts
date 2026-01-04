import type { AssetCategory, AssetSymbol, SignalRequest, UserMemory, UserProfile } from "./types";
import { mainMenu, signalMenu, symbolsMenu, assetActionMenu, formatProfileText, formatReferralText, formatWalletText, formatSupportText, formatUsageBlocked, formatAskChart, formatAskPrompt } from "./telegram";
import { makeReferralCode, nowISO, mdEscape, isAdmin, safeJsonParse, type Env } from "./utils";
import { analyzeChartWithVision, generateSignal, generateSignalImage } from "./llm";
import { fetchNewsBundle } from "./news";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    // Telegram webhook (protected by secret path)
    if (url.pathname === `/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const update = await req.json();
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleTelegramUpdate(update: any, env: Env): Promise<void> {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;

  if (msg) {
    const chatId = msg.chat?.id;
    const from = msg.from;
    if (!chatId || !from?.id) return;
    const userId = Number(from.id);

    const stub = env.USER_DO.get(env.USER_DO.idFromName(String(userId)));
    const state = await stub.fetch("https://do/state", {
      method: "POST",
      body: JSON.stringify({ type: "ensure_user", from: sanitizeFrom(from), startPayload: msg.text?.startsWith("/start") ? (msg.text.split(" ")[1] || "") : "" })
    }).then(r => r.json());

    // commands
    const text: string = msg.text || "";
    if (text.startsWith("/start")) {
      await tgSendMessage(env, chatId, welcomeText(state.profile), mainMenu());
      return;
    }
    if (text.startsWith("/help")) {
      await tgSendMessage(env, chatId, helpText(), mainMenu());
      return;
    }

    // admin
    if (text.startsWith("/admin_add_balance") && isAdmin(env, userId)) {
      const parts = text.trim().split(/\s+/);
      const target = Number(parts[1]);
      const amount = Number(parts[2] || 0);
      if (!target || !amount) {
        await tgSendMessage(env, chatId, "فرمت: /admin_add_balance <userId> <amount>");
        return;
      }
      const stub2 = env.USER_DO.get(env.USER_DO.idFromName(String(target)));
      await stub2.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "admin_add_balance", amount }) });
      await tgSendMessage(env, chatId, `✅ شارژ شد: ${target} +${amount}`);
      return;
    }
    if (text.startsWith("/admin_grant_uses") && isAdmin(env, userId)) {
      const parts = text.trim().split(/\s+/);
      const target = Number(parts[1]);
      const uses = Number(parts[2] || 0);
      if (!target || !uses) {
        await tgSendMessage(env, chatId, "فرمت: /admin_grant_uses <userId> <uses>");
        return;
      }
      const stub2 = env.USER_DO.get(env.USER_DO.idFromName(String(target)));
      await stub2.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "admin_grant_uses", uses }) });
      await tgSendMessage(env, chatId, `✅ استفاده بونوس اضافه شد: ${target} +${uses}`);
      return;
    }

    // photo handler (chart)
    if (msg.photo?.length) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;
      const file = await tgGetFile(env, fileId);
      if (!file?.file_path) {
        await tgSendMessage(env, chatId, "❌ دریافت فایل از تلگرام ناموفق بود.");
        return;
      }
      const bytes = await tgDownloadFileBytes(env, file.file_path);
      const mime = "image/jpeg";
      const b64 = arrayBufferToBase64(bytes);

      // send to DO: process image if awaiting
      const out = await stub.fetch("https://do/state", {
        method: "POST",
        body: JSON.stringify({ type: "on_chart_image", chatId, image: { mime, dataBase64: b64 } })
      }).then(r => r.json());

      if (out?.status === "need_menu") {
        await tgSendMessage(env, chatId, "ابتدا از منوی «دریافت سیگنال» نماد را انتخاب کنید.", mainMenu());
        return;
      }
      if (out?.status === "blocked") {
        await tgSendMessage(env, chatId, formatUsageBlocked(), mainMenu(), true);
        return;
      }

      // Now run pipeline
      await tgSendMessage(env, chatId, "⏳ در حال تحلیل چارت و خبرها...");
      const req: SignalRequest = out.request;

      const vision = await analyzeChartWithVision(env, req.chartImage!, req.symbol);
      const news = await fetchNewsBundle(env, req.symbol);

      const newsBlock = renderNewsBlock(news.headlines, news.gemmaScore, news.gemmaReasons);
      const memorySummary = out.memorySummary || "";

      const sig = await generateSignal(env, req, memorySummary, vision.summary, newsBlock);

      // patch gemma score into signal (authoritative from news.ts)
      sig.signal.newsScoreByGemma = news.gemmaScore;
      if (news.gemmaSummary?.length) sig.signal.newsSummary = news.gemmaSummary;

      // image card
      const img = await generateSignalImage(env, sig.signal.symbol, sig.signal.direction, sig.signal.timeframe);

      await stub.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "save_note", note: `آخرین سیگنال: ${sig.signal.symbol} ${sig.signal.direction} ${sig.signal.timeframe}` }) });

      const formatted = formatSignalMessage(sig.signal, sig.provider, vision.provider);
      if (img) {
        await tgSendPhoto(env, chatId, img.dataBase64, img.mime, formatted);
      } else {
        await tgSendMessage(env, chatId, formatted, mainMenu(), true);
      }
      return;
    }

    // text when awaiting prompt
    if (text && !text.startsWith("/")) {
      const out = await stub.fetch("https://do/state", {
        method: "POST",
        body: JSON.stringify({ type: "on_text", chatId, text })
      }).then(r => r.json());

      if (out?.status === "await_chart") {
        await tgSendMessage(env, chatId, formatAskChart(out.symbol), undefined, true);
        return;
      }
      if (out?.status === "blocked") {
        await tgSendMessage(env, chatId, formatUsageBlocked(), mainMenu(), true);
        return;
      }
      if (out?.status === "ready") {
        await tgSendMessage(env, chatId, "⏳ در حال تولید سیگنال...");
        const req: SignalRequest = out.request;

        const news = await fetchNewsBundle(env, req.symbol);
        const newsBlock = renderNewsBlock(news.headlines, news.gemmaScore, news.gemmaReasons);
        const memorySummary = out.memorySummary || "";

        const sig = await generateSignal(env, req, memorySummary, "", newsBlock);
        sig.signal.newsScoreByGemma = news.gemmaScore;
        if (news.gemmaSummary?.length) sig.signal.newsSummary = news.gemmaSummary;

        const img = await generateSignalImage(env, sig.signal.symbol, sig.signal.direction, sig.signal.timeframe);
        await stub.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "save_note", note: `آخرین سیگنال: ${sig.signal.symbol} ${sig.signal.direction} ${sig.signal.timeframe}` }) });

        const formatted = formatSignalMessage(sig.signal, sig.provider, "none");
        if (img) {
          await tgSendPhoto(env, chatId, img.dataBase64, img.mime, formatted);
        } else {
          await tgSendMessage(env, chatId, formatted, mainMenu(), true);
        }
        return;
      }

      // default
      await tgSendMessage(env, chatId, "از منو استفاده کنید 👇", mainMenu());
      return;
    }

    // ignore others
    return;
  }

  if (cb) {
    const chatId = cb.message?.chat?.id;
    const from = cb.from;
    const data = String(cb.data || "");
    if (!chatId || !from?.id) return;

    const userId = Number(from.id);
    const stub = env.USER_DO.get(env.USER_DO.idFromName(String(userId)));

    // Ack callback to remove loading spinner
    await tgAnswerCallback(env, cb.id);

    if (data === "menu:home") {
      await tgEditMessage(env, chatId, cb.message.message_id, welcomeText((await getProfile(stub))), mainMenu());
      return;
    }
    if (data === "menu:signal") {
      await tgEditMessage(env, chatId, cb.message.message_id, "📈 یک دسته را انتخاب کنید:", signalMenu());
      return;
    }
    if (data.startsWith("cat:")) {
      const cat = data.split(":")[1] as AssetCategory;
      await tgEditMessage(env, chatId, cb.message.message_id, "یک نماد را انتخاب کنید:", symbolsMenu(cat));
      return;
    }
    if (data.startsWith("sym:")) {
      const [, cat, sym] = data.split(":");
      await stub.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "set_last_asset", cat, sym }) });
      await tgEditMessage(env, chatId, cb.message.message_id, `نماد انتخاب شد: *${mdEscape(sym)}*\nحالا چه کار کنیم؟`, assetActionMenu(cat as any, sym as any), true);
      return;
    }

    if (data.startsWith("act:chart:")) {
      const [, , cat, sym] = data.split(":");
      const out = await stub.fetch("https://do/state", {
        method: "POST",
        body: JSON.stringify({ type: "begin_chart", cat, sym, chatId })
      }).then(r => r.json());
      if (out?.status === "blocked") {
        await tgSendMessage(env, chatId, formatUsageBlocked(), mainMenu(), true);
        return;
      }
      await tgSendMessage(env, chatId, formatAskChart(sym), undefined, true);
      return;
    }

    if (data.startsWith("act:prompt:")) {
      const [, , cat, sym] = data.split(":");
      const out = await stub.fetch("https://do/state", {
        method: "POST",
        body: JSON.stringify({ type: "begin_prompt", cat, sym, chatId })
      }).then(r => r.json());
      if (out?.status === "blocked") {
        await tgSendMessage(env, chatId, formatUsageBlocked(), mainMenu(), true);
        return;
      }
      await tgSendMessage(env, chatId, formatAskPrompt(sym), undefined, true);
      return;
    }

    if (data.startsWith("act:news:")) {
      const [, , cat, sym] = data.split(":");
      const news = await fetchNewsBundle(env, sym);
      const text = [
        `📰 خبرهای مرتبط با *${mdEscape(sym)}*`,
        "",
        ...news.headlines.slice(0, 8).map((h, i) => `${i + 1}) ${mdEscape(h)}`),
        "",
        `⭐️ امتیاز Gemma: *${news.gemmaScore}/10*`,
        ...(news.gemmaReasons?.length ? ["دلایل:", ...news.gemmaReasons.map(r => `• ${mdEscape(r)}`)] : [])
      ].join("\n");
      await tgSendMessage(env, chatId, text, assetActionMenu(cat as any, sym as any), true);
      return;
    }

    if (data === "menu:profile") {
      const prof = await getProfile(stub);
      await tgEditMessage(env, chatId, cb.message.message_id, formatProfileText(prof), mainMenu(), true);
      return;
    }
    if (data === "menu:wallet") {
      const prof = await getProfile(stub);
      await tgEditMessage(env, chatId, cb.message.message_id, formatWalletText(prof), mainMenu(), true);
      return;
    }
    if (data === "menu:referral") {
      const prof = await getProfile(stub);
      await tgEditMessage(env, chatId, cb.message.message_id, formatReferralText(prof, env.BOT_USERNAME), mainMenu(), true);
      return;
    }
    if (data === "menu:support") {
      await tgEditMessage(env, chatId, cb.message.message_id, formatSupportText(), mainMenu(), true);
      return;
    }
  }
}

// -------- Durable Object --------

export class UserDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/state") return new Response("Not found", { status: 404 });
    const body = await req.json();
    const type = body?.type;

    if (type === "ensure_user") {
      const from = body.from || {};
      const startPayload = String(body.startPayload || "");
      let profile = await this.getProfileInternal(from);
      let memory = await this.getMemoryInternal();

      // handle referral start
      if (startPayload && !profile.referredBy) {
        const code = startPayload.toUpperCase();
        const inviterId = await this.env.BOT_KV.get(`ref:${code}`);
        if (inviterId && inviterId !== String(profile.id)) {
          profile.referredBy = code;
          await this.state.storage.put("profile", profile);

          // increment inviter referrals
          const invStub = this.env.USER_DO.get(this.env.USER_DO.idFromName(inviterId));
          await invStub.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "referral_success" }) });
        }
      }

      return json({ ok: true, profile, memory });
    }

    if (type === "set_last_asset") {
      const mem = await this.getMemoryInternal();
      mem.lastCategory = body.cat;
      mem.lastSymbol = body.sym;
      mem.pendingAction = "none";
      await this.state.storage.put("memory", mem);
      return json({ ok: true });
    }

    if (type === "begin_chart" || type === "begin_prompt") {
      const profile = await this.getProfileInternal();
      const blocked = !this.canUse(profile);
      if (blocked) return json({ status: "blocked" });

      const mem = await this.getMemoryInternal();
      mem.pendingCategory = body.cat;
      mem.pendingSymbol = body.sym;
      mem.pendingAction = type === "begin_chart" ? "awaiting_chart" : "awaiting_prompt";
      await this.state.storage.put("memory", mem);
      return json({ status: "ok" });
    }

    if (type === "on_chart_image") {
      const profile = await this.getProfileInternal();
      const mem = await this.getMemoryInternal();
      if (mem.pendingAction !== "awaiting_chart" || !mem.pendingSymbol || !mem.pendingCategory) {
        return json({ status: "need_menu" });
      }
      const blocked = !this.consumeUse(profile);
      if (blocked) return json({ status: "blocked" });

      const request: SignalRequest = {
        userId: profile.id,
        chatId: Number(body.chatId),
        symbol: mem.pendingSymbol,
        category: mem.pendingCategory,
        timeframe: mem.lastTimeframe || this.env.DEFAULT_TIMEFRAME,
        style: mem.lastStyle || this.env.DEFAULT_STYLE,
        risk: mem.lastRisk || this.env.RISK_PROFILE,
        userPrompt: undefined,
        chartImage: body.image
      } as any;

      // reset pending
      mem.pendingAction = "none";
      mem.pendingSymbol = undefined;
      mem.pendingCategory = undefined;
      await this.state.storage.put("memory", mem);
      await this.state.storage.put("profile", profile);

      return json({ status: "ok", request, memorySummary: summarizeMemory(mem) });
    }

    if (type === "on_text") {
      const profile = await this.getProfileInternal();
      const mem = await this.getMemoryInternal();
      const text = String(body.text || "").slice(0, 1200);

      if (mem.pendingAction === "awaiting_prompt" && mem.pendingSymbol && mem.pendingCategory) {
        const blocked = !this.consumeUse(profile);
        if (blocked) return json({ status: "blocked" });

        const request: SignalRequest = {
          userId: profile.id,
          chatId: Number(body.chatId),
          symbol: mem.pendingSymbol,
          category: mem.pendingCategory,
          timeframe: mem.lastTimeframe || this.env.DEFAULT_TIMEFRAME,
          style: mem.lastStyle || this.env.DEFAULT_STYLE,
          risk: mem.lastRisk || this.env.RISK_PROFILE,
          userPrompt: text
        } as any;

        mem.pendingAction = "none";
        mem.pendingSymbol = undefined;
        mem.pendingCategory = undefined;

        // store prompt as note for memory
        mem.recentNotes = [`پرامپت کاربر: ${text}` , ...mem.recentNotes].slice(0, 12);

        await this.state.storage.put("memory", mem);
        await this.state.storage.put("profile", profile);

        return json({ status: "ready", request, memorySummary: summarizeMemory(mem) });
      }

      if (mem.pendingAction === "awaiting_chart" && mem.pendingSymbol) {
        // user typed but we need chart
        return json({ status: "await_chart", symbol: mem.pendingSymbol });
      }

      return json({ status: "ignored" });
    }

    if (type === "save_note") {
      const mem = await this.getMemoryInternal();
      const note = String(body.note || "").slice(0, 200);
      mem.recentNotes = [note, ...mem.recentNotes].slice(0, 12);
      await this.state.storage.put("memory", mem);
      return json({ ok: true });
    }

    if (type === "referral_success") {
      const prof = await this.getProfileInternal();
      prof.referrals += 1;

      const need = Number(this.env.REFERRALS_FOR_BONUS || "5");
      const bonus = Number(this.env.BONUS_USES || "3");
      // grant bonus each time referrals reach multiple of need
      if (prof.referrals > 0 && prof.referrals % need === 0) {
        prof.bonusUsesRemaining += bonus;
        prof.plan = "referral";
      }
      await this.state.storage.put("profile", prof);
      return json({ ok: true });
    }

    if (type === "admin_add_balance") {
      const prof = await this.getProfileInternal();
      prof.walletBalance += Number(body.amount || 0);
      prof.plan = "wallet";
      await this.state.storage.put("profile", prof);
      return json({ ok: true });
    }

    if (type === "admin_grant_uses") {
      const prof = await this.getProfileInternal();
      prof.bonusUsesRemaining += Number(body.uses || 0);
      await this.state.storage.put("profile", prof);
      return json({ ok: true });
    }

    if (type === "get_profile") {
      const prof = await this.getProfileInternal();
      return json(prof);
    }

    return json({ ok: false, error: "unknown_type" }, 400);
  }

  private async getProfileInternal(from?: any): Promise<UserProfile> {
    const existing = await this.state.storage.get<UserProfile>("profile");
    if (existing) {
      // update basic fields
      if (from?.username && existing.username !== from.username) {
        existing.username = from.username;
        await this.state.storage.put("profile", existing);
      }
      return existing;
    }
    const userId = Number(from?.id || 0);
    const freeUses = Number(this.env.FREE_USES || "3");
    const profile: UserProfile = {
      id: userId,
      username: from?.username,
      firstName: from?.first_name,
      language: "fa",
      createdAt: nowISO(),
      freeUsesRemaining: freeUses,
      bonusUsesRemaining: 0,
      referralCode: makeReferralCode(userId),
      referrals: 0,
      walletBalance: 0,
      plan: "free"
    };

    // store referral code mapping in KV
    await this.env.BOT_KV.put(`ref:${profile.referralCode}`, String(profile.id));

    await this.state.storage.put("profile", profile);

    // init memory
    const mem: UserMemory = { pendingAction: "none", recentNotes: [] };
    await this.state.storage.put("memory", mem);

    return profile;
  }

  private async getMemoryInternal(): Promise<UserMemory> {
    const mem = await this.state.storage.get<UserMemory>("memory");
    return mem || { pendingAction: "none", recentNotes: [] };
  }

  private canUse(p: UserProfile): boolean {
    if (p.freeUsesRemaining > 0) return true;
    if (p.bonusUsesRemaining > 0) return true;
    if (p.walletBalance > 0) return true;
    return false;
  }

  private consumeUse(p: UserProfile): boolean {
    if (!this.canUse(p)) return false;
    if (p.freeUsesRemaining > 0) p.freeUsesRemaining -= 1;
    else if (p.bonusUsesRemaining > 0) p.bonusUsesRemaining -= 1;
    else if (p.walletBalance > 0) p.walletBalance -= 1; // simple unit cost
    return true;
  }
}

function summarizeMemory(mem: any): string {
  const notes = Array.isArray(mem.recentNotes) ? mem.recentNotes.slice(0, 8) : [];
  const last = [
    mem.lastSymbol ? `نماد آخر: ${mem.lastSymbol}` : "",
    mem.lastCategory ? `دسته آخر: ${mem.lastCategory}` : "",
    mem.lastTimeframe ? `تایم‌فریم: ${mem.lastTimeframe}` : "",
    mem.lastStyle ? `سبک: ${mem.lastStyle}` : "",
    mem.lastRisk ? `ریسک: ${mem.lastRisk}` : ""
  ].filter(Boolean).join(" | ");
  return [last, ...notes.map((n: string) => `• ${n}`)].filter(Boolean).join("\n");
}

// -------- Telegram helpers --------

async function tgApi(env: Env, method: string, payload: any): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(`Telegram API error: ${method}`);
  return data.result;
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
  // Telegram expects multipart/form-data for binary upload. We'll use sendPhoto with base64 via URL is not supported.
  // Workaround: use "attach://photo" multipart.
  const boundary = "----sniperlm" + Math.random().toString(16).slice(2);
  const bodyParts: Uint8Array[] = [];

  const push = (s: string) => bodyParts.push(new TextEncoder().encode(s));

  const bin = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`);

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdownV2\r\n`);

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="photo"; filename="signal.png"\r\n`);
  push(`Content-Type: ${mime}\r\n\r\n`);
  bodyParts.push(bin);
  push(`\r\n--${boundary}--\r\n`);

  const body = concatUint8(bodyParts);

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    // fallback to text
    await tgSendMessage(env, chatId, caption, mainMenu(), true);
  }
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function sanitizeFrom(from: any): any {
  return { id: from.id, username: from.username, first_name: from.first_name };
}

async function getProfile(stub: DurableObjectStub): Promise<any> {
  return await stub.fetch("https://do/state", { method: "POST", body: JSON.stringify({ type: "get_profile" }) }).then(r => r.json());
}

// -------- Rendering --------

function welcomeText(profile: any): string {
  return [
    "🤖 *SniperLM* آماده است.",
    "",
    "از منوی زیر یک گزینه را انتخاب کنید:",
    "",
    `• سهمیه باقی‌مانده: رایگان *${profile.freeUsesRemaining}* | بونوس *${profile.bonusUsesRemaining}*`
  ].join("\n");
}

function helpText(): string {
  return [
    "ℹ️ *راهنما*",
    "1) «دریافت سیگنال» → دسته و نماد را انتخاب کنید",
    "2) یا «ارسال چارت» را بزنید و عکس چارت بفرستید",
    "3) یا «نوشتن پرامپت» را بزنید و توضیح بدهید",
    "",
    "دستورها:",
    "• /start",
    "• /help"
  ].join("\n");
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
    lines.push("📍 سطوح کلیدی:");
    for (const k of sig.keyLevels.slice(0, 8)) lines.push(`• ${mdEscape(String(k))}`);
  }
  if (sig.rationale?.length) {
    lines.push("");
    lines.push("🧠 منطق تحلیل:");
    for (const r of sig.rationale.slice(0, 6)) lines.push(`• ${mdEscape(String(r))}`);
  }
  if (sig.newsSummary?.length) {
    lines.push("");
    lines.push(`📰 خلاصه خبرها (Gemma: *${sig.newsScoreByGemma}/10*):`);
    for (const n of sig.newsSummary.slice(0, 6)) lines.push(`• ${mdEscape(String(n))}`);
  }
  if (sig.riskNotes?.length) {
    lines.push("");
    lines.push("⚠️ نکات ریسک:");
    for (const rn of sig.riskNotes.slice(0, 5)) lines.push(`• ${mdEscape(String(rn))}`);
  }
  lines.push("");
  lines.push(`🔎 مدل متن: *${mdEscape(llmProvider)}* | مدل چارت: *${mdEscape(visionProvider)}*`);
  lines.push("");
  lines.push(`📎 ${mdEscape(sig.disclaimer || "این خروجی صرفاً آموزشی است و توصیه مالی نیست.")}`);
  return lines.join("\n");
}

function renderNewsBlock(headlines: string[], score: number, reasons: string[]): string {
  const h = headlines.slice(0, 8).map((x, i) => `${i + 1}. ${x}`).join("\n");
  const r = reasons?.length ? "\nدلایل:\n" + reasons.slice(0, 4).map((x) => `- ${x}`).join("\n") : "";
  return `امتیاز Gemma: ${score}/10\nخبرها:\n${h}${r}`;
}

// -------- small response helpers --------
function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
