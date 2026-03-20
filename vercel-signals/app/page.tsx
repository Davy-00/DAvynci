"use client";

import { useEffect, useMemo, useState } from "react";

type Signal = {
  symbol: string;
  status: string;
  side: string;
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
  signals: Signal[];
};

export default function HomePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const res = await fetch("/api/signals", { cache: "no-store" });
      const data = await res.json();
      if (mounted) setSnapshot(data);
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  const active = useMemo(
    () => (snapshot?.signals || []).filter((s) => s.status === "signal" && (s.side === "buy" || s.side === "sell")),
    [snapshot]
  );

  return (
    <main>
      <h1>DAvynci Live Signals</h1>
      <p>Updated: {snapshot?.timestamp_utc || "-"}</p>

      <div className="card">
        <h3>Active Trade Calls</h3>
        {active.length === 0 ? (
          <p>No active BUY/SELL signal now.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
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
                    <span className={`badge ${s.side === "buy" ? "buy" : "sell"}`}>{String(s.side).toUpperCase()}</span>
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
    </main>
  );
}
