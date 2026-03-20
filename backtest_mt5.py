import argparse
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

import MetaTrader5 as mt5
import numpy as np
import pandas as pd

from config import CONFIG, scaled_risk_pct


TIMEFRAME_MAP = {
    1: mt5.TIMEFRAME_M1,
    5: mt5.TIMEFRAME_M5,
    15: mt5.TIMEFRAME_M15,
    30: mt5.TIMEFRAME_M30,
    60: mt5.TIMEFRAME_H1,
}


@dataclass
class Trade:
    symbol: str
    side: str
    entry_time: datetime
    exit_time: datetime
    entry: float
    exit: float
    sl: float
    tp: float
    lot: float
    pnl: float
    reason: str


@dataclass
class PositionState:
    symbol: str
    side: str
    entry_time: datetime
    entry: float
    sl: float
    tp: float
    lot: float


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def in_hour_window(hour: int, start_hour: int, end_hour: int) -> bool:
    if start_hour <= end_hour:
        return start_hour <= hour < end_hour
    return hour >= start_hour or hour < end_hour


def session_is_open(now_utc: datetime) -> bool:
    if not CONFIG.only_trade_london_newyork:
        return True
    h = now_utc.hour
    london = in_hour_window(h, CONFIG.london_start_hour_utc, CONFIG.london_end_hour_utc)
    newyork = in_hour_window(h, CONFIG.newyork_start_hour_utc, CONFIG.newyork_end_hour_utc)
    return london or newyork


def symbol_tokens(symbol: str) -> List[str]:
    s = symbol.upper()
    out = {s}
    if "GOLD" in s:
        out.add("XAU")
        out.add("GOLD")
    if s.startswith("XAU"):
        out.add("XAU")
        out.add("GOLD")
    if len(s) >= 6:
        out.add(s[:3])
        out.add(s[3:6])
    return list(out)


def load_news_events() -> List[Dict[str, object]]:
    file_path = Path(CONFIG.news_events_file)
    if not file_path.exists() or not CONFIG.use_news_filter:
        return []

    raw = pd.read_csv(file_path)
    events: List[Dict[str, object]] = []
    for _, row in raw.iterrows():
        ts = pd.to_datetime(str(row.get("timestamp_utc", "")), utc=True, errors="coerce")
        if pd.isna(ts):
            continue
        impact = str(row.get("impact", "high")).strip().lower()
        symbols = {
            token.strip().upper()
            for token in str(row.get("symbols", "ALL")).split("|")
            if token.strip()
        }
        events.append(
            {
                "time": ts.to_pydatetime(),
                "impact": impact,
                "symbols": symbols,
                "title": str(row.get("title", "event")),
            }
        )
    return events


def news_blocks_symbol(event_symbols: set, trade_symbol: str) -> bool:
    if "ALL" in event_symbols:
        return True
    tokens = set(symbol_tokens(trade_symbol))
    return trade_symbol.upper() in event_symbols or len(tokens.intersection(event_symbols)) > 0


def is_news_blocked(symbol: str, now_utc: datetime, events: List[Dict[str, object]]) -> bool:
    for event in events:
        impact = event["impact"]
        if CONFIG.news_only_high_impact and impact != "high":
            continue
        event_time = event["time"]
        if not isinstance(event_time, datetime):
            continue

        minutes_to_event = (event_time - now_utc).total_seconds() / 60.0
        if (
            -CONFIG.news_block_after_minutes
            <= minutes_to_event
            <= CONFIG.news_block_before_minutes
        ):
            event_symbols = event["symbols"]
            if isinstance(event_symbols, set) and news_blocks_symbol(event_symbols, symbol):
                return True
    return False


def initialize_mt5() -> bool:
    kwargs = {}
    if CONFIG.mt5_path:
        kwargs["path"] = CONFIG.mt5_path
    if not mt5.initialize(**kwargs):
        log(f"MT5 init failed: {mt5.last_error()}")
        return False

    if CONFIG.mt5_login > 0:
        ok = mt5.login(CONFIG.mt5_login, password=CONFIG.mt5_password, server=CONFIG.mt5_server)
        if not ok:
            log(f"MT5 login failed: {mt5.last_error()}")
            return False

    acct = mt5.account_info()
    if acct is None:
        log("No account info from MT5.")
        return False

    log(f"Connected: login={acct.login} server={acct.server} balance={acct.balance}")
    return True


