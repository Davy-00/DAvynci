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
  signals: Signal[];
};

export default function HomePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [email, setEmail] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const res = await fetch("/api/signals", { cache: "no-store" });
      const data = await res.json();
      if (mounted) setSnapshot(data);

      const sub = await fetch("/api/subscribers", { cache: "no-store" });
      const subData = await sub.json();
      if (mounted && subData?.email) setEmail(String(subData.email));
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  const active = useMemo(
    () =>
      (snapshot?.signals || []).filter((s) =>
        s.status === "signal" && ["buy", "sell", "buy_limit", "sell_limit"].includes(String(s.side || "").toLowerCase())
      ),
    [snapshot]
  );

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
    </main>
  );
}
