"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const STARTING_BALANCE = 200;

type PnlView = "day" | "week" | "month";
type MainTab = "overview" | "pnl" | "signals" | "positions" | "trades" | "events" | "logs" | "diagnostics";

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
  signals: Signal[];
};

type PerfPoint = { timestamp_utc: string; equity: number; balance: number };

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
  const ts = String(s.timestamp_utc || "");
  return `${ts}|${eq}|${bal}|${trades}|${signals}|${positions}`;
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
    const poll = setInterval(loadSignals, 5000);
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
    const points = performancePoints.slice(-120);
    if (!points.length) return { equityPath: "", balancePath: "", minY: 0, maxY: 1 };

    const w = 920;
    const h = 240;
    const px = 16;
    const py = 14;
    const values = points.flatMap((p) => [p.equity, p.balance]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;

    const xFor = (i: number) => (points.length === 1 ? w / 2 : px + (i / (points.length - 1)) * (w - px * 2));
    const yFor = (v: number) => h - py - ((v - min) / span) * (h - py * 2);
    const pathFor = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)} ${yFor(v).toFixed(2)}`).join(" ");

    return {
      equityPath: pathFor(points.map((p) => p.equity)),
      balancePath: pathFor(points.map((p) => p.balance)),
      minY: min,
      maxY: max,
    };
  }, [performancePoints]);

  const lastUpdateAge = useMemo(() => {
    if (!snapshot?.timestamp_utc) return "no data";
    const age = Math.max(0, Math.floor((nowMs - new Date(snapshot.timestamp_utc).getTime()) / 1000));
    return `${age}s ago`;
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

  const uiBalance = useAnimatedNumber(pnl.currentBalance);
  const uiEquity = useAnimatedNumber(pnl.currentEquity);
  const uiOpen = useAnimatedNumber(floatingPnl);
  const uiNet = useAnimatedNumber(pnl.net);
  const uiDay = useAnimatedNumber(pnl.day);
  const uiWeek = useAnimatedNumber(pnl.week);
  const uiMonth = useAnimatedNumber(pnl.month);

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
        <p>Last update: {snapshot?.timestamp_utc || "-"} ({lastUpdateAge})</p>
      </section>

      {menuOpen ? <div className="menu-backdrop" onClick={() => setMenuOpen(false)} /> : null}
      <nav id="main-nav" className={`menu-drawer ${menuOpen ? "open" : ""}`}>
        <div className="menu-title">Navigation</div>
        {([
          ["overview", "Overview"],
          ["pnl", "PnL Book"],
          ["signals", "Signals"],
          ["positions", "Positions"],
          ["trades", "Trades"],
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
            <div className="kpi"><span>Start Balance</span><strong>{fmtMoney(STARTING_BALANCE)}</strong></div>
            <div className="kpi"><span>Balance</span><strong>{fmtMoney(uiBalance)}</strong></div>
            <div className="kpi"><span>Equity</span><strong>{fmtMoney(uiEquity)}</strong></div>
            <div className="kpi"><span>Today Trades</span><strong>{snapshot?.guard_state?.today_opened_trades ?? 0}</strong></div>
            <div className="kpi"><span>Open PnL</span><strong className={uiOpen >= 0 ? "up" : "down"}>{fmtMoney(uiOpen)}</strong></div>
            <div className="kpi"><span>Net PnL from $200</span><strong className={uiNet >= 0 ? "up" : "down"}>{fmtMoney(uiNet)}</strong></div>
          </div>

          <div className="card">
            <h3>Performance</h3>
            {performance.equityPath ? (
              <>
                <svg viewBox="0 0 920 240" width="100%" height="240" role="img" aria-label="Equity and balance trend">
                  <rect x="0" y="0" width="920" height="240" fill="#f8fbff" rx="10" />
                  <path d={performance.balancePath} fill="none" stroke="#2b4c7e" strokeWidth="2" opacity="0.85" />
                  <path d={performance.equityPath} fill="none" stroke="#0e9f6e" strokeWidth="3" />
                </svg>
                <p>Range: {fmtMoney(performance.minY)} to {fmtMoney(performance.maxY)}</p>
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
            <div><strong>Transparent Formula</strong></div>
            <div>Day = Current Equity - Day Start Equity ({fmtMoney(pnl.currentEquity)} - {fmtMoney(pnl.dayBase)})</div>
            <div>Week = Current Equity - Week Start Equity ({fmtMoney(pnl.currentEquity)} - {fmtMoney(pnl.weekBase)})</div>
            <div>Month = Current Equity - Month Start Equity ({fmtMoney(pnl.currentEquity)} - {fmtMoney(pnl.monthBase)})</div>
            <div>Realized since $200 = Balance - 200 ({fmtMoney(pnl.currentBalance)} - {fmtMoney(STARTING_BALANCE)}) = {fmtMoney(pnl.realized)}</div>
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
          <h3>Closed Trades (All)</h3>
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
          <p className="muted" style={{ marginTop: 10 }}>
            Icons: T=TP, S=SL, R=Trailed SL, B=Break-even, M=Manual.
          </p>
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