def resolve_symbol(requested_symbol: str) -> Optional[str]:
    requested = requested_symbol.upper()
    all_symbols = mt5.symbols_get()
    if all_symbols is None:
        return None

    names = [s.name for s in all_symbols]
    for name in names:
        if name.upper() == requested:
            return name

    # Prefer candidates that start with the requested base symbol.
    starts = [n for n in names if n.upper().startswith(requested)]
    if starts:
        return starts[0]

    # For metals or broker naming differences, use partial match as fallback.
    contains = [n for n in names if requested in n.upper()]
    if contains:
        return contains[0]

    # Special fallback if XAUUSD is unavailable.
    if requested == "XAUUSD":
        xau = [n for n in names if "XAU" in n.upper()]
        if xau:
            return xau[0]

    return None


def get_rates(symbol: str, days: int) -> Optional[pd.DataFrame]:
    timeframe = TIMEFRAME_MAP.get(CONFIG.timeframe_minutes)
    if timeframe is None:
        return None

    bars_per_day = int((24 * 60) / CONFIG.timeframe_minutes)
    bars_to_fetch = max(300, days * bars_per_day + 500)

    # MT5 can reject very large count values, so request history in chunks.
    chunk_size = 5000
    start_pos = 0
    chunks = []
    while start_pos < bars_to_fetch:
        count = min(chunk_size, bars_to_fetch - start_pos)
        rates_chunk = mt5.copy_rates_from_pos(symbol, timeframe, start_pos, count)
        if rates_chunk is None or len(rates_chunk) == 0:
            break
        chunks.append(pd.DataFrame(rates_chunk))
        start_pos += count

    if not chunks:
        return None

    df = pd.concat(chunks, ignore_index=True)
    df = df.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)
    if len(df) < 300:
        return None

    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    return df


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["ema_fast"] = out["close"].ewm(span=CONFIG.ema_fast_period, adjust=False).mean()
    out["ema_slow"] = out["close"].ewm(span=CONFIG.ema_slow_period, adjust=False).mean()

    high_low = out["high"] - out["low"]
    high_prev_close = (out["high"] - out["close"].shift(1)).abs()
    low_prev_close = (out["low"] - out["close"].shift(1)).abs()
    tr = np.maximum(high_low, np.maximum(high_prev_close, low_prev_close))
    out["atr"] = pd.Series(tr).rolling(CONFIG.atr_period).mean()
    return out


def trend_signal_with_quality(frame: pd.DataFrame, i: int, symbol: str = "") -> Optional[tuple[str, float]]:
    if i < 3:
        return None

    last = frame.iloc[i]
    prev1 = frame.iloc[i - 1]
    prev2 = frame.iloc[i - 2]

    bullish = (
        last["ema_fast"] > last["ema_slow"]
        and prev1["ema_fast"] > prev1["ema_slow"]
        and prev1["ema_fast"] > prev2["ema_fast"]
        and prev1["ema_slow"] >= prev2["ema_slow"]
    )
    bearish = (
        last["ema_fast"] < last["ema_slow"]
        and prev1["ema_fast"] < prev1["ema_slow"]
        and prev1["ema_fast"] < prev2["ema_fast"]
        and prev1["ema_slow"] <= prev2["ema_slow"]
    )

    atr_value = float(last["atr"]) if not pd.isna(last["atr"]) else 0.0
    if atr_value <= 0:
        return None

    ema_distance = abs(float(last["ema_fast"]) - float(last["ema_slow"]))
    ema_distance_atr = ema_distance / atr_value
    if ema_distance_atr < CONFIG.min_ema_distance_atr:
        return None

    breakout_buffer = atr_value * CONFIG.breakout_atr_buffer

    side: Optional[str] = None
    breakout_strength_atr = 0.0
    if bullish and last["close"] > (prev1["high"] + breakout_buffer):
        side = "buy"
        breakout_strength_atr = (float(last["close"]) - float(prev1["high"])) / atr_value
    elif bearish and last["close"] < (prev1["low"] - breakout_buffer):
        side = "sell"
        breakout_strength_atr = (float(prev1["low"]) - float(last["close"])) / atr_value
    else:
        return None

    # Multi-factor confluence score used to rank candidates across symbols.
    fast_slope_atr = abs(float(prev1["ema_fast"]) - float(prev2["ema_fast"])) / atr_value
    slow_slope_atr = abs(float(prev1["ema_slow"]) - float(prev2["ema_slow"])) / atr_value
    candle_body_atr = abs(float(last["close"]) - float(last["open"])) / atr_value

    score = (
        min(ema_distance_atr * 1.2, 2.5)
        + min(breakout_strength_atr * 1.4, 2.5)
        + min(fast_slope_atr * 8.0, 1.5)
        + min(slow_slope_atr * 8.0, 1.0)
        + min(candle_body_atr * 1.5, 1.5)
    )

    symbol_offset = CONFIG.quality_score_offset_by_symbol.get(symbol.upper(), 0.0)
    min_required = CONFIG.min_quality_score + symbol_offset
    if score < min_required:
        return None

    return side, float(score)


