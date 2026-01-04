export type Locale = "fa" | "en";

export type AssetCategory = "majors" | "metals" | "stocks" | "crypto";
export type AssetSymbol =
  | "EURUSD" | "GBPUSD" | "USDJPY" | "USDCHF" | "AUDUSD" | "USDCAD" | "NZDUSD"
  | "XAUUSD" | "XAGUSD"
  | "US30" | "NAS100" | "SPX500"
  | "BTCUSDT" | "ETHUSDT" | "BNBUSDT" | "SOLUSDT" | "XRPUSDT" | "ADAUSDT" | "DOGEUSDT"
  | "AVAXUSDT" | "DOTUSDT" | "LINKUSDT" | "MATICUSDT" | "LTCUSDT" | "TRXUSDT" | "BCHUSDT" | "SHIBUSDT";

export type SignalRequest = {
  userId: number;
  chatId: number;
  symbol: AssetSymbol;
  category: AssetCategory;
  timeframe?: string;
  style?: string;
  risk?: string;
  userPrompt?: string;
  chartImage?: { mime: string; dataBase64: string };
};

export type SignalOutput = {
  symbol: string;
  timeframe: string;
  style: string;
  direction: "BUY" | "SELL" | "NEUTRAL";
  entry: string;
  stopLoss: string;
  takeProfits: string[];
  confidence: number; // 0-100
  rationale: string[];
  keyLevels: string[];
  newsSummary: string[];
  newsScoreByGemma: number; // 1-10
  riskNotes: string[];
  disclaimer: string;
};

export type UserProfile = {
  id: number;
  username?: string;
  firstName?: string;
  language?: Locale;
  createdAt: string;

  freeUsesRemaining: number;
  bonusUsesRemaining: number;

  referralCode: string;
  referredBy?: string;
  referrals: number;

  walletBalance: number; // arbitrary units
  plan: "free" | "referral" | "wallet";
};

export type UserMemory = {
  lastCategory?: AssetCategory;
  lastSymbol?: AssetSymbol;
  lastTimeframe?: string;
  lastStyle?: string;
  lastRisk?: string;

  // state machine
  pendingAction?:
    | "awaiting_chart"
    | "awaiting_prompt"
    | "none";
  pendingSymbol?: AssetSymbol;
  pendingCategory?: AssetCategory;

  // lightweight chat memory
  recentNotes: string[]; // last N short notes (summaries)
};
