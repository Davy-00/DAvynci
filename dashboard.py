from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Dict, Optional

import MetaTrader5 as mt5
import pandas as pd
import streamlit as st

from config import CONFIG


DEFAULT_PERIOD_FOLDERS = {
    "Week": "backtest_results_portfolio_200_week_boosted",
    "Month": "backtest_results_portfolio_200_30d",
    "Year": "backtest_results_portfolio_200_1y",
    "Trend Week": "backtest_results_week_trend_pairs",
    "Growth 30D": "backtest_results_growth_mode_30d",
}


def discover_period_folders() -> Dict[str, str]:
    discovered = {
        label: folder
        for label, folder in DEFAULT_PERIOD_FOLDERS.items()
        if (Path(folder) / "summary.csv").exists() and (Path(folder) / "trades.csv").exists()
    }
    return discovered


def inject_styles() -> None:
    st.markdown(
        """
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap');

        html, body, [class*="css"] {
            font-family: 'Space Grotesk', sans-serif;
            color: #13212a;
        }

        .stApp {
            background:
                radial-gradient(1000px 500px at -10% -20%, rgba(26, 146, 171, 0.22), transparent 60%),
                radial-gradient(900px 520px at 105% 0%, rgba(242, 152, 74, 0.22), transparent 58%),
                linear-gradient(180deg, #f4f8fb 0%, #eef4f8 100%);
        }

        .block-container {
            padding-top: 1.3rem;
        }

        .hero {
            border: 1px solid rgba(19, 33, 42, 0.14);
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.84) 0%, rgba(255, 255, 255, 0.74) 100%);
            backdrop-filter: blur(6px);
            border-radius: 20px;
            padding: 18px 20px;
            margin-bottom: 12px;
            animation: lift 450ms ease;
            box-shadow: 0 12px 28px rgba(18, 40, 55, 0.10);
        }

        .main-title {
            font-size: 2.15rem;
            font-weight: 700;
            letter-spacing: 0.2px;
            margin-bottom: 6px;
        }

        .subtitle {
            font-size: 1rem;
            color: #3b5566;
            margin-bottom: 0px;
        }

        .card {
            border: 1px solid rgba(20, 37, 47, 0.15);
            border-radius: 16px;
            background: linear-gradient(145deg, #ffffff, #f4f9fc);
            box-shadow: 0 8px 22px rgba(18, 40, 55, 0.08);
            padding: 14px 16px;
            animation: lift 500ms ease;
        }

        .label {
            font-size: 0.72rem;
            color: #4b6576;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 4px;
            font-weight: 600;
        }

        .value {
            font-size: 1.45rem;
            font-weight: 700;
            color: #0f222f;
        }

        .pnl-pos {
            color: #067647;
            font-weight: 700;
        }

        .pnl-neg {
            color: #b42318;
            font-weight: 700;
        }

        .badge {
            display: inline-block;
            margin-top: 8px;
            padding: 5px 10px;
            border-radius: 999px;
            background: #13212a;
            color: #f5fbff;
            font-size: 0.75rem;
            font-weight: 600;
            letter-spacing: 0.03em;
        }

        .section-title {
            margin-top: 12px;
            margin-bottom: 10px;
            font-size: 1.15rem;
            font-weight: 700;
            color: #122a39;
        }

        .journal-day {
            font-size: 0.93rem;
            font-weight: 700;
            margin-top: 12px;
            margin-bottom: 8px;
            border-bottom: 1px solid rgba(18, 40, 55, 0.2);
            padding-bottom: 6px;
            color: #1f3a4a;
        }

        .journal-item {
            border: 1px solid rgba(18, 40, 55, 0.12);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.92);
            padding: 10px;
            margin-bottom: 6px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.82rem;
            animation: lift 300ms ease;
        }

        @keyframes lift {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def init_mt5() -> bool:
    kwargs = {}
    if CONFIG.mt5_path:
        kwargs["path"] = CONFIG.mt5_path

    if not mt5.initialize(**kwargs):
        st.error(f"MT5 initialize failed: {mt5.last_error()}")
        return False

    if CONFIG.mt5_login > 0:
        ok = mt5.login(CONFIG.mt5_login, password=CONFIG.mt5_password, server=CONFIG.mt5_server)
        if not ok:
            st.error(f"MT5 login failed: {mt5.last_error()}")
            return False
    return True


def load_status() -> dict:
    path = Path(CONFIG.bot_status_file)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def read_recent_log_lines(max_lines: int = 200) -> list[str]:
    path = Path(CONFIG.bot_log_file)
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    return lines[-max_lines:]


def load_signal_snapshot() -> dict:
    path = Path(CONFIG.bot_signals_file)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def positions_df() -> pd.DataFrame:
    positions = mt5.positions_get()
    if positions is None:
        return pd.DataFrame()

    rows = []
    for p in positions:
        if p.symbol not in CONFIG.symbols:
            continue
        if p.magic not in (0, CONFIG.magic_number):
            continue
        rows.append(
            {
                "ticket": int(p.ticket),
                "symbol": p.symbol,
                "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
                "volume": float(p.volume),
                "open": float(p.price_open),
                "sl": float(p.sl),
                "tp": float(p.tp),
                "profit": float(p.profit),
                "time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
            }
        )
    return pd.DataFrame(rows)


def pending_orders_df() -> pd.DataFrame:
    orders = mt5.orders_get()
    if orders is None:
        return pd.DataFrame()

    rows = []
    for o in orders:
        if o.symbol not in CONFIG.symbols:
            continue
        if o.magic not in (0, CONFIG.magic_number):
            continue
        rows.append(
            {
                "ticket": int(o.ticket),
                "symbol": o.symbol,
                "type": int(o.type),
                "volume": float(o.volume_initial),
                "price_open": float(o.price_open),
                "sl": float(o.sl),
                "tp": float(o.tp),
                "time_setup": datetime.fromtimestamp(o.time_setup, tz=timezone.utc).isoformat(),
            }
        )
    return pd.DataFrame(rows)


def order_history_df(days: int = 30, max_rows: int = 1000) -> pd.DataFrame:
    utc_to = datetime.now(timezone.utc)
    utc_from = utc_to - timedelta(days=days)
    deals = mt5.history_deals_get(utc_from, utc_to)
    if deals is None:
        return pd.DataFrame()

    rows = []
    for d in deals:
        if d.symbol not in CONFIG.symbols:
            continue
        if d.magic not in (0, CONFIG.magic_number):
            continue
        pnl = float(d.profit) + float(d.swap) + float(d.commission)
        rows.append(
            {
                "time": datetime.fromtimestamp(d.time, tz=timezone.utc),
                "date": datetime.fromtimestamp(d.time, tz=timezone.utc).date(),
                "deal": int(d.ticket),
                "order": int(d.order),
                "symbol": d.symbol,
                "entry": int(d.entry),
                "type": int(d.type),
                "volume": float(d.volume),
                "price": float(d.price),
                "pnl": pnl,
                "comment": d.comment,
            }
        )

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df.sort_values("time", ascending=False).head(max_rows)


def load_backtest_summary(folder_name: str) -> pd.DataFrame:
    path = Path(folder_name) / "summary.csv"
    if not path.exists():
        return pd.DataFrame()
    try:
        return pd.read_csv(path)
    except Exception:
        return pd.DataFrame()


def load_backtest_trades(folder_name: str, initial_equity: float = 200.0) -> pd.DataFrame:
    path = Path(folder_name) / "trades.csv"
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(path)
    except Exception:
        return pd.DataFrame()
    if df.empty or "pnl" not in df.columns:
        return pd.DataFrame()

    if "exit_time" in df.columns:
        df["time"] = pd.to_datetime(df["exit_time"], errors="coerce", utc=True)
    elif "entry_time" in df.columns:
        df["time"] = pd.to_datetime(df["entry_time"], errors="coerce", utc=True)
    else:
        df["time"] = pd.NaT

    df["pnl"] = pd.to_numeric(df["pnl"], errors="coerce").fillna(0.0)
    df = df.dropna(subset=["time"]).sort_values("time").reset_index(drop=True)
    if df.empty:
        return df
    df["equity"] = initial_equity + df["pnl"].cumsum()
    df["date"] = df["time"].dt.date
    return df


def get_portfolio_row(summary_df: pd.DataFrame) -> Optional[dict]:
    if summary_df.empty:
        return None
    if "scope" in summary_df.columns:
        p = summary_df[summary_df["scope"] == "portfolio"]
        if not p.empty:
            return p.iloc[0].to_dict()
    return summary_df.iloc[0].to_dict()


def render_top() -> None:
    st.markdown('<div class="hero">', unsafe_allow_html=True)
    st.markdown('<div class="main-title">DAvynci Control Room</div>', unsafe_allow_html=True)
    st.markdown(
        '<div class="subtitle">Live execution visibility, portfolio diagnostics, and strategy memory in one cinematic view.</div>',
        unsafe_allow_html=True,
    )
    st.markdown('<span class="badge">M5 Multi-Symbol Trend Suite</span>', unsafe_allow_html=True)
    st.markdown('</div>', unsafe_allow_html=True)

    account = mt5.account_info()
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.markdown('<div class="label">Balance</div>', unsafe_allow_html=True)
        st.markdown(f'<div class="value">{(account.balance if account else 0.0):,.2f}</div>', unsafe_allow_html=True)
        st.markdown('</div>', unsafe_allow_html=True)
    with c2:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.markdown('<div class="label">Equity</div>', unsafe_allow_html=True)
        st.markdown(f'<div class="value">{(account.equity if account else 0.0):,.2f}</div>', unsafe_allow_html=True)
        st.markdown('</div>', unsafe_allow_html=True)
    with c3:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.markdown('<div class="label">Free Margin</div>', unsafe_allow_html=True)
        st.markdown(f'<div class="value">{(account.margin_free if account else 0.0):,.2f}</div>', unsafe_allow_html=True)
        st.markdown('</div>', unsafe_allow_html=True)
    with c4:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.markdown('<div class="label">UTC Time</div>', unsafe_allow_html=True)
        st.markdown(f'<div class="value">{datetime.now(timezone.utc).strftime("%H:%M:%S")}</div>', unsafe_allow_html=True)
        st.markdown('</div>', unsafe_allow_html=True)


def render_orders_section() -> None:
    st.markdown('<div class="section-title">Current Orders</div>', unsafe_allow_html=True)
    tabs = st.tabs(["Open Positions", "Pending Orders"])

    with tabs[0]:
        df = positions_df()
        if df.empty:
            st.info("No open positions right now.")
        else:
            st.dataframe(df, width="stretch")

    with tabs[1]:
        df = pending_orders_df()
        if df.empty:
            st.info("No pending orders right now.")
        else:
            st.dataframe(df, width="stretch")


def render_signals_window() -> None:
    st.markdown('<div class="section-title">Bot Signals</div>', unsafe_allow_html=True)

    snapshot = load_signal_snapshot()
    signals = snapshot.get("signals", []) if isinstance(snapshot, dict) else []
    if not isinstance(signals, list) or not signals:
        st.info("No signal snapshot yet. Start bot loop to stream signals.")
        return

    df = pd.DataFrame(signals)
    if df.empty:
        st.info("Signal data is empty.")
        return

    if "score" in df.columns:
        df["score"] = pd.to_numeric(df["score"], errors="coerce").fillna(0.0)
    if "lot" in df.columns:
        df["lot"] = pd.to_numeric(df["lot"], errors="coerce").fillna(0.0)
    if "sl" in df.columns:
        df["sl"] = pd.to_numeric(df["sl"], errors="coerce")
    if "tp" in df.columns:
        df["tp"] = pd.to_numeric(df["tp"], errors="coerce")

    # Primary panel: actionable trade calls only.
    actionable = df.copy()
    if "status" in actionable.columns:
        actionable = actionable[actionable["status"] == "signal"]
    if "side" in actionable.columns:
        actionable = actionable[actionable["side"].isin(["buy", "sell"])]

    st.markdown("### Trade Calls (Now)")
    if actionable.empty:
        st.info("No active BUY/SELL signal right now. Waiting for quality breakout setups.")
    else:
        action_cols = [
            col
            for col in ["symbol", "side", "lot", "sl", "tp", "score", "reason", "timestamp_utc"]
            if col in actionable.columns
        ]
        out = actionable[action_cols].copy().sort_values(by=["score"], ascending=False)
        if "side" in out.columns:
            out["side"] = out["side"].str.upper()
        if "sl" in out.columns:
            out["sl"] = out["sl"].map(lambda v: f"{v:.5f}" if pd.notna(v) else "")
        if "tp" in out.columns:
            out["tp"] = out["tp"].map(lambda v: f"{v:.5f}" if pd.notna(v) else "")
        st.dataframe(out, width="stretch")

        top_row = out.iloc[0]
        side_txt = str(top_row.get("side", "")).upper()
        symbol_txt = str(top_row.get("symbol", ""))
        lot_txt = str(top_row.get("lot", ""))
        sl_txt = str(top_row.get("sl", ""))
        tp_txt = str(top_row.get("tp", ""))
        st.success(f"Top signal: {side_txt} {symbol_txt} | lot {lot_txt} | SL {sl_txt} | TP {tp_txt}")

    st.markdown("### Signal Diagnostics")
    status_value = st.selectbox(
        "Signal Status",
        ["ALL", "signal", "wait", "blocked", "error"],
        index=0,
    )
    symbol_options = ["ALL"] + sorted(df["symbol"].dropna().astype(str).unique().tolist()) if "symbol" in df.columns else ["ALL"]
    symbol_value = st.selectbox("Signal Symbol", symbol_options, index=0)

    filtered = df.copy()
    if status_value != "ALL" and "status" in filtered.columns:
        filtered = filtered[filtered["status"] == status_value]
    if symbol_value != "ALL" and "symbol" in filtered.columns:
        filtered = filtered[filtered["symbol"] == symbol_value]

    c1, c2, c3, c4 = st.columns(4)
    with c1:
        st.metric("Total Symbols", f"{len(df)}")
    with c2:
        st.metric("Entry Ready", f"{int((df.get('status') == 'signal').sum()) if 'status' in df.columns else 0}")
    with c3:
        st.metric("Blocked", f"{int((df.get('status') == 'blocked').sum()) if 'status' in df.columns else 0}")
    with c4:
        st.metric("Waiting", f"{int((df.get('status') == 'wait').sum()) if 'status' in df.columns else 0}")

    show_cols = [
        col
        for col in [
            "timestamp_utc",
            "symbol",
            "status",
            "side",
            "score",
            "min_required_score",
            "lot",
            "reason",
            "sl",
            "tp",
        ]
        if col in filtered.columns
    ]

    if filtered.empty:
        st.info("No rows match selected filters.")
    else:
        st.dataframe(
            filtered[show_cols].sort_values(by=["status", "score"], ascending=[True, False]),
            width="stretch",
        )


def render_backtest_section() -> None:
    st.markdown('<div class="section-title">Performance Graphs</div>', unsafe_allow_html=True)

    period_folders = discover_period_folders()
    if not period_folders:
        st.info("No valid backtest folders found. Expected summary.csv and trades.csv in configured folders.")
        return

    left, right = st.columns([1, 3])
    with left:
        selected_periods = st.multiselect(
            "Periods",
            list(period_folders.keys()),
            default=list(period_folders.keys()),
            help="Choose week, month, and/or year sets.",
        )
        metric = st.selectbox(
            "Graph Metric",
            ["equity", "cumulative_pnl", "daily_pnl"],
            index=0,
        )

    series_frames = []
    summary_rows = []
    all_symbols = set()

    for period in selected_periods:
        folder = period_folders[period]
        trades = load_backtest_trades(folder)
        summary = load_backtest_summary(folder)
        p_row = get_portfolio_row(summary)

        if p_row is not None:
            summary_rows.append(
                {
                    "period": period,
                    "net_profit": float(p_row.get("net_profit", 0.0)),
                    "win_rate": float(p_row.get("win_rate", 0.0)),
                    "profit_factor": float(p_row.get("profit_factor", 0.0)),
                    "max_drawdown_pct": float(p_row.get("max_drawdown_pct", 0.0)),
                }
            )

        if trades.empty:
            continue

        if "symbol" in trades.columns:
            all_symbols.update(trades["symbol"].dropna().unique().tolist())

        trades = trades.copy()
        trades["period"] = period
        trades["cumulative_pnl"] = trades["pnl"].cumsum()
        daily = trades.groupby("date", as_index=False)["pnl"].sum().rename(columns={"pnl": "daily_pnl"})
        trades = trades.merge(daily, on="date", how="left")
        series_frames.append(trades)

    if summary_rows:
        s_df = pd.DataFrame(summary_rows)
        m1, m2, m3, m4 = st.columns(4)
        with m1:
            st.metric("Average Net Profit", f"{s_df['net_profit'].mean():,.2f}")
        with m2:
            st.metric("Average Win Rate", f"{s_df['win_rate'].mean():.2f}%")
        with m3:
            st.metric("Average Profit Factor", f"{s_df['profit_factor'].mean():.2f}")
        with m4:
            st.metric("Average Max DD", f"{s_df['max_drawdown_pct'].mean():.2f}%")

        chart_df = s_df.set_index("period")
        st.bar_chart(chart_df[["net_profit", "win_rate", "profit_factor", "max_drawdown_pct"]], width="stretch")

    if not series_frames:
        st.info("No trades data available for selected periods.")
        return

    merged = pd.concat(series_frames, ignore_index=True)
    symbol_options = ["ALL"] + sorted(all_symbols)

    with right:
        selected_symbol = st.selectbox("Symbol Filter", symbol_options, index=0)

    if selected_symbol != "ALL":
        merged = merged[merged["symbol"] == selected_symbol].copy()

    if merged.empty:
        st.info("No data after symbol filter.")
        return

    min_t = merged["time"].min().date()
    max_t = merged["time"].max().date()
    date_range = st.date_input("Date Filter", value=(min_t, max_t), min_value=min_t, max_value=max_t)
    if isinstance(date_range, tuple) and len(date_range) == 2:
        start_d, end_d = date_range
        merged = merged[(merged["time"].dt.date >= start_d) & (merged["time"].dt.date <= end_d)]

    if merged.empty:
        st.info("No data in selected date range.")
        return

    plot_df = merged[["time", "period", metric]].copy().sort_values("time")
    st.line_chart(plot_df.set_index("time")[metric], width="stretch")

    ranking = (
        merged.groupby("symbol", as_index=False)["pnl"]
        .agg(total_pnl="sum")
        .sort_values("total_pnl", ascending=False)
        .head(10)
    )
    if not ranking.empty:
        st.markdown('<div class="section-title">Top Symbols By PnL</div>', unsafe_allow_html=True)
        st.dataframe(ranking, width="stretch")


def render_history_journal() -> None:
    st.markdown('<div class="section-title">Previous Orders (Journal)</div>', unsafe_allow_html=True)
    days = st.slider("Journal Window (days)", min_value=7, max_value=365, value=30, step=1)
    df = order_history_df(days=days)
    if df.empty:
        st.info("No previous orders in this window.")
        return

    grouped = df.groupby("date", sort=False)
    for date_value, day_df in grouped:
        heading = pd.to_datetime(str(date_value)).strftime("%A, %Y-%m-%d")
        st.markdown(f'<div class="journal-day">{heading}</div>', unsafe_allow_html=True)
        for _, row in day_df.iterrows():
            pnl = float(row["pnl"])
            pnl_class = "pnl-pos" if pnl >= 0 else "pnl-neg"
            time_str = pd.to_datetime(row["time"]).strftime("%H:%M:%S")
            st.markdown(
                (
                    '<div class="journal-item">'
                    f"{time_str} | {row['symbol']} | vol {row['volume']:.2f} | price {row['price']:.5f} | "
                    f"<span class='{pnl_class}'>PNL {pnl:,.2f}</span>"
                    "</div>"
                ),
                unsafe_allow_html=True,
            )


def render_events_and_logs() -> None:
    st.markdown('<div class="section-title">Status and Logs</div>', unsafe_allow_html=True)
    status = load_status()
    if status:
        st.json(status)

    logs = read_recent_log_lines()
    st.code("\n".join(logs) if logs else "No logs found.", language="text")


def main() -> None:
    st.set_page_config(page_title="DAvynci", layout="wide")
    inject_styles()

    if not init_mt5():
        st.stop()

    render_top()

    section = st.sidebar.radio(
        "Section",
        ["Control Room", "Signals", "Orders & Journal", "Performance", "Status & Logs"],
        index=0,
    )
    st.sidebar.caption("DAvynci monitor suite")

    if section == "Control Room":
        render_orders_section()
        render_signals_window()
        render_backtest_section()
    elif section == "Signals":
        render_signals_window()
    elif section == "Orders & Journal":
        render_orders_section()
        render_history_journal()
    elif section == "Performance":
        render_backtest_section()
    else:
        render_events_and_logs()

    mt5.shutdown()


if __name__ == "__main__":
    main()
