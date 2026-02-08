export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // ultra-light endpoints (no DB)
      if (url.pathname === "/health") return new Response("ok", { status: 200 });
      if (url.pathname === "/favicon.ico") return new Response("", { status: 204 });

      // load config from bot_db (cached)
      env.__cfg = await loadMainConfig(env);

      // ===== MINI APP (inline) =====
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        return htmlResponse(MINI_APP_HTML);
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        const js = MINI_APP_JS
          .replace(/\\`/g, "`")
          .replace(/\\\$\{/g, "${");
        return jsResponse(js);
      }

      // ===== MINI APP APIs =====
      if (url.pathname === "/api/user" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        const st = await ensureUser(v.userId, env);
        const quota = isStaff(v.fromLike, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
        const symbols = [...MAJORS, ...METALS, ...INDICES, ...CRYPTOS];
        const marketSymbols = { forex: MAJORS, metals: METALS, indices: INDICES, crypto: CRYPTOS };

        const cfg = cfgOf(env);
        const styles = (cfg?.styles && Array.isArray(cfg.styles) && cfg.styles.length)
          ? cfg.styles.filter(s => s && s.enabled !== false).map(s => String(s.label || "").trim()).filter(Boolean)
          : Object.keys(STYLE_ANALYSIS_PROMPTS_DEFAULT || {});

        return jsonResponse({
          ok: true,
          welcome: WELCOME_MINIAPP,
          state: st,
          quota,
          symbols,
          marketSymbols,
          styles,
          isAdmin: isAdmin(v.fromLike, env) || isStaff(v.fromLike, env),
          walletAddress: (await getWallet(env)) || "",
          subPlans: getSubPlans(env),
          token: v.token || "",
        }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);

        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        const st = await ensureUser(v.userId, env);

        // users can tweak only their preferences (admin-only prompt/wallet enforced elsewhere)
        if (typeof body.timeframe === "string") st.timeframe = body.timeframe;
        if (typeof body.style === "string") st.style = normalizeStyleLabel(body.style);
        if (typeof body.risk === "string") st.risk = body.risk;
        if (typeof body.newsEnabled === "boolean") st.newsEnabled = body.newsEnabled;

        if (getDB(env)) await saveUser(v.userId, st, env);

        const quota = isStaff(v.fromLike, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
        return jsonResponse({ ok: true, state: st, quota , token: v.token || "" }, 200, authHeaders(v));
      }

      // Wallet APIs (credit balance; manual/admin managed)
      if (url.pathname === "/api/wallet/balance" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);

        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        const st = await ensureUser(v.userId, env);
        return jsonResponse({
          ok: true,
          balance: Number(st.wallet?.balance || 0),
          currency: st.wallet?.currency || "USDT",
          points: Number(st.referral?.points || 0),
          subscription: st.subscription,
          walletAddress: (await getWallet(env)) || "",
          pendingSubTicket: st.subscription?.pendingTicket || "",
          token: v.token || "",
        }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/wallet/withdraw" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);

        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        const st = await ensureUser(v.userId, env);

        const amount = Number(body.amount);
        const address = String(body.address || "").trim();

        if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ ok: false, error: "withdraw_bad_amount" }, 400);
        if (!address) return jsonResponse({ ok: false, error: "withdraw_bad_address" }, 400);

        if (Number(st.wallet?.balance || 0) < amount) {
          return jsonResponse({ ok: false, error: "insufficient_funds" }, 400);
        }

        st.wallet.balance = Number(st.wallet.balance || 0) - amount;

        const ticket = await createWithdrawTicket(env, {
          userId: v.userId,
          amount,
          address,
          from: v.fromLike,
        });

        await saveUser(v.userId, st, env);

        return jsonResponse({
          ok: true,
          ticket,
          balance: Number(st.wallet.balance || 0),
          currency: st.wallet.currency || "USDT",
        });
      }

      
      // Subscription APIs (purchase request -> admin approve -> activate)
      if (url.pathname === "/api/subscription/plans" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);
        return jsonResponse({ ok: true, plans: getSubPlans(env) , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/subscription/status" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        const st = await ensureUser(v.userId, env);
        let req = null;
        if (st.subscription?.pendingTicket) req = await getSubRequest(env, st.subscription.pendingTicket);
        return jsonResponse({ ok: true, subscription: st.subscription, pending: req || null , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/subscription/request" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        if (!getDB(env)) return jsonResponse({ ok: false, error: "kv_required" }, 500);

        const st = await ensureUser(v.userId, env);
        if (!st.profile?.name || !st.profile?.phone) return jsonResponse({ ok: false, error: "onboarding_required" }, 403);

        if (st.subscription?.pendingTicket) {
          return jsonResponse({ ok: false, error: "sub_pending_exists", ticket: st.subscription.pendingTicket }, 409);
        }

        const plan = planFromLabel(env, body.planId);
        if (!plan) return jsonResponse({ ok: false, error: "bad_plan" }, 400);

        const payMethod = String(body.payMethod || "").trim(); // balance | txid
        const txid = String(body.txid || "").trim();

        const bal = Number(st.wallet?.balance || 0);
        let paidFromBalance = false;

        if (payMethod === "balance") {
          if (bal < plan.price) return jsonResponse({ ok: false, error: "insufficient_funds" }, 400);
          st.wallet.balance = bal - plan.price;
          paidFromBalance = true;
        } else {
          if (!txid) return jsonResponse({ ok: false, error: "txid_required" }, 400);
        }

        const payload = {
          userId: String(v.userId),
          username: st.profile?.username || v.fromLike?.username || "",
          planId: plan.id,
          planTitle: plan.title,
          planDays: plan.days,
          dailyLimit: plan.dailyLimit,
          amount: plan.price,
          currency: plan.currency,
          payMethod: paidFromBalance ? "balance" : "txid",
          txid: paidFromBalance ? "" : txid,
          paidFromBalance,
        };

        const ticket = await createSubTicket(env, payload);

        st.subscription.pendingTicket = ticket;
        st.subscription.pendingPlanId = plan.id;
        st.subscription.pendingPayMethod = payload.payMethod;
        st.subscription.pendingAmount = plan.price;
        await saveUser(v.userId, st, env);

        await notifyAdminsSubRequest(env, { ...payload, ticket });

        return jsonResponse({ ok: true, ticket, balance: Number(st.wallet?.balance || 0), currency: st.wallet?.currency || "USDT" , token: v.token || "" }, 200, authHeaders(v));
      }


      // ===== ADMIN APIs (MiniApp) =====
      if (url.pathname === "/api/admin/config/get" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);
        const cfg = await loadMainConfig(env);
        return jsonResponse({ ok: true, cfg , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/admin/config/set" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);
        const db = getDB(env);
        if (!db) return jsonResponse({ ok: false, error: "bot_db_missing" }, 500);

        const current = await loadMainConfig(env);
        const patch = body.patch || {};

        const next = JSON.parse(JSON.stringify(current));

        if (typeof patch.walletAddress === "string") next.walletAddress = patch.walletAddress.trim();

        if (patch.limits && typeof patch.limits === "object") {
          if (patch.limits.freeDailyLimit != null) next.limits.freeDailyLimit = toInt(patch.limits.freeDailyLimit, next.limits.freeDailyLimit);
          if (patch.limits.premiumDailyLimit != null) next.limits.premiumDailyLimit = toInt(patch.limits.premiumDailyLimit, next.limits.premiumDailyLimit);
        }

        if (patch.commissions && typeof patch.commissions === "object") {
          if (patch.commissions.globalPct != null) next.commissions.globalPct = Number(patch.commissions.globalPct);
          if (patch.commissions.perUser && typeof patch.commissions.perUser === "object") {
            const per = {};
            for (const [k, v2] of Object.entries(patch.commissions.perUser)) {
              const nk = normHandle(k);
              const pv = Number(v2);
              if (!nk || !Number.isFinite(pv)) continue;
              per[nk] = pv;
            }
            next.commissions.perUser = { ...(next.commissions.perUser || {}), ...per };
          }
        }

        if (Array.isArray(patch.subPlans)) {
          next.subPlans = patch.subPlans
            .map(p => ({
              id: String(p.id || "").trim(),
              title: String(p.title || "").trim(),
              days: toInt(p.days, 0),
              price: Number(p.price),
              currency: String(p.currency || current.subPlans?.[0]?.currency || "USDT").trim() || "USDT",
              dailyLimit: toInt(p.dailyLimit, next.limits.premiumDailyLimit),
            }))
            .filter(p => p.id && p.title && p.days > 0 && Number.isFinite(p.price));
        }

        if (Array.isArray(patch.styles)) {
          next.styles = patch.styles.map(s => ({
            id: String(s.id || stylePromptKey(s.label) || s.label || "").trim() || randomCode(8),
            label: normalizeStyleLabel(s.label || ""),
            enabled: s.enabled !== false,
            prompt: String(s.prompt || "").trim(),
          })).filter(s => s.label);
        }

        const saved = await saveMainConfig(env, next);
        return jsonResponse({ ok: true, cfg: saved , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/admin/users/list" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);
        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);

        const db = getDB(env);
        if (!db || typeof db.list !== "function") return jsonResponse({ ok: false, error: "list_not_supported" }, 500);

        const limit = Math.min(50, Math.max(1, toInt(body.limit, 20)));
        const cursor = body.cursor ? String(body.cursor) : undefined;

        const res = await db.list({ prefix: "u:", limit, cursor });
        const keys = res?.keys || [];
        const users = [];

        for (const k of keys) {
          const raw = await db.get(k.name);
          if (!raw) continue;
          try {
            const u = JSON.parse(raw);
            users.push({
              userId: u.userId,
              name: u?.profile?.name || "",
              username: u?.profile?.username || "",
              phone: u?.profile?.phone || "",
              dailyUsed: u.dailyUsed || 0,
              dailyLimit: dailyLimit(env, u),
              points: u?.referral?.points || 0,
              invites: u?.referral?.successfulInvites || 0,
              subscription: u?.subscription || {},
              wallet: u?.wallet || {},
            });
          } catch {}
        }

        return jsonResponse({ ok: true, users, cursor: res?.cursor || null, listComplete: Boolean(res?.list_complete) , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/admin/sub/pending" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);
        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);

        const db = getDB(env);
        if (!db || typeof db.list !== "function") return jsonResponse({ ok: false, error: "list_not_supported" }, 500);

        const res = await db.list({ prefix: "subreq:", limit: 50 });
        const keys = res?.keys || [];
        const items = [];
        for (const k of keys) {
          const ticket = String(k.name || "").replace("subreq:", "");
          const req = await getSubRequest(env, ticket);
          if (req && req.status === "pending") items.push(req);
        }
        // newest first
        items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return jsonResponse({ ok: true, items , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/admin/sub/approve" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);
        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);

        const ticket = String(body.ticket || "").trim();
        if (!ticket) return jsonResponse({ ok: false, error: "bad_ticket" }, 400);

        const r = await adminApproveSub(env, ticket, v.fromLike);
        if (!r.ok) return jsonResponse({ ok: false, error: r.error || "failed" }, 400);
        return jsonResponse({ ok: true, ...r , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/admin/sub/reject" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);
        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);

        const ticket = String(body.ticket || "").trim();
        if (!ticket) return jsonResponse({ ok: false, error: "bad_ticket" }, 400);
        const reason = String(body.reason || "رد شد").trim();

        const r = await adminRejectSub(env, ticket, v.fromLike, reason);
        if (!r.ok) return jsonResponse({ ok: false, error: r.error || "failed" }, 400);
        return jsonResponse({ ok: true, ...r , token: v.token || "" }, 200, authHeaders(v));
      }

      if (url.pathname === "/api/admin/withdraw/list" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);
        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);
        if (!(isAdmin(v.fromLike, env) || isStaff(v.fromLike, env))) return jsonResponse({ ok: false, error: "forbidden" }, 403);

        const db = getDB(env);
        if (!db || typeof db.list !== "function") return jsonResponse({ ok: false, error: "list_not_supported" }, 500);

        const res = await db.list({ prefix: "wd:", limit: 50 });
        const keys = res?.keys || [];
        const items = [];
        for (const k of keys) {
          const raw = await db.get(k.name);
          if (!raw) continue;
          try { items.push(JSON.parse(raw)); } catch {}
        }
        items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return jsonResponse({ ok: true, items , token: v.token || "" }, 200, authHeaders(v));
      }
if (url.pathname === "/api/analyze" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ ok: false, error: "bad_json" }, 400);

        const v = await miniappAuth(request, body, env);
        if (!v.ok) return jsonResponse({ ok: false, error: v.reason }, 401);

        const st = await ensureUser(v.userId, env);
        const symbol = String(body.symbol || "").trim();
        if (!symbol || !isSymbol(symbol)) return jsonResponse({ ok: false, error: "invalid_symbol" }, 400);

        // must complete onboarding before using AI analysis (name+contact at least)
        if (!st.profile?.name || !st.profile?.phone) {
          return jsonResponse({ ok: false, error: "onboarding_required" }, 403);
        }

        if (getDB(env) && !canAnalyzeToday(st, v.fromLike, env)) {
          const quota = isStaff(v.fromLike, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
          return jsonResponse({ ok: false, error: `quota_exceeded_${quota}` }, 429);
        }

        if (getDB(env)) {
          consumeDaily(st, v.fromLike, env);
          await saveUser(v.userId, st, env);
        }

        const userPrompt = typeof body.userPrompt === "string" ? body.userPrompt : "";

// Optional per-request overrides (MiniApp wizard / quick analysis)
const overrides = {};
if (typeof body.timeframe === "string" && ["M15","H1","H4","D1"].includes(body.timeframe)) overrides.timeframe = body.timeframe;
if (typeof body.style === "string") overrides.style = body.style;

        try {
          const r = await runSignalTextFlowCompute(env, v.fromLike, st, symbol, userPrompt, overrides);
          const result = r.text;
          const chartUrl = r.chartUrl; 
          const quota = isStaff(v.fromLike, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
          return jsonResponse({ ok: true, result, chartUrl, state: st, quota , token: v.token || "" }, 200, authHeaders(v));
        } catch (e) {
          console.error("api/analyze error:", e);
          return jsonResponse({ ok: false, error: "server_error" }, 500);
        }
      }

      // Telegram webhook route: /telegram/<secret>
      if (url.pathname.startsWith("/telegram/")) {
        const secret = url.pathname.split("/")[2] || "";
        if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== String(env.TELEGRAM_WEBHOOK_SECRET)) {
          return new Response("forbidden", { status: 403 });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

        const update = await request.json().catch(() => null);
        if (!update) return new Response("bad request", { status: 400 });

        // respond fast; do heavy work in waitUntil
        ctx.waitUntil(handleUpdate(update, env));
        return new Response("ok", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error("fetch error:", e);
      return new Response("error", { status: 500 });
    }
  },
};

/* ========================== EPHEMERAL MEMORY (fallback if no KV/D1 bound) ========================== */
const __MEM_DB = new Map();
function __memGet(key) { try { return __MEM_DB.get(key) || null; } catch { return null; } }
function __memPut(key, val) { try { __MEM_DB.set(key, val); } catch {} }

/* ========================== BRAND / COPY ========================== */
const BOT_NAME = "MarketiQ";
const WELCOME_BOT =
`🎯 متن خوش‌آمدگویی بات تلگرام MarketiQ

👋 به MarketiQ خوش آمدید
هوش تحلیلی شما در بازارهای مالی

────────────────────────

📊 MarketiQ یک ایجنت تخصصی تحلیل بازارهای مالی است که با تمرکز بر تصمیم‌سازی هوشمند، در کنار شماست تا بازار را درست‌تر، عمیق‌تر و حرفه‌ای‌تر ببینید.

🔍 در MarketiQ چه دریافت می‌کنید؟
✅ تحلیل فاندامنتال بازارهای مالی
✅ تحلیل تکنیکال دقیق و ساختاریافته
✅ سیگنال‌های معاملاتی با رویکرد مدیریت ریسک
✅ پوشش بازارها:
- 🪙 کریپتوکارنسی
- 💱 جفت‌ارزها (Forex)
- 🪙 فلزات گران‌بها
- 📈 سهام

────────────────────────

🧠 فلسفه MarketiQ
ما سیگنال نمی‌فروشیم، ما «درک بازار» می‌سازیم.
هدف ما کمک به شما برای تصمیم‌گیری آگاهانه است، نه وابستگی کورکورانه به سیگنال.

────────────────────────

🚀 شروع کنید
/start | شروع تحلیل
/signals | سیگنال‌ها
/education | آموزش و مفاهیم بازار
/support | پشتیبانی

────────────────────────

⚠️ سلب مسئولیت:
تمام تحلیل‌ها صرفاً جنبه آموزشی و تحلیلی دارند و مسئولیت نهایی معاملات بر عهده کاربر است.`;

const WELCOME_MINIAPP =
`👋 به MarketiQ خوش آمدید — هوش تحلیلی شما در بازارهای مالی
این مینی‌اپ برای گرفتن تحلیل سریع، تنظیمات، و مدیریت دسترسی طراحی شده است.
⚠️ تحلیل‌ها آموزشی است و مسئولیت معاملات با شماست.`;

/* ========================== CONFIG ========================== */
const MAJORS = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"];
const METALS = ["XAUUSD", "XAGUSD"];
const INDICES = ["DJI", "NDX", "SPX"];
const CRYPTOS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","TRXUSDT","TONUSDT","AVAXUSDT",
  "LINKUSDT","DOTUSDT","MATICUSDT","LTCUSDT","BCHUSDT",
];

const BTN = {
  ANALYZE: "✅ تحلیل کن",
  SIGNAL: "📈 سیگنال‌ها",
  SETTINGS: "⚙️ تنظیمات",
  PROFILE: "👤 پروفایل",
  SUPPORT: "🆘 پشتیبانی",
  EDUCATION: "📚 آموزش",
  LEVELING: "🧪 تعیین سطح",
  BACK: "⬅️ برگشت",
  HOME: "🏠 منوی اصلی",
  MINIAPP: "🧩 مینی‌اپ",

  CAT_MAJORS: "💱 ماجورها",
  CAT_METALS: "🪙 فلزات",
  CAT_INDICES: "📊 شاخص‌ها",
  CAT_CRYPTO: "₿ کریپتو (15)",

  SET_TF: "⏱ تایم‌فریم",
  SET_STYLE: "🎯 سبک",
  SET_RISK: "⚠️ ریسک",
  SET_NEWS: "📰 خبر",

  WALLET: "💳 ولت",
  WALLET_DEPOSIT: "➕ واریز",
  WALLET_WITHDRAW: "➖ برداشت",
  WALLET_BALANCE: "📊 موجودی",

  SUBSCRIPTION: "👑 اشتراک",
  SUB_BUY: "🛒 خرید اشتراک",
  SUB_STATUS: "📌 وضعیت اشتراک",
};

const TYPING_INTERVAL_MS = 4000;
const TIMEOUT_TEXT_MS = 11000;
const TIMEOUT_VISION_MS = 12000;
const TIMEOUT_POLISH_MS = 9000;

/* ========================== UTILS ========================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkText(s, size = 3500) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function timeoutPromise(ms, label = "timeout") {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms));
}

async function fetchWithTimeout(url, init, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function normHandle(h) {
  if (!h) return "";
  return "@" + String(h).replace(/^@/, "").toLowerCase();
}

function normalizePhone(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  const map = {
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
  };
  let t = "";
  for (const ch of s) t += (map[ch] ?? ch);

  // keep only digits and (optional) leading +
  t = t.replace(/[^\d+]/g, "");
  if (t.includes("+")) {
    t = t.replace(/\+/g, "");
    t = "+" + t;
  }
  if (t.startsWith("00")) t = "+" + t.slice(2);

  const digits = t.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return t.startsWith("+") ? ("+" + digits) : digits;
}


function isStaff(from, env) {
  // staff = admin or owner
  return isOwner(from, env) || isAdmin(from, env);
}

function isOwner(from, env) {
  const u = normHandle(from?.username);
  if (!u) return false;
  const raw = (env.OWNER_HANDLES || "").toString().trim();
  if (!raw) return false;
  const set = new Set(raw.split(",").map(normHandle).filter(Boolean));
  return set.has(u);
}

function isAdmin(from, env) {
  const u = normHandle(from?.username);
  if (!u) return false;
  const raw = (env.ADMIN_HANDLES || "").toString().trim();
  if (!raw) return false;
  const set = new Set(raw.split(",").map(normHandle).filter(Boolean));
  return set.has(u);
}

function kyivDateString(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function parseOrder(raw, fallbackArr) {
  const s = (raw || "").toString().trim();
  if (!s) return fallbackArr;
  return s.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}

function detectMimeFromHeaders(resp, fallback = "image/jpeg") {
  const ct = resp.headers.get("content-type") || "";
  if (ct.startsWith("image/")) return ct.split(";")[0].trim();
  return fallback;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function randomCode(len = 10) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}


/* ========================== STORAGE (bot_db) ========================== */
/**
 * bot_db can be:
 * - Cloudflare KV namespace (has get/put/list/delete)
 * - Cloudflare D1 database (has prepare)
 *
 * This wrapper normalizes both into KV-like methods used by the bot.
 */
function getDB(env) {
  if (!env) return null;

  // If an older isolate cached a non-adapter object (e.g., raw D1), re-normalize it.
  if (env.__mq_db) {
    const cached = env.__mq_db;
    if (typeof cached.get === "function" && typeof cached.put === "function") return cached;
    if (typeof cached.prepare === "function") {
      try {
        const w = makeD1KVAdapter(cached);
        env.__mq_db = w;
        return w;
      } catch (_) {
        try { delete env.__mq_db; } catch (_) { env.__mq_db = null; }
      }
    } else {
      try { delete env.__mq_db; } catch (_) { env.__mq_db = null; }
    }
  }

  const raw = env.bot_db || env.BOT_DB || env.BOT_KV || null;
  if (!raw) return null;

  // KV namespace
  if (typeof raw.get === "function" && typeof raw.put === "function" && typeof raw.list === "function") {
    env.__mq_db = raw;
    return raw;
  }

  // D1 database
  if (typeof raw.prepare === "function") {
    const w = makeD1KVAdapter(raw);
    env.__mq_db = w;
    return w;
  }

  return null;
}

let __MQ_D1_READY = false;
let __MQ_D1_SCHEMA = { keyCol: "k", valCol: "v", expCol: "exp", updatedCol: "updated_at" };

async function ensureD1KV(d1) {
  if (__MQ_D1_READY) return;

  // 1) Try to create the expected schema (no-op if already exists)
  const stmts = [
    "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER, updated_at INTEGER)",
    "CREATE INDEX IF NOT EXISTS kv_k_idx ON kv(k)",
    "CREATE INDEX IF NOT EXISTS kv_exp_idx ON kv(exp)"
  ];

  try {
    if (typeof d1.exec === "function") {
      await d1.exec(stmts.join("; "));
    } else {
      for (const s of stmts) await d1.prepare(s).run();
    }
  } catch (_) {
    // ignore; we will introspect what exists
  }

  // 2) Introspect actual columns (handles older/alternate schemas)
  try {
    const info = await d1.prepare("PRAGMA table_info(kv)").all();
    const rows = Array.isArray(info) ? info : (info && info.results) ? info.results : [];
    const cols = new Set(rows.map(r => String(r.name || "").toLowerCase()).filter(Boolean));
    const keyCol = cols.has("k") ? "k" : cols.has("key") ? "key" : cols.has("id") ? "id" : "k";

    let valCol = cols.has("v") ? "v"
      : cols.has("value") ? "value"
      : cols.has("val") ? "val"
      : cols.has("data") ? "data"
      : null;

    // If multiple value columns exist (e.g. both `v` and `value`), keep a secondary column in sync
    let altValCol = null;
    if (valCol === "v") {
      if (cols.has("value")) altValCol = "value";
      else if (cols.has("val")) altValCol = "val";
      else if (cols.has("data")) altValCol = "data";
    } else if (valCol === "value" && cols.has("v")) {
      altValCol = "v";
    }

    const expCol = cols.has("exp") ? "exp" : (cols.has("expires_at") ? "expires_at" : null);
    const updatedCol = cols.has("updated_at") ? "updated_at" : (cols.has("updated") ? "updated" : null);

    // If there's no value column, attempt to add `v`
    if (!valCol) {
      try {
        await d1.prepare("ALTER TABLE kv ADD COLUMN v TEXT").run();
        valCol = "v";
        if (!altValCol) {
          if (cols.has("value")) altValCol = "value";
          else if (cols.has("val")) altValCol = "val";
          else if (cols.has("data")) altValCol = "data";
        }
      } catch (_) {
        // last resort: still mark schema, operations may fail loudly
        valCol = "v";
      }
    }

    // Backfill / keep value columns in sync (best-effort, ignore errors)
    try {
      if (valCol === "v" && altValCol) {
        // If we previously stored in `value` (or similar), copy into `v` when missing, and vice-versa.
        await d1.prepare(`UPDATE kv SET v = ${altValCol} WHERE v IS NULL AND ${altValCol} IS NOT NULL`).run();
        await d1.prepare(`UPDATE kv SET ${altValCol} = v WHERE ${altValCol} IS NULL AND v IS NOT NULL`).run();
      }
    } catch (_) {}

    __MQ_D1_SCHEMA = { keyCol, valCol, altValCol, expCol, updatedCol };
  } catch (_) {
    __MQ_D1_SCHEMA = { keyCol: "k", valCol: "v", altValCol: null, expCol: "exp", updatedCol: "updated_at" };
  }

  __MQ_D1_READY = true;
}

function likeEscape(s) {
  // Escape LIKE wildcards. Keys shouldn't contain these, but this makes prefix list robust.
  return String(s || "").replace(/[\\%_]/g, "\\$&");
}

function makeD1KVAdapter(d1) {
  const schema = __MQ_D1_SCHEMA || { keyCol: "k", valCol: "v", altValCol: null, expCol: "exp", updatedCol: "updated_at" };
  const keyCol = schema.keyCol || "k";
  const valCol = schema.valCol || "v";
  const altValCol = schema.altValCol || null;
  const expCol = schema.expCol || null;
  const updatedCol = schema.updatedCol || null;

  const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

  const colKey = q(keyCol);
  const colVal = q(valCol);
  const colAlt = altValCol && altValCol !== valCol ? q(altValCol) : null;
  const colExp = expCol ? q(expCol) : null;
  const colUpd = updatedCol ? q(updatedCol) : null;

  return {
    async get(key) {
      const whereExp = colExp ? ` AND (${colExp} IS NULL OR ${colExp} > ?2)` : "";
      const now = Math.floor(Date.now() / 1000);
      const valExpr = colAlt ? `COALESCE(${colVal}, ${colAlt}) AS v` : `${colVal} AS v`;
      const st = d1.prepare(`SELECT ${valExpr}${colExp ? `, ${colExp} AS exp` : ""}${colUpd ? `, ${colUpd} AS ts` : ""} FROM kv WHERE ${colKey} = ?1${whereExp} LIMIT 1`).bind(String(key), String(now));
      const res = await st.first();
      if (!res) return null;
      return { k: String(key), v: res.v, exp: res.exp ?? null, ts: res.ts ?? null };
    },

    async put(k, v, exp = null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const nowMs = Date.now();

      const cols = [keyCol, valCol];
      const vals = [String(k), String(v)];
      if (altValCol && altValCol !== valCol) {
        cols.push(altValCol);
        vals.push(String(v));
      }
      if (colExp) {
        cols.push(expCol);
        vals.push(exp == null ? null : String(Number(exp)));
      }
      if (colUpd) {
        cols.push(updatedCol);
        // store ms if looks like *_at, else seconds
        vals.push(String(String(updatedCol).toLowerCase().includes("_at") ? nowMs : nowSec));
      }

      const qCols = cols.map(q).join(", ");
      const qs = cols.map((_, i) => `?${i + 1}`).join(", ");

      const setParts = [`${colVal} = excluded.${colVal}`];
      if (colAlt) setParts.push(`${colAlt} = excluded.${colAlt}`);
      if (colExp) setParts.push(`${colExp} = excluded.${colExp}`);
      if (colUpd) setParts.push(`${colUpd} = excluded.${colUpd}`);

      const sql = `INSERT INTO kv (${qCols}) VALUES (${qs}) ON CONFLICT(${colKey}) DO UPDATE SET ${setParts.join(", ")}`;
      await d1.prepare(sql).bind(...vals).run();
      return true;
    },

    async delete(key) {
      await d1.prepare(`DELETE FROM kv WHERE ${colKey} = ?1`).bind(String(key)).run();
      return true;
    },

    async list(opts = {}) {
      const limit = Math.max(1, Math.min(500, Number(opts.limit || 100)));
      const prefix = typeof opts.prefix === "string" ? opts.prefix : "";
      const cursor = typeof opts.cursor === "string" ? opts.cursor : null;

      const params = [];
      let where = "1=1";
      if (prefix) {
        params.push(likeEscape(prefix) + "%");
        where += ` AND ${colKey} LIKE ?${params.length} ESCAPE '\\'`;
      }
      if (cursor) {
        params.push(cursor);
        where += ` AND ${colKey} > ?${params.length}`;
      }
      const sql = `SELECT ${colKey} AS k FROM kv WHERE ${where} ORDER BY ${colKey} ASC LIMIT ${limit}`;
      const res = await d1.prepare(sql).bind(...params).all();
      const keys = (res.results || []).map((r) => r.k);
      const nextCursor = keys.length ? String(keys[keys.length - 1]) : null;
      return { keys, cursor: nextCursor };
    }
  };
}


const __MQ_CFG_CACHE = globalThis.__MQ_CFG_CACHE || { ts: 0, cfg: null };
globalThis.__MQ_CFG_CACHE = __MQ_CFG_CACHE;

const MQ_CFG_KEY = "cfg:main";

function defaultMainConfig(env) {
  const currency = (env.SUB_CURRENCY || "USDT").toString().trim() || "USDT";
  const premiumLimit = toInt(env.PREMIUM_DAILY_LIMIT, 200);

  const p1 = Number(env.SUB_PRICE_M1 ?? env.SUB_PRICE_1M ?? 10);
  const p3 = Number(env.SUB_PRICE_M3 ?? env.SUB_PRICE_3M ?? 25);
  const p12 = Number(env.SUB_PRICE_Y1 ?? env.SUB_PRICE_12M ?? 80);

  const subPlans = [
    { id: "m1", title: "⭐ ماهانه", days: 30, price: Number.isFinite(p1) ? p1 : 10, currency, dailyLimit: premiumLimit },
    { id: "m3", title: "🔥 سه‌ماهه", days: 90, price: Number.isFinite(p3) ? p3 : 25, currency, dailyLimit: premiumLimit },
    { id: "y1", title: "👑 سالانه", days: 365, price: Number.isFinite(p12) ? p12 : 80, currency, dailyLimit: premiumLimit },
  ];

  const styles = Object.keys(STYLE_ANALYSIS_PROMPTS_DEFAULT || {}).map(label => ({
    id: stylePromptKey(label) || label,
    label,
    enabled: true,
    prompt: STYLE_ANALYSIS_PROMPTS_DEFAULT[label] || "",
  }));

  return {
    walletAddress: (env.WALLET_ADDRESS || "").toString().trim(),
    limits: {
      freeDailyLimit: toInt(env.FREE_DAILY_LIMIT, 3),
      premiumDailyLimit: premiumLimit,
    },
    commissions: {
      globalPct: Number(env.GLOBAL_COMMISSION_PCT ?? 0),
      perUser: {},
    },
    subPlans,
    styles,
  };
}

function normalizeMainConfig(cfg, env) {
  const d = defaultMainConfig(env);
  const out = { ...d, ...(cfg || {}) };

  out.limits = { ...d.limits, ...((cfg || {}).limits || {}) };
  out.commissions = { ...d.commissions, ...((cfg || {}).commissions || {}) };
  out.commissions.perUser = { ...((d.commissions || {}).perUser || {}), ...(((cfg || {}).commissions || {}).perUser || {}) };

  if (!Array.isArray(out.subPlans) || !out.subPlans.length) out.subPlans = d.subPlans;
  if (!Array.isArray(out.styles) || !out.styles.length) out.styles = d.styles;

  // sanitize numeric
  out.limits.freeDailyLimit = toInt(out.limits.freeDailyLimit, d.limits.freeDailyLimit);
  out.limits.premiumDailyLimit = toInt(out.limits.premiumDailyLimit, d.limits.premiumDailyLimit);
  out.commissions.globalPct = Number.isFinite(Number(out.commissions.globalPct)) ? Number(out.commissions.globalPct) : 0;

  return out;
}

async function loadMainConfig(env) {
  const ttl = toInt(env.CFG_CACHE_TTL_MS, 30000);
  const now = Date.now();

  if (__MQ_CFG_CACHE.cfg && (now - __MQ_CFG_CACHE.ts) < ttl) return __MQ_CFG_CACHE.cfg;

  const db = getDB(env);
  if (!db) {
    const c = defaultMainConfig(env);
    __MQ_CFG_CACHE.cfg = c; __MQ_CFG_CACHE.ts = now;
    return c;
  }

  const raw = await db.get(MQ_CFG_KEY);
  let cfg = null;
  if (raw) {
    try { cfg = JSON.parse(raw); } catch {}
  }

  const c = normalizeMainConfig(cfg, env);
  __MQ_CFG_CACHE.cfg = c; __MQ_CFG_CACHE.ts = now;
  return c;
}

async function saveMainConfig(env, cfg) {
  const db = getDB(env);
  if (!db) throw new Error("bot_db_missing");
  const c = normalizeMainConfig(cfg, env);
  await db.put(MQ_CFG_KEY, JSON.stringify(c));
  __MQ_CFG_CACHE.cfg = c; __MQ_CFG_CACHE.ts = Date.now();
  return c;
}

function cfgOf(env) {
  return env?.__cfg || __MQ_CFG_CACHE.cfg || null;
}

function toAsciiDigits(input) {
  const mapFa = { "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9" };
  const mapAr = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  return String(input || "")
    .replace(/[۰-۹]/g, (d) => mapFa[d] ?? d)
    .replace(/[٠-٩]/g, (d) => mapAr[d] ?? d);
}


/* ========================== PROMPTS (ADMIN/OWNER ONLY) ========================== */
const DEFAULT_ANALYSIS_PROMPT = `You are a professional market analyst.

TASK
Analyze the market using the provided data for timeframe {TIMEFRAME}.
Use clear structure, actionable levels, and strict invalidation.

RULES
- Output must be فارسی.
- Exactly sections ۱ تا ۵ (no extra headings).
- Use only provided OHLC / chart observations; خیال‌بافی نکن.
- Always specify invalidation (ابطال).

OUTPUT FORMAT (فارسی، دقیقاً ۱ تا ۵):
۱. جهت و ساختار بازار (روی {TIMEFRAME})
۲. سطوح و زون‌های کلیدی (S/R + عرضه/تقاضا + نقدینگی نزدیک)
۳. تریگر/شرایط ورود (کندلی/شکست-برگشت/ری‌تست)
۴. سناریوی معامله (Entry/SL/TP + نسبت ریسک/ریوارد)
۵. مدیریت معامله + شرایط ابطال`;

const SMARTMONEY_ANALYSIS_PROMPT = `SMART MONEY MODE: Institutional Liquidity Hunter

ROLE: You are an elite “Liquidity Hunter Algorithm” tracking Smart Money.
INPUT CONTEXT: {TIMEFRAME} Timeframe Chart.

MINDSET
Retail traders predict. Whales react.
Focus on Liquidity Pools (Targets) and Imbalances (Magnets).
Crucial: Determine what happens AT the target level (Reversal vs. Continuation).

ANALYSIS PROTOCOL
LIQUIDITY MAPPING: Where are the Stop Losses? (The Target).
MANIPULATION DETECTOR: Identify recent traps/fake-outs.
INSTITUTIONAL FOOTPRINT: Locate Order Blocks/FVGs (The Defense Wall).
THE KILL ZONE: Predict the next move to the liquidity pool.
REACTION LOGIC (THE MOST IMPORTANT PART): Analyze the specific target level. What specifically needs to happen for a “Reversal” (Sweep) vs a “Collapse” (Breakout)?

OUTPUT FORMAT (STRICTLY PERSIAN - فارسی)
Use a sharp, revealing, and “whistle-blower” tone.

۱. نقشه پول‌های پارک‌شده (شکارگاه نهنگ‌ها):
۲. تله‌های قیمتی اخیر (فریب بازار):
۳. ردپای ورود پول هوشمند (دیوار بتنی):
۴. سناریوی بی‌رحمانه بعدی (مسیر احتمالی):
۵. استراتژی لحظه برخورد (ماشه نهایی):

سناریوی بازگشت (Reversal):
سناریوی سقوط/صعود (Continuation):`;

/* ========================== STYLE PROMPTS (DEFAULTS) ==========================
 * Users choose st.style (Persian labels) and we inject a style-specific guide
 * into the analysis prompt. Admin can still override the global base prompt via KV.
 */
const STYLE_PROMPTS_DEFAULT = {
  "پرایس اکشن": `You are a professional Price Action trader and market analyst.

Analyze the given market (Symbol, Timeframe) using pure Price Action concepts only.
Do NOT use indicators unless explicitly requested.

Your analysis must include:

1. Market Structure
- Identify the current structure (Uptrend / Downtrend / Range)
- Mark HH, HL, LH, LL
- Specify whether structure is intact or broken (BOS / MSS)

2. Key Levels
- Strong Support & Resistance zones
- Flip zones (SR → Resistance / Resistance → Support)
- Psychological levels (if relevant)

3. Candlestick Behavior
- Identify strong rejection candles (Pin bar, Engulfing, Inside bar)
- Explain what these candles indicate about buyers/sellers

4. Entry Scenarios
For each valid setup:
- Entry zone
- Stop Loss (logical, structure-based)
- Take Profit targets (TP1 / TP2)
- Risk to Reward (minimum 1:2)

5. Bias & Scenarios
- Main bias (Bullish / Bearish / Neutral)
- Alternative scenario if price invalidates the setup

6. Execution Plan
- Is this a continuation or reversal trade?
- What confirmation is required before entry?

Explain everything step-by-step, clearly and professionally.
Avoid overtrading. Focus on high-probability setups only.`,
  "ICT": `You are an ICT (Inner Circle Trader) & Smart Money analyst.

Analyze the market (Symbol, Timeframe) using ICT & Smart Money Concepts ONLY.

Your analysis must include:

1. Higher Timeframe Bias
- Determine HTF bias (Daily / H4)
- Identify Premium & Discount zones
- Is price in equilibrium or imbalance?

2. Liquidity Mapping
- Identify:
  - Equal Highs / Equal Lows
  - Buy-side liquidity
  - Sell-side liquidity
- Mark likely stop-loss pools

3. Market Structure
- Identify:
  - BOS (Break of Structure)
  - MSS (Market Structure Shift)
- Clarify whether the move is manipulation or expansion

4. PD Arrays
- Order Blocks (Bullish / Bearish)
- Fair Value Gaps (FVG)
- Liquidity Voids
- Previous High / Low (PDH, PDL, PWH, PWL)

5. Kill Zones (if intraday)
- London Kill Zone
- New York Kill Zone
- Explain timing relevance

6. Entry Model
- Entry model used (e.g. Liquidity Sweep → MSS → FVG entry)
- Entry price
- Stop Loss (below/above OB or swing)
- Take Profits (liquidity targets)

7. Narrative
- Explain the story:
  - Who is trapped?
  - Where did smart money enter?
  - Where is price likely engineered to go?

Provide a clear bullish/bearish execution plan and an invalidation point.`,
  "ATR": `You are a quantitative trading assistant specializing in volatility-based strategies.

Analyze the market (Symbol, Timeframe) using ATR (Average True Range) as the core tool.

Your analysis must include:

1. Volatility State
- Current ATR value
- Compare current ATR with historical average
- Is volatility expanding or contracting?

2. Market Condition
- Trending or Ranging?
- Is the market suitable for breakout or mean reversion?

3. Trade Setup
- Optimal Entry based on price structure
- ATR-based Stop Loss:
  - SL = Entry ± (ATR × Multiplier)
- ATR-based Take Profit:
  - TP1, TP2 based on ATR expansion

4. Position Sizing
- Risk per trade (%)
- Position size calculation based on SL distance

5. Trade Filtering
- When NOT to trade based on ATR
- High-risk volatility conditions (news, spikes)

6. Risk Management
- Max daily loss
- Max consecutive losses
- Trailing Stop logic using ATR

7. Summary
- Is this trade statistically justified?
- Expected trade duration
- Risk classification (Low / Medium / High)

Keep the explanation practical and execution-focused.`,
};

const STYLE_ANALYSIS_PROMPTS_DEFAULT = {
  "اسمارت‌مانی": SMARTMONEY_ANALYSIS_PROMPT,

  "اسکالپ": `You are a professional intraday scalper and market analyst.

Focus on fast, high-probability setups with tight invalidation and realistic intraday targets.
Prefer: M15/H1 structure, session context (London/NY), recent liquidity, clean confirmations.

Constraints:
- No long explanations; be direct and executable.
- Suggest entries only if there is a clear trigger near a defined zone.
- Targets should be close and achievable intraday; always specify invalidation.

OUTPUT FORMAT (فارسی، دقیقاً ۱ تا ۵):
۱. جهت و ساختار کوتاه‌مدت (روی {TIMEFRAME})
۲. زون‌های کلیدی (S/R + عرضه/تقاضا + نقدینگی نزدیک)
۳. تریگرهای ورود اسکالپ (تایید کندلی/شکست-برگشت/ری‌تست)
۴. سناریوهای معامله (Entry/SL/TP و نسبت ریسک/ریوارد)
۵. پلن اجرای سریع + شرایط ابطال`,

  "سوئینگ": `You are a professional swing trader and market analyst.

Focus on multi-day/multi-week structure and higher-timeframe levels.
Prefer: H4/D1 context, major S/R, ranges, trend legs, and clean invalidation points.

Constraints:
- Avoid scalp-level noise. Use fewer, higher-quality zones.
- Targets can be broader (multiple R), but must be realistic and level-based.

OUTPUT FORMAT (فارسی، دقیقاً ۱ تا ۵):
۱. بایاس و ساختار میان‌مدت (روی {TIMEFRAME})
۲. سطوح/زون‌های اصلی (حمایت/مقاومت‌های تاییدشده)
۳. سناریوهای سوئینگ (سناریوی اصلی + آلترناتیو)
۴. پلن ورود/خروج (Entry/SL/TP های پله‌ای)
۵. مدیریت معامله + شرایط ابطال`,

  "پرایس اکشن": `You are a professional Price Action trader and market analyst.

Analyze the market using ONLY Price Action:
- Market structure (HH/HL / LH/LL), trend vs range
- Key S/R, supply/demand zones
- Candle behavior (rejections, impulses, pin/engulf)
Avoid indicators and avoid ICT-specific jargon.

OUTPUT FORMAT (فارسی، دقیقاً ۱ تا ۵):
۱. ساختار بازار و بایاس (روی {TIMEFRAME})
۲. سطوح کلیدی و زون‌ها (حمایت/مقاومت + عرضه/تقاضا)
۳. رفتار کندل/مومنتوم (نشانه‌های ادامه یا برگشت)
۴. سناریوهای معاملاتی (Entry/SL/TP)
۵. نکات اجرایی + شرایط ابطال`,

  "ICT": `You are an ICT (Inner Circle Trader) style market analyst.

Use ICT/SMC concepts:
- Liquidity pools (equal highs/lows, sell-side/buy-side)
- Market Structure Shift (MSS) / Break of Structure (BOS)
- Order Blocks (OB), Fair Value Gap (FVG), Imbalance
- Optimal Trade Entry (OTE) only if relevant
Avoid generic indicator-based advice.

OUTPUT FORMAT (فارسی، دقیقاً ۱ تا ۵):
۱. نقشه نقدینگی و بایاس (روی {TIMEFRAME})
۲. سطوح مهم: BOS/MSS + OB/FVG
۳. سناریوی برداشت نقدینگی (قبل/بعد از سوئیپ)
۴. پلن ورود/خروج (Entry/SL/TP + تایید)
۵. مدیریت ریسک + شرایط ابطال`,

  "ATR": `You are a professional trader using ATR-based risk and target planning.

Use ATR (Average True Range) as the core tool for:
- Stop distance (SL) and take profit (TP) planning
- Position sizing logic and volatility-aware expectations
You may reference ATR conceptually even if exact ATR value is not provided.

OUTPUT FORMAT (فارسی، دقیقاً ۱ تا ۵):
۱. جهت و ساختار بازار (روی {TIMEFRAME})
۲. زون‌های کلیدی + نوسان (برد منطقی حرکت)
۳. پلن SL/TP مبتنی بر ATR (مثلاً ۱×ATR، ۱.۵×ATR…)
۴. سناریوهای ورود (Entry/SL/TP)
۵. مدیریت ریسک + شرایط ابطال`,
};


function normalizeStyleLabel(style) {
  const s = String(style || "").trim();
  if (!s) return "";
  const low = s.toLowerCase();

  if (low.includes("پرایس") || low.includes("price")) return "پرایس اکشن";
  if (low.includes("اسمارت") || low.includes("smart")) return "اسمارت‌مانی";
  if (low.includes("اسکال") || low.includes("scalp")) return "اسکالپ";
  if (low.includes("سوئ") || low.includes("swing")) return "سوئینگ";

  if (low === "ict" || low.includes("ict")) return "ICT";
  if (low === "atr" || low.includes("atr")) return "ATR";

  return s;
}

function getStyleGuide(style) {
  const key = normalizeStyleLabel(style);
  return STYLE_PROMPTS_DEFAULT[key] || "";
}

function stylePromptKey(style) {
  const label = normalizeStyleLabel(style);
  const map = {
    "اسکالپ": "scalp",
    "سوئینگ": "swing",
    "اسمارت‌مانی": "smartmoney",
    "پرایس اکشن": "priceaction",
    "ICT": "ict",
    "ATR": "atr",
  };
  return map[label] || "";
}

async function getAnalysisPromptForStyle(env, style) {
  const label = normalizeStyleLabel(style);
  const key = stylePromptKey(label);

  // 0) config (bot_db cfg:main) per-style prompt
  const cfg = cfgOf(env);
  if (cfg && Array.isArray(cfg.styles)) {
    const it = cfg.styles.find(s => normalizeStyleLabel(s?.label) === label);
    const pCfg = String(it?.prompt || "").trim();
    if (pCfg) return pCfg;
  }

  // 1) legacy style-specific override (KV keys)
  const kv = getDB(env);
  if (kv && key) {
    const pStyle = await kv.get(`settings:analysis_prompt:${key}`);
    if (pStyle && pStyle.trim()) return pStyle;
  }

  // 2) built-in per-style prompt
  if (STYLE_ANALYSIS_PROMPTS_DEFAULT[label]) return STYLE_ANALYSIS_PROMPTS_DEFAULT[label];

  // 3) global override
  if (kv) {
    const p = await kv.get("settings:analysis_prompt");
    if (p && p.trim()) return p;
  }

  return DEFAULT_ANALYSIS_PROMPT;
}



async function getAnalysisPrompt(env) {
  const kv = getDB(env);
  if (!kv) return DEFAULT_ANALYSIS_PROMPT;
  const p = await kv.get("settings:analysis_prompt");
  return (p && p.trim()) ? p : DEFAULT_ANALYSIS_PROMPT;
}

/* ========================== KEYBOARDS ========================== */
function kb(rows) {
  return {
    keyboard: rows,
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "از دکمه‌ها استفاده کن…",
  };
}

function mainMenuKeyboard(env) {
  const url = getMiniappUrl(env);
  const miniRow = url ? [{ text: BTN.MINIAPP, web_app: { url } }] : [BTN.MINIAPP];
  return kb([
    [BTN.SIGNAL, BTN.SETTINGS],
    [BTN.PROFILE, BTN.WALLET],
    [BTN.SUBSCRIPTION],
    [BTN.SUPPORT, BTN.EDUCATION],
    [BTN.LEVELING],
    miniRow,
    [BTN.HOME],
  ]);
}

function signalMenuKeyboard() {
  return kb([[BTN.CAT_MAJORS, BTN.CAT_METALS], [BTN.CAT_INDICES, BTN.CAT_CRYPTO], [BTN.BACK, BTN.HOME]]);
}

function settingsMenuKeyboard() {
  return kb([[BTN.SET_TF, BTN.SET_STYLE], [BTN.SET_RISK, BTN.SET_NEWS], [BTN.BACK, BTN.HOME]]);
}

function walletMenuKeyboard() {
  return kb([[BTN.WALLET_DEPOSIT, BTN.WALLET_WITHDRAW], [BTN.WALLET_BALANCE], [BTN.BACK, BTN.HOME]]);
}

function subscriptionMenuKeyboard() {
  return kb([[BTN.SUB_BUY], [BTN.SUB_STATUS], [BTN.BACK, BTN.HOME]]);
}

function subscriptionPlanKeyboard() {
  return optionsKeyboard(["⭐ ماهانه", "🔥 سه‌ماهه", "👑 سالانه"]);
}

function subscriptionPayKeyboard(canPayFromBalance) {
  const rows = [];
  if (canPayFromBalance) rows.push(["💳 پرداخت از موجودی"]);
  rows.push(["💸 واریز (TxID)"]);
  rows.push([BTN.BACK, BTN.HOME]);
  return kb(rows);
}


function listKeyboard(items, columns = 2) {
  const rows = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  rows.push([BTN.BACK, BTN.HOME]);
  return kb(rows);
}

function optionsKeyboard(options) {
  const rows = [];
  for (let i = 0; i < options.length; i += 2) rows.push(options.slice(i, i + 2));
  rows.push([BTN.BACK, BTN.HOME]);
  return kb(rows);
}

function contactKeyboard() {
  return {
    keyboard: [[{ text: "📱 ارسال شماره تماس", request_contact: true }], [BTN.BACK, BTN.HOME]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function getMiniappUrl(env) {
  const u = (env.MINIAPP_URL || env.PUBLIC_BASE_URL || "").toString().trim();
  return u;
}
function miniappInlineKeyboard(env) {
  const url = getMiniappUrl(env);
  if (!url) return null;
  return { inline_keyboard: [[{ text: BTN.MINIAPP, web_app: { url } }]] };
}

/* ========================== KV STATE (bot_db) ========================== */
async function getUser(userId, env) {
  const key = `u:${userId}`;
  const db = getDB(env);
  if (!db) {
    const raw = __memGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  try {
    const raw = await db.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } catch (e) {
    console.error("getUser failed, using mem:", e);
    const raw = __memGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}

async function saveUser(userId, st, env) {
  const key = `u:${userId}`;
  const raw = JSON.stringify(st);
  const db = getDB(env);
  if (!db) {
    __memPut(key, raw);
    return;
  }
  try {
    await db.put(key, raw);
  } catch (e) {
    console.error("saveUser failed, using mem:", e);
    __memPut(key, raw);
  }
}


function getCommissionPct(env, username) {
  const cfg = cfgOf(env);
  const per = cfg?.commissions?.perUser || {};
  const k = normHandle(username);
  const raw = (k && Object.prototype.hasOwnProperty.call(per, k)) ? Number(per[k]) : Number(cfg?.commissions?.globalPct || 0);
  const pct = Number.isFinite(raw) ? raw : 0;
  return Math.max(0, pct);
}

async function createWithdrawTicket(env, payload) {
  const ticket = `WD-${randomCode(10).toUpperCase()}`;
  const db = getDB(env);
  if (db) {
    const amount = Number(payload?.amount || 0);
    const pct = getCommissionPct(env, payload?.username || payload?.fromUsername || payload?.from?.username);
    const fee = Math.max(0, amount * (pct / 100));
    const net = Math.max(0, amount - fee);

    const data = {
      ...payload,
      ticket,
      status: "pending",
      commissionPct: pct,
      commissionFee: Number(fee.toFixed(6)),
      netAmount: Number(net.toFixed(6)),
      createdAt: new Date().toISOString(),
    };
    // keep for 90 days
    await db.put(`wd:${ticket}`, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 90 });
  }
  return ticket;
}

async function getSubRequest(env, ticket) {
  const db = getDB(env);
  if (!db) return null;
  const raw = await db.get(`subreq:${ticket}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function putSubRequest(env, ticket, data) {
  const db = getDB(env);
  if (!db) return;
  await db.put(`subreq:${ticket}`, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 180 });
}

async function createSubTicket(env, payload) {
  const ticket = `SUB-${randomCode(10).toUpperCase()}`;
  const db = getDB(env);
  if (db) {
    const data = {
      ...payload,
      ticket,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await putSubRequest(env, ticket, data);
  }
  return ticket;
}


function getSubPlans(env) {
  const cfg = cfgOf(env);
  if (cfg && Array.isArray(cfg.subPlans) && cfg.subPlans.length) return cfg.subPlans;

  const currency = (env.SUB_CURRENCY || "USDT").toString().trim() || "USDT";
  const premiumLimit = toInt(env.PREMIUM_DAILY_LIMIT, 200);

  const p1 = Number(env.SUB_PRICE_M1 ?? env.SUB_PRICE_1M ?? 10);
  const p3 = Number(env.SUB_PRICE_M3 ?? env.SUB_PRICE_3M ?? 25);
  const p12 = Number(env.SUB_PRICE_Y1 ?? env.SUB_PRICE_12M ?? 80);

  return [
    { id: "m1", title: "⭐ ماهانه", days: 30, price: Number.isFinite(p1) ? p1 : 10, currency, dailyLimit: premiumLimit },
    { id: "m3", title: "🔥 سه‌ماهه", days: 90, price: Number.isFinite(p3) ? p3 : 25, currency, dailyLimit: premiumLimit },
    { id: "y1", title: "👑 سالانه", days: 365, price: Number.isFinite(p12) ? p12 : 80, currency, dailyLimit: premiumLimit },
  ];
}

function planFromLabel(env, label) {
  const s = String(label || "").trim();
  const plans = getSubPlans(env);
  if (s.includes("ماه")) return plans.find(p => p.id === "m1");
  if (s.includes("سه")) return plans.find(p => p.id === "m3");
  if (s.includes("سال")) return plans.find(p => p.id === "y1");
  return plans.find(p => p.id === s) || null;
}

async function notifyAdminsSubRequest(env, data) {
  const chatId = (env.ADMIN_NOTIFY_CHAT_ID || "").toString().trim();
  if (!chatId) return;

  const txt =
    `🧾 درخواست خرید اشتراک

` +
    `Ticket: ${data.ticket}
` +
    `UserId: ${data.userId}
` +
    `User: ${data.username ? "@" + data.username : "-"}
` +
    `Plan: ${data.planTitle} (${data.planId})
` +
    `Price: ${data.amount} ${data.currency}
` +
    `Pay: ${data.payMethod}${data.txid ? `
TxID: ${data.txid}` : ""}
` +
    `At: ${data.createdAt}
`;

  const kbInline = {
    inline_keyboard: [[
      { text: "✅ تایید", callback_data: `sub:approve:${data.ticket}` },
      { text: "❌ رد", callback_data: `sub:reject:${data.ticket}` },
    ]]
  };

  await tgSendMessage(env, chatId, txt, kbInline);
}


function defaultUser(userId) {
  return {
    userId,
    createdAt: new Date().toISOString(),

    // bot state machine
    state: "idle",
    selectedSymbol: "",

    // preferences
    timeframe: "H4",
    style: "اسمارت‌مانی",
    risk: "متوسط",
    newsEnabled: true,

    // usage quota
    dailyDate: kyivDateString(),
    dailyUsed: 0,

    // onboarding/profile
    profile: {
      name: "",
      phone: "",
      username: "",
      firstName: "",
      lastName: "",
      marketExperience: "",
      preferredMarket: "",
      level: "", // beginner/intermediate/pro
      levelNotes: "",
      onboardingDone: false,
    },

    // referral / points / subscription
    referral: {
      codes: [],            // 5 codes
      referredBy: "",       // inviter userId
      referredByCode: "",   // which code
      successfulInvites: 0,
      points: 0,
    },
    subscription: {
      active: false,
      type: "free", // free/premium/gift
      expiresAt: "",
      dailyLimit: 50, // base
      planId: "free",
      pendingTicket: "",
      pendingPlanId: "",
      pendingPayMethod: "",
      pendingAmount: 0,
    },

    // wallet (اعتبار داخلی - مدیریت دستی/ادمین)
    wallet: {
      balance: 0,
      currency: "USDT",
    },

    // provider overrides
    textOrder: "",
    visionOrder: "",
    polishOrder: "",
  };
}

function patchUser(st, userId) {
  const d = defaultUser(userId);
  const merged = { ...d, ...st };
  merged.profile = { ...d.profile, ...(st?.profile || {}) };
  merged.referral = { ...d.referral, ...(st?.referral || {}) };
  merged.subscription = { ...d.subscription, ...(st?.subscription || {}) };
  merged.wallet = { ...d.wallet, ...(st?.wallet || {}) };

  merged.timeframe = merged.timeframe || d.timeframe;
  merged.style = merged.style || d.style;
  merged.risk = merged.risk || d.risk;
  merged.newsEnabled = typeof merged.newsEnabled === "boolean" ? merged.newsEnabled : d.newsEnabled;

  merged.dailyDate = merged.dailyDate || d.dailyDate;
  merged.dailyUsed = Number.isFinite(Number(merged.dailyUsed)) ? Number(merged.dailyUsed) : d.dailyUsed;

  merged.wallet.balance = Number.isFinite(Number(merged.wallet?.balance)) ? Number(merged.wallet.balance) : d.wallet.balance;
  merged.wallet.currency = merged.wallet?.currency || d.wallet.currency;

  merged.state = merged.state || "idle";
  merged.selectedSymbol = merged.selectedSymbol || "";

  merged.textOrder = typeof merged.textOrder === "string" ? merged.textOrder : "";
  merged.visionOrder = typeof merged.visionOrder === "string" ? merged.visionOrder : "";
  merged.polishOrder = typeof merged.polishOrder === "string" ? merged.polishOrder : "";

  return merged;
}

async function ensureUser(userId, env, from) {
  const existing = await getUser(userId, env);
  let st = patchUser(existing || {}, userId);

  if (from?.username) st.profile.username = String(from.username);
  if (from?.first_name) st.profile.firstName = String(from.first_name);
  if (from?.last_name) st.profile.lastName = String(from.last_name);

  const today = kyivDateString();
  if (st.dailyDate !== today) {
    st.dailyDate = today;
    st.dailyUsed = 0;
  }

  if (!Array.isArray(st.referral.codes) || st.referral.codes.length < 5) {
    st.referral.codes = (st.referral.codes || []).filter(Boolean);
    while (st.referral.codes.length < 5) st.referral.codes.push(randomCode(10));
  }

  refreshSubscription(st, env);

  if (getDB(env)) await saveUser(userId, st, env);
  return st;
}

function dailyLimit(env, st) {
  const cfg = cfgOf(env);
  const freeBase = toInt(cfg?.limits?.freeDailyLimit ?? env?.FREE_DAILY_LIMIT, 3);
  const premiumBase = toInt(cfg?.limits?.premiumDailyLimit ?? env?.PREMIUM_DAILY_LIMIT, 200);

  if (st?.subscription?.active) {
    const v = toInt(st?.subscription?.dailyLimit, premiumBase);
    return v || premiumBase;
  }
  return freeBase;
}

function canAnalyzeToday(st, from, env) {
  if (isStaff(from, env)) return true;
  const today = kyivDateString();
  const used = (st.dailyDate === today) ? (st.dailyUsed || 0) : 0;
  return used < dailyLimit(env, st);
}

function consumeDaily(st, from, env) {
  if (isStaff(from, env)) return;
  const today = kyivDateString();
  if (st.dailyDate !== today) {
    st.dailyDate = today;
    st.dailyUsed = 0;
  }
  st.dailyUsed = (st.dailyUsed || 0) + 1;
}

/* ========================== TELEGRAM API ========================== */
async function tgApi(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) console.error("Telegram API error:", method, j);
  return j;
}
async function tgSendMessage(env, chatId, text, replyMarkup) {
  return tgApi(env, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 3900),
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}
async function tgSendPhoto(env, chatId, photoUrl, caption, replyMarkup) {
  // Telegram accepts an HTTPS URL as photo
  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    reply_markup: replyMarkup,
  };
  if (caption) payload.caption = String(caption).slice(0, 1000);
  return tgApi(env, "sendPhoto", payload);
}


async function tgAnswerCallbackQuery(env, callbackQueryId, text = "", showAlert = false) {
  return tgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ? String(text).slice(0, 200) : undefined,
    show_alert: !!showAlert,
  });
}

async function tgEditMessageText(env, chatId, messageId, text, replyMarkup) {
  return tgApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: String(text).slice(0, 3900),
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

async function tgSendChatAction(env, chatId, action) {
  return tgApi(env, "sendChatAction", { chat_id: chatId, action });
}
async function tgGetFilePath(env, fileId) {
  const j = await tgApi(env, "getFile", { file_id: fileId });
  return j?.result?.file_path || "";
}

// Send SVG as document (Telegram reliably shows it)
async function tgSendSvgDocument(env, chatId, svgText, filename = "zones.svg", caption = "🖼️ نقشه زون‌ها") {
  const boundary = "----tgform" + Math.random().toString(16).slice(2);
  const CRLF = "\r\n";

  const parts = [];
  const push = (s) => parts.push(typeof s === "string" ? new TextEncoder().encode(s) : s);

  push(`--${boundary}${CRLF}`);
  push(`Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}`);
  push(String(chatId) + CRLF);

  push(`--${boundary}${CRLF}`);
  push(`Content-Disposition: form-data; name="caption"${CRLF}${CRLF}`);
  push(String(caption) + CRLF);

  push(`--${boundary}${CRLF}`);
  push(`Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}`);
  push(`Content-Type: image/svg+xml${CRLF}${CRLF}`);
  push(svgText + CRLF);

  push(`--${boundary}--${CRLF}`);

  const body = concatU8(parts);
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) console.error("Telegram sendDocument error:", j);
  return j;
}

function concatU8(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(new Uint8Array(c), off); off += c.byteLength; }
  return out;
}

/* ========================== TYPING LOOP ========================== */
function stopToken() { return { stop: false }; }
async function typingLoop(env, chatId, token) {
  while (!token.stop) {
    await tgSendChatAction(env, chatId, "typing");
    await sleep(TYPING_INTERVAL_MS);
  }
}

/* ========================== IMAGE PICKING ========================== */
function extractImageFileId(msg, env) {
  if (msg.photo && msg.photo.length) {
    const maxBytes = Number(env.VISION_MAX_BYTES || 900000);
    const sorted = [...msg.photo].sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
    let best = null;
    for (const p of sorted) {
      if ((p.file_size || 0) <= maxBytes) best = p;
    }
    if (!best) best = sorted[0];
    return best?.file_id || "";
  }
  if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    return msg.document.file_id || "";
  }
  return "";
}

/* ========================== PROVIDER CHAINS ========================== */
async function runTextProviders(prompt, env, orderOverride) {
  const chain = parseOrder(orderOverride || env.TEXT_PROVIDER_ORDER, ["cf","openai","gemini"]);
  let lastErr = null;
  for (const p of chain) {
    try {
      const out = await Promise.race([
        textProvider(p, prompt, env),
        timeoutPromise(TIMEOUT_TEXT_MS, `text_${p}_timeout`)
      ]);
      if (out && String(out).trim()) return String(out).trim();
    } catch (e) {
      lastErr = e;
      console.error("text provider failed:", p, e?.message || e);
    }
  }
  throw lastErr || new Error("all_text_providers_failed");
}

async function runPolishProviders(draft, env, orderOverride) {
  const raw = (orderOverride || env.POLISH_PROVIDER_ORDER || "").toString().trim();
  if (!raw) return draft;

  const chain = parseOrder(raw, ["openai","cf","gemini"]);
  const polishPrompt =
    `تو یک ویراستار سخت‌گیر فارسی هستی. متن زیر را فقط “سفت‌وسخت” کن:\n` +
    `- فقط فارسی\n- قالب شماره‌دار ۱ تا ۵ حفظ شود\n- لحن افشاگر/تیز\n- اضافه‌گویی حذف\n- خیال‌بافی نکن\n\n` +
    `متن:\n${draft}`;

  for (const p of chain) {
    try {
      const out = await Promise.race([
        textProvider(p, polishPrompt, env),
        timeoutPromise(TIMEOUT_POLISH_MS, `polish_${p}_timeout`)
      ]);
      if (out && String(out).trim()) return String(out).trim();
    } catch (e) {
      console.error("polish provider failed:", p, e?.message || e);
    }
  }
  return draft;
}

async function runVisionProviders(imageUrl, visionPrompt, env, orderOverride) {
  const chain = parseOrder(orderOverride || env.VISION_PROVIDER_ORDER, ["openai","cf","gemini","hf"]);
  const totalBudget = Number(env.VISION_TOTAL_BUDGET_MS || 20000);
  const deadline = Date.now() + totalBudget;

  let lastErr = null;
  let cached = /** @type {{tooLarge?: boolean}|null} */ (null);

  for (const p of chain) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;

    try {
      if ((p === "cf" || p === "gemini" || p === "hf") && cached && cached.tooLarge) continue;

      const out = await Promise.race([
        visionProvider(p, imageUrl, visionPrompt, env, () => cached, (c) => (cached = c)),
        timeoutPromise(Math.min(TIMEOUT_VISION_MS, remaining), `vision_${p}_timeout`)
      ]);
      if (out && String(out).trim()) return String(out).trim();
    } catch (e) {
      lastErr = e;
      console.error("vision provider failed:", p, e?.message || e);
    }
  }

  throw lastErr || new Error("all_vision_providers_failed_or_budget_exceeded");
}

async function textProvider(name, prompt, env) {
  name = String(name || "").toLowerCase();

  if (name === "cf") {
    if (!env.AI) throw new Error("AI_binding_missing");
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 900,
      temperature: 0.25,
    });
    return out?.response || out?.result || "";
  }

  if (name === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_missing");
    const r = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.25,
      }),
    }, TIMEOUT_TEXT_MS);
    const j = await r.json().catch(() => null);
    return j?.choices?.[0]?.message?.content || "";
  }

  if (name === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY_missing");
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 900 },
        }),
      },
      TIMEOUT_TEXT_MS
    );
    const j = await r.json().catch(() => null);
    return j?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  }

  throw new Error(`unknown_text_provider:${name}`);
}

async function ensureImageCache(imageUrl, env, getCache, setCache) {
  const cur = getCache();
  if (cur?.buf && cur?.mime) return cur;

  const maxBytes = Number(env.VISION_MAX_BYTES || 900000);

  const resp = await fetchWithTimeout(imageUrl, {}, TIMEOUT_VISION_MS);

  const len = Number(resp.headers.get("content-length") || "0");
  if (len && len > maxBytes) {
    const c = { tooLarge: true, mime: "image/jpeg" };
    setCache(c);
    return c;
  }

  const mime = detectMimeFromHeaders(resp, "image/jpeg");
  const buf = await resp.arrayBuffer();

  if (buf.byteLength > maxBytes) {
    const c = { tooLarge: true, mime };
    setCache(c);
    return c;
  }

  const u8 = new Uint8Array(buf);
  const bytesArr = [...u8];
  const base64 = arrayBufferToBase64(buf);

  const c = { buf, mime, base64, bytesArr, u8, tooLarge: false };
  setCache(c);
  return c;
}

async function visionProvider(name, imageUrl, visionPrompt, env, getCache, setCache) {
  name = String(name || "").toLowerCase();

  if (name === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_missing");
    const body = {
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: visionPrompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }],
      temperature: 0.2,
    };
    const r = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, TIMEOUT_VISION_MS);
    const j = await r.json().catch(() => null);
    return j?.choices?.[0]?.message?.content || "";
  }

  if (name === "cf") {
    if (!env.AI) throw new Error("AI_binding_missing");
    const c = await ensureImageCache(imageUrl, env, getCache, setCache);
    if (c.tooLarge) return "";
    const out = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", { image: c.bytesArr, prompt: visionPrompt });
    return out?.description || out?.response || out?.result || "";
  }

  if (name === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY_missing");
    const c = await ensureImageCache(imageUrl, env, getCache, setCache);
    if (c.tooLarge) return "";
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: visionPrompt },
              { inlineData: { mimeType: c.mime, data: c.base64 } },
            ],
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
        }),
      },
      TIMEOUT_VISION_MS
    );
    const j = await r.json().catch(() => null);
    return j?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  }

  if (name === "hf") {
    if (!env.HF_API_KEY) throw new Error("HF_API_KEY_missing");
    const model = (env.HF_VISION_MODEL || "Salesforce/blip-image-captioning-large").toString().trim();
    const c = await ensureImageCache(imageUrl, env, getCache, setCache);
    if (c.tooLarge) return "";
    const r = await fetchWithTimeout(
      `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.HF_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        body: c.u8,
      },
      TIMEOUT_VISION_MS
    );
    const j = await r.json().catch(() => null);
    const txt = Array.isArray(j) ? j?.[0]?.generated_text : (j?.generated_text || j?.text);
    return txt ? String(txt) : "";
  }

  throw new Error(`unknown_vision_provider:${name}`);
}

/* ========================== MARKET DATA (LIVE) ========================== */
function assetKind(symbol) {
  if (symbol.endsWith("USDT")) return "crypto";
  if (/^[A-Z]{6}$/.test(symbol)) return "forex";
  if (symbol === "XAUUSD" || symbol === "XAGUSD") return "metal";
  if (symbol === "DJI" || symbol === "NDX" || symbol === "SPX") return "index";
  return "unknown";
}

function mapTimeframeToBinance(tf) {
  const m = { M15: "15m", H1: "1h", H4: "4h", D1: "1d" };
  return m[tf] || "4h";
}
function mapTimeframeToTwelve(tf) {
  const m = { M15: "15min", H1: "1h", H4: "4h", D1: "1day" };
  return m[tf] || "4h";
}
function mapForexSymbolForTwelve(symbol) {
  if (/^[A-Z]{6}$/.test(symbol)) return `${symbol.slice(0,3)}/${symbol.slice(3,6)}`;
  if (symbol === "XAUUSD") return "XAU/USD";
  if (symbol === "XAGUSD") return "XAG/USD";
  return symbol;
}

function mapTimeframeToAlphaVantage(tf) {
  const m = { M15:"15min", H1:"60min" };
  if (!m[tf]) throw new Error("alphavantage_tf_not_supported");
  return m[tf];
}

function toYahooSymbol(symbol) {
  // Forex
  if (/^[A-Z]{6}$/.test(symbol)) return `${symbol}=X`;

  // Metals (Yahoo FX tickers)
  if (symbol === "XAUUSD") return "XAUUSD=X";
  if (symbol === "XAGUSD") return "XAGUSD=X";

  // Indices
  const idxMap = { DJI: "^DJI", NDX: "^NDX", SPX: "^GSPC" };
  if (idxMap[symbol]) return idxMap[symbol];

  // Crypto
  if (symbol.endsWith("USDT")) return `${symbol.replace("USDT","-USD")}`;

  return symbol;
}
function yahooInterval(tf) {
  const m = { M15:"15m", H1:"60m", H4:"240m", D1:"1d" };
  return m[tf] || "240m";
}

async function fetchBinanceCandles(symbol, timeframe, limit, timeoutMs) {
  if (!symbol.endsWith("USDT")) throw new Error("binance_not_crypto");
  const interval = mapTimeframeToBinance(timeframe);
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`binance_http_${r.status}`);
  const data = await r.json();
  return data.map(k => ({
    t: k[0],
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }));
}

async function fetchTwelveDataCandles(symbol, timeframe, limit, timeoutMs, env) {
  if (!env.TWELVEDATA_API_KEY) throw new Error("twelvedata_key_missing");
  const kind = assetKind(symbol);
  if (kind === "unknown") throw new Error("twelvedata_unknown_symbol");

  const isH4 = String(timeframe || "").toUpperCase() === "H4";
  const interval = isH4 ? "1h" : mapTimeframeToTwelve(timeframe);
  const outputsize = isH4 ? Math.min(limit * 4, 5000) : limit;
  const sym = mapForexSymbolForTwelve(symbol);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&outputsize=${outputsize}&apikey=${encodeURIComponent(env.TWELVEDATA_API_KEY)}`;

  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`twelvedata_http_${r.status}`);
  const j = await r.json();
  if (j.status === "error") throw new Error(`twelvedata_err_${j.code || ""}`);

  const values = Array.isArray(j.values) ? j.values : [];
  const candles = values.reverse().map(v => ({
    t: Date.parse(v.datetime + "Z") || Date.now(),
    o: Number(v.open),
    h: Number(v.high),
    l: Number(v.low),
    c: Number(v.close),
    v: v.volume ? Number(v.volume) : null,
  }));
  return isH4 ? resampleCandles(candles, 4 * 60 * 60 * 1000).slice(-limit) : candles;
}

async function fetchAlphaVantageFxIntraday(symbol, timeframe, limit, timeoutMs, env) {
  if (!env.ALPHAVANTAGE_API_KEY) throw new Error("alphavantage_key_missing");
  if (!/^[A-Z]{6}$/.test(symbol) && symbol !== "XAUUSD" && symbol !== "XAGUSD") throw new Error("alphavantage_only_fx_like");

  const from = symbol.slice(0,3);
  const to = symbol.slice(3,6);
  const interval = mapTimeframeToAlphaVantage(timeframe);

  const url =
    `https://www.alphavantage.co/query?function=FX_INTRADAY` +
    `&from_symbol=${encodeURIComponent(from)}` +
    `&to_symbol=${encodeURIComponent(to)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=compact` +
    `&apikey=${encodeURIComponent(env.ALPHAVANTAGE_API_KEY)}`;

  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`alphavantage_http_${r.status}`);
  const j = await r.json();

  const key = Object.keys(j).find(k => k.startsWith("Time Series FX"));
  if (!key) throw new Error("alphavantage_no_timeseries");

  const ts = j[key];
  const rows = Object.entries(ts)
    .slice(0, limit)
    .map(([dt, v]) => ({
      t: Date.parse(dt + "Z") || Date.now(),
      o: Number(v["1. open"]),
      h: Number(v["2. high"]),
      l: Number(v["3. low"]),
      c: Number(v["4. close"]),
      v: null,
    }))
    .reverse();

  return rows;
}

function mapTimeframeToFinnhubResolution(tf) {
  const m = { M15:"15", H1:"60", H4:"240", D1:"D" };
  return m[tf] || "240";
}
async function fetchFinnhubForexCandles(symbol, timeframe, limit, timeoutMs, env) {
  if (!env.FINNHUB_API_KEY) throw new Error("finnhub_key_missing");
  if (!/^[A-Z]{6}$/.test(symbol)) throw new Error("finnhub_only_forex");

  const res = mapTimeframeToFinnhubResolution(timeframe);
  const inst = `OANDA:${symbol.slice(0,3)}_${symbol.slice(3,6)}`;

  const now = Math.floor(Date.now() / 1000);
  const lookbackSec = 60 * 60 * 24 * 10;
  const from = now - lookbackSec;

  const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(inst)}&resolution=${encodeURIComponent(res)}&from=${from}&to=${now}&token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;

  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`finnhub_http_${r.status}`);
  const j = await r.json();
  if (j.s !== "ok") throw new Error(`finnhub_status_${j.s}`);

  const candles = j.t.map((t, i) => ({
    t: t * 1000,
    o: Number(j.o[i]),
    h: Number(j.h[i]),
    l: Number(j.l[i]),
    c: Number(j.c[i]),
    v: j.v ? Number(j.v[i]) : null,
  }));
  return candles.slice(-limit);
}

async function fetchYahooChartCandles(symbol, timeframe, limit, timeoutMs) {
  const ysym = toYahooSymbol(symbol);
  const isH4 = String(timeframe || "").toUpperCase() === "H4";

  // Yahoo often rejects 240m; fetch 60m and resample to 4H
  const interval = isH4 ? "60m" : yahooInterval(timeframe);
  const range = isH4 ? "30d" : "10d";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  if (!res.ok) throw new Error("yahoo_http_" + res.status);
  const j = await res.json();

  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp;
  const quote = r?.indicators?.quote?.[0];
  if (!ts || !quote) throw new Error("yahoo_no_data");

  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i] ?? 0;
    if ([o, h, l, c].some(x => x == null)) continue;
    out.push({ t: ts[i] * 1000, o, h, l, c, v });
  }

  const candles = isH4 ? resampleCandles(out, 4 * 60 * 60 * 1000) : out;
  return candles.slice(-limit);
}