def trend_signal(frame: pd.DataFrame, i: int) -> Optional[str]:
    setup = trend_signal_with_quality(frame, i, "")
    if setup is None:
        return None
    side, _ = setup
    return side


def normalize_volume(symbol: str, requested: float) -> float:
    info = mt5.symbol_info(symbol)
    if info is None:
        return requested
    volume = max(info.volume_min, min(requested, info.volume_max))
    steps = round((volume - info.volume_min) / info.volume_step)
    normalized = info.volume_min + steps * info.volume_step
    return round(normalized, 2)


def dynamic_lot(
    symbol: str,
    equity: float,
    entry: float,
    sl: float,
    baseline_equity: Optional[float] = None,
) -> float:
    fallback = CONFIG.fixed_lot_by_symbol.get(symbol, 0.01)
    if not CONFIG.use_dynamic_risk_sizing:
        return normalize_volume(symbol, fallback)

    info = mt5.symbol_info(symbol)
    if info is None:
        return normalize_volume(symbol, fallback)

    tick_size = float(info.trade_tick_size) if info.trade_tick_size > 0 else float(info.point)
    tick_value = abs(float(info.trade_tick_value))
    stop_distance = abs(entry - sl)
    if tick_size <= 0 or tick_value <= 0 or stop_distance <= 0:
        return normalize_volume(symbol, fallback)

    baseline = float(baseline_equity) if baseline_equity and baseline_equity > 0 else float(equity)
    effective_risk_pct = scaled_risk_pct(float(equity), baseline)
    risk_money = equity * (effective_risk_pct / 100.0)
    loss_per_lot = (stop_distance / tick_size) * tick_value
    if loss_per_lot <= 0 or risk_money <= 0:
        return normalize_volume(symbol, fallback)

    return normalize_volume(symbol, risk_money / loss_per_lot)


def pnl_money(symbol: str, side: str, entry: float, exit_price: float, lot: float) -> float:
    info = mt5.symbol_info(symbol)
    if info is None:
        return 0.0
    tick_size = float(info.trade_tick_size) if info.trade_tick_size > 0 else float(info.point)
    tick_value = abs(float(info.trade_tick_value))
    if tick_size <= 0 or tick_value <= 0:
        return 0.0

    diff = (exit_price - entry) if side == "buy" else (entry - exit_price)
    return (diff / tick_size) * tick_value * lot


def apply_position_management(pos: PositionState, bar: pd.Series, point: float) -> None:
    high = float(bar["high"])
    low = float(bar["low"])
    current = float(bar["close"])

    is_buy = pos.side == "buy"
    profit_points = (current - pos.entry) / point if is_buy else (pos.entry - current) / point

    if profit_points >= CONFIG.breakeven_trigger_points:
        be = (
            pos.entry + CONFIG.breakeven_lock_points * point
            if is_buy
            else pos.entry - CONFIG.breakeven_lock_points * point
        )
        if is_buy:
            pos.sl = max(pos.sl, be)
        else:
            pos.sl = min(pos.sl, be)

    if profit_points >= CONFIG.trailing_start_points:
        trail = (
            current - CONFIG.trailing_distance_points * point
            if is_buy
            else current + CONFIG.trailing_distance_points * point
        )
        if is_buy:
            pos.sl = max(pos.sl, trail)
        else:
            pos.sl = min(pos.sl, trail)

    _ = high
    _ = low


