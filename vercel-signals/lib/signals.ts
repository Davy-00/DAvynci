export type BotSignal = {
  symbol: string;
  status: string;
  side: string;
  order_type?: string;
  score: number;
  min_required_score: number;
  lot: number;
  reason: string;
  sl?: number;
  tp?: number;
  timestamp_utc?: string;
};

export type SignalSnapshot = {
  timestamp_utc: string;
  halted: boolean;
  halt_reason: string;
  dry_run?: boolean;
  symbols?: string[];
  guard_state?: {
    today_opened_trades?: number;
    today_consecutive_losses?: number;
    mt5_failure_streak?: number;
    stale_data_streak?: number;
    unhandled_error_streak?: number;
  };
  account?: {
    login?: number;
    server?: string;
    balance?: number;
    equity?: number;
    margin_free?: number;
  };
  bot_positions?: Array<{
    ticket: number;
    symbol: string;
    type: string;
    volume: number;
    price_open: number;
    sl: number;
    tp: number;
    profit: number;
  }>;
  closed_trades?: Array<{
    position_id: number;
    symbol: string;
    side: string;
    volume: number;
    entry_price: number;
    close_price: number;
    entry_time_utc: string;
    close_time_utc: string;
    pnl: number;
    close_reason: string;
    reason_icon: string;
  }>;
  recent_events?: Array<{
    timestamp_utc: string;
    event_type: string;
    symbol: string;
    details: string;
  }>;
  recent_logs?: string[];
  signals: BotSignal[];
  performance_history?: Array<{
    timestamp_utc: string;
    equity: number;
    balance: number;
  }>;
};

export function actionableSignals(snapshot: SignalSnapshot): BotSignal[] {
  return (snapshot.signals || []).filter(
    (s) => s.status === "signal" && ["buy", "sell", "buy_limit", "sell_limit"].includes(String(s.side || "").toLowerCase())
  );
}

export function signalLabel(signal: BotSignal): string {
  const side = String(signal.side || "").toLowerCase();
  if (side === "buy_limit") return "BUY LIMIT";
  if (side === "sell_limit") return "SELL LIMIT";
  if (side === "buy") return "BUY";
  if (side === "sell") return "SELL";
  return side.toUpperCase() || "UNKNOWN";
}

export function signalDigest(signals: BotSignal[]): string {
  const core = signals
    .map((s) => [s.symbol, s.side, s.order_type || "", s.lot, s.sl, s.tp, s.score].join("|"))
    .sort()
    .join(";");
  return core;
}