function resampleCandles(candles, bucketMs) {
  const out = [];
  if (!Array.isArray(candles) || !candles.length) return out;

  let cur = null;
  for (const x of candles) {
    const b = Math.floor(Number(x.t) / bucketMs) * bucketMs;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: Number(x.v || 0) };
      continue;
    }
    cur.h = Math.max(cur.h, x.h);
    cur.l = Math.min(cur.l, x.l);
    cur.c = x.c;
    cur.v = Number(cur.v || 0) + Number(x.v || 0);
  }
  if (cur) out.push(cur);
  return out;
}

async function getMarketCandlesWithFallback(env, symbol, timeframe) {
  const timeoutMs = Number(env.MARKET_DATA_TIMEOUT_MS || 7000);
  const limit = Number(env.MARKET_DATA_CANDLES_LIMIT || 120);

  const kind = assetKind(symbol);

  // Default provider order is chosen by asset kind to avoid noisy/pointless fallbacks.
  const defaultByKind =
    kind === "crypto" ? ["binance", "yahoo", "twelvedata"] :
    kind === "index" ? ["yahoo", "twelvedata"] :
    /* forex/metals/unknown */ ["twelvedata", "alphavantage", "finnhub", "yahoo"];

  // Allow override via env.MARKET_DATA_PROVIDER_ORDER, but still filter by compatibility.
  const chainRaw = parseOrder(env.MARKET_DATA_PROVIDER_ORDER, defaultByKind);

  const isCompat = (p) => {
    if (p === "binance") return kind === "crypto";
    if (p === "alphavantage") return kind === "forex" || kind === "metal";
    if (p === "finnhub") return kind === "forex";
    if (p === "twelvedata") return kind === "forex" || kind === "metal" || kind === "index";
    if (p === "yahoo") return true;
    return false;
  };

  // Ensure yahoo is always available as last resort
  const chain = [...chainRaw.filter(isCompat), "yahoo"].filter((v, i, a) => a.indexOf(v) === i);

  let lastErr = null;

  for (const p of chain) {
    try {
      if (p === "binance") return await fetchBinanceCandles(symbol, timeframe, limit, timeoutMs);
      if (p === "twelvedata") return await fetchTwelveDataCandles(symbol, timeframe, limit, timeoutMs, env);
      if (p === "alphavantage") return await fetchAlphaVantageFxIntraday(symbol, timeframe, limit, timeoutMs, env);
      if (p === "finnhub") return await fetchFinnhubForexCandles(symbol, timeframe, limit, timeoutMs, env);
      if (p === "yahoo") return await fetchYahooChartCandles(symbol, timeframe, limit, timeoutMs);
    } catch (e) {
      lastErr = e;

      // By default keep logs clean; enable with DEBUG_MARKET_DATA=1
      if (String(env.DEBUG_MARKET_DATA || "") === "1") {
        console.warn("market provider failed:", p, e?.message || e);
      }
    }
  }

  throw lastErr || new Error("market_data_all_failed");
}

