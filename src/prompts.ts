import type { SignalRequest } from "./types";

export function buildSignalSystemPrompt(req: SignalRequest, memorySummary: string, visionSummary: string, newsBlock: string): string {
  return [
    "تو یک دستیار حرفه‌ای ترید هستی که باید فقط خروجی ساختاریافته بدهی.",
    "هدف: تولید سیگنال آموزشی (نه مشاوره مالی) بر اساس: (۱) توضیح کاربر، (۲) خلاصه چارت، (۳) خبرها، (۴) حافظه کاربر.",
    "قوانین:",
    "- خروجی را به صورت JSON خالص بده (بدون توضیح اضافی، بدون ```).",
    "- اگر داده کافی نیست، direction را NEUTRAL و confidence را پایین بده.",
    "- اعداد را به شکل رشته (string) بنویس تا خطا کمتر شود.",
    "- زبان خروجی فارسی باشد.",
    "",
    `نماد: ${req.symbol}`,
    `تایم‌فریم: ${req.timeframe || ""}`,
    `سبک: ${req.style || ""}`,
    `ریسک: ${req.risk || ""}`,
    "",
    "حافظه کاربر (خلاصه):",
    memorySummary || "(ندارد)",
    "",
    "خلاصه چارت (Vision):",
    visionSummary || "(چارت ارسال نشده یا قابل تحلیل نبود)",
    "",
    "خبرها:",
    newsBlock || "(خبر مرتبطی دریافت نشد)",
    "",
    "الگوی JSON خروجی (حتماً همین کلیدها):",
    JSON.stringify({
      symbol: req.symbol,
      timeframe: req.timeframe || "H1",
      style: req.style || "swing",
      direction: "BUY",
      entry: "string",
      stopLoss: "string",
      takeProfits: ["string"],
      confidence: 70,
      rationale: ["string"],
      keyLevels: ["string"],
      newsSummary: ["string"],
      newsScoreByGemma: 7,
      riskNotes: ["string"],
      disclaimer: "این خروجی صرفاً آموزشی است و توصیه مالی نیست."
    }, null, 2)
  ].join("\n");
}

export function buildNewsScoringPrompt(headlines: string[]): string {
  return [
    "تو یک تحلیل‌گر خبر هستی.",
    "به اخبار مرتبط با کریپتو/فارکس از ۱ تا ۱۰ امتیاز بده (۱۰ یعنی خیلی تاثیرگذار و مهم برای بازار کوتاه‌مدت).",
    "فقط JSON بده.",
    "کلیدها: score (1-10), reasons (آرایه کوتاه)، summary (آرایه خلاصه خبرها).",
    "خبرها:",
    ...headlines.map((h, i) => `${i + 1}. ${h}`)
  ].join("\n");
}

export function buildImagePromptForSignal(symbol: string, direction: string, timeframe: string): string {
  return [
    "A clean trading signal card in Persian.",
    `Asset: ${symbol}`,
    `Direction: ${direction}`,
    `Timeframe: ${timeframe}`,
    "Include: entry, SL, TP1/TP2/TP3, confidence meter, minimal chart-style background.",
    "Modern, readable typography, high contrast, no logos, no watermarks."
  ].join("\n");
}
