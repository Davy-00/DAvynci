export type BotSignal = {
  symbol: string;
  status: string;
  side: string;
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
  signals: BotSignal[];
};

export function actionableSignals(snapshot: SignalSnapshot): BotSignal[] {
  return (snapshot.signals || []).filter(
    (s) => s.status === "signal" && (s.side === "buy" || s.side === "sell")
  );
}

export function signalDigest(signals: BotSignal[]): string {
  const core = signals
    .map((s) => [s.symbol, s.side, s.lot, s.sl, s.tp, s.score].join("|"))
    .sort()
    .join(";");
  return core;
}