function computeSnapshot(candles) {
  if (!candles?.length) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const closes = candles.map(x => x.c);
  const sma = (arr, p) => {
    if (arr.length < p) return null;
    const s = arr.slice(-p).reduce((a,b)=>a+b,0);
    return s / p;
  };

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const trend = (sma20 && sma50) ? (sma20 > sma50 ? "صعودی" : "نزولی") : "نامشخص";

  const n = Math.min(50, candles.length);
  const recent = candles.slice(-n);
  const hi = Math.max(...recent.map(x => x.h));
  const lo = Math.min(...recent.map(x => x.l));

  const lastClose = last.c;
  const changePct = prev?.c ? ((lastClose - prev.c) / prev.c) * 100 : 0;

  return {
    lastPrice: lastClose,
    changePct: Number(changePct.toFixed(3)),
    trend,
    range50: { hi, lo },
    sma20: sma20 ? Number(sma20.toFixed(6)) : null,
    sma50: sma50 ? Number(sma50.toFixed(6)) : null,
    lastTs: last.t,
  };
}

function candlesToCompactCSV(candles, maxRows = 80) {
  const tail = candles.slice(-maxRows);
  return tail.map(x => `${x.t},${x.o},${x.h},${x.l},${x.c}`).join("\n");
}
function buildQuickChartUrl(candles, symbol, timeframe, analysisText) {
  try {
    const tail = (candles || []).slice(-70);
    if (!tail.length) return "";

    const labels = tail.map(c => {
      const d = new Date(c.t);
      return (timeframe === "D1")
        ? d.toISOString().slice(5, 10)   // MM-DD
        : d.toISOString().slice(11, 16); // HH:MM
    });

    const closes = tail.map(c => Number(c.c)).filter(n => Number.isFinite(n));
    if (!closes.length) return "";

    const hi = Math.max(...closes);
    const lo = Math.min(...closes);
    const range = (hi - lo) || (Math.abs(hi) || 1);

    // ---- Extract likely price levels from analysis text (and keep only a few) ----
    const levels = (() => {
      if (!analysisText) return [];
      const raw = (toLatinDigits(analysisText).match(/\b\d{1,10}(?:\.\d{1,10})?\b/g) || []);
      const nums = raw.map(Number).filter(n => Number.isFinite(n));
      const minOk = lo - range * 0.25;
      const maxOk = hi + range * 0.25;

      // remove list numbers (1..20) that often appear in sections
      const filtered = nums.filter(n => {
        if (Number.isInteger(n) && n >= 1 && n <= 20) return false;
        return n >= minOk && n <= maxOk;
      }).sort((a, b) => a - b);

      // de-duplicate with tolerance
      const uniq = [];
      const eps = Math.max(range * 0.006, (Math.abs(hi) || 1) * 0.001);
      for (const n of filtered) {
        if (!uniq.length || Math.abs(uniq[uniq.length - 1] - n) > eps) uniq.push(n);
      }

      if (uniq.length <= 3) return uniq;
      // pick support / mid / resistance
      return [uniq[0], uniq[Math.floor(uniq.length / 2)], uniq[uniq.length - 1]];
    })();

    const constArr = (v) => labels.map(() => Number(v));
    const zoneDatasets = [];

    // band width: ~1.2% of recent range (with a floor based on price)
    for (let i = 0; i < levels.length; i++) {
      const L = levels[i];
      const band = Math.max(range * 0.012, Math.abs(L) * 0.0015);

      // upper (invisible)
      zoneDatasets.push({
        label: "zone_u_" + i,
        data: constArr(L + band),
        borderWidth: 0,
        pointRadius: 0,
        borderColor: "rgba(0,0,0,0)",
        backgroundColor: "rgba(0,0,0,0)",
        fill: false,
        order: 0
      });

      // lower (fills to previous -> shaded band)
      zoneDatasets.push({
        label: "zone_" + i,
        data: constArr(L - band),
        borderWidth: 0,
        pointRadius: 0,
        borderColor: "rgba(0,0,0,0)",
        backgroundColor: (i % 2 === 0) ? "rgba(109,94,246,0.14)" : "rgba(0,209,255,0.12)",
        fill: "-1",
        order: 0
      });

      // center dashed line
      zoneDatasets.push({
        label: "level_" + i,
        data: constArr(L),
        borderWidth: 1,
        pointRadius: 0,
        borderDash: [6, 5],
        fill: false,
        order: 1
      });
    }

    const cfg = {
      type: "line",
      data: {
        labels,
        datasets: [
          ...zoneDatasets,
          {
            label: symbol + " " + timeframe,
            data: closes,
            fill: false,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            order: 99
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          title: { display: true, text: symbol + " • " + timeframe + " • Close + Zones" }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { ticks: { maxTicksLimit: 6 } }
        }
      }
    };

    return "https://quickchart.io/chart?format=png&width=900&height=450&devicePixelRatio=2&c=" +
      encodeURIComponent(JSON.stringify(cfg));
  } catch {
    return "";
  }
}


/* ========================== TEXT BUILDERS ========================== */
async function buildTextPromptForSymbol(symbol, userPrompt, st, marketBlock, env) {
  const tf = st.timeframe || "H4";
  const baseRaw = await getAnalysisPromptForStyle(env, st.style);
  const base = baseRaw.replaceAll("{TIMEFRAME}", tf);

  const userExtra = (isStaff({ username: st.profile?.username }, env) && userPrompt?.trim())
    ? userPrompt.trim()
    : "تحلیل با حالت نهادی";

  return (
    `${base}\n\n` +
    (getStyleGuide(st.style) ? `STYLE_GUIDE:\n${getStyleGuide(st.style)}\n\n` : ``) +
    `ASSET: ${symbol}\n` +
    `USER SETTINGS: Style=${st.style}, Risk=${st.risk}\n\n` +
    `MARKET_DATA:\n${marketBlock}\n\n` +
    `RULES:\n` +
    `- خروجی فقط فارسی و دقیقاً بخش‌های ۱ تا ۵\n` +
    `- سطح‌های قیمتی را مشخص کن (X/Y/Z)\n` +
    `- شرط کندلی را واضح بگو (close/wick)\n` +
    `- از داده OHLC استفاده کن، خیال‌بافی نکن\n\n` +
    `EXTRA:\n${userExtra}`
  );
}

async function buildVisionPrompt(st, env) {
  const tf = st.timeframe || "H4";
  const baseRaw = await getAnalysisPromptForStyle(env, st.style);
  const base = baseRaw.replaceAll("{TIMEFRAME}", tf);
  return (
    `${base}\n\n` +
    `TASK: این تصویر چارت را تحلیل کن. دقیقاً خروجی ۱ تا ۵ بده و سطح‌ها را مشخص کن.\n` +
    `RULES: فقط فارسی، لحن افشاگر، خیال‌بافی نکن.\n`
  );
}

/* ========================== WALLET (ADMIN ONLY) ========================== */
async function getWallet(env) {
  const cfg = cfgOf(env);
  if (cfg?.walletAddress) return String(cfg.walletAddress).trim();

  const db = getDB(env);
  if (db) {
    const v = await db.get("settings:wallet");
    if (v && String(v).trim()) return String(v).trim();
  }

  return (env.WALLET_ADDRESS || "").toString().trim();
}
async function setWallet(env, wallet) {
  const db = getDB(env);
  if (!db) throw new Error("bot_db_missing");

  const w = String(wallet || "").trim();
  const cfg = cfgOf(env) || defaultMainConfig(env);
  cfg.walletAddress = w;

  await saveMainConfig(env, cfg);
  // backward compat key
  await db.put("settings:wallet", w);
}

/* ========================== LEVELING (AI) ========================== */
const QUIZ = [
  { key: "q1", text: "۱) بیشتر دنبال چی هستی؟", options: ["اسکالپ سریع", "سوئینگ چندروزه", "هولد/سرمایه‌گذاری", "نمی‌دانم"] },
  { key: "q2", text: "۲) وقتی معامله خلاف تو رفت…", options: ["فوراً می‌بندم", "صبر می‌کنم تا ساختار مشخص شود", "میانگین کم می‌کنم", "تجربه‌ای ندارم"] },
  { key: "q3", text: "۳) ابزار تحلیل‌ات؟", options: ["پرایس‌اکشن", "اندیکاتور", "اسمارت‌مانی", "هیچکدام"] },
  { key: "q4", text: "۴) تحمل ریسک؟", options: ["کم", "متوسط", "زیاد", "نمی‌دانم"] },
  { key: "q5", text: "۵) تایم آزاد برای چک کردن بازار؟", options: ["ساعتی", "چندبار در روز", "روزانه", "هفتگی/کم"] },
];

async function evaluateLevelWithAI(env, profile, quizAnswers) {
  const prompt =
`تو یک مشاور تعیین‌سطح معامله‌گری هستی. خروجی فقط JSON باشد.
ورودی:
- تجربه بازار: ${profile.marketExperience}
- بازار مورد علاقه: ${profile.preferredMarket}
- پاسخ‌های آزمون: ${JSON.stringify(quizAnswers)}

خروجی JSON با کلیدهای:
level یکی از: beginner|intermediate|pro
recommendedMarket یکی از: crypto|forex|metals|stocks
settings: { timeframe: "M15|H1|H4|D1", style: "اسکالپ|سوئینگ|اسمارت‌مانی", risk: "کم|متوسط|زیاد" }
notes: رشته کوتاه فارسی`;

  try {
    const out = await runTextProviders(prompt, env, env.TEXT_PROVIDER_ORDER);
    const json = safeExtractJson(out);
    if (json && json.settings) return json;
  } catch (e) {
    console.error("evaluateLevelWithAI failed:", e);
  }

  const risk = (quizAnswers.q4 || "").includes("کم") ? "کم" : (quizAnswers.q4 || "").includes("زیاد") ? "زیاد" : "متوسط";
  const tf = (quizAnswers.q1 || "").includes("اسکالپ") ? "M15" : (quizAnswers.q1 || "").includes("سوئینگ") ? "H4" : "H1";
  return {
    level: "beginner",
    recommendedMarket: mapPreferredMarket(profile.preferredMarket),
    settings: { timeframe: tf, style: "اسمارت‌مانی", risk },
    notes: "تنظیمات اولیه بر اساس پاسخ‌های شما چیده شد.",
  };
}

function safeExtractJson(txt) {
  const s = String(txt || "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function mapPreferredMarket(s) {
  s = (s || "").toLowerCase();
  if (s.includes("کریپتو") || s.includes("crypto")) return "crypto";
  if (s.includes("فارکس") || s.includes("forex")) return "forex";
  if (s.includes("فلز") || s.includes("gold") || s.includes("xau")) return "metals";
  if (s.includes("سهام") || s.includes("stock")) return "stocks";
  return "crypto";
}

/* ========================== REFERRAL / POINTS ========================== */
async function storeReferralCodeOwner(env, code, ownerUserId) {
  const db = getDB(env);
  if (!db) return;
  await db.put(`ref:${code}`, String(ownerUserId));
}
async function resolveReferralOwner(env, code) {
  const db = getDB(env);
  if (!db) return "";
  const v = await db.get(`ref:${code}`);
  return (v || "").toString().trim();
}

async function hashPhone(phone) {
  const data = new TextEncoder().encode(String(phone || "").trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  const u8 = new Uint8Array(digest);
  let hex = "";
  for (const b of u8) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function isPhoneNew(env, phone) {
  if (!getDB(env)) return true;
  const h = await hashPhone(phone);
  const key = `phone:${h}`;
  const exists = await getDB(env).get(key);
  return !exists;
}

async function markPhoneSeen(env, phone, userId) {
  const db = getDB(env);
  if (!db) return;
  const h = await hashPhone(phone);
  await db.put(`phone:${h}`, String(userId));
}

async function awardReferralIfEligible(env, newUserSt) {
  if (!getDB(env)) return;
  const phone = newUserSt.profile?.phone || "";
  if (!phone) return;

  const isNew = await isPhoneNew(env, phone);
  await markPhoneSeen(env, phone, newUserSt.userId);

  if (!newUserSt.referral?.referredBy || !newUserSt.referral?.referredByCode) return;
  if (!isNew) return;

  const inviterId = String(newUserSt.referral.referredBy);
  const inviter = await ensureUser(inviterId, env);
  inviter.referral.successfulInvites = (inviter.referral.successfulInvites || 0) + 1;
  inviter.referral.points = (inviter.referral.points || 0) + 3;

  if (inviter.referral.points >= 500) {
    inviter.referral.points -= 500;
    inviter.subscription.active = true;
    inviter.subscription.type = "gift";
    inviter.subscription.dailyLimit = 50;
    inviter.subscription.expiresAt = futureISO(30);
  }

  await saveUser(inviterId, inviter, env);
}

function futureISO(days) {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  return d.toISOString();
}

function addDaysISO(baseIso, days) {
  const base = baseIso ? Date.parse(baseIso) : NaN;
  const t0 = Number.isFinite(base) ? base : Date.now();
  const d = new Date(t0 + Number(days || 0) * 24 * 3600 * 1000);
  return d.toISOString();
}

function refreshSubscription(st, env) {
  st.subscription = st.subscription || {};
  const exp = st.subscription.expiresAt;
  if (st.subscription.active && exp) {
    const t = Date.parse(exp);
    if (Number.isFinite(t) && t <= Date.now()) {
      st.subscription.active = false;
      st.subscription.type = "free";
      st.subscription.planId = "free";
      st.subscription.expiresAt = "";
      st.subscription.dailyLimit = toInt(env?.FREE_DAILY_LIMIT, 3);
    }
  }
  if (!st.subscription.dailyLimit) st.subscription.dailyLimit = toInt(env?.FREE_DAILY_LIMIT, 3);
}

/* ========================== UPDATE HANDLER ========================== */
async function handleUpdate(update, env) {
  try {
    env.__cfg = await loadMainConfig(env);

    const cq = update.callback_query;
    if (cq) {
      await handleCallbackQuery(env, cq);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const from = msg.from;
    const userId = from?.id;
    if (!chatId || !userId) return;

    const st = await ensureUser(userId, env, from);

    if (msg.contact && msg.contact.phone_number) {
      await handleContact(env, chatId, from, st, msg.contact);
      return;
    }

    const imageFileId = extractImageFileId(msg, env);
    if (imageFileId) {
      if (!st.profile?.name || !st.profile?.phone) {
        await tgSendMessage(env, chatId, "برای استفاده از تحلیل، ابتدا نام و شماره را ثبت کن ✅", mainMenuKeyboard(env));
        await startOnboarding(env, chatId, from, st);
        return;
      }
      await handleVisionFlow(env, chatId, from, userId, st, imageFileId);
      return;
    }

    const text = (msg.text || "").trim();
    // quick onboarding fallback (اگر state ذخیره نشد یا پاک شد)
    if (!st.profile?.name && text && !text.startsWith("/") && !Object.values(BTN).includes(text)) {
      const nameTry = text.replace(/\s+/g, " ").trim();
      if (nameTry && nameTry.length >= 2) {
        st.profile.name = nameTry;
        st.state = "onb_contact";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "عالی ✅ حالا لطفاً شماره تماس را با دکمه زیر ارسال کن:", contactKeyboard());
      }
    }


    if (text === "/start") {
      const refArg = (msg.text || "").split(" ").slice(1).join(" ").trim();
      await onStart(env, chatId, from, st, refArg);
      return;
    }

    if (text.startsWith("/setwallet")) {
      if (!isAdmin(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین می‌تواند آدرس ولت را تنظیم کند.", mainMenuKeyboard(env));
      const wallet = text.split(" ").slice(1).join(" ").trim();
      if (!wallet) return tgSendMessage(env, chatId, "فرمت: /setwallet <wallet_address>", mainMenuKeyboard(env));
      await setWallet(env, wallet);
      return tgSendMessage(env, chatId, "✅ آدرس ولت ذخیره شد.", mainMenuKeyboard(env));
    }

    if (text.startsWith("/setprompt")) {
      if (!isStaff(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین/اونر می‌تواند پرامپت تحلیل را تعیین کند.", mainMenuKeyboard(env));
      const p = text.split(" ").slice(1).join(" ").trim();
      if (!p) return tgSendMessage(env, chatId, "فرمت: /setprompt <prompt_text>", mainMenuKeyboard(env));
      if (!getDB(env)) return tgSendMessage(env, chatId, "⛔️ BOT_KV فعال نیست.", mainMenuKeyboard(env));
      await getDB(env).put("settings:analysis_prompt", p);
      return tgSendMessage(env, chatId, "✅ پرامپت تحلیل ذخیره شد.", mainMenuKeyboard(env));
    }

    if (text.startsWith("/setpromptstyle")) {
      if (!isStaff(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین/اونر می‌تواند پرامپت هر سبک را تعیین کند.", mainMenuKeyboard(env));
      if (!getDB(env)) return tgSendMessage(env, chatId, "⛔️ BOT_KV فعال نیست.", mainMenuKeyboard(env));

      const parts = text.split(" ");
      const styleArg = parts[1] || "";
      const p = parts.slice(2).join(" ").trim();
      if (!styleArg || !p) {
        return tgSendMessage(
          env,
          chatId,
          "فرمت: /setpromptstyle <style> <prompt_text>\n\nstyle های معتبر: اسکالپ | سوئینگ | اسمارت‌مانی | پرایس اکشن | ICT | ATR",
          mainMenuKeyboard(env)
        );
      }

      const label = normalizeStyleLabel(styleArg);
      const key = stylePromptKey(label);
      if (!key) {
        return tgSendMessage(env, chatId, "❌ سبک نامعتبر است. یکی از این‌ها را وارد کن: اسکالپ | سوئینگ | اسمارت‌مانی | پرایس اکشن | ICT | ATR", mainMenuKeyboard(env));
      }

      await getDB(env).put(`settings:analysis_prompt:${key}`, p);
      return tgSendMessage(env, chatId, `✅ پرامپت سبک «${label}» ذخیره شد.`, mainMenuKeyboard(env));
    }

    if (text.startsWith("/getpromptstyle")) {
      if (!isStaff(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین/اونر می‌تواند پرامپت‌ها را ببیند.", mainMenuKeyboard(env));
      const styleArg = text.split(" ").slice(1).join(" ").trim();
      if (!styleArg) return tgSendMessage(env, chatId, "فرمت: /getpromptstyle <style>", mainMenuKeyboard(env));
      const label = normalizeStyleLabel(styleArg);
      const p = await getAnalysisPromptForStyle(env, label);
      return tgSendMessage(env, chatId, `🧩 پرامپت سبک «${label}»:\n\n${p}`, mainMenuKeyboard(env));
    }

    if (text.startsWith("/setbalance")) {
      if (!isAdmin(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین می‌تواند موجودی را تغییر دهد.", mainMenuKeyboard(env));
      const parts = text.split(" ");
      const uid = parts[1];
      const amount = Number(toAsciiDigits(parts[2] || ""));
      if (!uid || !Number.isFinite(amount)) return tgSendMessage(env, chatId, "فرمت: /setbalance <userId> <amount>", mainMenuKeyboard(env));
      const u = await ensureUser(uid, env);
      u.wallet = u.wallet || { balance: 0, currency: "USDT" };
      u.wallet.balance = amount;
      await saveUser(uid, u, env);
      return tgSendMessage(env, chatId, `✅ موجودی کاربر ${uid} شد: ${amount} ${u.wallet.currency || "USDT"}`, mainMenuKeyboard(env));
    }

    if (text.startsWith("/addbalance")) {
      if (!isAdmin(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین می‌تواند موجودی را تغییر دهد.", mainMenuKeyboard(env));
      const parts = text.split(" ");
      const uid = parts[1];
      const delta = Number(toAsciiDigits(parts[2] || ""));
      if (!uid || !Number.isFinite(delta)) return tgSendMessage(env, chatId, "فرمت: /addbalance <userId> <delta>", mainMenuKeyboard(env));
      const u = await ensureUser(uid, env);
      u.wallet = u.wallet || { balance: 0, currency: "USDT" };
      u.wallet.balance = Number(u.wallet.balance || 0) + delta;
      await saveUser(uid, u, env);
      return tgSendMessage(env, chatId, `✅ موجودی کاربر ${uid} تغییر کرد: ${u.wallet.balance} ${u.wallet.currency || "USDT"}`, mainMenuKeyboard(env));
    }

    // ===== Subscription admin commands =====
    if (text === "/sublist") {
      if (!isAdmin(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین.", mainMenuKeyboard(env));
      if (!getDB(env) || !getDB(env).list) return tgSendMessage(env, chatId, "⛔️ KV list در دسترس نیست.", mainMenuKeyboard(env));

      const res = await getDB(env).list({ prefix: "subreq:", limit: 30 });
      const keys = res?.keys || [];
      if (!keys.length) return tgSendMessage(env, chatId, "درخواستی پیدا نشد.", mainMenuKeyboard(env));

      const pending = [];
      for (const k of keys) {
        const ticket = String(k.name || "").replace("subreq:", "");
        const req = await getSubRequest(env, ticket);
        if (req && req.status === "pending") {
          pending.push(`• ${ticket} | ${req.planTitle || req.planId} | ${req.amount} ${req.currency} | ${req.userId}`);
        }
      }
      if (!pending.length) return tgSendMessage(env, chatId, "درخواست در انتظار نداریم ✅", mainMenuKeyboard(env));
      return tgSendMessage(env, chatId, "🕓 Pending:\n" + pending.join("\n"), mainMenuKeyboard(env));
    }

    if (text.startsWith("/subapprove")) {
      if (!isAdmin(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین.", mainMenuKeyboard(env));
      const parts = text.split(" ");
      const ticket = (parts[1] || "").trim();
      if (!ticket) return tgSendMessage(env, chatId, "فرمت: /subapprove <ticket>", mainMenuKeyboard(env));
      const r = await adminApproveSub(env, ticket, from);
      if (!r.ok) return tgSendMessage(env, chatId, "⚠️ خطا: " + (r.error || "نامشخص"), mainMenuKeyboard(env));
      return tgSendMessage(env, chatId, `✅ تایید شد. اعتبار تا: ${r.expiresAt}`, mainMenuKeyboard(env));
    }

    if (text.startsWith("/subreject")) {
      if (!isAdmin(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین.", mainMenuKeyboard(env));
      const parts = text.split(" ");
      const ticket = (parts[1] || "").trim();
      const reason = parts.slice(2).join(" ").trim();
      if (!ticket) return tgSendMessage(env, chatId, "فرمت: /subreject <ticket> <reason?>", mainMenuKeyboard(env));
      const r = await adminRejectSub(env, ticket, from, reason || "رد شد");
      if (!r.ok) return tgSendMessage(env, chatId, "⚠️ خطا: " + (r.error || "نامشخص"), mainMenuKeyboard(env));
      return tgSendMessage(env, chatId, "❌ رد شد.", mainMenuKeyboard(env));
    }


    if (text === "/signals" || text === "/signal" || text === BTN.SIGNAL) {
      if (!st.profile?.name || !st.profile?.phone) {
        await tgSendMessage(env, chatId, "برای شروع تحلیل، ابتدا پروفایل را کامل کن ✅", mainMenuKeyboard(env));
        await startOnboarding(env, chatId, from, st);
        return;
      }
      st.state = "wiz_market";
      st.selectedSymbol = "";
      st.wizard = { market: "", symbol: "", style: "", timeframe: "" };
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "🧭 مرحله ۱/۴: بازار را انتخاب کن:", signalMenuKeyboard());
    }

    if (text === "/settings" || text === BTN.SETTINGS) {
      if (!st.profile?.name || !st.profile?.phone) {
        await tgSendMessage(env, chatId, "برای تنظیمات، ابتدا پروفایل را کامل کن ✅", mainMenuKeyboard(env));
        await startOnboarding(env, chatId, from, st);
        return;
      }
      return sendSettingsSummary(env, chatId, st, from);
    }

    if (text === "/profile" || text === BTN.PROFILE) {
      return tgSendMessage(env, chatId, profileText(st, from, env), mainMenuKeyboard(env));
    }


    if (text === "/wallet" || text === BTN.WALLET) {
      const walletAddr = await getWallet(env);
      const addrLine = walletAddr ? `\n\nآدرس واریز:\n${walletAddr}` : "";
      const bal = Number(st.wallet?.balance || 0);
      const cur = st.wallet?.currency || "USDT";
      return tgSendMessage(
        env,
        chatId,
        `💳 کیف پول\n\nموجودی: ${bal} ${cur}\nامتیاز شما: ${Number(st.referral?.points || 0)}${addrLine}\n\nیکی از گزینه‌ها را انتخاب کن:`,
        walletMenuKeyboard()
      );
    }

    if (text === BTN.WALLET_DEPOSIT) {
      const walletAddr = await getWallet(env);
      const addrLine = walletAddr ? `${walletAddr}` : "فعلاً آدرس ولت تنظیم نشده.";
      return tgSendMessage(
        env,
        chatId,
        `➕ واریز\n\nآدرس واریز:\n${addrLine}\n\nبعد از واریز، رسید/TxId را برای پشتیبانی ارسال کن تا موجودی‌ات شارژ شود.`,
        walletMenuKeyboard()
      );
    }

    if (text === BTN.WALLET_BALANCE) {
      const bal = Number(st.wallet?.balance || 0);
      const cur = st.wallet?.currency || "USDT";
      return tgSendMessage(
        env,
        chatId,
        `📊 موجودی\n\nموجودی: ${bal} ${cur}\nامتیاز: ${Number(st.referral?.points || 0)}\nاشتراک: ${st.subscription?.active ? "فعال ✅" : "غیرفعال ❌"}${st.subscription?.expiresAt ? `\nانقضا: ${st.subscription.expiresAt}` : ""}`,
        walletMenuKeyboard()
      );
    }

    if (text === BTN.WALLET_WITHDRAW) {
      st.state = "wallet_withdraw_amount";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "➖ برداشت\n\nمبلغ برداشت را وارد کن (عدد).", kb([[BTN.BACK, BTN.HOME]]));
    }


    
    // ===== Subscription (purchase -> admin approve -> activate) =====
    if (text === "/sub" || text === "/subscription" || text === BTN.SUBSCRIPTION) {
      if (!st.profile?.name || !st.profile?.phone) {
        await tgSendMessage(env, chatId, "برای خرید اشتراک، اول نام و شماره را ثبت کن ✅", mainMenuKeyboard(env));
        await startOnboarding(env, chatId, from, st);
        return;
      }
      st.state = "sub_menu";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, subscriptionStatusText(st, env), subscriptionMenuKeyboard());
    }

    if (text === BTN.SUB_STATUS) {
      st.state = "sub_menu";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, subscriptionStatusText(st, env), subscriptionMenuKeyboard());
    }

    if (text === BTN.SUB_BUY) {
      if (!getDB(env)) return tgSendMessage(env, chatId, "⚠️ سیستم اشتراک نیاز به BOT_KV دارد.", mainMenuKeyboard(env));
      if (st.subscription?.pendingTicket) {
        st.state = "sub_menu";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, `🕓 یک درخواست در انتظار داری:\nTicket: ${st.subscription.pendingTicket}\n\nبعد از تأیید مدیریت فعال می‌شود.`, subscriptionMenuKeyboard());
      }
      st.state = "sub_choose_plan";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "🛒 پلن را انتخاب کن:", subscriptionPlanKeyboard());
    }

    if (st.state === "sub_choose_plan") {
      const plan = planFromLabel(env, text);
      if (!plan) {
        return tgSendMessage(env, chatId, "پلن نامعتبره. یکی از گزینه‌ها را انتخاب کن:", subscriptionPlanKeyboard());
      }

      st.subscription.pendingPlanId = plan.id;
      st.subscription.pendingAmount = plan.price;
      st.subscription.pendingPayMethod = "";
      st.state = "sub_choose_pay";
      await saveUser(userId, st, env);

      const bal = Number(st.wallet?.balance || 0);
      const canPay = bal >= plan.price;

      const walletAddr = await getWallet(env);
      const msg =
        `🧾 فاکتور اشتراک\n\n` +
        `پلن: ${plan.title}\n` +
        `مبلغ: ${plan.price} ${plan.currency}\n\n` +
        (canPay ? `گزینه «پرداخت از موجودی» فعال است ✅\n` : `موجودی کافی نیست (موجودی: ${bal}).\n`) +
        (walletAddr ? `آدرس واریز: ${walletAddr}\n` : ``) +
        `\nروش پرداخت را انتخاب کن:`;

      return tgSendMessage(env, chatId, msg, subscriptionPayKeyboard(canPay));
    }

    if (st.state === "sub_choose_pay") {
      const plan = planFromLabel(env, st.subscription?.pendingPlanId);
      if (!plan) {
        st.state = "sub_choose_plan";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "پلن از دست رفت. دوباره انتخاب کن:", subscriptionPlanKeyboard());
      }

      if (text.includes("پرداخت از موجودی")) {
        const bal = Number(st.wallet?.balance || 0);
        if (bal < plan.price) return tgSendMessage(env, chatId, "⛔️ موجودی کافی نیست.", subscriptionPayKeyboard(false));

        st.wallet.balance = bal - plan.price;

        const payload = {
          userId: String(userId),
          username: st.profile?.username || from?.username || "",
          planId: plan.id,
          planTitle: plan.title,
          planDays: plan.days,
          dailyLimit: plan.dailyLimit,
          amount: plan.price,
          currency: plan.currency,
          payMethod: "balance",
          txid: "",
          paidFromBalance: true,
        };

        const ticket = await createSubTicket(env, payload);

        st.subscription.pendingTicket = ticket;
        st.subscription.pendingPayMethod = "balance";
        st.state = "sub_menu";
        await saveUser(userId, st, env);

        await notifyAdminsSubRequest(env, { ...payload, ticket });

        return tgSendMessage(env, chatId, `✅ درخواست ثبت شد.\nTicket: ${ticket}\n\n🕓 بعد از تأیید مدیریت اشتراک فعال می‌شود.`, subscriptionMenuKeyboard());
      }

      if (text.includes("واریز")) {
        st.subscription.pendingPayMethod = "txid";
        st.state = "sub_enter_txid";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "TxID / رسید واریز را ارسال کن (یک متن کوتاه کافیست).", kb([[BTN.BACK, BTN.HOME]]));
      }

      return tgSendMessage(env, chatId, "یک روش پرداخت انتخاب کن:", subscriptionPayKeyboard(true));
    }

    if (st.state === "sub_enter_txid") {
      const plan = planFromLabel(env, st.subscription?.pendingPlanId);
      if (!plan) {
        st.state = "sub_choose_plan";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "پلن از دست رفت. دوباره انتخاب کن:", subscriptionPlanKeyboard());
      }

      const txid = String(text || "").trim();
      if (txid.length < 4) return tgSendMessage(env, chatId, "TxID/رسید نامعتبره. دوباره ارسال کن.", kb([[BTN.BACK, BTN.HOME]]));

      const payload = {
        userId: String(userId),
        username: st.profile?.username || from?.username || "",
        planId: plan.id,
        planTitle: plan.title,
        planDays: plan.days,
        dailyLimit: plan.dailyLimit,
        amount: plan.price,
        currency: plan.currency,
        payMethod: "txid",
        txid,
        paidFromBalance: false,
      };

      const ticket = await createSubTicket(env, payload);

      st.subscription.pendingTicket = ticket;
      st.state = "sub_menu";
      await saveUser(userId, st, env);

      await notifyAdminsSubRequest(env, { ...payload, ticket });

      return tgSendMessage(env, chatId, `✅ رسید ثبت شد.\nTicket: ${ticket}\n\n🕓 بعد از تأیید مدیریت اشتراک فعال می‌شود.`, subscriptionMenuKeyboard());
    }


if (text === "/education" || text === BTN.EDUCATION) {
      return tgSendMessage(env, chatId, "📚 آموزش و مفاهیم بازار\n\nبه‌زودی محتوای آموزشی اضافه می‌شود.\nفعلاً برای تعیین سطح روی «🧪 تعیین سطح» بزن.", mainMenuKeyboard(env));
    }

    if (text === "/support" || text === BTN.SUPPORT) {
      const handle = env.SUPPORT_HANDLE || "@support";
      const wallet = await getWallet(env);
      const walletLine = wallet ? `\n\n💳 آدرس ولت جهت پرداخت:\n${wallet}` : "";
      return tgSendMessage(env, chatId, `🆘 پشتیبانی\n\nپیام بده به: ${handle}${walletLine}`, mainMenuKeyboard(env));
    }

    if (text === "/miniapp" || text === BTN.MINIAPP) {
      const url = getMiniappUrl(env);
      if (!url) {
        return tgSendMessage(env, chatId, "⚠️ لینک مینی‌اپ تنظیم نشده.\n\nدر Wrangler / داشبورد یک متغیر ENV به نام MINIAPP_URL یا PUBLIC_BASE_URL بگذار (مثلاً https://<your-worker-domain>/ ) و دوباره Deploy کن.", mainMenuKeyboard(env));
      }
      return tgSendMessage(env, chatId, "🧩 برای باز کردن مینی‌اپ روی دکمه زیر بزن:", miniappInlineKeyboard(env) || mainMenuKeyboard(env));
    }

    if (text === "/users") {
      if (!isStaff(from, env)) return tgSendMessage(env, chatId, "⛔️ فقط ادمین/اونر می‌تواند لیست کاربران را ببیند.", mainMenuKeyboard(env));
      return sendUsersList(env, chatId);
    }

    if (text === BTN.LEVELING || text === "/level") {
      if (!st.profile?.name || !st.profile?.phone) {
        await tgSendMessage(env, chatId, "برای تعیین سطح، ابتدا پروفایل را کامل کن ✅", mainMenuKeyboard(env));
        await startOnboarding(env, chatId, from, st);
        return;
      }
      await startLeveling(env, chatId, from, st);
      return;
    }

    if (text === BTN.HOME) {
      st.state = "idle";
      st.selectedSymbol = "";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "🏠 منوی اصلی:", mainMenuKeyboard(env));
    }

    if (text === BTN.BACK) {
      if (st.state.startsWith("quiz_")) {
        st.state = "idle";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🏠 برگشتی به منوی اصلی.", mainMenuKeyboard(env));
      }
      if (st.state === "wiz_tf") {
        st.state = "wiz_style";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🧭 مرحله ۳/۴: سبک را انتخاب کن:", optionsKeyboard(["اسکالپ","سوئینگ","اسمارت‌مانی","پرایس اکشن","ICT","ATR"]));
      }
      if (st.state === "wiz_style") {
        st.state = "wiz_symbol";
        const mkt = st.wizard?.market || "";
        const list = (mkt === "forex") ? MAJORS : (mkt === "metals") ? METALS : (mkt === "indices") ? INDICES : CRYPTOS;
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🧭 مرحله ۲/۴: نماد را انتخاب کن:", listKeyboard(list));
      }
      if (st.state === "wiz_symbol") {
        st.state = "wiz_market";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🧭 مرحله ۱/۴: بازار را انتخاب کن:", signalMenuKeyboard());
      }
      if (st.state === "wiz_market") {
        st.state = "idle";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🏠 منوی اصلی:", mainMenuKeyboard(env));
      }
      if (st.state === "await_prompt") {
        st.state = "wiz_market";
        st.selectedSymbol = "";
        st.wizard = { market: "", symbol: "", style: "", timeframe: "" };
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🧭 مرحله ۱/۴: بازار را انتخاب کن:", signalMenuKeyboard());
      }
      if (st.state.startsWith("set_")) {
        st.state = "idle";
        await saveUser(userId, st, env);
        return sendSettingsSummary(env, chatId, st, from);
      }
      if (st.state.startsWith("sub_")) {
        st.state = "sub_menu";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, subscriptionStatusText(st, env), subscriptionMenuKeyboard());
      }
      return tgSendMessage(env, chatId, "🏠 منوی اصلی:", mainMenuKeyboard(env));
    }

    if (st.state === "onb_name") {
      const name = text.replace(/\s+/g, " ").trim();
      if (!name || name.length < 2) return tgSendMessage(env, chatId, "نام را درست وارد کن (حداقل ۲ حرف).", kb([[BTN.HOME]]));
      st.profile.name = name;
      st.state = "onb_contact";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "عالی ✅ حالا لطفاً شماره تماس را با دکمه زیر ارسال کن:", contactKeyboard());
    }

    if (st.state === "onb_experience") {
      st.profile.marketExperience = text;
      st.state = "onb_market";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "بازار مورد علاقه‌ات کدام است؟", optionsKeyboard(["کریپتو", "فارکس", "فلزات", "سهام"]));
    }

    if (st.state === "onb_market") {
      st.profile.preferredMarket = text;
      await saveUser(userId, st, env);
      await startLeveling(env, chatId, from, st);
      return;
    }

    if (st.state.startsWith("quiz_")) {
      const idx = Number(st.state.split("_")[1] || "0");
      if (!Number.isFinite(idx)) return;
      const q = QUIZ[idx];
      if (!q) return;

      st.profile.quizAnswers = st.profile.quizAnswers || {};
      st.profile.quizAnswers[q.key] = text;

      const nextIdx = idx + 1;
      if (nextIdx < QUIZ.length) {
        st.state = `quiz_${nextIdx}`;
        await saveUser(userId, st, env);
        const nq = QUIZ[nextIdx];
        return tgSendMessage(env, chatId, nq.text, optionsKeyboard(nq.options));
      }

      st.state = "idle";
      await saveUser(userId, st, env);

      await tgSendMessage(env, chatId, "⏳ در حال تحلیل پاسخ‌های آزمون و تنظیم خودکار پروفایل…", kb([[BTN.HOME]]));

      const result = await evaluateLevelWithAI(env, st.profile, st.profile.quizAnswers || {});
      st.profile.level = result.level || "";
      st.profile.levelNotes = result.notes || "";
      st.timeframe = result.settings?.timeframe || st.timeframe;
      st.style = normalizeStyleLabel(result.settings?.style || st.style);
      st.risk = result.settings?.risk || st.risk;
      st.profile.onboardingDone = true;

      await saveUser(userId, st, env);

      const marketFa = ({crypto:"کریپتو", forex:"فارکس", metals:"فلزات", stocks:"سهام"})[result.recommendedMarket] || "کریپتو";
      return tgSendMessage(
        env,
        chatId,
        `✅ تعیین سطح انجام شد.\n\nسطح: ${st.profile.level}\nپیشنهاد بازار: ${marketFa}\n\nتنظیمات پیشنهادی:\n⏱ ${st.timeframe} | 🎯 ${st.style} | ⚠️ ${st.risk}\n\nیادداشت:\n${st.profile.levelNotes || "—"}\n\nاگر می‌خوای دوباره تعیین‌سطح انجام بدی یا تنظیماتت تغییر کنه، به پشتیبانی پیام بده (ادمین بررسی می‌کند).`,
        mainMenuKeyboard(env)
      );
    }
    if (text === BTN.CAT_MAJORS || text === BTN.CAT_METALS || text === BTN.CAT_INDICES || text === BTN.CAT_CRYPTO) {
      const market = (text === BTN.CAT_MAJORS) ? "forex" :
        (text === BTN.CAT_METALS) ? "metals" :
        (text === BTN.CAT_INDICES) ? "indices" : "crypto";

      const title = (text === BTN.CAT_MAJORS) ? "💱 ماجورها:" :
        (text === BTN.CAT_METALS) ? "🪙 فلزات:" :
        (text === BTN.CAT_INDICES) ? "📊 شاخص‌ها:" : "₿ کریپتو:";

      const list = (market === "forex") ? MAJORS :
        (market === "metals") ? METALS :
        (market === "indices") ? INDICES : CRYPTOS;

      // Wizard flow: Market -> Symbol -> Style -> Timeframe -> Analyze
      if (st.state === "wiz_market") {
        st.wizard = st.wizard || { market: "", symbol: "", style: "", timeframe: "" };
        st.wizard.market = market;
        st.state = "wiz_symbol";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🧭 مرحله ۲/۴: نماد را انتخاب کن:", listKeyboard(list));
      }

      return tgSendMessage(env, chatId, title, listKeyboard(list));
    }

    if (text === BTN.SET_TF) {
      st.state = "set_tf";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "⏱ تایم‌فریم:", optionsKeyboard(["M15","H1","H4","D1"]));
    }
    if (text === BTN.SET_STYLE) {
      st.state = "set_style";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "🎯 سبک:", optionsKeyboard(["اسکالپ","سوئینگ","اسمارت‌مانی","پرایس اکشن","ICT","ATR"]));
    }
    if (text === BTN.SET_RISK) {
      st.state = "set_risk";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "⚠️ ریسک:", optionsKeyboard(["کم","متوسط","زیاد"]));
    }
    if (text === BTN.SET_NEWS) {
      st.state = "set_news";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "📰 خبر:", optionsKeyboard(["روشن ✅","خاموش ❌"]));
    }

    if (st.state === "set_tf") { st.timeframe = text; st.state = "idle"; await saveUser(userId, st, env); return tgSendMessage(env, chatId, `✅ تایم‌فریم: ${st.timeframe}`, mainMenuKeyboard(env)); }
    if (st.state === "set_style") { st.style = normalizeStyleLabel(text); st.state = "idle"; await saveUser(userId, st, env); return tgSendMessage(env, chatId, `✅ سبک: ${st.style}`, mainMenuKeyboard(env)); }

    if (st.state === "wallet_withdraw_amount") {
      const cleaned = toAsciiDigits(text).replace(/[^0-9.]/g, "");
      const amount = Number(cleaned);
      if (!Number.isFinite(amount) || amount <= 0) {
        return tgSendMessage(env, chatId, "❌ مبلغ نامعتبر است. لطفاً فقط عدد وارد کن.", kb([[BTN.BACK, BTN.HOME]]));
      }
      const bal = Number(st.wallet?.balance || 0);
      if (bal < amount) {
        st.state = "idle";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, `❌ موجودی کافی نیست.
موجودی فعلی: ${bal} ${st.wallet?.currency || "USDT"}`, walletMenuKeyboard());
      }
      st.wallet._pendingWithdrawAmount = amount;
      st.state = "wallet_withdraw_address";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "✅ مبلغ ثبت شد.\n\nحالا آدرس مقصد (TRC20/ERC20/… بسته به نوع پرداخت) را بفرست.", kb([[BTN.BACK, BTN.HOME]]));
}

    if (st.state === "wallet_withdraw_address") {
      const address = String(text || "").trim();
      const amount = Number(st.wallet?._pendingWithdrawAmount || 0);
      if (!address) return tgSendMessage(env, chatId, "❌ آدرس نامعتبر است. دوباره بفرست.", kb([[BTN.BACK, BTN.HOME]]));

      const bal = Number(st.wallet?.balance || 0);
      if (bal < amount || amount <= 0) {
        st.state = "idle";
        delete st.wallet._pendingWithdrawAmount;
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "❌ درخواست نامعتبر شد (موجودی/مبلغ). دوباره تلاش کن.", walletMenuKeyboard());
      }

      st.wallet.balance = bal - amount;
      delete st.wallet._pendingWithdrawAmount;

      const ticket = await createWithdrawTicket(env, { userId, amount, address, from });
      st.state = "idle";
      await saveUser(userId, st, env);

      return tgSendMessage(
        env,
        chatId,
        `✅ درخواست برداشت ثبت شد.

کد پیگیری: ${ticket}
مبلغ: ${amount} ${st.wallet?.currency || "USDT"}
آدرس: ${address}

برای انجام برداشت، در صورت نیاز پشتیبانی با شما تماس می‌گیرد.`,
        walletMenuKeyboard()
      );
    }

    if (st.state === "set_risk") { st.risk = text; st.state = "idle"; await saveUser(userId, st, env); return tgSendMessage(env, chatId, `✅ ریسک: ${st.risk}`, mainMenuKeyboard(env)); }
    if (st.state === "set_news") { st.newsEnabled = text.includes("روشن"); st.state = "idle"; await saveUser(userId, st, env); return tgSendMessage(env, chatId, `✅ خبر: ${st.newsEnabled ? "روشن ✅" : "خاموش ❌"}`, mainMenuKeyboard(env)); }

    if (isSymbol(text)) {
      if (!st.profile?.name || !st.profile?.phone) {
        await tgSendMessage(env, chatId, "برای شروع تحلیل، ابتدا پروفایل را کامل کن ✅", mainMenuKeyboard(env));
        await startOnboarding(env, chatId, from, st);
        return;
      }

      // Wizard step 2 -> 3
      if (st.state === "wiz_symbol" || st.state === "choose_symbol") {
        st.wizard = st.wizard || { market: "", symbol: "", style: "", timeframe: "" };
        st.wizard.symbol = text;

        // If user picked symbol without market step, infer it
        if (!st.wizard.market) {
          st.wizard.market =
            MAJORS.includes(text) ? "forex" :
            METALS.includes(text) ? "metals" :
            INDICES.includes(text) ? "indices" : "crypto";
        }

        st.state = "wiz_style";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "🧭 مرحله ۳/۴: سبک را انتخاب کن:", optionsKeyboard(["اسکالپ","سوئینگ","اسمارت‌مانی","پرایس اکشن","ICT","ATR"]));
      }

      // Legacy: quick pick symbol -> ask to press analyze
      st.selectedSymbol = text;
      st.state = "await_prompt";
      await saveUser(userId, st, env);

      const quota = isStaff(from, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
      return tgSendMessage(env, chatId, `✅ نماد: ${st.selectedSymbol}\n\nبرای شروع تحلیل روی «${BTN.ANALYZE}» بزن.\n\nسهمیه امروز: ${quota}`, kb([[BTN.ANALYZE], [BTN.BACK, BTN.HOME]]));
    }

    
    if (st.state === "wiz_style") {
      const style = normalizeStyleLabel(text);
      const allowed = ["اسکالپ","سوئینگ","اسمارت‌مانی","پرایس اکشن","ICT","ATR"];
      if (!allowed.includes(style)) {
        return tgSendMessage(env, chatId, "یکی از گزینه‌های سبک را انتخاب کن:", optionsKeyboard(allowed));
      }
      st.wizard = st.wizard || { market: "", symbol: "", style: "", timeframe: "" };
      st.wizard.style = style;
      st.state = "wiz_tf";
      await saveUser(userId, st, env);
      return tgSendMessage(env, chatId, "🧭 مرحله ۴/۴: تایم‌فریم را انتخاب کن:", optionsKeyboard(["M15","H1","H4","D1"]));
    }

    if (st.state === "wiz_tf") {
      const tf = String(text || "").trim().toUpperCase();
      if (!["M15","H1","H4","D1"].includes(tf)) {
        return tgSendMessage(env, chatId, "یکی از تایم‌فریم‌ها را انتخاب کن:", optionsKeyboard(["M15","H1","H4","D1"]));
      }

      st.wizard = st.wizard || { market: "", symbol: "", style: "", timeframe: "" };
      st.wizard.timeframe = tf;

      const symbol = st.wizard.symbol;
      const style = st.wizard.style;

      if (!symbol || !style) {
        st.state = "wiz_market";
        await saveUser(userId, st, env);
        return tgSendMessage(env, chatId, "⚠️ انتخاب‌ها کامل نیست. از اول شروع کنیم: بازار را انتخاب کن.", signalMenuKeyboard());
      }

      if (getDB(env) && !canAnalyzeToday(st, from, env)) {
        return tgSendMessage(env, chatId, `⛔️ سهمیه امروزت تموم شده (${dailyLimit(env, st)} تحلیل در روز).`, mainMenuKeyboard(env));
      }

      // Persist selected style/timeframe as user's current prefs
      st.style = style;
      st.timeframe = tf;

      st.state = "idle";
      st.selectedSymbol = "";
      st.wizard = { market: "", symbol: "", style: "", timeframe: "" };

      if (getDB(env)) {
        consumeDaily(st, from, env);
        await saveUser(userId, st, env);
      } else {
        await saveUser(userId, st, env);
      }

      await runSignalTextFlow(env, chatId, from, st, symbol, "", { timeframe: tf, style });
      return;
    }

if (st.state === "await_prompt" && st.selectedSymbol) {
      if (getDB(env) && !canAnalyzeToday(st, from, env)) {
        return tgSendMessage(env, chatId, `⛔️ سهمیه امروزت تموم شده (${dailyLimit(env, st)} تحلیل در روز).`, mainMenuKeyboard(env));
      }

      const symbol = st.selectedSymbol;
      const isAnalyzeCmd = text === BTN.ANALYZE || text.replace(/\s+/g, "") === "تحلیلکن";
      if (!isAnalyzeCmd) return tgSendMessage(env, chatId, `برای شروع تحلیل روی «${BTN.ANALYZE}» بزن ✅`, kb([[BTN.ANALYZE], [BTN.BACK, BTN.HOME]]));

      st.state = "idle";
      st.selectedSymbol = "";

      if (getDB(env)) {
        consumeDaily(st, from, env);
        await saveUser(userId, st, env);
      }

      await runSignalTextFlow(env, chatId, from, st, symbol, "");
      return;
    }

    return tgSendMessage(env, chatId, "از منوی پایین استفاده کن ✅", mainMenuKeyboard(env));
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
}

/* ========================== START / ONBOARDING ========================== */
async function onStart(env, chatId, from, st, refArg) {
  st.state = "idle";
  st.selectedSymbol = "";
  st.profile.username = from?.username ? String(from.username) : st.profile.username;

  if (getDB(env)) {
    for (const c of st.referral.codes || []) {
      await storeReferralCodeOwner(env, c, st.userId);
    }
  }

  if (refArg && refArg.startsWith("ref_") && !st.referral.referredBy) {
    const code = refArg.replace(/^ref_/, "").trim();
    const ownerId = await resolveReferralOwner(env, code);
    if (ownerId && String(ownerId) !== String(st.userId)) {
      st.referral.referredBy = String(ownerId);
      st.referral.referredByCode = code;
    }
  }

  await saveUser(st.userId, st, env);

  await tgSendMessage(env, chatId, WELCOME_BOT, mainMenuKeyboard(env));

  if (!st.profile?.name || !st.profile?.phone) {
    await startOnboarding(env, chatId, from, st);
  }
}

async function startOnboarding(env, chatId, from, st) {
  if (!st.profile?.name) {
    st.state = "onb_name";
    await saveUser(st.userId, st, env);
    return tgSendMessage(env, chatId, "👤 لطفاً نام خود را وارد کنید:", kb([[BTN.HOME]]));
  }
  if (!st.profile?.phone) {
    st.state = "onb_contact";
    await saveUser(st.userId, st, env);
    return tgSendMessage(env, chatId, "📱 برای فعال‌سازی، شماره تماس را ارسال کنید (یا تایپ کنید، یا با Share Contact):", contactKeyboard());
  }
  if (!st.profile?.marketExperience) {
    st.state = "onb_experience";
    await saveUser(st.userId, st, env);
    return tgSendMessage(env, chatId, "سطح آشنایی/تجربه‌ات در بازار چقدر است؟", optionsKeyboard(["تازه‌کار","کمتر از ۶ ماه","۶ تا ۲۴ ماه","بیشتر از ۲ سال"]));
  }
  if (!st.profile?.preferredMarket) {
    st.state = "onb_market";
    await saveUser(st.userId, st, env);
    return tgSendMessage(env, chatId, "بازار مورد علاقه‌ات کدام است؟", optionsKeyboard(["کریپتو", "فارکس", "فلزات", "سهام"]));
  }
  await startLeveling(env, chatId, from, st);
}

async function handleContact(env, chatId, from, st, contact) {
  if (contact.user_id && String(contact.user_id) !== String(st.userId)) {
    return tgSendMessage(env, chatId, "⚠️ لطفاً فقط شماره خودت را با دکمه ارسال کن.", contactKeyboard());
  }

  const phone = String(contact.phone_number || "").trim();
  st.profile.phone = phone;
  st.profile.onboardingDone = Boolean(st.profile.name && st.profile.phone);

  await awardReferralIfEligible(env, st);

  if (st.state === "onb_contact") st.state = "onb_experience";
  await saveUser(st.userId, st, env);

  await tgSendMessage(env, chatId, "✅ شماره ثبت شد. ممنون!", mainMenuKeyboard(env));
  return startOnboarding(env, chatId, from, st);
}


  if (st.state === "onb_contact") {
    const phone = normalizePhone(text);
    if (!phone) {
      await tgSendMessage(
        env,
        chatId,
        "📱 لطفاً شماره تماس را به صورت عددی ارسال کن (مثلاً 0912xxxxxxx یا +98...) یا با دکمه «ارسال مخاطب» شماره‌ات را Share کن.",
        contactKeyboard()
      );
      return;
    }
    st.profile.phone = phone;
    st.profile.onboardingDone = Boolean(st.profile.name && st.profile.phone);
    await awardReferralIfEligible(env, st);
    st.state = "onb_experience";
    if (getDB(env)) await saveUser(userId, st, env);
    return startOnboarding(env, chatId, from, st);
  }

async function startLeveling(env, chatId, from, st) {
  st.profile.quizAnswers = {};
  st.state = "quiz_0";
  await saveUser(st.userId, st, env);
  return tgSendMessage(env, chatId, QUIZ[0].text, optionsKeyboard(QUIZ[0].options));
}

/* ========================== ADMIN: USERS LIST ========================== */
async function sendUsersList(env, chatId) {
  if (!getDB(env) || typeof getDB(env).list !== "function") {
    return tgSendMessage(env, chatId, "⛔️ KV list در دسترس نیست. (BOT_KV را درست بایند کن)", mainMenuKeyboard(env));
  }

  const res = await getDB(env).list({ prefix: "u:", limit: 20 });
  const keys = res?.keys || [];
  if (!keys.length) return tgSendMessage(env, chatId, "هیچ کاربری ثبت نشده.", mainMenuKeyboard(env));

  const users = [];
  for (const k of keys) {
    const raw = await getDB(env).get(k.name);
    if (!raw) continue;
    try {
      const u = JSON.parse(raw);
      users.push(u);
    } catch {}
  }

  const lines = users.map(u => {
    const name = u?.profile?.name || "-";
    const phone = u?.profile?.phone ? maskPhone(u.profile.phone) : "-";
    const username = u?.profile?.username ? ("@" + u.profile.username) : "-";
    const used = `${u.dailyUsed || 0}/${dailyLimit(env, u)}`;
    const pts = u?.referral?.points || 0;
    const inv = u?.referral?.successfulInvites || 0;
    return `• ${name} | ${username} | ${phone} | استفاده: ${used} | امتیاز: ${pts} | دعوت: ${inv}`;
  });

  return tgSendMessage(env, chatId, "👥 کاربران (۲۰ تای اول):\n\n" + lines.join("\n"), mainMenuKeyboard(env));
}

function maskPhone(p) {
  const s = String(p);
  if (s.length <= 6) return s;
  return s.slice(0, 3) + "****" + s.slice(-3);
}

/* ========================== ROUTING HELPERS ========================== */
function isSymbol(t) {
  return MAJORS.includes(t) || METALS.includes(t) || INDICES.includes(t) || CRYPTOS.includes(t);
}

/* ========================== TEXTS ========================== */
async function sendSettingsSummary(env, chatId, st, from) {
  const quota = isStaff(from, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
  const wallet = await getWallet(env);
  const txt =
    `⚙️ تنظیمات:\n\n` +
    `⏱ تایم‌فریم: ${st.timeframe}\n` +
    `🎯 سبک: ${st.style}\n` +
    `⚠️ ریسک: ${st.risk}\n` +
    `📰 خبر: ${st.newsEnabled ? "روشن ✅" : "خاموش ❌"}\n\n` +
    `سهمیه امروز: ${quota}\n` +
    (wallet ? `\n💳 آدرس ولت:\n${wallet}\n` : "") +
    (isStaff(from, env) ? `\n(ادمین/اونر) برای تغییر پرامپت: /setprompt ...\n` : "");
  return tgSendMessage(env, chatId, txt, settingsMenuKeyboard());
}

function profileText(st, from, env) {
  const quota = isStaff(from, env) ? "∞" : `${st.dailyUsed}/${dailyLimit(env, st)}`;
  const adminTag = isStaff(from, env) ? "✅ ادمین/اونر" : "👤 کاربر";
  const level = st.profile?.level ? `\nسطح: ${st.profile.level}` : "";
  const pts = st.referral?.points || 0;
  const inv = st.referral?.successfulInvites || 0;

  const botUser = env.BOT_USERNAME ? String(env.BOT_USERNAME).replace(/^@/, "") : "";
  const links = (st.referral?.codes || []).slice(0, 5).map((c, i) => {
    const deep = botUser ? `https://t.me/${botUser}?start=ref_${c}` : `ref_${c}`;
    return `${i+1}) ${deep}`;
  }).join("\n");

  return `👤 پروفایل\n\nوضعیت: ${adminTag}\n🆔 ID: ${st.userId}\nنام: ${st.profile?.name || "-"}\nیوزرنیم: ${st.profile?.username ? "@"+st.profile.username : "-"}\nشماره: ${st.profile?.phone ? maskPhone(st.profile.phone) : "-"}${level}\n\n📅 امروز: ${kyivDateString()}\nسهمیه امروز: ${quota}\n\n🎁 امتیاز: ${pts}\n👥 دعوت موفق: ${inv}\n\n🔗 لینک‌های رفرال (۵ عدد):\n${links}\n\nℹ️ هر دعوت موفق ۳ امتیاز.\nهر ۵۰۰ امتیاز = ۳۰ روز اشتراک هدیه.`;
}

/* ========================== FLOWS ========================== */
async function runSignalTextFlow(env, chatId, from, st, symbol, userPrompt, overrides) {
  const tfUse = (overrides && overrides.timeframe) ? String(overrides.timeframe) : (st.timeframe || "H4");
  const styleUse = (overrides && overrides.style) ? normalizeStyleLabel(overrides.style) : st.style;

  await tgSendMessage(
    env,
    chatId,
    `⏳ جمع‌آوری داده و تحلیل ${symbol}...\n⏱ ${tfUse} | 🎯 ${styleUse}`,
    kb([[BTN.HOME]])
  );

  const t = stopToken();
  const typingTask = typingLoop(env, chatId, t);

  try {
    const r = await runSignalTextFlowCompute(env, from, st, symbol, userPrompt, { timeframe: tfUse, style: styleUse });
    const result = r.text;

    // Quick chart (image) – can be disabled with QUICK_CHART=0
    if (r.chartUrl) {
      await tgSendPhoto(
        env,
        chatId,
        r.chartUrl,
        `📈 چارت + زون‌ها ${symbol} (${r.used?.timeframe || tfUse})`,
        kb([[BTN.HOME]])
      );
    }

    if (String(env.RENDER_ZONES || "") === "1") {
      const svg = buildZonesSvgFromAnalysis(result, symbol, r.used?.timeframe || tfUse);
      await tgSendSvgDocument(env, chatId, svg, "zones.svg", `🖼️ نقشه زون‌ها: ${symbol} (${r.used?.timeframe || tfUse})`);
    }

    t.stop = true;
    await Promise.race([typingTask, sleep(10)]).catch(() => {});

    for (const part of chunkText(result, 3500)) {
      await tgSendMessage(env, chatId, part, mainMenuKeyboard(env));
    }
  } catch (e) {
    // Keep a single error log (provider fallbacks are silent unless DEBUG_MARKET_DATA=1)
    console.error("runSignalTextFlow error:", e);
    t.stop = true;
    await tgSendMessage(env, chatId, "⚠️ فعلاً امکان انجام این عملیات نیست. لطفاً بعداً دوباره تلاش کن.", mainMenuKeyboard(env));
  }
}

async function runSignalTextFlowCompute(env, from, st, symbol, userPrompt, overrides) {
  const tf = (overrides && overrides.timeframe) ? String(overrides.timeframe) : (st.timeframe || "H4");
  const style = (overrides && overrides.style) ? normalizeStyleLabel(overrides.style) : st.style;

  // use an ephemeral view of user settings for this run
  const stRun = { ...st, timeframe: tf, style };

  const candles = await getMarketCandlesWithFallback(env, symbol, tf);
  const snap = computeSnapshot(candles);
  const ohlc = candlesToCompactCSV(candles, 80);

  const marketBlock =
    `lastPrice=${snap?.lastPrice}\n` +
    `changePct=${snap?.changePct}%\n` +
    `trend=${snap?.trend}\n` +
    `range50_hi=${snap?.range50?.hi} range50_lo=${snap?.range50?.lo}\n` +
    `sma20=${snap?.sma20} sma50=${snap?.sma50}\n` +
    `lastTs=${snap?.lastTs}\n\n` +
    `OHLC_CSV(t,o,h,l,c):\n${ohlc}`;

  const prompt = await buildTextPromptForSymbol(symbol, userPrompt, stRun, marketBlock, env);
  const draft = await runTextProviders(prompt, env, stRun.textOrder);
  const polished = await runPolishProviders(draft, env, stRun.polishOrder);

  // Chart uses the final analysis text to infer zones/levels
  const chartUrl = String(env.QUICK_CHART || "1") === "1" ? buildQuickChartUrl(candles, symbol, tf, polished) : "";
  return { text: polished, chartUrl, snap, used: { timeframe: tf, style } };
}


async function runSignalTextFlowReturnText(env, from, st, symbol, userPrompt) {
  const r = await runSignalTextFlowCompute(env, from, st, symbol, userPrompt);
  return r.text;
}

async function handleVisionFlow(env, chatId, from, userId, st, fileId) {
  if (getDB(env) && !canAnalyzeToday(st, from, env)) {
    await tgSendMessage(env, chatId, `⛔️ سهمیه امروزت تموم شده (${dailyLimit(env, st)} تحلیل در روز).`, mainMenuKeyboard(env));
    return;
  }

  await tgSendMessage(env, chatId, "🖼️ عکس دریافت شد… در حال تحلیل 🔍", kb([[BTN.HOME]]));

  const t = stopToken();
  const typingTask = typingLoop(env, chatId, t);

  try {
    const filePath = await tgGetFilePath(env, fileId);
    if (!filePath) throw new Error("no_file_path");
    const imageUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

    if (getDB(env)) {
      consumeDaily(st, from, env);
      await saveUser(userId, st, env);
    }

    const vPrompt = await buildVisionPrompt(st, env);
    const visionRaw = await runVisionProviders(imageUrl, vPrompt, env, st.visionOrder);

    const tf = st.timeframe || "H4";
    const baseRaw = await getAnalysisPromptForStyle(env, st.style);
    const base = baseRaw.replaceAll("{TIMEFRAME}", tf);

    const finalPrompt =
      `${base}\n\n` +
      `ورودی ویژن (مشاهدات تصویر):\n${visionRaw}\n\n` +
      `وظیفه: بر اساس همین مشاهده‌ها خروجی دقیق ۱ تا ۵ بده. سطح‌ها را مشخص کن.\n` +
      `قوانین: فقط فارسی، لحن افشاگر، خیال‌بافی نکن.\n` ;

    const draft = await runTextProviders(finalPrompt, env, st.textOrder);
    const polished = await runPolishProviders(draft, env, st.polishOrder);

    if (String(env.RENDER_ZONES || "") === "1") {
      const svg = buildZonesSvgFromAnalysis(polished, "CHART", tf);
      await tgSendSvgDocument(env, chatId, svg, "zones.svg", `🖼️ نقشه زون‌ها (${tf})`);
    }

    t.stop = true;
    await Promise.race([typingTask, sleep(10)]).catch(() => {});

    for (const part of chunkText(polished, 3500)) {
      await tgSendMessage(env, chatId, part, mainMenuKeyboard(env));
    }
  } catch (e) {
    console.error("handleVisionFlow error:", e);
    t.stop = true;
    await tgSendMessage(env, chatId, "⚠️ فعلاً امکان تحلیل تصویر نیست. لطفاً بعداً دوباره تلاش کن.", mainMenuKeyboard(env));
  }
}

/* ========================== ZONES RENDER (SVG) ========================== */
function toLatinDigits(s) {
  const a = "۰۱۲۳۴۵۶۷۸۹";
  const b = "٠١٢٣٤٥٦٧٨٩";
  return String(s || "")
    .replace(/[۰-۹]/g, d => String(a.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(b.indexOf(d)));
}

function extractLevels(text) {
  const norm = toLatinDigits(text);
  const nums = (String(norm || "").match(/\b\d{1,10}(?:\.\d{1,10})?\b/g) || [])
    .map(Number)
    .filter(n => Number.isFinite(n))
    .filter(n => !(Number.isInteger(n) && n >= 1 && n <= 20)); // ignore section numbering

  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  return uniq.slice(0, 8);
}

function buildZonesSvgFromAnalysis(analysisText, symbol, timeframe) {
  const levels = extractLevels(analysisText);
  const W = 900, H = 520;
  const pad = 60;

  const bg = `
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0B0F17"/>
        <stop offset="100%" stop-color="#090D14"/>
      </linearGradient>
      <linearGradient id="a" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#6D5EF6" stop-opacity="0.65"/>
        <stop offset="100%" stop-color="#00D1FF" stop-opacity="0.35"/>
      </linearGradient>
      <style>
        .t{ font: 700 20px ui-sans-serif,system-ui; fill:#ffffff; }
        .s{ font: 500 14px ui-sans-serif,system-ui; fill:rgba(255,255,255,.75); }
        .l{ stroke: rgba(255,255,255,.20); stroke-width: 2; }
        .z{ fill:url(#a); opacity:0.18; }
        .p{ font: 700 14px ui-monospace,monospace; fill: rgba(255,255,255,.92); }
      </style>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#g)"/>
    <rect x="${pad}" y="${pad}" width="${W-2*pad}" height="${H-2*pad}" rx="24" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.10)"/>
  `;

  const header = `
    <text class="t" x="${pad}" y="${pad-18}">MarketiQ • Zones</text>
    <text class="s" x="${pad}" y="${pad-0}">${escapeXml(symbol)} — ${escapeXml(timeframe)} — (auto)</text>
  `;

  const plotX = pad + 30;
  const plotY = pad + 30;
  const plotW = W - 2*pad - 60;
  const plotH = H - 2*pad - 80;

  let lines = "";
  if (levels.length >= 2) {
    const min = levels[0], max = levels[levels.length-1];
    const toY = (v) => plotY + plotH - ((v - min) / (max - min || 1)) * plotH;

    for (let i = 0; i < Math.min(levels.length-1, 4); i++) {
      const y1 = toY(levels[i+1]);
      const y2 = toY(levels[i]);
      lines += `<rect class="z" x="${plotX}" y="${Math.min(y1,y2)}" width="${plotW}" height="${Math.abs(y2-y1)}" rx="14"/>`;
      lines += `<line class="l" x1="${plotX}" y1="${y1}" x2="${plotX+plotW}" y2="${y1}"/>`;
      lines += `<text class="p" x="${plotX+plotW+10}" y="${y1+5}">${levels[i+1]}</text>`;
    }
    const y0 = toY(levels[0]);
    lines += `<line class="l" x1="${plotX}" y1="${y0}" x2="${plotX+plotW}" y2="${y0}"/>`;
    lines += `<text class="p" x="${plotX+plotW+10}" y="${y0+5}">${levels[0]}</text>`;
  } else {
    lines += `<text class="s" x="${plotX}" y="${plotY+30}">Level یافت نشد. برای رندر بهتر، خروجی مدل باید شامل چند عدد سطح باشد.</text>`;
  }

  const footer = `
    <text class="s" x="${pad}" y="${H-18}">Generated by MarketiQ (SVG) — Educational use only</text>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bg}${header}${lines}${footer}</svg>`;
}

function escapeXml(s) {
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&apos;");
}

/* ========================== MINI APP INLINE ASSETS ========================== */
function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function jsResponse(js, status = 200) {
  return new Response(js, { status, headers: { "content-type": "application/javascript; charset=utf-8" } });
}
function jsonResponse(obj, status = 200, extraHeaders = null) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

/* ========================== TELEGRAM MINI APP initData verification ========================== */
async function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== "string") return { ok: false, reason: "initData_missing" };
  if (!botToken) return { ok: false, reason: "bot_token_missing" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "hash_missing" };
  params.delete("hash");

  const authDate = Number(params.get("auth_date") || "0");
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: "auth_date_invalid" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - authDate) > 7 * 24 * 3600) return { ok: false, reason: "initData_expired" };

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push([k, v]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = await hmacSha256Raw(utf8("WebAppData"), utf8(botToken));
  const sigHex = await hmacSha256Hex(secretKey, utf8(dataCheckString));

  if (!timingSafeEqualHex(sigHex, hash)) return { ok: false, reason: "hash_mismatch" };

  const user = safeJsonParse(params.get("user") || "") || {};
  const userId = user?.id;
  if (!userId) return { ok: false, reason: "user_missing" };

  const fromLike = { username: user?.username || "" };
  return { ok: true, userId, fromLike };
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
function utf8(s) { return new TextEncoder().encode(String(s)); }

async function hmacSha256Raw(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}
async function hmacSha256Hex(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return toHex(new Uint8Array(sig));
}
function toHex(u8) { let out=""; for (const b of u8) out += b.toString(16).padStart(2,"0"); return out; }
function timingSafeEqualHex(a, b) {
  a = String(a || "").toLowerCase();
  b = String(b || "").toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ========================== MINI APP AUTH (lenient 7-day session) ========================== */
const MINIAPP_AUTH_COOKIE = "mq_token";
const MINIAPP_AUTH_DAYS = 7;
const MINIAPP_AUTH_MAX_AGE = MINIAPP_AUTH_DAYS * 24 * 3600;

function base64UrlEncode(u8) {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecodeToU8(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function timingSafeEqualStr(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hmacSha256B64url(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return base64UrlEncode(new Uint8Array(sig));
}

function getMiniappSecret(env) {
  // Recommended: set MINIAPP_AUTH_SECRET in worker env. Fallback to TELEGRAM_BOT_TOKEN.
  return String(env?.MINIAPP_AUTH_SECRET || env?.AUTH_SECRET || env?.TELEGRAM_BOT_TOKEN || "");
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const n = String(name || "").replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${n}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}
function miniappCookie(token) {
  return `${MINIAPP_AUTH_COOKIE}=${encodeURIComponent(String(token || ""))}; Max-Age=${MINIAPP_AUTH_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=None`;
}
function authHeaders(v) {
  return v?.setCookie && v?.token ? { "Set-Cookie": miniappCookie(v.token) } : null;
}

async function issueMiniappToken(userId, fromLike, env) {
  const secret = getMiniappSecret(env);
  if (!secret) return "";
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    uid: String(userId || ""),
    un: String(fromLike?.username || ""),
    iat: now,
    exp: now + MINIAPP_AUTH_MAX_AGE,
  };
  const payloadB64 = base64UrlEncode(utf8(JSON.stringify(payload)));
  const sig = await hmacSha256B64url(utf8(secret), utf8(payloadB64));
  return `${payloadB64}.${sig}`;
}

async function verifyMiniappToken(token, env) {
  token = String(token || "");
  const secret = getMiniappSecret(env);
  if (!secret) return { ok: false, reason: "secret_missing" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "token_bad_format" };
  const [payloadB64, sig] = parts;
  const expected = await hmacSha256B64url(utf8(secret), utf8(payloadB64));
  if (!timingSafeEqualStr(expected, sig)) return { ok: false, reason: "token_bad_sig" };
  const payload = safeJsonParse(new TextDecoder().decode(base64UrlDecodeToU8(payloadB64)));
  const now = Math.floor(Date.now() / 1000);
  if (!payload?.uid) return { ok: false, reason: "token_no_uid" };
  if (!payload?.exp || Number(payload.exp) < now) return { ok: false, reason: "token_expired" };
  return { ok: true, payload };
}

async function miniappAuth(request, body, env) {
  // 1) Accept existing token (header/cookie/body) for up to 7 days.
  const hdr = request.headers.get("Authorization") || "";
  const bearer = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7).trim() : "";
  const token = bearer || String(body?.token || "") || getCookie(request, MINIAPP_AUTH_COOKIE);
  if (token) {
    const v = await verifyMiniappToken(token, env);
    if (v.ok) {
      const uid = Number(v.payload.uid);
      const fromLike = { username: String(v.payload.un || "") };
      return { ok: true, userId: uid, fromLike, token, setCookie: false };
    }
    // If token present but invalid, we still allow initData fallback (lenient).
  }

  // 2) Fallback to Telegram initData (first login).
  const initData = String(body?.initData || "");
  const tg = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!tg.ok) return { ok: false, reason: tg.reason || "auth_failed" };

  const newToken = await issueMiniappToken(tg.userId, tg.fromLike, env);
  return { ok: true, userId: tg.userId, fromLike: tg.fromLike, token: newToken, setCookie: Boolean(newToken) };
}


/* ========================== MINI APP UI (MODERN TRADING) ========================== */
const MINI_APP_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>MarketiQ Mini App</title>
  <meta name="color-scheme" content="dark light" />
  <style>
    :root{
      --bg: #0B0F17;
      --card: rgba(255,255,255,.06);
      --text: rgba(255,255,255,.92);
      --muted: rgba(255,255,255,.62);
      --good:#2FE3A5;
      --warn:#FFB020;
      --bad:#FF4D4D;
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --radius: 18px;
      --font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans";
    }
    *{ box-sizing:border-box; }
    body{
      margin:0;
      font-family: var(--font);
      color: var(--text);
      background:
        radial-gradient(900px 500px at 25% -10%, rgba(109,94,246,.35), transparent 60%),
        radial-gradient(800px 500px at 90% 0%, rgba(0,209,255,.20), transparent 60%),
        linear-gradient(180deg, #070A10 0%, #0B0F17 60%, #090D14 100%);
      padding: 12px 12px calc(14px + env(safe-area-inset-bottom));
    }
    .shell{ max-width: 760px; margin: 0 auto; }
    .topbar{
      position: sticky; top: 0; z-index: 50;
      backdrop-filter: blur(10px);
      background: rgba(11,15,23,.65);
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 20px;
      padding: 12px;
      box-shadow: var(--shadow);
      display:flex; align-items:center; justify-content:space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .brand{ display:flex; align-items:center; gap:10px; min-width: 0; }
    .logo{
      width: 38px; height: 38px; border-radius: 14px;
      background: linear-gradient(135deg, rgba(109,94,246,1), rgba(0,209,255,1));
      box-shadow: 0 10px 22px rgba(109,94,246,.25);
      display:flex; align-items:center; justify-content:center;
      font-weight: 900;
    }
    .titlewrap{ min-width: 0; }
    .title{ font-size: 15px; font-weight: 900; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
    .subtitle{ font-size: 12px; color: var(--muted); white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
    .pill{
      display:inline-flex; align-items:center; gap:7px;
      padding: 9px 10px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.06);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .dot{ width: 8px; height: 8px; border-radius: 99px; background: var(--good); box-shadow: 0 0 0 3px rgba(47,227,165,.12); }
    .grid{ display:grid; grid-template-columns: 1fr; gap: 12px; }
    .card{
      background: var(--card);
      border: 1px solid rgba(255,255,255,.10);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .card-h{
      padding: 12px 14px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      border-bottom: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.03);
    }
    .card-h strong{ font-size: 13px; }
    .card-h span{ font-size: 12px; color: var(--muted); }
    .card-b{ padding: 14px; }
    .row{ display:flex; gap:10px; flex-wrap: wrap; align-items:center; }
    .field{ display:flex; flex-direction: column; gap:8px; min-width: 140px; flex:1; }
    .label{ font-size: 12px; color: var(--muted); }
    .control{
      width:100%;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
      color: var(--text);
      padding: 12px 12px;
      font-size: 14px;
      outline:none;
    }
    .chips{ display:flex; gap:8px; flex-wrap: wrap; }
    .chip{
      border:1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
      color: var(--muted);
      padding: 9px 12px;
      border-radius: 999px;
      font-size: 13px;
      cursor:pointer;
      user-select:none;
    }
    .chip.on{
      color: rgba(255,255,255,.92);
      border-color: rgba(109,94,246,.55);
      background: rgba(109,94,246,.16);
      box-shadow: 0 8px 20px rgba(109,94,246,.15);
    }
    .actions{ display:flex; gap:10px; flex-wrap:wrap; }
    .btn{
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
      color: var(--text);
      padding: 12px 12px;
      border-radius: 16px;
      font-size: 14px;
      cursor:pointer;
      display:inline-flex; align-items:center; justify-content:center; gap:8px;
      min-width: 120px;
      flex: 1;
    }
    .btn.primary{
      border-color: rgba(109,94,246,.65);
      background: linear-gradient(135deg, rgba(109,94,246,.92), rgba(0,209,255,.55));
      box-shadow: 0 12px 30px rgba(109,94,246,.20);
      font-weight: 900;
    }
    .btn.ghost{ color: var(--muted); }
    .out{
      padding: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace;
      font-size: 13px;
      line-height: 1.75;
      white-space: pre-wrap;
      background: rgba(0,0,0,.20);
      border-top: 1px solid rgba(255,255,255,.08);
      min-height: 240px;
    }
    .toast{
      position: fixed;
      left: 12px; right: 12px;
      bottom: calc(12px + env(safe-area-inset-bottom));
      max-width: 760px;
      margin: 0 auto;
      background: rgba(20,25,36,.92);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 16px;
      padding: 12px 12px;
      box-shadow: var(--shadow);
      display:none;
      gap: 10px;
      align-items: center;
      z-index: 100;
    }
    .toast.show{ display:flex; }
    .toast .t{ font-size: 13px; color: var(--text); }
    .toast .s{ font-size: 12px; color: var(--muted); }
    .toast .badge{
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.06);
      color: var(--muted);
      white-space: nowrap;
    }
    .spin{
      width: 16px; height: 16px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,.25);
      border-top-color: rgba(255,255,255,.85);
      animation: spin .8s linear infinite;
    }
    @keyframes spin{ to { transform: rotate(360deg); } }
    .muted{ color: var(--muted); }
    .list{max-height:280px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px;background:rgba(255,255,255,.03)}
    .list .item{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;border-bottom:1px dashed rgba(255,255,255,.08);padding:8px 0}
    .list .item:last-child{border-bottom:none}
    .list .item small{opacity:.8;display:block;line-height:1.5}
    .list .actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    textarea{width:100%}

  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand">
        <div class="logo">MQ</div>
        <div class="titlewrap">
          <div class="title">MarketiQ Mini App</div>
          <div class="subtitle" id="sub">اتصال…</div>
        </div>
      </div>
      <div class="pill"><span class="dot"></span><span id="pillTxt">Online</span></div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="card-h">
          <strong>تحلیل سریع</strong>
          <span id="meta">—</span>
        </div>
        <div class="card-b">
          <div class="row">
            <div class="field" style="flex:1">
              <div class="label">بازار</div>
              <div class="chips" id="marketChips">
                <div class="chip on" data-market="crypto">کریپتو</div>
                <div class="chip" data-market="forex">فارکس</div>
                <div class="chip" data-market="metals">فلزات</div>
                <div class="chip" data-market="indices">شاخص‌ها</div>
              </div>
              <select id="market" class="control" style="display:none">
                <option value="crypto" selected>crypto</option>
                <option value="forex">forex</option>
                <option value="metals">metals</option>
                <option value="indices">indices</option>
              </select>
            </div>
          </div>

          <div style="height:10px"></div>

          <div class="row">
            <div class="field" style="flex:1.4">
              <div class="label">جستجوی نماد</div>
              <input id="q" class="control" placeholder="مثلاً BTC یا EUR یا XAU…" />
            </div>
            <div class="field" style="flex:1">
              <div class="label">نماد</div>
              <select id="symbol" class="control"></select>
            </div>
          </div>

          <div style="height:10px"></div>

          <div class="row">
            <div class="field">
              <div class="label">سبک</div>
              <select id="style" class="control">
                <option value="اسکالپ">اسکالپ</option>
                <option value="سوئینگ">سوئینگ</option>
                <option value="اسمارت‌مانی" selected>اسمارت‌مانی</option>
                <option value="پرایس اکشن">پرایس اکشن</option>
                <option value="ICT">ICT</option>
                <option value="ATR">ATR</option>
              </select>
            </div>
            <div class="field">
              <div class="label">تایم‌فریم</div>
              <div class="chips" id="tfChips">
                <div class="chip" data-tf="M15">M15</div>
                <div class="chip" data-tf="H1">H1</div>
                <div class="chip on" data-tf="H4">H4</div>
                <div class="chip" data-tf="D1">D1</div>
              </div>
              <select id="timeframe" class="control" style="display:none">
                <option value="M15">M15</option>
                <option value="H1">H1</option>
                <option value="H4" selected>H4</option>
                <option value="D1">D1</option>
              </select>
            </div>
            <div class="field">
              <div class="label">ریسک</div>
              <select id="risk" class="control">
                <option value="کم">کم</option>
                <option value="متوسط" selected>متوسط</option>
                <option value="زیاد">زیاد</option>
              </select>
            </div>
            <div class="field">
              <div class="label">خبر</div>
              <select id="newsEnabled" class="control">
                <option value="true" selected>روشن ✅</option>
                <option value="false">خاموش ❌</option>
              </select>
            </div>
          </div>

          <div style="height:12px"></div>

          <div class="actions">
            <button id="save" class="btn">💾 ذخیره</button>
            <button id="analyze" class="btn primary">⚡ تحلیل</button>
            <button id="close" class="btn ghost">✖ بستن</button>
          </div>

          <div style="height:10px"></div>
          <div class="muted" style="font-size:12px; line-height:1.6;" id="welcome"></div>
        </div>

        <div class="out" id="out">آماده…</div>
        <div class="chart" id="chartBox" style="display:none; margin-top:10px;">
          <img id="qChart" alt="Quick Chart" style="width:100%; border-radius:14px; box-shadow: var(--shadow);" />
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <strong>💳 کیف پول</strong>
          <span id="wMeta">—</span>
        </div>
        <div class="card-b">
          <div class="row">
            <div class="field">
              <div class="label">موجودی</div>
              <input id="wBalance" class="control" readonly value="—" />
            </div>
            <div class="field">
              <div class="label">آدرس واریز</div>
              <input id="wAddress" class="control" readonly value="—" />
            </div>
          </div>

          <div style="height:12px"></div>
          <div class="actions">
            <button id="wDeposit" class="btn">➕ واریز</button>
            <button id="wWithdraw" class="btn">➖ برداشت</button>
            <button id="wSubBuy" class="btn">👑 اشتراک</button>
            <button id="wRefresh" class="btn ghost">🔄 موجودی</button>
          </div>

          <div style="height:10px"></div>
          <div class="muted" style="font-size:12px; line-height:1.6;" id="wNote"></div>
        </div>
      </div>
    </div>
  </div>


  <div class="card" id="adminCard" style="display:none">
    <h2>🛠 پنل ادمین</h2>
    <div class="meta">برای اعمال تغییرات، ذخیره را بزن. همه چیز داخل <b>bot_db</b> ذخیره می‌شود.</div>

    <div class="row">
      <div>
        <label>آدرس ولت (واریز)</label>
        <input id="adm_wallet" placeholder="Wallet Address..." />
      </div>
      <div>
        <label>Limit روزانه (Free)</label>
        <input id="adm_limit_free" type="number" min="0" />
      </div>
      <div>
        <label>Limit روزانه (Premium)</label>
        <input id="adm_limit_premium" type="number" min="0" />
      </div>
      <div>
        <label>کمسیون کلی (%)</label>
        <input id="adm_comm_global" type="number" step="0.01" min="0" />
      </div>
    </div>

    <label>پلن‌های اشتراک (JSON)</label>
    <textarea id="adm_plans" rows="7" spellcheck="false"></textarea>

    <label>کمسیون اختصاصی (JSON - مثال: {"@user": 3.5})</label>
    <textarea id="adm_comm_per" rows="5" spellcheck="false"></textarea>

    <label>سبک‌ها (JSON - هر سبک: {label, enabled, prompt})</label>
    <textarea id="adm_styles" rows="10" spellcheck="false"></textarea>

    <div class="row">
      <button class="btn" id="adm_reload">🔄 دریافت تنظیمات</button>
      <button class="btn primary" id="adm_save">💾 ذخیره تنظیمات</button>
      <button class="btn" id="adm_refresh_lists">📊 بروزرسانی گزارش‌ها</button>
    </div>

    <div class="row">
      <div>
        <h3 style="margin: 10px 0 6px">درخواست‌های اشتراک (Pending)</h3>
        <div class="list" id="adm_sub_pending"></div>
      </div>
      <div>
        <h3 style="margin: 10px 0 6px">برداشت‌ها</h3>
        <div class="list" id="adm_withdraws"></div>
      </div>
    </div>

    <h3 style="margin: 10px 0 6px">کاربران</h3>
    <div class="list" id="adm_users"></div>
  </div>


  <div class="toast" id="toast">
    <div class="spin" id="spin" style="display:none"></div>
    <div style="min-width:0">
      <div class="t" id="toastT">…</div>
      <div class="s" id="toastS"></div>
    </div>
    <div class="badge" id="toastB"></div>
  </div>

  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/app.js"></script>
</body>
</html>`;

const MINI_APP_JS = "const tg = window.Telegram?.WebApp;\nif (tg) tg.ready();\n\nconst out = document.getElementById(\"out\");\nconst chartBox = document.getElementById(\"chartBox\");\nconst qChart = document.getElementById(\"qChart\");\nconst meta = document.getElementById(\"meta\");\nconst sub = document.getElementById(\"sub\");\nconst pillTxt = document.getElementById(\"pillTxt\");\nconst welcome = document.getElementById(\"welcome\");\n\nfunction el(id){ return document.getElementById(id); }\nfunction val(id){ return el(id).value; }\nfunction setVal(id, v){ el(id).value = v; }\n\nconst toast = el(\"toast\");\nconst toastT = el(\"toastT\");\nconst toastS = el(\"toastS\");\nconst toastB = el(\"toastB\");\nconst spin = el(\"spin\");\n\nlet ALL_SYMBOLS = [];\nlet MARKET_SYMBOLS = {};\nlet CURRENT_MARKET = \"crypto\";\n\nfunction showToast(title, subline = \"\", badge = \"\", loading = false){\n  toastT.textContent = title || \"\";\n  toastS.textContent = subline || \"\";\n  toastB.textContent = badge || \"\";\n  spin.style.display = loading ? \"inline-block\" : \"none\";\n  toast.classList.add(\"show\");\n}\nfunction hideToast(){ toast.classList.remove(\"show\"); }\n\nfunction fillSymbols(list){\n  ALL_SYMBOLS = Array.isArray(list) ? list.slice() : [];\n  const sel = el(\"symbol\");\n  const cur = sel.value;\n  sel.innerHTML = \"\";\n  for (const s of ALL_SYMBOLS) {\n    const opt = document.createElement(\"option\");\n    opt.value = s;\n    opt.textContent = s;\n    sel.appendChild(opt);\n  }\n  if (cur && ALL_SYMBOLS.includes(cur)) sel.value = cur;\n}\n\nfunction filterSymbols(q){\n  q = (q || \"\").trim().toUpperCase();\n  const sel = el(\"symbol\");\n  const cur = sel.value;\n  sel.innerHTML = \"\";\n\n  const list = !q ? ALL_SYMBOLS : ALL_SYMBOLS.filter(s => s.includes(q));\n  for (const s of list) {\n    const opt = document.createElement(\"option\");\n    opt.value = s;\n    opt.textContent = s;\n    sel.appendChild(opt);\n  }\n  if (cur && list.includes(cur)) sel.value = cur;\n}\n\nfunction setMarket(market){\n  market = String(market || \"\").trim();\n  if (!market) return;\n  CURRENT_MARKET = market;\n  setVal(\"market\", market);\n\n  const chips = el(\"marketChips\")?.querySelectorAll(\".chip\") || [];\n  for (const c of chips) c.classList.toggle(\"on\", c.dataset.market === market);\n\n  const list = (MARKET_SYMBOLS && MARKET_SYMBOLS[market]) ? MARKET_SYMBOLS[market] : [];\n  fillSymbols(list);\n  filterSymbols(val(\"q\"));\n}\n\nfunction setTf(tf){\n  setVal(\"timeframe\", tf);\n  const chips = el(\"tfChips\")?.querySelectorAll(\".chip\") || [];\n  for (const c of chips) c.classList.toggle(\"on\", c.dataset.tf === tf);\n}\n\nconst AUTH_KEY = \"mq_token\";\nfunction getToken(){\n  try { return localStorage.getItem(AUTH_KEY) || \"\"; } catch(_) { return \"\"; }\n}\nfunction setToken(t){\n  try { if (t) localStorage.setItem(AUTH_KEY, t); } catch(_) {}\n}\n\nasync function api(path, body){\n  body = body || {};\n  const tok = getToken();\n  if (tok && !body.token) body.token = tok;\n\n  const headers = {\"content-type\":\"application/json\"};\n  if (tok) headers[\"authorization\"] = \"Bearer \" + tok;\n\n  const r = await fetch(path, {\n    method: \"POST\",\n    headers,\n    body: JSON.stringify(body),\n  });\n  const j = await r.json().catch(() => null);\n  if (j?.token) setToken(j.token);\n  return { status: r.status, json: j };\n}\n\nfunction prettyErr(j, status){\n  const e = String(j?.error || \"نامشخص\");\n\n  if (status === 429 && e.startsWith(\"quota_exceeded\")) return \"سهمیه امروز تمام شد.\";\n  if (status === 403 && e === \"onboarding_required\") return \"ابتدا نام و شماره را داخل ربات ثبت کنید.\";\n  if (status === 401) return \"احراز هویت تلگرام ناموفق است.\";\n\n  if (e === \"insufficient_funds\") return \"موجودی کافی نیست.\";\n  if (e === \"withdraw_bad_amount\") return \"مبلغ نامعتبر است.\";\n  if (e === \"withdraw_bad_address\") return \"آدرس نامعتبر است.\";\n  if (e === \"txid_required\") return \"TxID/رسید لازم است.\";\n  if (e === \"sub_pending_exists\") return \"یک درخواست اشتراک در انتظار دارید.\";\n\n  return \"مشکلی پیش آمد. لطفاً دوباره تلاش کنید.\";\n}\n\n\nfunction updateWallet(state, walletAddress){\n  const bal = Number(state?.wallet?.balance || 0);\n  const cur = state?.wallet?.currency || \"USDT\";\n  const wBal = el(\"wBalance\");\n  const wAddr = el(\"wAddress\");\n  const wMeta = el(\"wMeta\");\n  const wNote = el(\"wNote\");\n  if (wBal) wBal.value = String(bal) + \" \" + String(cur);\n  if (wAddr) wAddr.value = walletAddress || \"\";\n  if (wMeta) wMeta.textContent = state?.subscription?.active ? \"اشتراک: فعال ✅\" : \"اشتراک: رایگان\";\n  if (wNote) wNote.textContent = \"واریز/برداشت به‌صورت دستی توسط پشتیبانی تأیید می‌شود.\";\n}\n\nasync function refreshWallet(){\n  const initData = tg?.initData || \"\";\n  const {status, json} = await api(\"/api/wallet/balance\", { initData });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n\n  window.__STATE = window.__STATE || {};\n  window.__STATE.wallet = window.__STATE.wallet || {};\n  window.__STATE.wallet.balance = json.balance;\n  window.__STATE.wallet.currency = json.currency;\n\n  updateWallet(window.__STATE, json.walletAddress);\n  return json;\n}\n\n\nfunction updateMeta(state, quota){\n  meta.textContent = \\`سهمیه: \\${quota || \"-\"}\\`;\n  sub.textContent = \\`ID: \\${state?.userId || \"-\"} | امروز: \\${state?.dailyDate || \"-\"}\\`;\n}\n\nasync function boot(){\n  out.textContent = \"⏳ در حال آماده‌سازی…\";\n  pillTxt.textContent = \"Connecting…\";\n  showToast(\"در حال اتصال…\", \"دریافت پروفایل و تنظیمات\", \"API\", true);\n\n  const initData = tg?.initData || \"\";\n  const {status, json} = await api(\"/api/user\", { initData });\n\n  if (!json?.ok) {\n    hideToast();\n    pillTxt.textContent = \"Offline\";\n    out.textContent = \"⚠️ خطا: \" + prettyErr(json, status);\n    showToast(\"خطا\", prettyErr(json, status), \"API\", false);\n    return;\n  }\n\n  welcome.textContent = json.welcome || \"\";\n\n  window.__SUB_PLANS = json.subPlans || [];\n\n  window.__IS_ADMIN = !!json.isAdmin;\n  window.__STYLES = Array.isArray(json.styles) ? json.styles : [];\n\n  // Fill styles from server (admin can edit styles in bot_db)\n  try {\n    const styleSel = el(\"style\");\n    if (styleSel && window.__STYLES.length) {\n      styleSel.innerHTML = window.__STYLES.map(s => `<option value=\"${s}\">${s}</option>`).join(\"\");\n      // keep selection if exists\n      if (json.state?.style) styleSel.value = json.state.style;\n    }\n  } catch(_){}\n\n  MARKET_SYMBOLS = json.marketSymbols || {};\n  // Default market (from profile or fallback to crypto)\n  let defMarket = \"crypto\";\n  const pref = String(json.state?.profile?.preferredMarket || json.state?.preferredMarket || \"\");\n  if (pref.includes(\"فارکس\")) defMarket = \"forex\";\n  else if (pref.includes(\"فلز\")) defMarket = \"metals\";\n  else if (pref.includes(\"شاخص\") || pref.includes(\"سهام\")) defMarket = \"indices\";\n  else if (pref.includes(\"کریپتو\")) defMarket = \"crypto\";\n\n  setMarket(defMarket);\n\n  if (json.state?.timeframe) setTf(json.state.timeframe);\n  if (json.state?.style) setVal(\"style\", json.state.style);\n  if (json.state?.risk) setVal(\"risk\", json.state.risk);\n  setVal(\"newsEnabled\", String(!!json.state?.newsEnabled));\n\n  updateMeta(json.state, json.quota);\n  window.__STATE = json.state || window.__STATE || {};\n  updateWallet(window.__STATE, json.walletAddress || el(\"wAddress\")?.value || \"\");\n  window.__STATE = json.state || {};\n  updateWallet(window.__STATE, json.walletAddress || \"\");\n\n  if (window.__IS_ADMIN) {\n    try { await initAdmin(); } catch(_){}\n  }\n\n  out.textContent = \"آماده ✅\";\n  pillTxt.textContent = \"Online\";\n  hideToast();\n}\n\n\n// ===== Admin Panel (MiniApp) =====\nasync function adminGetCfg() {\n  const initData = tg?.initData || \"\";\n  const { status, json } = await api(\"/api/admin/config/get\", { initData });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json.cfg;\n}\nasync function adminSetCfg(patch) {\n  const initData = tg?.initData || \"\";\n  const { status, json } = await api(\"/api/admin/config/set\", { initData, patch });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json.cfg;\n}\nasync function adminListUsers() {\n  const initData = tg?.initData || \"\";\n  const { status, json } = await api(\"/api/admin/users/list\", { initData, limit: 20 });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json.users || [];\n}\nasync function adminListSubs() {\n  const initData = tg?.initData || \"\";\n  const { status, json } = await api(\"/api/admin/sub/pending\", { initData });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json.items || [];\n}\nasync function adminApprove(ticket) {\n  const initData = tg?.initData || \"\";\n  const { status, json } = await api(\"/api/admin/sub/approve\", { initData, ticket });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json;\n}\nasync function adminReject(ticket) {\n  const initData = tg?.initData || \"\";\n  const reason = prompt(\"دلیل رد؟\", \"رد شد\");\n  if (reason == null) return null;\n  const { status, json } = await api(\"/api/admin/sub/reject\", { initData, ticket, reason });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json;\n}\nasync function adminListWithdraws() {\n  const initData = tg?.initData || \"\";\n  const { status, json } = await api(\"/api/admin/withdraw/list\", { initData });\n  if (!json?.ok) throw new Error(prettyErr(json, status));\n  return json.items || [];\n}\n\nfunction prettyJson(x){\n  try { return JSON.stringify(x, null, 2); } catch { return \"[]\"; }\n}\nfunction parseJson(str, fallback){\n  try { return JSON.parse(str); } catch { return fallback; }\n}\n\nfunction renderSubList(items){\n  const box = el(\"adm_sub_pending\");\n  if (!box) return;\n  if (!items.length) { box.innerHTML = \"<div class='meta'>موردی نیست.</div>\"; return; }\n\n  box.innerHTML = items.map(it => {\n    const user = it.username ? (\"@\" + it.username) : (it.userId || \"\");\n    const plan = it.planTitle || it.planId || \"-\";\n    const pay = it.payMethod === \"balance\" ? \"از موجودی\" : (it.txid || \"-\");\n    return `<div class=\"item\">\n      <div>\n        <b>${it.ticket}</b>\n        <small>کاربر: ${user} | پلن: ${plan}</small>\n        <small>پرداخت: ${pay}</small>\n        <small>${it.createdAt || \"\"}</small>\n      </div>\n      <div class=\"actions\">\n        <button class=\"btn primary\" data-act=\"approve\" data-ticket=\"${it.ticket}\">تایید</button>\n        <button class=\"btn\" data-act=\"reject\" data-ticket=\"${it.ticket}\">رد</button>\n      </div>\n    </div>`;\n  }).join(\"\");\n\n  box.querySelectorAll(\"button[data-act]\").forEach(btn=>{\n    btn.addEventListener(\"click\", async ()=>{\n      const ticket = btn.dataset.ticket;\n      const act = btn.dataset.act;\n      try{\n        showToast(\"ادمین\", \"در حال انجام…\", act.toUpperCase(), true);\n        if(act===\"approve\") await adminApprove(ticket);\n        if(act===\"reject\") { const r = await adminReject(ticket); if(!r) return; }\n        await adminRefreshLists();\n        hideToast();\n      }catch(err){\n        showToast(\"خطا\", String(err?.message||err), \"ADM\", false);\n      }\n    });\n  });\n}\n\nfunction renderWithdrawList(items){\n  const box = el(\"adm_withdraws\");\n  if (!box) return;\n  if (!items.length) { box.innerHTML = \"<div class='meta'>موردی نیست.</div>\"; return; }\n\n  box.innerHTML = items.map(it => {\n    const user = it.username ? (\"@\" + it.username) : (it.userId || \"\");\n    const amt = it.amount || \"-\";\n    const fee = it.commissionFee != null ? ` | fee: ${it.commissionFee}` : \"\";\n    const net = it.netAmount != null ? ` | net: ${it.netAmount}` : \"\";\n    return `<div class=\"item\">\n      <div>\n        <b>${it.ticket || \"-\"}</b>\n        <small>کاربر: ${user}</small>\n        <small>مبلغ: ${amt}${fee}${net}</small>\n        <small>آدرس: ${it.wallet || \"-\"}</small>\n        <small>${it.createdAt || \"\"}</small>\n      </div>\n    </div>`;\n  }).join(\"\");\n}\n\nfunction renderUsers(items){\n  const box = el(\"adm_users\");\n  if (!box) return;\n  if (!items.length) { box.innerHTML = \"<div class='meta'>موردی نیست.</div>\"; return; }\n\n  box.innerHTML = items.map(u => {\n    const sub = u.subscription?.active ? \"✅\" : (u.subscription?.pendingTicket ? \"⏳\" : \"—\");\n    const bal = u.wallet?.balance ?? 0;\n    return `<div class=\"item\">\n      <div>\n        <b>${u.name || u.username || u.userId}</b>\n        <small>${u.username ? (\"@\" + u.username) : \"\"} | used: ${u.dailyUsed}/${u.dailyLimit} | sub: ${sub}</small>\n        <small>balance: ${bal} | points: ${u.points} | invites: ${u.invites}</small>\n      </div>\n    </div>`;\n  }).join(\"\");\n}\n\nasync function adminLoadCfgToUI(){\n  const cfg = await adminGetCfg();\n  el(\"adm_wallet\").value = cfg.walletAddress || \"\";\n  el(\"adm_limit_free\").value = cfg.limits?.freeDailyLimit ?? \"\";\n  el(\"adm_limit_premium\").value = cfg.limits?.premiumDailyLimit ?? \"\";\n  el(\"adm_comm_global\").value = cfg.commissions?.globalPct ?? 0;\n\n  el(\"adm_plans\").value = prettyJson(cfg.subPlans || []);\n  el(\"adm_comm_per\").value = prettyJson(cfg.commissions?.perUser || {});\n  el(\"adm_styles\").value = prettyJson(cfg.styles || []);\n\n  return cfg;\n}\n\nasync function adminSaveFromUI(){\n  const patch = {\n    walletAddress: String(el(\"adm_wallet\").value || \"\").trim(),\n    limits: {\n      freeDailyLimit: Number(el(\"adm_limit_free\").value || 0),\n      premiumDailyLimit: Number(el(\"adm_limit_premium\").value || 0),\n    },\n    commissions: {\n      globalPct: Number(el(\"adm_comm_global\").value || 0),\n      perUser: parseJson(el(\"adm_comm_per\").value, {}),\n    },\n    subPlans: parseJson(el(\"adm_plans\").value, []),\n    styles: parseJson(el(\"adm_styles\").value, []),\n  };\n  await adminSetCfg(patch);\n}\n\nasync function adminRefreshLists(){\n  const [subs, wds, users] = await Promise.all([adminListSubs(), adminListWithdraws(), adminListUsers()]);\n  renderSubList(subs);\n  renderWithdrawList(wds);\n  renderUsers(users);\n}\n\nlet __ADMIN_READY = false;\nasync function initAdmin(){\n  if (__ADMIN_READY) return;\n  __ADMIN_READY = true;\n\n  const card = el(\"adminCard\");\n  if (!card) return;\n  card.style.display = \"block\";\n\n  el(\"adm_reload\")?.addEventListener(\"click\", async ()=>{\n    try{\n      showToast(\"ادمین\", \"دریافت تنظیمات…\", \"CFG\", true);\n      await adminLoadCfgToUI();\n      hideToast();\n    }catch(err){\n      showToast(\"خطا\", String(err?.message||err), \"CFG\", false);\n    }\n  });\n\n  el(\"adm_save\")?.addEventListener(\"click\", async ()=>{\n    try{\n      showToast(\"ادمین\", \"ذخیره تنظیمات…\", \"SAVE\", true);\n      await adminSaveFromUI();\n\n      // update local dropdowns (styles & plans) without reloading the whole app\n      try{\n        const cfg = await adminGetCfg();\n        window.__SUB_PLANS = cfg.subPlans || window.__SUB_PLANS || [];\n        const styles = (cfg.styles || []).filter(s => s && s.enabled !== false).map(s => s.label).filter(Boolean);\n        window.__STYLES = styles;\n        const styleSel = el(\"style\");\n        if (styleSel && styles.length) {\n          const cur = styleSel.value;\n          styleSel.innerHTML = styles.map(s => `<option value=\"${s}\">${s}</option>`).join(\"\");\n          if (styles.includes(cur)) styleSel.value = cur;\n        }\n      }catch(_){}\n\n      hideToast();\n    }catch(err){\n      showToast(\"خطا\", String(err?.message||err), \"SAVE\", false);\n    }\n  });\n\n  el(\"adm_refresh_lists\")?.addEventListener(\"click\", async ()=>{\n    try{\n      showToast(\"ادمین\", \"بروزرسانی گزارش‌ها…\", \"RPT\", true);\n      await adminRefreshLists();\n      hideToast();\n    }catch(err){\n      showToast(\"خطا\", String(err?.message||err), \"RPT\", false);\n    }\n  });\n\n  // initial load\n  try { await adminLoadCfgToUI(); } catch(_){}\n  try { await adminRefreshLists(); } catch(_){}\n}\n\n\nel(\"q\").addEventListener(\"input\", (e) => filterSymbols(e.target.value));\n\nel(\"marketChips\").addEventListener(\"click\", (e) => {\n  const chip = e.target?.closest?.(\".chip\");\n  const m = chip?.dataset?.market;\n  if (!m) return;\n  setMarket(m);\n});\n\nel(\"tfChips\").addEventListener(\"click\", (e) => {\n  const chip = e.target?.closest?.(\".chip\");\n  const tf = chip?.dataset?.tf;\n  if (!tf) return;\n  setTf(tf);\n});\n\nel(\"save\").addEventListener(\"click\", async () => {\n  showToast(\"در حال ذخیره…\", \"تنظیمات ذخیره می‌شود\", \"SET\", true);\n  out.textContent = \"⏳ ذخیره تنظیمات…\";\n\n  const initData = tg?.initData || \"\";\n  const payload = {\n    initData,\n    timeframe: val(\"timeframe\"),\n    style: val(\"style\"),\n    risk: val(\"risk\"),\n    newsEnabled: val(\"newsEnabled\") === \"true\",\n  };\n\n  const {status, json} = await api(\"/api/settings\", payload);\n  if (!json?.ok) {\n    out.textContent = \"⚠️ خطا: \" + prettyErr(json, status);\n    showToast(\"خطا\", prettyErr(json, status), \"SET\", false);\n    return;\n  }\n\n  out.textContent = \"✅ تنظیمات ذخیره شد.\";\n  updateMeta(json.state, json.quota);\n  window.__STATE = json.state || window.__STATE || {};\n  updateWallet(window.__STATE, json.walletAddress || el(\"wAddress\")?.value || \"\");\n  showToast(\"ذخیره شد ✅\", \"تنظیمات اعمال شد\", \"OK\", false);\n  setTimeout(hideToast, 1200);\n});\n\nel(\"analyze\").addEventListener(\"click\", async () => {\n  showToast(\"در حال تحلیل…\", \"جمع‌آوری دیتا + تولید خروجی\", \"AI\", true);\n  out.textContent = \"⏳ در حال تحلیل…\";\n\n  if (!val(\"market\") || !val(\"symbol\")) {\n    const msg = \"اول بازار و نماد را انتخاب کن.\";\n    out.textContent = \"⚠️ \" + msg;\n    showToast(\"نیاز به انتخاب\", msg, \"WIZ\", false);\n    return;\n  }\n\n  const initData = tg?.initData || \"\";\n  const payload = { initData, symbol: val(\"symbol\"), userPrompt: \"\", market: val(\"market\"), style: val(\"style\"), timeframe: val(\"timeframe\") };\n\n  const {status, json} = await api(\"/api/analyze\", payload);\n  if (!json?.ok) {\n    const msg = prettyErr(json, status);\n    out.textContent = \"⚠️ \" + msg;\n    showToast(\"خطا\", msg, status === 429 ? \"Quota\" : \"AI\", false);\n    return;\n  }\n\n  out.textContent = json.result || \"⚠️ بدون خروجی\";\n  if (json.chartUrl && qChart && chartBox) {\n    qChart.src = json.chartUrl;\n    chartBox.style.display = \"block\";\n  } else if (chartBox) {\n    chartBox.style.display = \"none\";\n  }\n  updateMeta(json.state, json.quota);\n  window.__STATE = json.state || window.__STATE || {};\n  updateWallet(window.__STATE, json.walletAddress || el(\"wAddress\")?.value || \"\");\n  showToast(\"آماده ✅\", \"خروجی دریافت شد\", \"OK\", false);\n  setTimeout(hideToast, 1200);\n});\n\n// Wallet buttons\nel(\"wRefresh\")?.addEventListener(\"click\", async () => {\n  showToast(\"در حال بروزرسانی…\", \"دریافت موجودی\", \"WALLET\", true);\n  try {\n    await refreshWallet();\n    showToast(\"✅ بروزرسانی شد\", el(\"wBalance\")?.value || \"\", \"OK\", false);\n    setTimeout(hideToast, 1000);\n  } catch (e) {\n    showToast(\"خطا\", e?.message || \"نامشخص\", \"WALLET\", false);\n  }\n});\n\nel(\"wDeposit\")?.addEventListener(\"click\", async () => {\n  const addr = el(\"wAddress\")?.value || \"\";\n  if (addr && navigator?.clipboard?.writeText) {\n    try { await navigator.clipboard.writeText(addr); } catch(_){}\n  }\n  showToast(\"آدرس واریز\", addr || \"فعلاً آدرس تنظیم نشده\", \"COPY\", false);\n  setTimeout(hideToast, 1500);\n});\n\nel(\"wWithdraw\")?.addEventListener(\"click\", async () => {\n  const amount = prompt(\"مبلغ برداشت (عدد):\");\n  if (!amount) return;\n  const address = prompt(\"آدرس مقصد:\");\n  if (!address) return;\n\n  showToast(\"در حال ثبت برداشت…\", \"لطفاً صبر کنید\", \"WD\", true);\n  const initData = tg?.initData || \"\";\n  const {status, json} = await api(\"/api/wallet/withdraw\", { initData, amount, address });\n\n  if (!json?.ok) {\n    showToast(\"خطا\", prettyErr(json, status), \"WD\", false);\n    return;\n  }\n\n  await refreshWallet();\n  out.textContent = \"✅ درخواست برداشت ثبت شد: \" + json.ticket;\n  showToast(\"ثبت شد ✅\", \"کد: \" + json.ticket, \"OK\", false);\n  setTimeout(hideToast, 2000);\n});\n\n\n// Subscription buy (admin approval required)\nel(\"wSubBuy\")?.addEventListener(\"click\", async () => {\n  const initData = tg?.initData || \"\";\n\n  // check pending\n  try {\n    const st = window.__STATE || {};\n    const pendingTicket = st?.subscription?.pendingTicket || \"\";\n    if (pendingTicket) {\n      showToast(\"در انتظار تایید\", \"Ticket: \" + pendingTicket, \"SUB\", false);\n      setTimeout(hideToast, 1800);\n      return;\n    }\n  } catch(_){}\n\n  const plans = Array.isArray(window.__SUB_PLANS) && window.__SUB_PLANS.length ? window.__SUB_PLANS : [\n    { id:\"m1\", title:\"⭐ ماهانه\", days:30, price:10, currency:\"USDT\" },\n    { id:\"m3\", title:\"🔥 سه‌ماهه\", days:90, price:25, currency:\"USDT\" },\n    { id:\"y1\", title:\"👑 سالانه\", days:365, price:80, currency:\"USDT\" },\n  ];\n\n  const menu = plans.map((p,i)=> `${i+1}) ${p.title} - ${p.price} ${p.currency}`).join(\"\\\\n\");\n  const pick = prompt(\"انتخاب پلن:\\\\n\" + menu + \"\\\\n\\\\nعدد را وارد کن:\");\n  if (!pick) return;\n  const idx = Number(pick) - 1;\n  const plan = plans[idx];\n  if (!plan) { showToast(\"پلن نامعتبر\", \"\", \"SUB\", false); return; }\n\n  // payment method\n  const bal = Number(window.__STATE?.wallet?.balance || 0);\n  let payMethod = \"txid\";\n  let txid = \"\";\n\n  if (bal >= Number(plan.price || 0)) {\n    const useBal = confirm(`موجودی شما کافی است (${bal}).\\\\nمی‌خواهید از موجودی پرداخت کنید؟`);\n    if (useBal) payMethod = \"balance\";\n  }\n\n  if (payMethod === \"txid\") {\n    txid = prompt(\"TxID / رسید واریز را وارد کنید:\");\n    if (!txid) return;\n  }\n\n  showToast(\"در حال ثبت…\", \"درخواست اشتراک ارسال می‌شود\", \"SUB\", true);\n\n  const {status, json} = await api(\"/api/subscription/request\", { initData, planId: plan.id, payMethod, txid });\n  if (!json?.ok) {\n    showToast(\"خطا\", prettyErr(json, status), \"SUB\", false);\n    return;\n  }\n\n  // refresh wallet + state\n  try { await refreshWallet(); } catch(_){}\n  window.__STATE = window.__STATE || {};\n  window.__STATE.subscription = window.__STATE.subscription || {};\n  window.__STATE.subscription.pendingTicket = json.ticket;\n\n  out.textContent = \"✅ درخواست اشتراک ثبت شد: \" + json.ticket + \"\\\\nبعد از تایید مدیریت فعال می‌شود.\";\n  showToast(\"ثبت شد ✅\", \"Ticket: \" + json.ticket, \"OK\", false);\n  setTimeout(hideToast, 2200);\n});\n\nel(\"close\").addEventListener(\"click\", () => tg?.close());\n\nboot();";


/* ========================== SUBSCRIPTIONS ========================== */
function subscriptionStatusText(st, env) {
  refreshSubscription(st, env);

  const isActive = !!st.subscription?.active;
  const exp = st.subscription?.expiresAt || "";
  const expLine = isActive ? (exp ? `⏳ اعتبار تا: ${exp}` : "⏳ اعتبار: نامشخص") : "⛔️ اشتراک فعال نیست";
  const planId = st.subscription?.planId || (isActive ? "premium" : "free");
  const pending = st.subscription?.pendingTicket ? `\n\n🕓 درخواست در انتظار تأیید مدیریت:\nTicket: ${st.subscription.pendingTicket}` : "";

  const freeBase = toInt(env?.FREE_DAILY_LIMIT, 3);
  const premiumBase = toInt(env?.PREMIUM_DAILY_LIMIT, 200);
  const limit = isActive ? toInt(st.subscription?.dailyLimit, premiumBase) : freeBase;

  const plans = getSubPlans(env).map(p => `• ${p.title}: ${p.price} ${p.currency} / ${p.days} روز`).join("\n");

  return (
    `👑 وضعیت اشتراک\n\n` +
    `وضعیت: ${isActive ? "فعال ✅" : "رایگان"}\n` +
    `پلن: ${planId}\n` +
    `${expLine}\n` +
    `📊 سهمیه روزانه: ${limit}\n` +
    pending +
    `\n\n🛒 پلن‌ها:\n${plans}\n\n` +
    `برای خرید: «${BTN.SUB_BUY}»`
  );
}

async function adminApproveSub(env, ticket, adminFrom) {
  if (!getDB(env)) return { ok: false, error: "kv_required" };
  const req = await getSubRequest(env, ticket);
  if (!req) return { ok: false, error: "ticket_not_found" };
  if (req.status !== "pending") return { ok: false, error: "already_processed", status: req.status };

  const userId = String(req.userId || "");
  if (!userId) return { ok: false, error: "bad_user" };

  const st = await ensureUser(userId, env);
  refreshSubscription(st, env);

  const nowIso = new Date().toISOString();
  const currentExp = st.subscription?.expiresAt;
  const baseIso = (currentExp && Number.isFinite(Date.parse(currentExp)) && Date.parse(currentExp) > Date.now()) ? currentExp : nowIso;
  const exp = addDaysISO(baseIso, Number(req.planDays || 30));

  st.subscription.active = true;
  st.subscription.type = "premium";
  st.subscription.planId = req.planId || "premium";
  st.subscription.dailyLimit = toInt(req.dailyLimit, toInt(env.PREMIUM_DAILY_LIMIT, 200));
  st.subscription.expiresAt = exp;

  st.subscription.pendingTicket = "";
  st.subscription.pendingPlanId = "";
  st.subscription.pendingPayMethod = "";
  st.subscription.pendingAmount = 0;

  await saveUser(userId, st, env);

  req.status = "approved";
  req.approvedAt = nowIso;
  req.approvedBy = adminFrom?.username ? ("@" + adminFrom.username) : String(adminFrom?.id || "");
  req.resultExpiresAt = exp;
  await putSubRequest(env, ticket, req);

  await tgSendMessage(env, userId, `✅ اشتراک شما فعال شد.\n\nپلن: ${req.planTitle || req.planId}\nاعتبار تا: ${exp}`, mainMenuKeyboard(env));

  return { ok: true, expiresAt: exp };
}

async function adminRejectSub(env, ticket, adminFrom, reason) {
  if (!getDB(env)) return { ok: false, error: "kv_required" };
  const req = await getSubRequest(env, ticket);
  if (!req) return { ok: false, error: "ticket_not_found" };
  if (req.status !== "pending") return { ok: false, error: "already_processed", status: req.status };

  const userId = String(req.userId || "");
  if (!userId) return { ok: false, error: "bad_user" };

  const st = await ensureUser(userId, env);
  // refund if paid from balance
  if (req.paidFromBalance) {
    st.wallet = st.wallet || { balance: 0, currency: "USDT" };
    st.wallet.balance = Number(st.wallet.balance || 0) + Number(req.amount || 0);
  }

  st.subscription.pendingTicket = "";
  st.subscription.pendingPlanId = "";
  st.subscription.pendingPayMethod = "";
  st.subscription.pendingAmount = 0;

  await saveUser(userId, st, env);

  req.status = "rejected";
  req.rejectedAt = new Date().toISOString();
  req.rejectedBy = adminFrom?.username ? ("@" + adminFrom.username) : String(adminFrom?.id || "");
  req.reason = String(reason || "").slice(0, 500);
  await putSubRequest(env, ticket, req);

  await tgSendMessage(env, userId, `❌ درخواست اشتراک شما رد شد.\n\nTicket: ${ticket}\n${req.reason ? ("دلیل: " + req.reason) : ""}`, mainMenuKeyboard(env));

  return { ok: true };
}

async function handleCallbackQuery(env, cq) {
  const data = String(cq.data || "");
  if (!data.startsWith("sub:")) {
    await tgAnswerCallbackQuery(env, cq.id, "");
    return;
  }

  if (!isStaff(cq.from, env)) {
    await tgAnswerCallbackQuery(env, cq.id, "⛔️ دسترسی ندارید", true);
    return;
  }

  const parts = data.split(":");
  const action = parts[1] || "";
  const ticket = parts[2] || "";

  if (!ticket) {
    await tgAnswerCallbackQuery(env, cq.id, "ticket نامعتبر", true);
    return;
  }

  const msgChatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;

  if (action === "approve") {
    const r = await adminApproveSub(env, ticket, cq.from);
    if (r.ok) {
      await tgAnswerCallbackQuery(env, cq.id, "✅ تایید شد", false);
      if (msgChatId && msgId) {
        await tgEditMessageText(env, msgChatId, msgId, `✅ تایید شد\nTicket: ${ticket}\nاعتبار تا: ${r.expiresAt}`, null);
      }
    } else {
      await tgAnswerCallbackQuery(env, cq.id, "خطا: " + (r.error || "نامشخص"), true);
    }
    return;
  }

  if (action === "reject") {
    const r = await adminRejectSub(env, ticket, cq.from, "رد شد توسط مدیریت");
    if (r.ok) {
      await tgAnswerCallbackQuery(env, cq.id, "❌ رد شد", false);
      if (msgChatId && msgId) {
        await tgEditMessageText(env, msgChatId, msgId, `❌ رد شد\nTicket: ${ticket}`, null);
      }
    } else {
      await tgAnswerCallbackQuery(env, cq.id, "خطا: " + (r.error || "نامشخص"), true);
    }
    return;
  }

  await tgAnswerCallbackQuery(env, cq.id, "اکشن نامعتبر", true);
}