def run_symbol_backtest(
    symbol: str,
    days: int,
    events: List[Dict[str, object]],
    initial_equity: float,
) -> Dict[str, object]:
    actual_symbol = symbol
    if CONFIG.strict_symbol_names:
        info = mt5.symbol_info(symbol)
        if info is None:
            return {"symbol": symbol, "error": "symbol_not_found_exact"}
    else:
        actual_symbol = resolve_symbol(symbol)
        if actual_symbol is None:
            return {"symbol": symbol, "error": "symbol_not_found"}

        if actual_symbol != symbol:
            log(f"Symbol alias: requested={symbol} actual={actual_symbol}")

    if not mt5.symbol_select(actual_symbol, True):
        return {"symbol": symbol, "error": "symbol_select_failed"}

    info = mt5.symbol_info(actual_symbol)
    if info is None:
        return {"symbol": symbol, "error": "symbol_info_missing"}

    frame = get_rates(actual_symbol, days)
    if frame is None:
        return {"symbol": symbol, "error": "no_rates"}

    frame = compute_indicators(frame)
    trades: List[Trade] = []
    position: Optional[PositionState] = None
    equity = initial_equity
    max_equity = initial_equity
    max_drawdown = 0.0

    day_key = None
    day_start_equity = initial_equity
    halted_today = False

    for i in range(3, len(frame) - 1):
        row = frame.iloc[i]
        nxt = frame.iloc[i + 1]

        now = row["time"].to_pydatetime()
        now_day = now.date()
        if day_key != now_day:
            day_key = now_day
            day_start_equity = equity
            halted_today = False

        if CONFIG.use_daily_loss_limit and not halted_today:
            max_loss = (
                CONFIG.daily_loss_limit_amount
                if CONFIG.daily_loss_limit_amount > 0
                else day_start_equity * (CONFIG.daily_loss_limit_pct / 100.0)
            )
            if (day_start_equity - equity) >= max_loss > 0:
                halted_today = True

        if position is not None:
            apply_position_management(position, row, info.point)

            # Conservative fill assumption: if SL and TP both touched in same bar, SL is hit first.
            if position.side == "buy":
                sl_hit = float(nxt["low"]) <= position.sl
                tp_hit = float(nxt["high"]) >= position.tp
                if sl_hit:
                    exit_price = position.sl
                    reason = "sl"
                elif tp_hit:
                    exit_price = position.tp
                    reason = "tp"
                else:
                    exit_price = None
                    reason = ""
            else:
                sl_hit = float(nxt["high"]) >= position.sl
                tp_hit = float(nxt["low"]) <= position.tp
                if sl_hit:
                    exit_price = position.sl
                    reason = "sl"
                elif tp_hit:
                    exit_price = position.tp
                    reason = "tp"
                else:
                    exit_price = None
                    reason = ""

            if exit_price is not None:
                pnl = pnl_money(actual_symbol, position.side, position.entry, exit_price, position.lot)
                equity += pnl
                trades.append(
                    Trade(
                        symbol=symbol,
                        side=position.side,
                        entry_time=position.entry_time,
                        exit_time=nxt["time"].to_pydatetime(),
                        entry=position.entry,
                        exit=exit_price,
                        sl=position.sl,
                        tp=position.tp,
                        lot=position.lot,
                        pnl=pnl,
                        reason=reason,
                    )
                )
                position = None

                max_equity = max(max_equity, equity)
                dd = (max_equity - equity) / max_equity if max_equity > 0 else 0.0
                max_drawdown = max(max_drawdown, dd)

        if position is not None or halted_today:
            continue

        if not session_is_open(now):
            continue

        if is_news_blocked(symbol, now, events):
            continue

        signal = trend_signal(frame, i)
        if signal is None:
            continue

        atr = float(row["atr"]) if not pd.isna(row["atr"]) else math.nan
        if not np.isfinite(atr) or atr <= 0:
            continue

        entry = float(nxt["open"])
        stop_distance = atr * CONFIG.stop_atr_multiplier
        tp_distance = stop_distance * CONFIG.takeprofit_rr

        if signal == "buy":
            sl = entry - stop_distance
            tp = entry + tp_distance
        else:
            sl = entry + stop_distance
            tp = entry - tp_distance

        lot = dynamic_lot(actual_symbol, equity, entry, sl, baseline_equity=initial_equity)
        if lot <= 0:
            continue

        position = PositionState(
            symbol=actual_symbol,
            side=signal,
            entry_time=nxt["time"].to_pydatetime(),
            entry=entry,
            sl=sl,
            tp=tp,
            lot=lot,
        )

    # Close any remaining position at final close.
    if position is not None:
        last_row = frame.iloc[-1]
        last_close = float(last_row["close"])
        pnl = pnl_money(actual_symbol, position.side, position.entry, last_close, position.lot)
        equity += pnl
        trades.append(
            Trade(
                symbol=symbol,
                side=position.side,
                entry_time=position.entry_time,
                exit_time=last_row["time"].to_pydatetime(),
                entry=position.entry,
                exit=last_close,
                sl=position.sl,
                tp=position.tp,
                lot=position.lot,
                pnl=pnl,
                reason="eod",
            )
        )

    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl < 0]
    gross_profit = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else float("inf")

    return {
        "symbol": symbol,
        "trades": trades,
        "start_equity": initial_equity,
        "end_equity": equity,
        "net_profit": equity - initial_equity,
        "trade_count": len(trades),
        "win_rate": (len(wins) / len(trades) * 100.0) if trades else 0.0,
        "profit_factor": profit_factor,
        "max_drawdown_pct": max_drawdown * 100.0,
    }


