"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const STARTING_BALANCE = 200;

type PnlView = "day" | "week" | "month";
type MainTab = "overview" | "analytics" | "pnl" | "signals" | "positions" | "trades" | "diary" | "events" | "logs" | "diagnostics";
type ChartRange = "15m" | "1h" | "4h" | "12h" | "1d" | "3d" | "1w" | "all";
type ChartResolution = "raw" | "1m" | "5m";
type ChartSmoothing = "none" | "ema3" | "ema8";
type ChartScale = "auto" | "fromStart";

type Signal = {
  symbol: string;
  status: string;
  side: string;
  order_type?: string;
  lot: number;
  sl?: number;
  tp?: number;
  score: number;
  reason: string;
};

type Snapshot = {
  timestamp_utc: string;
  halted: boolean;
  halt_reason: string;
  dry_run?: boolean;
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
  performance_history?: Array<{
    timestamp_utc: string;
    equity: number;
    balance: number;
  }>;
  backtest_summary?: Array<{
    window: string;
    symbol: string;
    start_equity: number;
    end_equity: number;
    net_profit: number;
    trade_count: number;
    win_rate: number;
    profit_factor: number | string;
    max_drawdown_pct: number;
  }>;
  signals: Signal[];
};

type PerfPoint = { timestamp_utc: string; equity: number; balance: number };
type DiaryEntry = {
  trade_id: string;
  created_at_utc: string;
  updated_at_utc: string;
  setup: string;
  emotion: string;
  mistakes: string;
  lesson: string;
  rating: number;
};

