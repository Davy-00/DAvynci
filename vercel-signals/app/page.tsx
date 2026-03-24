"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const STARTING_BALANCE = 30;
const LIVE_POLL_INTERVAL_MS = 1200;
const KPI_ANIMATION_MS = 900;

type PnlView = "day" | "week" | "month";
type MainTab = "overview" | "analytics" | "pnl" | "signals" | "positions" | "trades" | "diary" | "events" | "logs" | "diagnostics";

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
    starting_balance?: number;
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
declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

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

function tradeSortTs(t: { close_time_utc?: string; entry_time_utc?: string; position_id?: number }): number {
  const raw = String(t.close_time_utc || t.entry_time_utc || "").trim();
  const tryParse = (value: string): number => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  };
  let ts = tryParse(raw);
  if (!Number.isFinite(ts) && raw.includes(" ")) ts = tryParse(raw.replace(" ", "T"));
  if (!Number.isFinite(ts) && raw && !raw.endsWith("Z")) ts = tryParse(`${raw}Z`);
  if (Number.isFinite(ts)) return ts;
  return Number(t.position_id || 0);
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
  const [diary, setDiary] = useState<Record<string, DiaryEntry>>({});
  const [selectedTradeId, setSelectedTradeId] = useState("");
  const [draft, setDraft] = useState({ setup: "", emotion: "", mistakes: "", lesson: "", rating: 0 });
  const [diaryMsg, setDiaryMsg] = useState("");
  const [liveMode, setLiveMode] = useState<"stream" | "polling">("stream");
  const [mobileDeckIndex, setMobileDeckIndex] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const mobileDeckRef = useRef<HTMLDivElement | null>(null);
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

    const loadSignals = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/ingest?t=${Date.now()}`, { cache: "no-store" });
        const data = await res.json();
        if (mounted) {
          applySnapshot(data);
          setLiveMode("polling");
        }
      } finally {
        inFlight = false;
      }
    };

    loadSignals();
    const poll = setInterval(loadSignals, LIVE_POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(poll);
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

  const startingBalance = STARTING_BALANCE;

  const activeSignals = useMemo(
    () =>
      (snapshot?.signals || []).filter(
        (s) => s.status === "signal" && ["buy", "sell", "buy_limit", "sell_limit"].includes(String(s.side || "").toLowerCase())
      ),
    [snapshot]
  );

  const pendingOrders = useMemo(
    () =>
      (snapshot?.signals || []).filter((s) => ["buy_limit", "sell_limit"].includes(String(s.side || "").toLowerCase())),
    [snapshot]
  );

  const activeSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const s of snapshot?.symbols || []) {
      const k = String(s || "").trim().toUpperCase();
      if (k) set.add(k);
    }
    for (const s of snapshot?.signals || []) {
      const k = String(s.symbol || "").trim().toUpperCase();
      if (k) set.add(k);
    }
    for (const p of snapshot?.bot_positions || []) {
      const k = String(p.symbol || "").trim().toUpperCase();
      if (k) set.add(k);
    }
    return set;
  }, [snapshot]);

  const openPositions = useMemo(() => snapshot?.bot_positions || [], [snapshot]);
  const latestClosedTrade = useMemo(() => {
    const base = [...(snapshot?.closed_trades || [])];
    const rows = activeSymbols.size
      ? base.filter((t) => activeSymbols.has(String(t.symbol || "").trim().toUpperCase()))
      : base;
    if (!rows.length) return null;
    rows.sort((a, b) => {
      const aTs = tradeSortTs(a);
      const bTs = tradeSortTs(b);
      if (aTs !== bTs) return bTs - aTs;
      return Number(b.position_id || 0) - Number(a.position_id || 0);
    });
    return rows[0];
  }, [snapshot, activeSymbols]);

  const latestEvent = useMemo(() => {
    const rows = snapshot?.recent_events || [];
    if (!rows.length) return null;
    return rows[0];
  }, [snapshot]);

  const mobileCardCount = 4;

  const onMobileDeckScroll = () => {
    const el = mobileDeckRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const idx = Math.max(0, Math.min(mobileCardCount - 1, Math.round(el.scrollLeft / w)));
    if (idx !== mobileDeckIndex) setMobileDeckIndex(idx);
  };

  const goToMobileCard = (idx: number) => {
    const el = mobileDeckRef.current;
    if (!el) return;
    const safe = Math.max(0, Math.min(mobileCardCount - 1, idx));
    el.scrollTo({ left: safe * el.clientWidth, behavior: "smooth" });
    setMobileDeckIndex(safe);
  };

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
        : startingBalance;
    const lastBal = Number.isFinite(currentBalance)
      ? currentBalance
      : performancePoints.length
        ? performancePoints[performancePoints.length - 1].balance
        : startingBalance;

    const latestTs = snapshot?.timestamp_utc ? new Date(snapshot.timestamp_utc) : new Date();
    const dayStart = new Date(Date.UTC(latestTs.getUTCFullYear(), latestTs.getUTCMonth(), latestTs.getUTCDate()));
    const weekStart = startOfWeekUtc(latestTs);
    const monthStart = startOfMonthUtc(latestTs);

    const firstAtOrAfter = (start: Date): PerfPoint | null => {
      const ms = start.getTime();
      return performancePoints.find((p) => new Date(p.timestamp_utc).getTime() >= ms) || null;
    };

    const dayBase = firstAtOrAfter(dayStart)?.equity ?? startingBalance;
    const weekBase = firstAtOrAfter(weekStart)?.equity ?? startingBalance;
    const monthBase = firstAtOrAfter(monthStart)?.equity ?? startingBalance;

    return {
      day: lastEq - dayBase,
      week: lastEq - weekBase,
      month: lastEq - monthBase,
      realized: lastBal - startingBalance,
      net: lastEq - startingBalance,
      currentEquity: lastEq,
      currentBalance: lastBal,
      dayBase,
      weekBase,
      monthBase,
    };
  }, [snapshot, performancePoints, startingBalance]);

  const pnlBookRows = useMemo(() => {
    const dayClose = new Map<string, number>();
    for (const p of performancePoints) {
      dayClose.set(dateKeyUtc(p.timestamp_utc), p.equity);
    }
    const dayKeys = Array.from(dayClose.keys()).sort();
    const dayRows = dayKeys.slice(-30).reverse().map((k) => ({ label: k, pnl: (dayClose.get(k) || 0) - startingBalance }));

    const weekMap = new Map<string, number>();
    for (const [k, v] of dayClose.entries()) {
      const wk = dateKeyUtc(startOfWeekUtc(new Date(`${k}T00:00:00.000Z`)).toISOString());
      weekMap.set(wk, v);
    }
    const weekRows = Array.from(weekMap.keys())
      .sort()
      .slice(-12)
      .reverse()
      .map((wk) => ({ label: `Week ${wk}`, pnl: (weekMap.get(wk) || 0) - startingBalance }));

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
        pnl: dayClose.has(key) ? (dayClose.get(key) || 0) - startingBalance : null,
        isCurrentMonth: d.getUTCMonth() === latest.getUTCMonth() && d.getUTCFullYear() === latest.getUTCFullYear(),
      });
    }

    return {
      dayRows,
      weekRows,
      monthCells,
      monthName: latest.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  }, [performancePoints, snapshot, startingBalance]);

  const isConnected = !!snapshot?.timestamp_utc;

  const saveEmail = async () => {
    setSaveMsg("");
    const res = await fetch("/api/subscribers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSaveMsg(res.ok ? "Email saved." : "Failed to save email.");
  };

  const closedTrades = useMemo(() => {
    const base = [...(snapshot?.closed_trades || [])];
    const rows = activeSymbols.size
      ? base.filter((t) => activeSymbols.has(String(t.symbol || "").trim().toUpperCase()))
      : base;
    rows.sort((a, b) => {
      const aTs = tradeSortTs(a);
      const bTs = tradeSortTs(b);
      if (aTs !== bTs) return bTs - aTs;
      return Number(b.position_id || 0) - Number(a.position_id || 0);
    });
    return rows;
  }, [snapshot, activeSymbols]);
  const HISTORY_PAGE_SIZE = 20;
  const historyTotalPages = Math.max(1, Math.ceil(closedTrades.length / HISTORY_PAGE_SIZE));
  const historyPageSafe = Math.min(historyPage, historyTotalPages);
  const historyStart = (historyPageSafe - 1) * HISTORY_PAGE_SIZE;
  const historyEnd = Math.min(closedTrades.length, historyStart + HISTORY_PAGE_SIZE);
  const pagedClosedTrades = closedTrades.slice(historyStart, historyEnd);

  useEffect(() => {
    setHistoryPage((prev) => Math.min(prev, historyTotalPages));
  }, [historyTotalPages]);

  useEffect(() => {
    setHistoryPage(1);
  }, [closedTrades[0]?.position_id, closedTrades.length]);

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

  const uiBalance = useAnimatedNumber(pnl.currentBalance, KPI_ANIMATION_MS);
  const uiEquity = useAnimatedNumber(pnl.currentEquity, KPI_ANIMATION_MS);
  const uiOpen = useAnimatedNumber(floatingPnl, KPI_ANIMATION_MS);
  const uiNet = useAnimatedNumber(pnl.net, KPI_ANIMATION_MS);
  const uiDay = useAnimatedNumber(pnl.day, KPI_ANIMATION_MS);
  const uiWeek = useAnimatedNumber(pnl.week, KPI_ANIMATION_MS);
  const uiMonth = useAnimatedNumber(pnl.month, KPI_ANIMATION_MS);

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
    let peak = startingBalance;
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
    let prevEq = startingBalance;
    for (const m of months) {
      const eq = byMonth.get(m) || prevEq;
      const gain = eq - prevEq;
      const gainPct = prevEq > 0 ? (gain / prevEq) * 100 : 0;
      monthlyRows.push({ month: m, equity: eq, gain, gainPct });
      prevEq = eq;
    }
    monthlyRows.reverse();

    const currentEq = Number(snapshot?.account?.equity ?? startingBalance);
    const absoluteGain = currentEq - startingBalance;
    const absoluteGainPct = startingBalance > 0 ? (absoluteGain / startingBalance) * 100 : 0;
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
  }, [snapshot, performancePoints, startingBalance]);

  const growthLedger = useMemo(() => {
    const points = performancePoints
      .map((p) => ({
        ts: String(p.timestamp_utc || ""),
        tsMs: new Date(String(p.timestamp_utc || "")).getTime(),
        equity: Number(p.equity || 0),
        balance: Number(p.balance || 0),
      }))
      .filter((p) => Number.isFinite(p.tsMs) && Number.isFinite(p.equity) && Number.isFinite(p.balance));

    const fallbackTs = snapshot?.timestamp_utc || new Date().toISOString();
    const fallbackPoint = {
      ts: fallbackTs,
      tsMs: new Date(fallbackTs).getTime(),
      equity: Number(snapshot?.account?.equity ?? startingBalance),
      balance: Number(snapshot?.account?.balance ?? startingBalance),
    };
    let safePoints = points.length ? points : [fallbackPoint];
    if (safePoints.length === 1) {
      const only = safePoints[0];
      const prevTs = new Date(only.tsMs - 60 * 1000).toISOString();
      safePoints = [
        {
          ts: prevTs,
          tsMs: only.tsMs - 60 * 1000,
          equity: startingBalance,
          balance: startingBalance,
        },
        only,
      ];
    }

    if (!safePoints.length) {
      return {
        points: [] as Array<{
          ts: string;
          tsMs: number;
          equity: number;
          balance: number;
          net: number;
          growthPct: number;
          drawdown: number;
          drawdownPct: number;
        }>,
        equityAreaPath: "",
        balanceAreaPath: "",
        equityPath: "",
        balancePath: "",
        yTicks: [] as Array<{ y: number; label: string }>,
        xTicks: [] as Array<{ x: number; label: string }>,
        width: 920,
        height: 280,
        plotLeft: 68,
        plotRight: 902,
        plotTop: 18,
        plotBottom: 246,
        samples: 0,
        ageHours: 0,
        growthPerHour: 0,
        firstPoint: null as null | { x: number; yEq: number; yBal: number; equity: number; balance: number },
        lastPoint: null as null | { x: number; yEq: number; yBal: number; equity: number; balance: number },
        maxPoint: null as null | { x: number; yEq: number; equity: number },
        minPoint: null as null | { x: number; yEq: number; equity: number },
      };
    }

    let peak = startingBalance;
    const enriched = safePoints.map((p) => {
      if (p.equity > peak) peak = p.equity;
      const net = p.equity - startingBalance;
      const growthPct = startingBalance > 0 ? (net / startingBalance) * 100 : 0;
      const drawdown = Math.max(0, peak - p.equity);
      const drawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
      return { ...p, net, growthPct, drawdown, drawdownPct };
    });

    const w = 920;
    const h = 280;
    const plotLeft = 68;
    const plotRight = w - 18;
    const plotTop = 18;
    const plotBottom = h - 34;
    const values = [...enriched.map((p) => p.equity), ...enriched.map((p) => p.balance), startingBalance];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const xFor = (i: number) => (enriched.length === 1 ? (plotLeft + plotRight) / 2 : plotLeft + (i / (enriched.length - 1)) * (plotRight - plotLeft));
    const yFor = (v: number) => plotBottom - ((v - min) / span) * (plotBottom - plotTop);
    const pathFor = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)} ${yFor(v).toFixed(2)}`).join(" ");

    const plotted = enriched.map((p, i) => ({
      ...p,
      x: xFor(i),
      yEq: yFor(p.equity),
      yBal: yFor(p.balance),
    }));

    const areaPathFor = (arr: Array<{ x: number; y: number }>) => {
      if (!arr.length) return "";
      const head = `M${arr[0].x.toFixed(2)} ${plotBottom.toFixed(2)}`;
      const body = arr.map((p) => `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
      const tail = `L${arr[arr.length - 1].x.toFixed(2)} ${plotBottom.toFixed(2)} Z`;
      return `${head} ${body} ${tail}`;
    };

    const firstPoint = plotted[0] || null;
    const lastPoint = plotted[plotted.length - 1] || null;
    const maxPoint = plotted.length
      ? plotted.reduce((best, p) => (p.equity > best.equity ? p : best), plotted[0])
      : null;
    const minPoint = plotted.length
      ? plotted.reduce((best, p) => (p.equity < best.equity ? p : best), plotted[0])
      : null;

    const yTicks = [0, 1, 2, 3, 4].map((i) => {
      const ratio = i / 4;
      const value = max - ratio * span;
      return { y: yFor(value), label: fmtMoney(value) };
    });

    const formatUtcTick = (tsMs: number) => {
      const d = new Date(tsMs);
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mi = String(d.getUTCMinutes()).padStart(2, "0");
      return `${mm}-${dd} ${hh}:${mi}`;
    };

    const xTickCount = Math.min(5, enriched.length);
    const xIdxRaw = Array.from({ length: xTickCount }, (_, i) =>
      Math.round((i * (enriched.length - 1)) / Math.max(1, xTickCount - 1))
    );
    const xIdx = Array.from(new Set(xIdxRaw));
    const xTicks = xIdx.map((idx) => ({ x: xFor(idx), label: formatUtcTick(enriched[idx].tsMs) }));

    const ageHours = Math.max(0, (enriched[enriched.length - 1].tsMs - enriched[0].tsMs) / 3600000);
    const growthPerHour = ageHours > 0 ? (enriched[enriched.length - 1].equity - enriched[0].equity) / ageHours : 0;

    return {
      points: enriched,
      equityAreaPath: areaPathFor(plotted.map((p) => ({ x: p.x, y: p.yEq }))),
      balanceAreaPath: areaPathFor(plotted.map((p) => ({ x: p.x, y: p.yBal }))),
      equityPath: pathFor(enriched.map((p) => p.equity)),
      balancePath: pathFor(enriched.map((p) => p.balance)),
      yTicks,
      xTicks,
      width: w,
      height: h,
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      samples: enriched.length,
      ageHours,
      growthPerHour,
      firstPoint: firstPoint ? { x: firstPoint.x, yEq: firstPoint.yEq, yBal: firstPoint.yBal, equity: firstPoint.equity, balance: firstPoint.balance } : null,
      lastPoint: lastPoint ? { x: lastPoint.x, yEq: lastPoint.yEq, yBal: lastPoint.yBal, equity: lastPoint.equity, balance: lastPoint.balance } : null,
      maxPoint: maxPoint ? { x: maxPoint.x, yEq: maxPoint.yEq, equity: maxPoint.equity } : null,
      minPoint: minPoint ? { x: minPoint.x, yEq: minPoint.yEq, equity: minPoint.equity } : null,
    };
  }, [performancePoints, snapshot, startingBalance]);

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
        </div>
      </header>

      <section className="hero minimal">
        <p className={isConnected ? "up" : "down"}>{isConnected ? "Bot Connected" : "Bot Disconnected"}</p>
        <div className="hero-actions">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setTab("trades");
            }}
          >
            History
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setTab("analytics");
            }}
          >
            Analytics
          </button>
        </div>
      </section>

      {tab === "overview" ? (
        <>
          <div className="kpi-grid">
            <div className="kpi"><span>Start</span><strong>{fmtMoney(startingBalance)}</strong></div>
            <div className="kpi"><span>Balance</span><strong>{fmtMoney(uiBalance)}</strong></div>
            <div className="kpi"><span>Equity</span><strong>{fmtMoney(uiEquity)}</strong></div>
            <div className="kpi"><span>Trades Today</span><strong>{snapshot?.guard_state?.today_opened_trades ?? 0}</strong></div>
            <div className="kpi"><span>Open</span><strong className={uiOpen >= 0 ? "up" : "down"}>{fmtMoney(uiOpen)}</strong></div>
            <div className="kpi"><span>Net</span><strong className={uiNet >= 0 ? "up" : "down"}>{fmtMoney(uiNet)}</strong></div>
          </div>

          <div className="mobile-trader-cards" ref={mobileDeckRef} onScroll={onMobileDeckScroll}>
            <div className="mobile-trader-card mobile-slide">
              <p className="mobile-label">Live Signal</p>
              {activeSignals[0] ? (
                <>
                  <h4>{activeSignals[0].symbol}</h4>
                  <p>{signalType(activeSignals[0])}</p>
                  <p>SL {Number(activeSignals[0].sl || 0).toFixed(2)} | TP {Number(activeSignals[0].tp || 0).toFixed(2)}</p>
                </>
              ) : (
                <p>No active signal</p>
              )}
            </div>

            <div className="mobile-trader-card mobile-slide">
              <p className="mobile-label">Open Position</p>
              {openPositions[0] ? (
                <>
                  <h4>{openPositions[0].symbol}</h4>
                  <p>{String(openPositions[0].type).toUpperCase()} | Lot {Number(openPositions[0].volume || 0).toFixed(2)}</p>
                  <p className={Number(openPositions[0].profit || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(openPositions[0].profit || 0))}</p>
                </>
              ) : (
                <p>No open position</p>
              )}
            </div>

            <div className="mobile-trader-card mobile-slide">
              <p className="mobile-label">Last Closed Trade</p>
              {latestClosedTrade ? (
                <>
                  <h4>{latestClosedTrade.symbol}</h4>
                  <p>{String(latestClosedTrade.side || "").toUpperCase()} | {latestClosedTrade.close_reason}</p>
                  <p className={Number(latestClosedTrade.pnl || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(latestClosedTrade.pnl || 0))}</p>
                </>
              ) : (
                <p>No closed trades yet</p>
              )}
            </div>

            <div className="mobile-trader-card mobile-slide">
              <p className="mobile-label">Risk Snapshot</p>
              <h4>{snapshot?.symbols?.[0] || "-"}</h4>
              <p>Trades Today: {snapshot?.guard_state?.today_opened_trades ?? 0}</p>
              <p>{latestEvent ? `${latestEvent.event_type}: ${latestEvent.symbol}` : "No recent event"}</p>
            </div>
          </div>
          <div className="mobile-deck-dots" role="tablist" aria-label="Mobile trader cards">
            {[0, 1, 2, 3].map((i) => (
              <button
                key={`dot-${i}`}
                type="button"
                className={`mobile-dot ${mobileDeckIndex === i ? "active" : ""}`}
                onClick={() => goToMobileCard(i)}
                aria-label={`Show card ${i + 1}`}
              />
            ))}
          </div>

          <div className="card">
            <div className="tv-order-grid">
              <div>
                <h4>Pending Orders</h4>
                {!pendingOrders.length ? (
                  <p className="muted">No pending orders right now.</p>
                ) : (
                  <div className="table-wrap"><table>
                    <thead><tr><th>Symbol</th><th>Side</th><th>Lot</th><th>SL</th><th>TP</th></tr></thead>
                    <tbody>
                      {pendingOrders.slice(0, 20).map((o, i) => (
                        <tr key={`${o.symbol}-${o.side}-${i}`}>
                          <td>{o.symbol}</td>
                          <td>{signalType(o)}</td>
                          <td>{Number(o.lot || 0).toFixed(2)}</td>
                          <td>{Number(o.sl || 0).toFixed(2)}</td>
                          <td>{Number(o.tp || 0).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </div>

              <div>
                <h4>Open Positions</h4>
                {!openPositions.length ? (
                  <p className="muted">No open positions right now.</p>
                ) : (
                  <div className="table-wrap"><table>
                    <thead><tr><th>Symbol</th><th>Type</th><th>Entry</th><th>SL</th><th>TP</th><th>PnL</th></tr></thead>
                    <tbody>
                      {openPositions.slice(0, 20).map((p) => (
                        <tr key={String(p.ticket)}>
                          <td>{p.symbol}</td>
                          <td>{String(p.type).toUpperCase()}</td>
                          <td>{Number(p.price_open || 0).toFixed(2)}</td>
                          <td>{Number(p.sl || 0).toFixed(2)}</td>
                          <td>{Number(p.tp || 0).toFixed(2)}</td>
                          <td className={Number(p.profit || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(p.profit || 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </div>
            </div>
            <h3>Email Alerts</h3>
            <div className="row">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" />
              <button className="btn" onClick={saveEmail}>Save Email</button>
            </div>
            {saveMsg ? <p>{saveMsg}</p> : null}
          </div>

          <div className="card">
            <h3>Positions History (All Closed)</h3>
            {!closedTrades.length ? (
              <p>No closed positions yet.</p>
            ) : (
              <>
                <div className="table-wrap"><table>
                  <thead>
                    <tr>
                      <th>Position ID</th>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Lot</th>
                      <th>Entry</th>
                      <th>Close</th>
                      <th>PnL</th>
                      <th>Close Type</th>
                      <th>Opened (UTC)</th>
                      <th>Closed (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedClosedTrades.map((t, i) => (
                      <tr key={`${t.position_id}-${i}`}>
                        <td>{t.position_id}</td>
                        <td>{t.symbol}</td>
                        <td>{String(t.side || "").toUpperCase()}</td>
                        <td>{Number(t.volume || 0).toFixed(2)}</td>
                        <td>{Number(t.entry_price || 0).toFixed(5)}</td>
                        <td>{Number(t.close_price || 0).toFixed(5)}</td>
                        <td className={Number(t.pnl || 0) >= 0 ? "up" : "down"}>{fmtMoney(Number(t.pnl || 0))}</td>
                        <td>{t.close_reason || "-"}</td>
                        <td>{t.entry_time_utc || "-"}</td>
                        <td>{t.close_time_utc || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
                <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
                  <p className="muted">Showing {historyStart + 1}-{historyEnd} of {closedTrades.length}</p>
                  <div className="row">
                    <button className="btn btn-ghost" disabled={historyPageSafe <= 1} onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>Previous</button>
                    <p className="muted">Page {historyPageSafe} / {historyTotalPages}</p>
                    <button className="btn btn-ghost" disabled={historyPageSafe >= historyTotalPages} onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}>Next</button>
                  </div>
                </div>
              </>
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

          <div className="card growth-card">
            <h3>Account Growth Ledger</h3>
            <p className="muted">Precise timeline of balance/equity progression from the account start value.</p>
            <div className="growth-meta">
              <div><span>Starting Equity</span><strong>{fmtMoney(startingBalance)}</strong></div>
              <div><span>Samples</span><strong>{growthLedger.samples}</strong></div>
              <div><span>Tracked Hours</span><strong>{growthLedger.ageHours.toFixed(2)}</strong></div>
              <div><span>Growth / Hour</span><strong className={growthLedger.growthPerHour >= 0 ? "up" : "down"}>{fmtMoney(growthLedger.growthPerHour)}</strong></div>
            </div>

            {growthLedger.points.length ? (
              <>
                <div className="growth-chart-shell">
                  <svg
                    viewBox={`0 0 ${growthLedger.width} ${growthLedger.height}`}
                    width="100%"
                    height="280"
                    role="img"
                    aria-label="Account growth monitoring graph"
                  >
                    <defs>
                      <linearGradient id="growth-bg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ffffff" />
                        <stop offset="100%" stopColor="#f3fbf8" />
                      </linearGradient>
                      <linearGradient id="growth-equity-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(14, 159, 110, 0.4)" />
                        <stop offset="100%" stopColor="rgba(14, 159, 110, 0.03)" />
                      </linearGradient>
                      <linearGradient id="growth-balance-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(47, 74, 127, 0.26)" />
                        <stop offset="100%" stopColor="rgba(47, 74, 127, 0.02)" />
                      </linearGradient>
                    </defs>
                    <rect x="0" y="0" width={growthLedger.width} height={growthLedger.height} fill="url(#growth-bg)" rx="12" />
                    {growthLedger.yTicks.map((t, i) => (
                      <line
                        key={`gy-${i}`}
                        x1={growthLedger.plotLeft}
                        y1={t.y}
                        x2={growthLedger.plotRight}
                        y2={t.y}
                        stroke="#deebe6"
                        strokeDasharray="4 6"
                      />
                    ))}
                    {growthLedger.xTicks.map((t, i) => (
                      <line
                        key={`gx-${i}`}
                        x1={t.x}
                        y1={growthLedger.plotTop}
                        x2={t.x}
                        y2={growthLedger.plotBottom}
                        stroke="#edf4f0"
                      />
                    ))}
                    <line x1={growthLedger.plotLeft} y1={growthLedger.plotBottom} x2={growthLedger.plotRight} y2={growthLedger.plotBottom} stroke="#7a95a8" strokeWidth="1.4" />
                    <line x1={growthLedger.plotLeft} y1={growthLedger.plotTop} x2={growthLedger.plotLeft} y2={growthLedger.plotBottom} stroke="#7a95a8" strokeWidth="1.4" />
                    <path d={growthLedger.balanceAreaPath} fill="url(#growth-balance-fill)" />
                    <path d={growthLedger.equityAreaPath} fill="url(#growth-equity-fill)" />
                    <path d={growthLedger.balancePath} fill="none" stroke="#2f4a7f" strokeWidth="2" />
                    <path d={growthLedger.equityPath} fill="none" stroke="#0e9f6e" strokeWidth="3" />
                    {growthLedger.firstPoint ? (
                      <circle cx={growthLedger.firstPoint.x} cy={growthLedger.firstPoint.yEq} r="3.5" fill="#ffffff" stroke="#0e9f6e" strokeWidth="1.6" />
                    ) : null}
                    {growthLedger.maxPoint ? (
                      <g>
                        <circle cx={growthLedger.maxPoint.x} cy={growthLedger.maxPoint.yEq} r="5" fill="#ffffff" stroke="#0e9f6e" strokeWidth="2.2" />
                        <text x={growthLedger.maxPoint.x + 8} y={growthLedger.maxPoint.yEq - 8} fontSize="10" fill="#0d7f58">HIGH {fmtMoney(growthLedger.maxPoint.equity)}</text>
                      </g>
                    ) : null}
                    {growthLedger.minPoint ? (
                      <g>
                        <circle cx={growthLedger.minPoint.x} cy={growthLedger.minPoint.yEq} r="5" fill="#ffffff" stroke="#9b4b3f" strokeWidth="2" />
                        <text x={growthLedger.minPoint.x + 8} y={growthLedger.minPoint.yEq + 14} fontSize="10" fill="#9b4b3f">LOW {fmtMoney(growthLedger.minPoint.equity)}</text>
                      </g>
                    ) : null}
                    {growthLedger.lastPoint ? (
                      <>
                        <circle cx={growthLedger.lastPoint.x} cy={growthLedger.lastPoint.yEq} r="6" fill="#ffffff" stroke="#0e9f6e" strokeWidth="2.6" />
                        <circle cx={growthLedger.lastPoint.x} cy={growthLedger.lastPoint.yEq} r="2" fill="#0e9f6e" />
                        <circle cx={growthLedger.lastPoint.x} cy={growthLedger.lastPoint.yBal} r="4" fill="#ffffff" stroke="#2f4a7f" strokeWidth="2" />
                      </>
                    ) : null}
                    {growthLedger.yTicks.map((t, i) => (
                      <text key={`yt-${i}`} x={growthLedger.plotLeft - 8} y={t.y + 4} textAnchor="end" fontSize="11" fill="#5e7891">
                        {t.label}
                      </text>
                    ))}
                    {growthLedger.xTicks.map((t, i) => (
                      <text key={`xt-${i}`} x={t.x} y={growthLedger.plotBottom + 18} textAnchor="middle" fontSize="11" fill="#5e7891">
                        {t.label}
                      </text>
                    ))}
                    <text x={growthLedger.plotLeft - 44} y={growthLedger.plotTop - 2} fontSize="11" fill="#5e7891">Y (USD)</text>
                    <text x={(growthLedger.plotLeft + growthLedger.plotRight) / 2} y={growthLedger.height - 6} textAnchor="middle" fontSize="11" fill="#5e7891">X (UTC Time)</text>
                  </svg>
                  <div className="growth-legend">
                    <span className="growth-chip equity">Equity {fmtMoney(growthLedger.lastPoint?.equity ?? 0)}</span>
                    <span className="growth-chip balance">Balance {fmtMoney(growthLedger.lastPoint?.balance ?? 0)}</span>
                    <span className="growth-chip neutral">Spread {fmtMoney((growthLedger.lastPoint?.equity ?? 0) - (growthLedger.lastPoint?.balance ?? 0))}</span>
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Timestamp (UTC)</th>
                        <th>Balance</th>
                        <th>Equity</th>
                        <th>Net vs Start</th>
                        <th>Growth %</th>
                        <th>Drawdown</th>
                        <th>Drawdown %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {growthLedger.points.slice(-120).reverse().map((p) => (
                        <tr key={`${p.ts}-${p.equity.toFixed(2)}-${p.balance.toFixed(2)}`}>
                          <td>{p.ts}</td>
                          <td>{fmtMoney(p.balance)}</td>
                          <td>{fmtMoney(p.equity)}</td>
                          <td className={p.net >= 0 ? "up" : "down"}>{fmtMoney(p.net)}</td>
                          <td className={p.growthPct >= 0 ? "up" : "down"}>{p.growthPct.toFixed(3)}%</td>
                          <td className={p.drawdown > 0 ? "down" : "muted"}>{fmtMoney(p.drawdown)}</td>
                          <td className={p.drawdownPct > 0 ? "down" : "muted"}>{p.drawdownPct.toFixed(3)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p>No growth records yet.</p>
            )}
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
                <thead><tr><th>Date (UTC)</th><th>Equity vs Start</th></tr></thead>
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
                <thead><tr><th>Week</th><th>Equity vs Start</th></tr></thead>
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
            <>
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
                  {pagedClosedTrades.map((t, i) => (
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
              <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
                <p className="muted">Showing {historyStart + 1}-{historyEnd} of {closedTrades.length}</p>
                <div className="row">
                  <button className="btn btn-ghost" disabled={historyPageSafe <= 1} onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>Previous</button>
                  <p className="muted">Page {historyPageSafe} / {historyTotalPages}</p>
                  <button className="btn btn-ghost" disabled={historyPageSafe >= historyTotalPages} onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}>Next</button>
                </div>
              </div>
            </>
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