def write_reports(results: List[Dict[str, object]], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    trade_rows: List[Dict[str, object]] = []
    summary_rows: List[Dict[str, object]] = []

    for r in results:
        if "error" in r:
            summary_rows.append({"symbol": r["symbol"], "error": r["error"]})
            continue

        summary_rows.append(
            {
                "symbol": r["symbol"],
                "start_equity": r["start_equity"],
                "end_equity": r["end_equity"],
                "net_profit": r["net_profit"],
                "trade_count": r["trade_count"],
                "win_rate": round(float(r["win_rate"]), 2),
                "profit_factor": round(float(r["profit_factor"]), 3)
                if np.isfinite(float(r["profit_factor"]))
                else "inf",
                "max_drawdown_pct": round(float(r["max_drawdown_pct"]), 2),
            }
        )

        for t in r["trades"]:
            trade_rows.append(
                {
                    "symbol": t.symbol,
                    "side": t.side,
                    "entry_time": t.entry_time.isoformat(),
                    "exit_time": t.exit_time.isoformat(),
                    "entry": t.entry,
                    "exit": t.exit,
                    "sl": t.sl,
                    "tp": t.tp,
                    "lot": t.lot,
                    "pnl": t.pnl,
                    "reason": t.reason,
                }
            )

    pd.DataFrame(summary_rows).to_csv(output_dir / "summary.csv", index=False)
    pd.DataFrame(trade_rows).to_csv(output_dir / "trades.csv", index=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Deep backtest for MT5 M5 trend scalper")
    parser.add_argument("--days", type=int, default=180, help="History depth in days")
    parser.add_argument("--initial-equity", type=float, default=200.0)
    parser.add_argument("--symbols", type=str, default=",".join(CONFIG.symbols))
    parser.add_argument("--output", type=str, default="backtest_results")
    args = parser.parse_args()

    if not initialize_mt5():
        return

    try:
        events = load_news_events()
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]

        results: List[Dict[str, object]] = []
        for symbol in symbols:
            log(f"Backtesting {symbol} for {args.days} days...")
            res = run_symbol_backtest(
                symbol=symbol,
                days=args.days,
                events=events,
                initial_equity=args.initial_equity,
            )
            results.append(res)

        write_reports(results, Path(args.output))

        log("Backtest completed.")
        for r in results:
            if "error" in r:
                log(f"{r['symbol']}: ERROR={r['error']}")
                continue
            log(
                f"{r['symbol']} trades={r['trade_count']} net={r['net_profit']:.2f} "
                f"win_rate={r['win_rate']:.2f}% pf={r['profit_factor']:.2f} "
                f"max_dd={r['max_drawdown_pct']:.2f}%"
            )

    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
