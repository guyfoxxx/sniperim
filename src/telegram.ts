import { mdEscape, chunk } from "./utils";
import type { AssetCategory, AssetSymbol } from "./types";

export type TgUpdate = any;

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];

export const CATEGORIES: { key: AssetCategory; label: string }[] = [
  { key: "majors", label: "💱 جفت‌ارزهای ماجور" },
  { key: "metals", label: "🪙 فلزات" },
  { key: "stocks", label: "📊 سهام" },
  { key: "crypto", label: "₿ کریپتو" }
];

export const SYMBOLS: Record<AssetCategory, { sym: AssetSymbol; label: string }[]> = {
  majors: [
    { sym: "EURUSD", label: "EUR/USD" },
    { sym: "GBPUSD", label: "GBP/USD" },
    { sym: "USDJPY", label: "USD/JPY" },
    { sym: "USDCHF", label: "USD/CHF" },
    { sym: "AUDUSD", label: "AUD/USD" },
    { sym: "USDCAD", label: "USD/CAD" },
    { sym: "NZDUSD", label: "NZD/USD" }
  ],
  metals: [
    { sym: "XAUUSD", label: "طلا (XAU/USD)" },
    { sym: "XAGUSD", label: "نقره (XAG/USD)" }
  ],
  stocks: [
    { sym: "US30", label: "Dow Jones (US30)" },
    { sym: "NAS100", label: "Nasdaq (NAS100)" },
    { sym: "SPX500", label: "S&P 500 (SPX500)" }
  ],
  crypto: [
    { sym: "BTCUSDT", label: "BTC/USDT" },
    { sym: "ETHUSDT", label: "ETH/USDT" },
    { sym: "BNBUSDT", label: "BNB/USDT" },
    { sym: "SOLUSDT", label: "SOL/USDT" },
    { sym: "XRPUSDT", label: "XRP/USDT" },
    { sym: "ADAUSDT", label: "ADA/USDT" },
    { sym: "DOGEUSDT", label: "DOGE/USDT" },
    { sym: "AVAXUSDT", label: "AVAX/USDT" },
    { sym: "DOTUSDT", label: "DOT/USDT" },
    { sym: "LINKUSDT", label: "LINK/USDT" },
    { sym: "MATICUSDT", label: "MATIC/USDT" },
    { sym: "LTCUSDT", label: "LTC/USDT" },
    { sym: "TRXUSDT", label: "TRX/USDT" },
    { sym: "BCHUSDT", label: "BCH/USDT" },
    { sym: "SHIBUSDT", label: "SHIB/USDT" }
  ]
};

export function mainMenu(): InlineKeyboard {
  return [
    [{ text: "📈 دریافت سیگنال", callback_data: "menu:signal" }],
    [
      { text: "👤 پروفایل", callback_data: "menu:profile" },
      { text: "🎁 رفرال", callback_data: "menu:referral" }
    ],
    [
      { text: "💳 کیف پول", callback_data: "menu:wallet" },
      { text: "🆘 پشتیبانی", callback_data: "menu:support" }
    ]
  ];
}

export function signalMenu(): InlineKeyboard {
  return [
    ...CATEGORIES.map((c) => [{ text: c.label, callback_data: `cat:${c.key}` }]),
    [{ text: "🔙 بازگشت", callback_data: "menu:home" }]
  ];
}

export function symbolsMenu(cat: AssetCategory): InlineKeyboard {
  const buttons = SYMBOLS[cat].map((s) => ({ text: s.label, callback_data: `sym:${cat}:${s.sym}` }));
  const rows = chunk(buttons, 2);
  rows.push([{ text: "🔙 بازگشت", callback_data: "menu:signal" }]);
  return rows;
}

export function assetActionMenu(cat: AssetCategory, sym: AssetSymbol): InlineKeyboard {
  return [
    [{ text: "🖼 ارسال چارت (عکس)", callback_data: `act:chart:${cat}:${sym}` }],
    [{ text: "✍️ نوشتن پرامپت/توضیح", callback_data: `act:prompt:${cat}:${sym}` }],
    [{ text: "📰 خبر مرتبط", callback_data: `act:news:${cat}:${sym}` }],
    [{ text: "🔙 بازگشت", callback_data: `cat:${cat}` }]
  ];
}

export function formatProfileText(p: any): string {
  const lines = [
    "👤 *پروفایل شما*",
    `• آیدی: \`${p.id}\``,
    p.username ? `• یوزرنیم: @${mdEscape(p.username)}` : "",
    `• استفاده باقی‌مانده (رایگان): *${p.freeUsesRemaining}*`,
    `• استفاده باقی‌مانده (بونوس): *${p.bonusUsesRemaining}*`,
    `• رفرال‌های موفق: *${p.referrals}*`,
    `• موجودی کیف پول: *${p.walletBalance}*`,
    `• پلن: *${mdEscape(p.plan)}*`
  ].filter(Boolean);
  return lines.join("\n");
}

export function formatSupportText(): string {
  return [
    "🆘 *پشتیبانی*",
    "برای شارژ کیف پول یا مشکلات فنی، پیام بدهید:",
    "• ادمین: (بعداً اضافه کنید)",
    "• همچنین می‌توانید از دستور /help استفاده کنید."
  ].join("\n");
}

export function formatWalletText(p: any): string {
  return [
    "💳 *کیف پول*",
    `موجودی فعلی: *${p.walletBalance}*`,
    "",
    "روش شارژ (نمونه):",
    "۱) مبلغ را واریز کنید (درگاه/آدرس بعداً اضافه می‌شود)",
    "۲) رسید یا TXID را برای پشتیبانی ارسال کنید تا ادمین شارژ کند.",
    "",
    "فعلاً برای تست می‌توانید از ادمین بخواهید با دستور /admin_add_balance شارژ کند."
  ].join("\n");
}

export function formatReferralText(p: any, botUsername: string): string {
  const link = `https://t.me/${botUsername}?start=${p.referralCode}`;
  return [
    "🎁 *رفرال*",
    `کد شما: \`${p.referralCode}\``,
    "",
    "لینک دعوت:",
    mdEscape(link),
    "",
    "با هر ۵ دعوت موفق، ۳ استفاده بونوس می‌گیرید."
  ].join("\n");
}

export function formatUsageBlocked(): string {
  return [
    "⛔️ *سهمیه شما تمام شده است.*",
    "",
    "برای ادامه یکی از کارهای زیر را انجام دهید:",
    "1) ۵ نفر را با لینک رفرال دعوت کنید (۳ استفاده بونوس می‌گیرید)",
    "2) کیف پول را شارژ کنید (فعلاً از پشتیبانی/ادمین)",
    "",
    "دکمه «🎁 رفرال» یا «💳 کیف پول» را بزنید."
  ].join("\n");
}

export function formatAskChart(symbol: string): string {
  return [
    `🖼 لطفاً عکس چارت *${mdEscape(symbol)}* را ارسال کنید.`,
    "نکته: بهتر است تایم‌فریم و محدوده قیمت روی تصویر مشخص باشد."
  ].join("\n");
}

export function formatAskPrompt(symbol: string): string {
  return [
    `✍️ لطفاً توضیح/پرامپت برای *${mdEscape(symbol)}* را بنویسید.`,
    "مثلاً: «استراتژی اسکالپ، تایم‌فریم ۱۵ دقیقه، ریسک کم، فقط پرایس اکشن»"
  ].join("\n");
}