function ema(values: number[], span: number): number[] {
  if (values.length === 0) return [];
  const alpha = 2 / (span + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

function rangeMs(range: ChartRange): number | null {
  if (range === "15m") return 15 * 60 * 1000;
  if (range === "1h") return 60 * 60 * 1000;
  if (range === "4h") return 4 * 60 * 60 * 1000;
  if (range === "12h") return 12 * 60 * 60 * 1000;
  if (range === "1d") return 24 * 60 * 60 * 1000;
  if (range === "3d") return 3 * 24 * 60 * 60 * 1000;
  if (range === "1w") return 7 * 24 * 60 * 60 * 1000;
  return null;
}

function resolutionMs(res: ChartResolution): number {
  if (res === "1m") return 60 * 1000;
  if (res === "5m") return 5 * 60 * 1000;
  return 0;
}

function signalType(s: Signal): string {
  const side = String(s.side || "").toLowerCase();
  if (side === "buy_limit") return "BUY LIMIT";
  if (side === "sell_limit") return "SELL LIMIT";
  if (side === "buy") return "BUY";
  if (side === "sell") return "SELL";
  return side.toUpperCase() || "UNKNOWN";
}

function dateKeyUtc(ts: string): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function startOfWeekUtc(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return x;
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addDaysUtc(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function fmtMoney(v: number): string {
  return `$${v.toFixed(2)}`;
}

function snapshotFingerprint(s: Snapshot | null): string {
  if (!s) return "";
  const eq = Number(s.account?.equity ?? 0).toFixed(2);
  const bal = Number(s.account?.balance ?? 0).toFixed(2);
  const trades = Number(s.guard_state?.today_opened_trades ?? 0);
  const signals = Array.isArray(s.signals) ? s.signals.length : 0;
  const positions = Array.isArray(s.bot_positions) ? s.bot_positions.length : 0;
  const closedTrades = Array.isArray(s.closed_trades) ? s.closed_trades.length : 0;
  const perfPoints = Array.isArray(s.performance_history) ? s.performance_history.length : 0;
  const ts = String(s.timestamp_utc || "");
  return `${ts}|${eq}|${bal}|${trades}|${signals}|${positions}|${closedTrades}|${perfPoints}`;
}

function useAnimatedNumber(target: number, durationMs = 320): number {
  const [value, setValue] = useState(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = value;
    const delta = target - start;
    if (!Number.isFinite(target) || Math.abs(delta) < 0.0001) {
      setValue(target);
      return;
    }

    const t0 = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(start + delta * eased);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target]);

  return value;
}

export default function HomePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [email, setEmail] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [pnlView, setPnlView] = useState<PnlView>("day");
  const [tab, setTab] = useState<MainTab>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [chartRange, setChartRange] = useState<ChartRange>("1d");
  const [chartResolution, setChartResolution] = useState<ChartResolution>("raw");
  const [chartSmoothing, setChartSmoothing] = useState<ChartSmoothing>("none");
  const [chartScale, setChartScale] = useState<ChartScale>("auto");
  const [showEquitySeries, setShowEquitySeries] = useState(true);
  const [showBalanceSeries, setShowBalanceSeries] = useState(true);
  const [showNetSeries, setShowNetSeries] = useState(false);
  const [showCloseMarkers, setShowCloseMarkers] = useState(true);
  const [diary, setDiary] = useState<Record<string, DiaryEntry>>({});
  const [selectedTradeId, setSelectedTradeId] = useState("");
  const [draft, setDraft] = useState({ setup: "", emotion: "", mistakes: "", lesson: "", rating: 0 });
  const [diaryMsg, setDiaryMsg] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());
  const [liveMode, setLiveMode] = useState<"stream" | "polling">("stream");
  const fingerprintRef = useRef("");

  const applySnapshot = (next: Snapshot | null) => {
    const fp = snapshotFingerprint(next);
    if (!fp || fp === fingerprintRef.current) return;
    fingerprintRef.current = fp;
    setSnapshot(next);
  };

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let es: EventSource | null = null;

    const loadSignals = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/signals?t=${Date.now()}`, { cache: "no-store" });
        const data = await res.json();
        if (mounted) applySnapshot(data);
      } finally {
        inFlight = false;
      }
    };

    try {
      es = new EventSource("/api/stream");
      es.onopen = () => {
        if (mounted) setLiveMode("stream");
      };
      es.addEventListener("snapshot", (evt) => {
        if (!mounted) return;
        const msg = evt as MessageEvent;
        try {
          applySnapshot(JSON.parse(msg.data));
          setLiveMode("stream");
        } catch {
          // Ignore malformed events and rely on fallback polling.
        }
      });
      es.onerror = () => {
        if (mounted) setLiveMode("polling");
      };
    } catch {
      setLiveMode("polling");
    }

    loadSignals();
    const poll = setInterval(loadSignals, 1000);
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      mounted = false;
      clearInterval(poll);
      clearInterval(clock);
      if (es) es.close();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadDiary = async () => {
      const res = await fetch("/api/diary", { cache: "no-store" });
      const data = await res.json();
      if (mounted) setDiary(data?.entries || {});
    };
    loadDiary();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadSubscriber = async () => {
      const sub = await fetch("/api/subscribers", { cache: "no-store" });
      const subData = await sub.json();
      if (mounted && subData?.email) setEmail(String(subData.email));
    };
    loadSubscriber();
    return () => {
      mounted = false;
    };
  }, []);

  const performancePoints = useMemo<PerfPoint[]>(() => {
    return (snapshot?.performance_history || [])
      .map((p) => ({
        timestamp_utc: String(p.timestamp_utc || ""),
        equity: Number(p.equity),
        balance: Number(p.balance),
      }))
      .filter((p) => p.timestamp_utc && Number.isFinite(p.equity) && Number.isFinite(p.balance))
      .sort((a, b) => a.timestamp_utc.localeCompare(b.timestamp_utc));
  }, [snapshot]);

  const activeSignals = useMemo(
    () =>
      (snapshot?.signals || []).filter(
        (s) => s.status === "signal" && ["buy", "sell", "buy_limit", "sell_limit"].includes(String(s.side || "").toLowerCase())
      ),
    [snapshot]
  );

  const floatingPnl = useMemo(
    () => (snapshot?.bot_positions || []).reduce((acc, p) => acc + Number(p.profit || 0), 0),
    [snapshot]
  );

  const pnl = useMemo(() => {
    const currentEquity = Number(snapshot?.account?.equity ?? NaN);
    const currentBalance = Number(snapshot?.account?.balance ?? NaN);
    const lastEq = Number.isFinite(currentEquity)
      ? currentEquity
      : performancePoints.length
        ? performancePoints[performancePoints.length - 1].equity
        : STARTING_BALANCE;
    const lastBal = Number.isFinite(currentBalance)
      ? currentBalance
      : performancePoints.length
        ? performancePoints[performancePoints.length - 1].balance
        : STARTING_BALANCE;

    const latestTs = snapshot?.timestamp_utc ? new Date(snapshot.timestamp_utc) : new Date();
    const dayStart = new Date(Date.UTC(latestTs.getUTCFullYear(), latestTs.getUTCMonth(), latestTs.getUTCDate()));
    const weekStart = startOfWeekUtc(latestTs);
    const monthStart = startOfMonthUtc(latestTs);

    const firstAtOrAfter = (start: Date): PerfPoint | null => {
      const ms = start.getTime();
      return performancePoints.find((p) => new Date(p.timestamp_utc).getTime() >= ms) || null;
    };

    const dayBase = firstAtOrAfter(dayStart)?.equity ?? STARTING_BALANCE;
    const weekBase = firstAtOrAfter(weekStart)?.equity ?? STARTING_BALANCE;
    const monthBase = firstAtOrAfter(monthStart)?.equity ?? STARTING_BALANCE;

    return {
      day: lastEq - dayBase,
      week: lastEq - weekBase,
      month: lastEq - monthBase,
      realized: lastBal - STARTING_BALANCE,
      net: lastEq - STARTING_BALANCE,
      currentEquity: lastEq,
      currentBalance: lastBal,
      dayBase,
      weekBase,
      monthBase,
    };
  }, [snapshot, performancePoints]);

  const pnlBookRows = useMemo(() => {
    const dayClose = new Map<string, number>();
    for (const p of performancePoints) {
      dayClose.set(dateKeyUtc(p.timestamp_utc), p.equity);
    }
    const dayKeys = Array.from(dayClose.keys()).sort();
    const dayRows = dayKeys.slice(-30).reverse().map((k) => ({ label: k, pnl: (dayClose.get(k) || 0) - STARTING_BALANCE }));

    const weekMap = new Map<string, number>();
    for (const [k, v] of dayClose.entries()) {
      const wk = dateKeyUtc(startOfWeekUtc(new Date(`${k}T00:00:00.000Z`)).toISOString());
      weekMap.set(wk, v);
    }
    const weekRows = Array.from(weekMap.keys())
      .sort()
      .slice(-12)
      .reverse()
      .map((wk) => ({ label: `Week ${wk}`, pnl: (weekMap.get(wk) || 0) - STARTING_BALANCE }));

    const latest = snapshot?.timestamp_utc ? new Date(snapshot.timestamp_utc) : new Date();
    const monthStart = startOfMonthUtc(latest);
    const monthEnd = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + 1, 0));
    const gridStart = startOfWeekUtc(monthStart);
    const gridEnd = addDaysUtc(monthEnd, monthEnd.getUTCDay() === 0 ? 0 : 7 - monthEnd.getUTCDay());
    const monthCells: Array<{ key: string; day: number; pnl: number | null; isCurrentMonth: boolean }> = [];

    for (let d = new Date(gridStart); d <= gridEnd; d = addDaysUtc(d, 1)) {
      const key = dateKeyUtc(d.toISOString());
      monthCells.push({
        key,
        day: d.getUTCDate(),
        pnl: dayClose.has(key) ? (dayClose.get(key) || 0) - STARTING_BALANCE : null,
        isCurrentMonth: d.getUTCMonth() === latest.getUTCMonth() && d.getUTCFullYear() === latest.getUTCFullYear(),
      });
    }

    return {
      dayRows,
      weekRows,
      monthCells,
      monthName: latest.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  }, [performancePoints, snapshot]);

  const performance = useMemo(() => {
    if (!performancePoints.length) {
      return {
        points: [] as Array<PerfPoint & { net: number; tsMs: number }>,
        equityPath: "",
        equityAreaPath: "",
        balancePath: "",
        netPath: "",
        minY: 0,
        maxY: 1,
        gridLines: [] as number[],
        currentEq: STARTING_BALANCE,
        currentBal: STARTING_BALANCE,
        currentNet: 0,
        highEq: STARTING_BALANCE,
        lowEq: STARTING_BALANCE,
        changePct: 0,
        perMinute: 0,
        tradeMarkers: [] as Array<{ x: number; y: number; pnl: number; closeReason: string; symbol: string }>,
      };
    }

    const latestTs = snapshot?.timestamp_utc ? new Date(snapshot.timestamp_utc).getTime() : new Date(performancePoints[performancePoints.length - 1].timestamp_utc).getTime();
    const cutMs = rangeMs(chartRange);
    const raw = cutMs === null
      ? performancePoints
      : performancePoints.filter((p) => new Date(p.timestamp_utc).getTime() >= latestTs - cutMs);

    const bucketMs = resolutionMs(chartResolution);
    let points = raw;
    if (bucketMs > 0 && raw.length > 1) {
      const buckets = new Map<number, PerfPoint>();
      for (const p of raw) {
        const t = new Date(p.timestamp_utc).getTime();
        const b = Math.floor(t / bucketMs) * bucketMs;
        buckets.set(b, p);
      }
      points = Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map((x) => x[1]);
    }

    const withNet = points.map((p) => ({ ...p, net: p.equity - STARTING_BALANCE, tsMs: new Date(p.timestamp_utc).getTime() }));
    if (!withNet.length) {
      return {
        points: [] as Array<PerfPoint & { net: number; tsMs: number }>,
        equityPath: "",
        equityAreaPath: "",
        balancePath: "",
        netPath: "",
        minY: 0,
        maxY: 1,
        gridLines: [] as number[],
        currentEq: STARTING_BALANCE,
        currentBal: STARTING_BALANCE,
        currentNet: 0,
        highEq: STARTING_BALANCE,
        lowEq: STARTING_BALANCE,
        changePct: 0,
        perMinute: 0,
        tradeMarkers: [] as Array<{ x: number; y: number; pnl: number; closeReason: string; symbol: string }>,
      };
    }

    let eq = withNet.map((p) => p.equity);
    let bal = withNet.map((p) => p.balance);
    let net = withNet.map((p) => p.net);
    if (chartSmoothing === "ema3") {
      eq = ema(eq, 3);
      bal = ema(bal, 3);
      net = ema(net, 3);
    } else if (chartSmoothing === "ema8") {
      eq = ema(eq, 8);
      bal = ema(bal, 8);
      net = ema(net, 8);
    }

    const smoothed = withNet.map((p, i) => ({ ...p, equity: eq[i], balance: bal[i], net: net[i] }));

    const w = 920;
    const h = 280;
    const px = 18;
    const py = 16;
    const selectedValues: number[] = [];
    if (showEquitySeries) selectedValues.push(...smoothed.map((p) => p.equity));
    if (showBalanceSeries) selectedValues.push(...smoothed.map((p) => p.balance));
    if (showNetSeries) selectedValues.push(...smoothed.map((p) => p.net));
    if (!selectedValues.length) selectedValues.push(...smoothed.map((p) => p.equity));
    if (chartScale === "fromStart") selectedValues.push(STARTING_BALANCE);

    const min = Math.min(...selectedValues);
    const max = Math.max(...selectedValues);
    const span = max - min || 1;

    const xFor = (i: number) => (smoothed.length === 1 ? w / 2 : px + (i / (smoothed.length - 1)) * (w - px * 2));
    const yFor = (v: number) => h - py - ((v - min) / span) * (h - py * 2);
    const pathFor = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)} ${yFor(v).toFixed(2)}`).join(" ");
    const areaFor = (arr: number[]) => {
      const line = pathFor(arr);
      const endX = xFor(arr.length - 1).toFixed(2);
      const startX = xFor(0).toFixed(2);
      const baseY = yFor(min).toFixed(2);
      return `${line} L${endX} ${baseY} L${startX} ${baseY} Z`;
    };

    const minTs = smoothed[0].tsMs;
    const maxTs = smoothed[smoothed.length - 1].tsMs;
    const xForTs = (ts: number) => {
      if (maxTs <= minTs) return w / 2;
      return px + ((ts - minTs) / (maxTs - minTs)) * (w - px * 2);
    };

    const markers = showCloseMarkers
      ? (snapshot?.closed_trades || [])
          .map((t) => ({ ...t, tsMs: new Date(String(t.close_time_utc || "")).getTime() }))
          .filter((t) => Number.isFinite(t.tsMs) && t.tsMs >= minTs && t.tsMs <= maxTs)
          .slice(0, 80)
          .map((t) => ({
            x: xForTs(t.tsMs),
            y: yFor(
              showNetSeries
                ? Number(t.pnl || 0)
                : smoothed.reduce((best, p) => {
                    return Math.abs(p.tsMs - t.tsMs) < Math.abs(best.tsMs - t.tsMs) ? p : best;
                  }, smoothed[0]).equity
            ),
            pnl: Number(t.pnl || 0),
            closeReason: String(t.close_reason || ""),
            symbol: String(t.symbol || ""),
          }))
      : [];

    const current = smoothed[smoothed.length - 1];
    const first = smoothed[0];
    const prev = smoothed.length > 1 ? smoothed[smoothed.length - 2] : current;
    const dtMin = Math.max(1 / 60, (current.tsMs - prev.tsMs) / 60000);
    const perMinute = (current.equity - prev.equity) / dtMin;
    const gridLines = [0, 1, 2, 3, 4].map((i) => py + (i / 4) * (h - py * 2));

    return {
      points: smoothed,
      equityPath: pathFor(smoothed.map((p) => p.equity)),
      equityAreaPath: areaFor(smoothed.map((p) => p.equity)),
      balancePath: pathFor(smoothed.map((p) => p.balance)),
      netPath: pathFor(smoothed.map((p) => p.net)),
      minY: min,
      maxY: max,
      gridLines,
      currentEq: current.equity,
      currentBal: current.balance,
      currentNet: current.net,
      highEq: Math.max(...smoothed.map((p) => p.equity)),
      lowEq: Math.min(...smoothed.map((p) => p.equity)),
      changePct: first.equity > 0 ? ((current.equity - first.equity) / first.equity) * 100 : 0,
      perMinute,
      tradeMarkers: markers,
    };
  }, [
    performancePoints,
    snapshot,
    chartRange,
    chartResolution,
    chartSmoothing,
    chartScale,
    showEquitySeries,
    showBalanceSeries,
    showNetSeries,
    showCloseMarkers,
  ]);

  const lastUpdateAge = useMemo(() => {
    if (!snapshot?.timestamp_utc) return "no data";
    const age = Math.max(0, Math.floor((nowMs - new Date(snapshot.timestamp_utc).getTime()) / 1000));
    return `${age}s ago`;
  }, [snapshot, nowMs]);

  const isConnected = useMemo(() => {
    if (!snapshot?.timestamp_utc) return false;
    const ageSec = Math.max(0, Math.floor((nowMs - new Date(snapshot.timestamp_utc).getTime()) / 1000));
    return ageSec <= 20;
  }, [snapshot, nowMs]);

  const saveEmail = async () => {
    setSaveMsg("");
    const res = await fetch("/api/subscribers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSaveMsg(res.ok ? "Email saved." : "Failed to save email.");
  };

  const closedTrades = snapshot?.closed_trades || [];

  useEffect(() => {
    if (!closedTrades.length) return;
    if (!selectedTradeId) {
      setSelectedTradeId(String(closedTrades[0].position_id));
    }
  }, [closedTrades, selectedTradeId]);

  useEffect(() => {
    if (!selectedTradeId) return;
    const existing = diary[selectedTradeId];
    setDraft({
      setup: existing?.setup || "",
      emotion: existing?.emotion || "",
      mistakes: existing?.mistakes || "",
      lesson: existing?.lesson || "",
      rating: Number(existing?.rating || 0),
    });
  }, [selectedTradeId, diary]);

  const saveDiaryEntry = async () => {
    if (!selectedTradeId) return;
    setDiaryMsg("Saving...");
    const res = await fetch("/api/diary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trade_id: selectedTradeId, ...draft }),
    });
    const data = await res.json();
    if (res.ok && data?.entry) {
      setDiary((prev) => ({ ...prev, [selectedTradeId]: data.entry }));
      setDiaryMsg("Saved.");
      return;
    }
    setDiaryMsg("Failed to save.");
  };

  const uiBalance = useAnimatedNumber(pnl.currentBalance);
  const uiEquity = useAnimatedNumber(pnl.currentEquity);
  const uiOpen = useAnimatedNumber(floatingPnl);
  const uiNet = useAnimatedNumber(pnl.net);
  const uiDay = useAnimatedNumber(pnl.day);
  const uiWeek = useAnimatedNumber(pnl.week);
  const uiMonth = useAnimatedNumber(pnl.month);

  const analytics = useMemo(() => {
    const trades = (snapshot?.closed_trades || []).map((t) => ({
      ...t,
      pnl: Number(t.pnl || 0),
      openMs: new Date(String(t.entry_time_utc || "")).getTime(),
      closeMs: new Date(String(t.close_time_utc || "")).getTime(),
    }));
    const total = trades.length;
    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl < 0).length;
    const breakeven = total - wins - losses;
    const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const grossLoss = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
    const netProfit = grossProfit + grossLoss;
    const avgWin = wins ? grossProfit / wins : 0;
    const avgLoss = losses ? grossLoss / losses : 0;
    const profitFactor = losses ? grossProfit / Math.abs(grossLoss) : 0;
    const expectancy = total ? netProfit / total : 0;
    const largestWin = trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0;
    const largestLoss = trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0;

    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let winStreak = 0;
    let lossStreak = 0;
    for (const t of [...trades].sort((a, b) => a.closeMs - b.closeMs)) {
      if (t.pnl > 0) {
        winStreak += 1;
        lossStreak = 0;
      } else if (t.pnl < 0) {
        lossStreak += 1;
        winStreak = 0;
      } else {
        winStreak = 0;
        lossStreak = 0;
      }
      if (winStreak > maxWinStreak) maxWinStreak = winStreak;
      if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
    }

    const durations = trades
      .map((t) => (Number.isFinite(t.openMs) && Number.isFinite(t.closeMs) ? Math.max(0, t.closeMs - t.openMs) : 0))
      .filter((d) => d > 0);
    const avgDurationMin = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 60000 : 0;

    const perf = performancePoints;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    let peak = STARTING_BALANCE;
    for (const p of perf) {
      if (p.equity > peak) peak = p.equity;
      const dd = peak - p.equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }

    const byMonth = new Map<string, number>();
    for (const p of perf) {
      const d = new Date(p.timestamp_utc);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth.set(key, p.equity);
    }
    const months = Array.from(byMonth.keys()).sort();
    const monthlyRows: Array<{ month: string; equity: number; gain: number; gainPct: number }> = [];
    let prevEq = STARTING_BALANCE;
    for (const m of months) {
      const eq = byMonth.get(m) || prevEq;
      const gain = eq - prevEq;
      const gainPct = prevEq > 0 ? (gain / prevEq) * 100 : 0;
      monthlyRows.push({ month: m, equity: eq, gain, gainPct });
      prevEq = eq;
    }
    monthlyRows.reverse();

    const currentEq = Number(snapshot?.account?.equity ?? STARTING_BALANCE);
    const absoluteGain = currentEq - STARTING_BALANCE;
    const absoluteGainPct = STARTING_BALANCE > 0 ? (absoluteGain / STARTING_BALANCE) * 100 : 0;
    const winRate = total ? (wins / total) * 100 : 0;

    return {
      total,
      wins,
      losses,
      breakeven,
      winRate,
      grossProfit,
      grossLoss,
      netProfit,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy,
      largestWin,
      largestLoss,
      maxDrawdown,
      maxDrawdownPct,
      maxWinStreak,
      maxLossStreak,
      avgDurationMin,
      absoluteGain,
      absoluteGainPct,
      monthlyRows,
    };
  }, [snapshot, performancePoints]);

  return (
    <main>
      <header className="topbar">
        <div className="logo-wrap" aria-label="DAvynci logo">
          <div className="logo-mark">
            <span className="logo-stroke" />
          </div>
          <div className="logo-text">
            <strong>DAvynci</strong>
            <span>Live Signals</span>
          </div>
        </div>

        <div className="topbar-right">
          <div className="live-pill">{liveMode === "stream" ? "LIVE STREAM" : "LIVE POLLING"}</div>
          <button className="menu-btn" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-controls="main-nav">
            <span />
            <span />
            <span />
          </button>
        </div>
      </header>

      <section className="hero minimal">
        <p>Updated {lastUpdateAge}</p>
        <p className={isConnected ? "up" : "down"}>{isConnected ? "Bot Connected" : "Bot Disconnected"}</p>
        <div className="hero-actions">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setTab("trades");
              setMenuOpen(false);
            }}
          >
            History
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setTab("analytics");
              setMenuOpen(false);
            }}
          >
            Analytics
          </button>
        </div>
      </section>

      {menuOpen ? <div className="menu-backdrop" onClick={() => setMenuOpen(false)} /> : null}
      <nav id="main-nav" className={`menu-drawer ${menuOpen ? "open" : ""}`}>
        <div className="menu-title">Navigation</div>
        {([
          ["overview", "Overview"],
          ["analytics", "Analytics"],
          ["pnl", "PnL Book"],
          ["signals", "Signals"],
          ["positions", "Positions"],
          ["trades", "History"],
          ["diary", "Trading Diary"],
          ["events", "Events"],
          ["logs", "Logs"],
          ["diagnostics", "Diagnostics"],
        ] as Array<[MainTab, string]>).map(([k, label]) => (
          <button
            key={k}
            className={`menu-link ${tab === k ? "active" : ""}`}
            onClick={() => {
              setTab(k);
              setMenuOpen(false);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <>
          <div className="kpi-grid">
            <div className="kpi"><span>Start</span><strong>{fmtMoney(STARTING_BALANCE)}</strong></div>
            <div className="kpi"><span>Balance</span><strong>{fmtMoney(uiBalance)}</strong></div>
            <div className="kpi"><span>Equity</span><strong>{fmtMoney(uiEquity)}</strong></div>
            <div className="kpi"><span>Trades Today</span><strong>{snapshot?.guard_state?.today_opened_trades ?? 0}</strong></div>
            <div className="kpi"><span>Open</span><strong className={uiOpen >= 0 ? "up" : "down"}>{fmtMoney(uiOpen)}</strong></div>
            <div className="kpi"><span>Net</span><strong className={uiNet >= 0 ? "up" : "down"}>{fmtMoney(uiNet)}</strong></div>
          </div>

          <div className="card">
            <h3>Performance</h3>
            <div className="chart-filters">
              <label>
                Range
                <select value={chartRange} onChange={(e) => setChartRange(e.target.value as ChartRange)}>
                  <option value="15m">15m</option>
                  <option value="1h">1h</option>
                  <option value="4h">4h</option>
                  <option value="12h">12h</option>
                  <option value="1d">1d</option>
                  <option value="3d">3d</option>
                  <option value="1w">1w</option>
                  <option value="all">All</option>
                </select>
              </label>
              <label>
                Resolution
                <select value={chartResolution} onChange={(e) => setChartResolution(e.target.value as ChartResolution)}>
                  <option value="raw">Raw</option>
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                </select>
              </label>
              <label>
                Smoothing
                <select value={chartSmoothing} onChange={(e) => setChartSmoothing(e.target.value as ChartSmoothing)}>
                  <option value="none">None</option>
                  <option value="ema3">EMA 3</option>
                  <option value="ema8">EMA 8</option>
                </select>
              </label>
              <label>
                Scale
                <select value={chartScale} onChange={(e) => setChartScale(e.target.value as ChartScale)}>
                  <option value="auto">Auto</option>
                  <option value="fromStart">Include Start</option>
                </select>
              </label>
            </div>

            <div className="series-toggles">
              <label><input type="checkbox" checked={showEquitySeries} onChange={(e) => setShowEquitySeries(e.target.checked)} /> Equity</label>
              <label><input type="checkbox" checked={showBalanceSeries} onChange={(e) => setShowBalanceSeries(e.target.checked)} /> Balance</label>
              <label><input type="checkbox" checked={showNetSeries} onChange={(e) => setShowNetSeries(e.target.checked)} /> Net PnL</label>
              <label><input type="checkbox" checked={showCloseMarkers} onChange={(e) => setShowCloseMarkers(e.target.checked)} /> Close Markers</label>
            </div>

            {performance.points.length ? (
              <>
                <div className="perf-strip">
                  <div><span>Equity</span><strong>{fmtMoney(performance.currentEq)}</strong></div>
                  <div><span>Balance</span><strong>{fmtMoney(performance.currentBal)}</strong></div>
                  <div><span>Net</span><strong className={performance.currentNet >= 0 ? "up" : "down"}>{fmtMoney(performance.currentNet)}</strong></div>
                  <div><span>High</span><strong>{fmtMoney(performance.highEq)}</strong></div>
                  <div><span>Low</span><strong>{fmtMoney(performance.lowEq)}</strong></div>
                  <div><span>Change</span><strong className={performance.changePct >= 0 ? "up" : "down"}>{performance.changePct.toFixed(2)}%</strong></div>
                  <div><span>Speed</span><strong className={performance.perMinute >= 0 ? "up" : "down"}>{fmtMoney(performance.perMinute)}/m</strong></div>
                </div>

                <svg viewBox="0 0 920 320" width="100%" height="320" role="img" aria-label="Filtered performance chart">
                  <defs>
                    <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#20b486" stopOpacity="0.36" />
                      <stop offset="100%" stopColor="#20b486" stopOpacity="0.03" />
                    </linearGradient>
                    <radialGradient id="chart-bg" cx="50%" cy="10%" r="75%">
                      <stop offset="0%" stopColor="#ffffff" />
                      <stop offset="100%" stopColor="#f3f8ff" />
                    </radialGradient>
                  </defs>
                  <rect x="0" y="0" width="920" height="320" fill="url(#chart-bg)" rx="12" />
                  {performance.gridLines.map((y, i) => (
                    <line key={`g-${i}`} x1="18" y1={y} x2="902" y2={y} stroke="#dfe8f4" strokeDasharray="4 6" />
                  ))}
                  {showEquitySeries ? <path d={performance.equityAreaPath} fill="url(#eq-fill)" /> : null}
                  {showBalanceSeries ? <path d={performance.balancePath} fill="none" stroke="#2b4c7e" strokeWidth="2" opacity="0.9" /> : null}
                  {showEquitySeries ? <path d={performance.equityPath} fill="none" stroke="#0e9f6e" strokeWidth="3" /> : null}
                  {showNetSeries ? <path d={performance.netPath} fill="none" stroke="#9b2c2c" strokeWidth="2" strokeDasharray="5 4" /> : null}
                  {performance.tradeMarkers.map((m, i) => (
                    <circle key={`mk-${i}`} cx={m.x} cy={m.y} r="5" fill={m.pnl >= 0 ? "#0e9f6e" : "#b9303d"} stroke="#ffffff" strokeWidth="2">
                      <title>{`${m.symbol} ${m.closeReason} ${fmtMoney(m.pnl)}`}</title>
                    </circle>
                  ))}
                </svg>
                <p>
                  Range {fmtMoney(performance.minY)} to {fmtMoney(performance.maxY)} | Points {performance.points.length}
                </p>
              </>
            ) : (
              <p>Waiting for performance snapshots.</p>
            )}
          </div>

          <div className="card">
            <h3>Email Alerts</h3>
            <div className="row">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" />
              <button className="btn" onClick={saveEmail}>Save Email</button>
            </div>
            {saveMsg ? <p>{saveMsg}</p> : null}
          </div>

          <div className="card">
            <h3>Backtested</h3>
            {!(snapshot?.backtest_summary || []).length ? (
              <p>No backtest summary in latest bot snapshot yet.</p>
            ) : (
              <div className="table-wrap"><table>
                <thead><tr><th>Window</th><th>Net</th><th>Win Rate</th><th>PF</th><th>DD</th><th>Trades</th></tr></thead>
                <tbody>
                  {(snapshot?.backtest_summary || []).map((b, i) => (
                    <tr key={`${b.window}-${i}`}>
                      <td>{b.window}</td>
                      <td className={Number(b.net_profit || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(b.net_profit || 0))}</td>
                      <td>{Number(b.win_rate || 0).toFixed(2)}%</td>
                      <td>{String(b.profit_factor ?? "-")}</td>
                      <td>{Number(b.max_drawdown_pct || 0).toFixed(2)}%</td>
                      <td>{Number(b.trade_count || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        </>
      ) : null}

      {tab === "analytics" ? (
        <>
          <div className="kpi-grid kpi-grid-analytics">
            <div className="kpi"><span>Absolute Gain</span><strong className={analytics.absoluteGain >= 0 ? "up" : "down"}>{fmtMoney(analytics.absoluteGain)} ({analytics.absoluteGainPct.toFixed(2)}%)</strong></div>
            <div className="kpi"><span>Win Rate</span><strong>{analytics.winRate.toFixed(1)}%</strong></div>
            <div className="kpi"><span>Profit Factor</span><strong>{analytics.profitFactor.toFixed(2)}</strong></div>
            <div className="kpi"><span>Expectancy</span><strong className={analytics.expectancy >= 0 ? "up" : "down"}>{fmtMoney(analytics.expectancy)}</strong></div>
            <div className="kpi"><span>Max Drawdown</span><strong className="down">{fmtMoney(analytics.maxDrawdown)} ({analytics.maxDrawdownPct.toFixed(2)}%)</strong></div>
            <div className="kpi"><span>Avg Trade Duration</span><strong>{analytics.avgDurationMin.toFixed(1)} min</strong></div>
          </div>

          <div className="card">
            <h3>Trading Stats</h3>
            <div className="table-wrap"><table>
              <tbody>
                <tr><td>Total Trades</td><td>{analytics.total}</td></tr>
                <tr><td>Winning Trades</td><td>{analytics.wins}</td></tr>
                <tr><td>Losing Trades</td><td>{analytics.losses}</td></tr>
                <tr><td>Breakeven Trades</td><td>{analytics.breakeven}</td></tr>
                <tr><td>Gross Profit</td><td className="up">{fmtMoney(analytics.grossProfit)}</td></tr>
                <tr><td>Gross Loss</td><td className="down">{fmtMoney(analytics.grossLoss)}</td></tr>
                <tr><td>Net Profit</td><td className={analytics.netProfit >= 0 ? "up" : "down"}>{fmtMoney(analytics.netProfit)}</td></tr>
                <tr><td>Average Win</td><td className="up">{fmtMoney(analytics.avgWin)}</td></tr>
                <tr><td>Average Loss</td><td className="down">{fmtMoney(analytics.avgLoss)}</td></tr>
                <tr><td>Largest Win</td><td className="up">{fmtMoney(analytics.largestWin)}</td></tr>
                <tr><td>Largest Loss</td><td className="down">{fmtMoney(analytics.largestLoss)}</td></tr>
                <tr><td>Max Win Streak</td><td>{analytics.maxWinStreak}</td></tr>
                <tr><td>Max Loss Streak</td><td>{analytics.maxLossStreak}</td></tr>
              </tbody>
            </table></div>
          </div>

          <div className="card">
            <h3>Monthly Returns</h3>
            {!analytics.monthlyRows.length ? (
              <p>No monthly history yet.</p>
            ) : (
              <div className="table-wrap"><table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Equity Close</th>
                    <th>Monthly Gain</th>
                    <th>Monthly %</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.monthlyRows.map((m) => (
                    <tr key={m.month}>
                      <td>{m.month}</td>
                      <td>{fmtMoney(m.equity)}</td>
                      <td className={m.gain >= 0 ? "up" : "down"}>{fmtMoney(m.gain)}</td>
                      <td className={m.gainPct >= 0 ? "up" : "down"}>{m.gainPct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        </>
      ) : null}

      {tab === "pnl" ? (
        <div className="card">
          <h3>PnL Book</h3>
          <div className="pnl-summary">
            <div><div className="muted">Today</div><div className={uiDay >= 0 ? "pnl up" : "pnl down"}>{fmtMoney(uiDay)}</div></div>
            <div><div className="muted">This Week</div><div className={uiWeek >= 0 ? "pnl up" : "pnl down"}>{fmtMoney(uiWeek)}</div></div>
            <div><div className="muted">This Month</div><div className={uiMonth >= 0 ? "pnl up" : "pnl down"}>{fmtMoney(uiMonth)}</div></div>
          </div>

          <div className="method">
            <div><strong>Formula</strong></div>
            <div>Day: Equity - Day Base</div>
            <div>Week: Equity - Week Base</div>
            <div>Month: Equity - Month Base</div>
            <div>Realized: Balance - Start</div>
          </div>

          <div className="segmented">
            <button className={`seg-btn ${pnlView === "day" ? "active" : ""}`} onClick={() => setPnlView("day")}>Day</button>
            <button className={`seg-btn ${pnlView === "week" ? "active" : ""}`} onClick={() => setPnlView("week")}>Week</button>
            <button className={`seg-btn ${pnlView === "month" ? "active" : ""}`} onClick={() => setPnlView("month")}>Month</button>
          </div>

          {pnlView === "day" ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date (UTC)</th><th>Equity vs $200</th></tr></thead>
                <tbody>
                  {pnlBookRows.dayRows.map((r) => (
                    <tr key={r.label}><td>{r.label}</td><td className={r.pnl >= 0 ? "up" : "down"}>{fmtMoney(r.pnl)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {pnlView === "week" ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Week</th><th>Equity vs $200</th></tr></thead>
                <tbody>
                  {pnlBookRows.weekRows.map((r) => (
                    <tr key={r.label}><td>{r.label}</td><td className={r.pnl >= 0 ? "up" : "down"}>{fmtMoney(r.pnl)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {pnlView === "month" ? (
            <>
              <p>{pnlBookRows.monthName} (UTC)</p>
              <div className="calendar-head"><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div></div>
              <div className="calendar-grid">
                {pnlBookRows.monthCells.map((c) => (
                  <div key={c.key} className={`calendar-cell ${c.isCurrentMonth ? "" : "other-month"}`}>
                    <div className="calendar-day">{c.day}</div>
                    {c.pnl === null ? <div className="muted">-</div> : <div className={c.pnl >= 0 ? "up" : "down"}>{fmtMoney(c.pnl)}</div>}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {tab === "signals" ? (
        <div className="card">
          <h3>Active Trade Calls</h3>
          {activeSignals.length === 0 ? <p>No active signal now.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Symbol</th><th>Signal</th><th>Lot</th><th>SL</th><th>TP</th><th>Score</th></tr></thead>
              <tbody>
                {activeSignals.map((s, i) => (
                  <tr key={`${s.symbol}-${i}`}>
                    <td>{s.symbol}</td>
                    <td><span className={`badge ${String(s.side).toLowerCase().startsWith("buy") ? "buy" : "sell"}`}>{signalType(s)}</span></td>
                    <td>{s.lot}</td><td>{s.sl ?? ""}</td><td>{s.tp ?? ""}</td><td>{Number(s.score || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      ) : null}

      {tab === "positions" ? (
        <div className="card">
          <h3>Open Positions</h3>
          {!(snapshot?.bot_positions || []).length ? <p>No open positions.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Pair</th><th>Type</th><th>Lot</th><th>Entry</th><th>SL</th><th>TP</th><th>PnL</th></tr></thead>
              <tbody>
                {(snapshot?.bot_positions || []).map((p) => (
                  <tr key={p.ticket}><td>{p.symbol}</td><td>{String(p.type).toUpperCase()}</td><td>{p.volume}</td><td>{p.price_open}</td><td>{p.sl}</td><td>{p.tp}</td><td className={p.profit >= 0 ? "up" : "down"}>{fmtMoney(Number(p.profit || 0))}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      ) : null}

      {tab === "trades" ? (
        <div className="card">
          <h3>Closed Trades</h3>
          {!(snapshot?.closed_trades || []).length ? (
            <p>No closed trades yet.</p>
          ) : (
            <div className="table-wrap"><table>
              <thead>
                <tr>
                  <th>Icon</th>
                  <th>Close Type</th>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Lot</th>
                  <th>Entry</th>
                  <th>Close</th>
                  <th>PnL</th>
                  <th>Opened (UTC)</th>
                  <th>Closed (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot?.closed_trades || []).map((t, i) => (
                  <tr key={`${t.position_id}-${i}`}>
                    <td><span className={`trade-icon ${String(t.close_reason || "").toLowerCase()}`}>{t.reason_icon || "?"}</span></td>
                    <td><span className={`exit-badge ${String(t.close_reason || "").toLowerCase()}`}>{t.close_reason}</span></td>
                    <td>{t.symbol}</td>
                    <td>{String(t.side || "").toUpperCase()}</td>
                    <td>{Number(t.volume || 0).toFixed(2)}</td>
                    <td>{Number(t.entry_price || 0).toFixed(5)}</td>
                    <td>{Number(t.close_price || 0).toFixed(5)}</td>
                    <td className={Number(t.pnl || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(t.pnl || 0))}</td>
                    <td>{t.entry_time_utc || "-"}</td>
                    <td>{t.close_time_utc || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <p className="muted" style={{ marginTop: 10 }}>T TP | S SL | R Trail | B BE | M Manual</p>
        </div>
      ) : null}

      {tab === "diary" ? (
        <div className="card">
          <h3>Trading Diary</h3>
          {!closedTrades.length ? (
            <p>No closed trades yet to journal.</p>
          ) : (
            <div className="diary-layout">
              <div className="diary-list">
                {closedTrades.slice(0, 80).map((t, i) => {
                  const id = String(t.position_id);
                  return (
                    <button
                      key={`${id}-${i}`}
                      className={`diary-item ${selectedTradeId === id ? "active" : ""}`}
                      onClick={() => setSelectedTradeId(id)}
                    >
                      <span>{t.symbol} {String(t.side).toUpperCase()}</span>
                      <span className={Number(t.pnl || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(t.pnl || 0))}</span>
                    </button>
                  );
                })}
              </div>

              <div className="diary-editor">
                <label>
                  Setup
                  <textarea value={draft.setup} onChange={(e) => setDraft((d) => ({ ...d, setup: e.target.value }))} placeholder="Why did I take this trade?" />
                </label>
                <label>
                  Emotion
                  <textarea value={draft.emotion} onChange={(e) => setDraft((d) => ({ ...d, emotion: e.target.value }))} placeholder="How did I feel during entry/management?" />
                </label>
                <label>
                  Mistakes
                  <textarea value={draft.mistakes} onChange={(e) => setDraft((d) => ({ ...d, mistakes: e.target.value }))} placeholder="What mistakes happened?" />
                </label>
                <label>
                  Lesson
                  <textarea value={draft.lesson} onChange={(e) => setDraft((d) => ({ ...d, lesson: e.target.value }))} placeholder="What will I do better next time?" />
                </label>
                <label>
                  Trade Rating (0-5)
                  <input type="number" min={0} max={5} step={1} value={draft.rating} onChange={(e) => setDraft((d) => ({ ...d, rating: Number(e.target.value || 0) }))} />
                </label>
                <button className="btn" onClick={saveDiaryEntry}>Save Diary Entry</button>
                {diaryMsg ? <p className="muted">{diaryMsg}</p> : null}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {tab === "events" ? (
        <div className="card">
          <h3>Recent Events</h3>
          {!(snapshot?.recent_events || []).length ? <p>No events yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Time</th><th>Type</th><th>Pair</th><th>Details</th></tr></thead>
              <tbody>
                {(snapshot?.recent_events || []).slice().reverse().map((e, i) => (
                  <tr key={`${e.timestamp_utc}-${i}`}><td>{e.timestamp_utc}</td><td>{e.event_type}</td><td>{e.symbol}</td><td>{e.details}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      ) : null}

      {tab === "logs" ? (
        <div className="card">
          <h3>Recent Logs</h3>
          {!(snapshot?.recent_logs || []).length ? <p>No logs yet.</p> : <pre className="log-box">{(snapshot?.recent_logs || []).join("\n")}</pre>}
        </div>
      ) : null}

      {tab === "diagnostics" ? (
        <>
          <div className="card">
            <h3>Live Status</h3>
            <div className="table-wrap"><table><tbody>
              <tr><td>Account</td><td>{snapshot?.account?.login || "-"}</td></tr>
              <tr><td>Server</td><td>{snapshot?.account?.server || "-"}</td></tr>
              <tr><td>Balance</td><td>{fmtMoney(Number(snapshot?.account?.balance || 0))}</td></tr>
              <tr><td>Equity</td><td>{fmtMoney(Number(snapshot?.account?.equity || 0))}</td></tr>
              <tr><td>Free Margin</td><td>{fmtMoney(Number(snapshot?.account?.margin_free || 0))}</td></tr>
              <tr><td>Dry Run</td><td>{String(snapshot?.dry_run ?? false)}</td></tr>
              <tr><td>Halted</td><td>{String(snapshot?.halted ?? false)}</td></tr>
              <tr><td>Halt Reason</td><td>{snapshot?.halt_reason || "-"}</td></tr>
            </tbody></table></div>
          </div>

          <div className="card">
            <h3>Guard State</h3>
            <div className="table-wrap"><table><tbody>
              <tr><td>Trades Today</td><td>{snapshot?.guard_state?.today_opened_trades ?? 0}</td></tr>
              <tr><td>Consecutive Losses</td><td>{snapshot?.guard_state?.today_consecutive_losses ?? 0}</td></tr>
              <tr><td>MT5 Failure Streak</td><td>{snapshot?.guard_state?.mt5_failure_streak ?? 0}</td></tr>
              <tr><td>Stale Data Streak</td><td>{snapshot?.guard_state?.stale_data_streak ?? 0}</td></tr>
              <tr><td>Unhandled Error Streak</td><td>{snapshot?.guard_state?.unhandled_error_streak ?? 0}</td></tr>
            </tbody></table></div>
          </div>

          <div className="card">
            <h3>All Signal Diagnostics</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Symbol</th><th>Status</th><th>Reason</th><th>Score</th></tr></thead>
              <tbody>
                {(snapshot?.signals || []).map((s, i) => (
                  <tr key={`${s.symbol}-d-${i}`}><td>{s.symbol}</td><td>{s.status}</td><td>{s.reason}</td><td>{Number(s.score || 0).toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </>
      ) : null}
    </main>
  );
}
