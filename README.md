# SniperLM Telegram Bot (Cloudflare Workers)

این پروژه یک ربات تلگرام برای **آنالیز چارت ترید + خبرخوانی کریپتو/فارکس + تولید خروجی سیگنال** است و روی **Cloudflare Workers** دیپلوی می‌شود.

## معماری (طبق اسکچ شما)
- ورودی‌ها: تلگرام (متن/عکس چارت)، Google CSE، NewsAPI
- پردازش: 
  - تحلیل چارت (Vision): **OpenAI Vision → Cloudflare Vision → HuggingFace**
  - تحلیل متنی/سیگنال: **Cloudflare AI → OpenAI → Gemini**
  - ارزش‌گذاری خبر با Gemma: **Gemma (روی Cloudflare AI)**
  - تولید تصویر خروجی: **OpenAI Image → NanoBanana → Cloudflare Image**
- حافظه: **Durable Object** برای هر کاربر + KV برای مپ رفرال و تنظیمات

> نکته: خروجی‌ها صرفاً آموزشی هستند و **مشاوره مالی** محسوب نمی‌شوند.

---

## پیش‌نیازها
- حساب Cloudflare + Workers
- Bot Token تلگرام از BotFather
- کلیدها (اختیاری ولی توصیه‌شده): OpenAI, Gemini, NewsAPI, Google CSE, HuggingFace

---

## راه‌اندازی سریع (از موبایل/داشبورد)
### 1) ساخت KV و Durable Object
1. Cloudflare Dashboard → Workers & Pages → KV → Create namespace  
   - نام پیشنهادی: `sniperlm_bot_kv`
2. Workers & Pages → Durable Objects (یا داخل Worker bindings)  
   - کلاس: `UserDO` (در فایل `src/index.ts` هست)

### 2) ساخت Worker از GitHub
1. پروژه را روی GitHub بسازید و این کد را Push کنید.
2. Cloudflare Dashboard → Workers & Pages → Create → **Import a repository**
3. Build settings:
   - Framework preset: None
   - Build command: `npm ci`
   - Deploy command: `npx wrangler deploy`
4. Bindings:
   - AI binding: `AI`
   - KV namespace: `BOT_KV`
   - Durable Object: `USER_DO` → class `UserDO`
5. Variables/Secrets (Settings → Variables):
   - Secrets:
     - `TELEGRAM_BOT_TOKEN`
     - `TELEGRAM_WEBHOOK_SECRET` (یک رشته رندوم)
     - `OPENAI_API_KEY` (اختیاری)
     - `GEMINI_API_KEY` (اختیاری)
     - `NEWSAPI_KEY` (اختیاری)
     - `GOOGLE_CSE_KEY` (اختیاری)
     - `GOOGLE_CSE_CX` (اختیاری)
     - `HUGGINGFACE_TOKEN` (اختیاری)
   - Vars:
     - `BOT_USERNAME` (نام ربات بدون @)
     - `ADMIN_IDS` (آیدی عددی تلگرام ادمین‌ها با کاما)

### 3) ست کردن Webhook تلگرام
بعد از دیپلوی، آدرس Worker شما مثل این است:
- `https://<worker-subdomain>.workers.dev`

Webhook را این‌طور ست کنید:
- URL: `https://<worker-subdomain>.workers.dev/telegram/<TELEGRAM_WEBHOOK_SECRET>`

می‌توانید با مرورگر یا curl بزنید:
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker-subdomain>.workers.dev/telegram/<TELEGRAM_WEBHOOK_SECRET>
```

---

## منطق استفاده/رفرال
- ۳ بار اول رایگان
- بعد از آن:
  - با ۵ رفرال موفق → ۳ استفاده اضافه
  - یا از طریق کیف پول/پشتیبانی (در این نسخه فقط شبیه‌سازی شده و بعداً می‌توانید درگاه اضافه کنید)

---

## فایل‌های مهم
- `src/index.ts` : ورودی Worker + webhook + Durable Object + منوها
- `src/llm.ts` : روتینگ مدل‌ها (CF → OpenAI → Gemini) + Vision + Image
- `src/news.ts` : گرفتن اخبار از NewsAPI و Google CSE + امتیازدهی Gemma
- `src/telegram.ts` : توابع تلگرام و ساخت Inline Keyboard

---

## نکات امنیتی
- هیچ کلیدی را داخل کد ننویسید؛ همه را Secret کنید.
- مسیر webhook با `TELEGRAM_WEBHOOK_SECRET` محافظت شده است.
