"use client";

import { useEffect, useMemo, useState } from "react";

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

export default function HomePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [email, setEmail] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    let mounted = true;
    const loadSignals = async () => {
      const res = await fetch("/api/signals", { cache: "no-store" });
      const data = await res.json();
      if (mounted) setSnapshot(data);
    };
    loadSignals();
    const t = setInterval(loadSignals, 3000);
    return () => {
      mounted = false;
      clearInterval(t);
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

  const active = useMemo(
    () =>
      (snapshot?.signals || []).filter((s) =>
        s.status === "signal" && ["buy", "sell", "buy_limit", "sell_limit"].includes(String(s.side || "").toLowerCase())
      ),
    [snapshot]
  );

  const performance = useMemo(() => {
    const points = (snapshot?.performance_history || []).slice(-120);
    if (!points.length) {
      return {
        equityPath: "",
        balancePath: "",
        minY: 0,
        maxY: 1,
      };
    }

    const width = 920;
    const height = 240;
    const padX = 18;
    const padY = 16;
    const values = points.flatMap((p) => [Number(p.equity), Number(p.balance)]).filter(Number.isFinite);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const span = maxV - minV || 1;

    const xFor = (i: number) => {
      if (points.length === 1) return width / 2;
      return padX + (i / (points.length - 1)) * (width - padX * 2);
    };
    const yFor = (v: number) => {
      const normalized = (v - minV) / span;
      return height - padY - normalized * (height - padY * 2);
    };

    const toPath = (series: Array<{ x: number; y: number }>) =>
      series.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

    const equityPath = toPath(points.map((p, i) => ({ x: xFor(i), y: yFor(Number(p.equity)) })));
    const balancePath = toPath(points.map((p, i) => ({ x: xFor(i), y: yFor(Number(p.balance)) })));

    return {
      equityPath,
      balancePath,
      minY: minV,
      maxY: maxV,
    };
  }, [snapshot]);

  const signalType = (s: Signal) => {
    const side = String(s.side || "").toLowerCase();
    if (side === "buy_limit") return "BUY LIMIT";
    if (side === "sell_limit") return "SELL LIMIT";
    if (side === "buy") return "BUY";
    if (side === "sell") return "SELL";
    return side.toUpperCase() || "UNKNOWN";
  };

  const saveEmail = async () => {
    setSaveMsg("");
    const res = await fetch("/api/subscribers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      setSaveMsg("Email saved. Alerts will be sent here.");
      return;
    }
    setSaveMsg("Failed to save email. Check format or KV configuration.");
  };

  return (
    <main>
      <h1>DAvynci Live Signals</h1>
      <p>Updated: {snapshot?.timestamp_utc || "-"}</p>

      <div className="card">
        <h3>Live Status</h3>
        <table>
          <tbody>
            <tr><td>Account</td><td>{snapshot?.account?.login || "-"}</td></tr>
            <tr><td>Server</td><td>{snapshot?.account?.server || "-"}</td></tr>
            <tr><td>Balance</td><td>{snapshot?.account?.balance ?? "-"}</td></tr>
            <tr><td>Equity</td><td>{snapshot?.account?.equity ?? "-"}</td></tr>
            <tr><td>Free Margin</td><td>{snapshot?.account?.margin_free ?? "-"}</td></tr>
            <tr><td>Dry Run</td><td>{String(snapshot?.dry_run ?? false)}</td></tr>
            <tr><td>Halted</td><td>{String(snapshot?.halted ?? false)}</td></tr>
            <tr><td>Halt Reason</td><td>{snapshot?.halt_reason || "-"}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Bot Performance</h3>
        {!(snapshot?.performance_history || []).length ? (
          <p>Waiting for enough account snapshots to draw performance.</p>
        ) : (
          <>
            <svg viewBox="0 0 920 240" width="100%" height="240" role="img" aria-label="Bot equity and balance history">
              <rect x="0" y="0" width="920" height="240" fill="#0f172a" rx="8" />
              <path d={performance.balancePath} fill="none" stroke="#e2e8f0" strokeWidth="2" opacity="0.9" />
              <path d={performance.equityPath} fill="none" stroke="#22d3ee" strokeWidth="3" />
            </svg>
            <p style={{ marginTop: 8 }}>
              Range: {performance.minY.toFixed(2)} to {performance.maxY.toFixed(2)}
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h3>Guard State</h3>
        <table>
          <tbody>
            <tr><td>Trades Today</td><td>{snapshot?.guard_state?.today_opened_trades ?? 0}</td></tr>
            <tr><td>Consecutive Losses</td><td>{snapshot?.guard_state?.today_consecutive_losses ?? 0}</td></tr>
            <tr><td>MT5 Failure Streak</td><td>{snapshot?.guard_state?.mt5_failure_streak ?? 0}</td></tr>
            <tr><td>Stale Data Streak</td><td>{snapshot?.guard_state?.stale_data_streak ?? 0}</td></tr>
            <tr><td>Unhandled Error Streak</td><td>{snapshot?.guard_state?.unhandled_error_streak ?? 0}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Email Alerts</h3>
        <p>Set the email that will receive BUY/SELL and LIMIT signal alerts with pair, lot, TP, and SL.</p>
        <div className="row">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
          />
          <button className="btn" onClick={saveEmail}>Save Email</button>
        </div>
        {saveMsg ? <p>{saveMsg}</p> : null}
      </div>

      <div className="card">
        <h3>Active Trade Calls</h3>
        {active.length === 0 ? (
          <p>No active BUY/SELL/LIMIT signal now.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Signal</th>
                <th>Lot</th>
                <th>SL</th>
                <th>TP</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {active.map((s, i) => (
                <tr key={`${s.symbol}-${i}`}>
                  <td>{s.symbol}</td>
                  <td>
                    <span className={`badge ${String(s.side).toLowerCase().startsWith("buy") ? "buy" : "sell"}`}>{signalType(s)}</span>
                  </td>
                  <td>{s.lot ?? ""}</td>
                  <td>{s.sl ?? ""}</td>
                  <td>{s.tp ?? ""}</td>
                  <td>{Number(s.score || 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>All Signal Diagnostics</h3>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {(snapshot?.signals || []).map((s, i) => (
              <tr key={`${s.symbol}-d-${i}`}>
                <td>{s.symbol}</td>
                <td>{s.status}</td>
                <td>{s.reason}</td>
                <td>{Number(s.score || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Open Bot Positions</h3>
        {!(snapshot?.bot_positions || []).length ? (
          <p>No open positions.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Type</th>
                <th>Lot</th>
                <th>Entry</th>
                <th>SL</th>
                <th>TP</th>
                <th>PnL</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot?.bot_positions || []).map((p) => (
                <tr key={p.ticket}>
                  <td>{p.symbol}</td>
                  <td>{String(p.type).toUpperCase()}</td>
                  <td>{p.volume}</td>
                  <td>{p.price_open}</td>
                  <td>{p.sl}</td>
                  <td>{p.tp}</td>
                  <td>{p.profit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Recent Events</h3>
        {!(snapshot?.recent_events || []).length ? (
          <p>No events yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Pair</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot?.recent_events || []).slice().reverse().map((e, i) => (
                <tr key={`${e.timestamp_utc}-${i}`}>
                  <td>{e.timestamp_utc}</td>
                  <td>{e.event_type}</td>
                  <td>{e.symbol}</td>
                  <td>{e.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Recent Logs</h3>
        {!(snapshot?.recent_logs || []).length ? (
          <p>No logs yet.</p>
        ) : (
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {(snapshot?.recent_logs || []).join("\n")}
          </pre>
        )}
      </div>
    </main>
  );
}
