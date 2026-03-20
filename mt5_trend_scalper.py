import time
import json
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from urllib import request
from urllib.error import URLError, HTTPError

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

RUNTIME_STATE: Dict[str, object] = {
    "day": None,
    "start_balance": None,
    "initial_balance": None,
    "halted": False,
    "halt_reason": "",
    "last_halt_log": None,
    "today_opened_trades": 0,
    "today_consecutive_losses": 0,
    "mt5_failure_streak": 0,
    "stale_data_streak": 0,
    "unhandled_error_streak": 0,
}

NEWS_CACHE: Dict[str, object] = {
    "last_load_at": None,
    "mtime": None,
    "events": [],
}


@dataclass
class EntryCandidate:
    symbol: str
    side: str
    score: float
    lot: float
    sl: float
    tp: float


def log(message: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {message}"
    print(line)
    try:
        with open(CONFIG.bot_log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def append_event(event_type: str, symbol: str, details: str) -> None:
    file_path = Path(CONFIG.bot_events_file)
    write_header = not file_path.exists()
    ts = datetime.now(timezone.utc).isoformat()
    row = f'{ts},{event_type},{symbol},"{details.replace("\"", "'")}"\n'
    try:
        with open(file_path, "a", encoding="utf-8") as f:
            if write_header:
                f.write("timestamp_utc,event_type,symbol,details\n")
            f.write(row)
    except Exception:
        pass


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
    clean = symbol.upper()
    tokens = {clean}
    if "GOLD" in clean:
        tokens.add("XAU")
        tokens.add("GOLD")
    if clean.startswith("XAU"):
        tokens.add("XAU")
        tokens.add("GOLD")
    if len(clean) >= 6:
        tokens.add(clean[:3])
        tokens.add(clean[3:6])
    return list(tokens)


def load_news_events(now_utc: datetime) -> List[Dict[str, object]]:
    # Reload at most once per minute unless file mtime changes.
    file_path = Path(CONFIG.news_events_file)
    if not file_path.exists():
        return []

    mtime = file_path.stat().st_mtime
    last_load_at = NEWS_CACHE.get("last_load_at")
    if (
        NEWS_CACHE.get("mtime") == mtime
        and isinstance(last_load_at, datetime)
        and (now_utc - last_load_at) < timedelta(minutes=1)
    ):
        return NEWS_CACHE.get("events", [])  # type: ignore[return-value]

    try:
        raw = pd.read_csv(file_path)
    except Exception as ex:
        log(f"News file read error: {ex}")
        return []

    events: List[Dict[str, object]] = []
    for _, row in raw.iterrows():
        try:
            ts = pd.to_datetime(str(row.get("timestamp_utc", "")), utc=True)
            if pd.isna(ts):
                continue
            impact = str(row.get("impact", "high")).strip().lower()
            symbols_str = str(row.get("symbols", "ALL"))
            symbols = {s.strip().upper() for s in symbols_str.split("|") if s.strip()}
            title = str(row.get("title", "event"))
            events.append(
                {
                    "time": ts.to_pydatetime(),
                    "impact": impact,
                    "symbols": symbols,
                    "title": title,
                }
            )
        except Exception:
            continue

    NEWS_CACHE["last_load_at"] = now_utc
    NEWS_CACHE["mtime"] = mtime
    NEWS_CACHE["events"] = events
    return events


def news_blocks_symbol(event_symbols: set, trade_symbol: str) -> bool:
    if "ALL" in event_symbols:
        return True
    tokens = set(symbol_tokens(trade_symbol))
    return trade_symbol.upper() in event_symbols or len(tokens.intersection(event_symbols)) > 0


def is_news_blocked(symbol: str, now_utc: datetime) -> bool:
    if not CONFIG.use_news_filter:
        return False

    events = load_news_events(now_utc)
    for event in events:
        impact = event["impact"]
        if CONFIG.news_only_high_impact and impact != "high":
            continue

        event_time = event["time"]
        if not isinstance(event_time, datetime):
            continue

        minutes_to_event = (event_time - now_utc).total_seconds() / 60.0
        in_block_window = (
            -CONFIG.news_block_after_minutes
            <= minutes_to_event
            <= CONFIG.news_block_before_minutes
        )
        if not in_block_window:
            continue

        event_symbols = event["symbols"]
        if isinstance(event_symbols, set) and news_blocks_symbol(event_symbols, symbol):
            title = event.get("title", "event")
            log(f"{symbol} blocked by news window: {title}")
            return True

    return False


def initialize_mt5() -> bool:
    if not CONFIG.dry_run and CONFIG.mt5_login <= 0:
        log("Live mode requested without MT5_LOGIN. Using current MT5 terminal session.")

    init_kwargs = {}
    if CONFIG.mt5_path:
        init_kwargs["path"] = CONFIG.mt5_path

    if not mt5.initialize(**init_kwargs):
        log(f"MT5 initialize failed: {mt5.last_error()}")
        return False

    if CONFIG.mt5_login > 0 and CONFIG.mt5_password and CONFIG.mt5_server:
        authorized = mt5.login(
            login=CONFIG.mt5_login,
            password=CONFIG.mt5_password,
            server=CONFIG.mt5_server,
        )
        if not authorized:
            log(f"MT5 login failed: {mt5.last_error()}")
            return False
    elif CONFIG.mt5_login > 0:
        log("MT5_LOGIN set but password/server missing. Using current MT5 terminal session.")

    account = mt5.account_info()
    if account is None:
        log("Could not read account info.")
        return False

    log(
        "Connected to MT5 | "
        f"Login={account.login} | Server={account.server} | Balance={account.balance}"
    )
    log(f"DRY_RUN={CONFIG.dry_run}")
    if RUNTIME_STATE.get("initial_balance") is None:
        RUNTIME_STATE["initial_balance"] = float(account.balance)

    if CONFIG.strict_symbol_names:
        missing_symbols = [s for s in CONFIG.symbols if mt5.symbol_info(s) is None]
        if missing_symbols:
            log(
                "Strict symbol mode is ON. Missing exact symbols: "
                + ", ".join(missing_symbols)
            )
            log("Bot stopped. Update CONFIG.symbols to exact broker symbol names.")
            return False

    return True


def refresh_daily_state(now_utc: datetime) -> None:
    current_day = now_utc.date()
    if RUNTIME_STATE["day"] == current_day:
        return

    account = mt5.account_info()
    start_balance = account.balance if account is not None else 0.0
    RUNTIME_STATE["day"] = current_day
    RUNTIME_STATE["start_balance"] = float(start_balance)
    RUNTIME_STATE["halted"] = False
    RUNTIME_STATE["halt_reason"] = ""
    RUNTIME_STATE["last_halt_log"] = None
    RUNTIME_STATE["today_opened_trades"] = 0
    RUNTIME_STATE["today_consecutive_losses"] = 0
    log(f"Daily state reset. day={current_day} start_balance={start_balance}")


def halt_trading(reason: str, symbol: str = "ALL") -> None:
    if bool(RUNTIME_STATE.get("halted")):
        return
    RUNTIME_STATE["halted"] = True
    RUNTIME_STATE["halt_reason"] = reason
    log(reason)
    append_event("trading_halted", symbol, reason)


def get_today_trade_stats(now_utc: datetime) -> Dict[str, float]:
    day_start = datetime(
        year=now_utc.year,
        month=now_utc.month,
        day=now_utc.day,
        tzinfo=timezone.utc,
    )
    deals = mt5.history_deals_get(day_start, now_utc)
    if deals is None:
        return {
            "entries": 0.0,
            "closed": 0.0,
            "current_consecutive_losses": 0.0,
        }

    entries = 0
    closed = []
    for d in sorted(deals, key=lambda x: x.time):
        if d.magic != CONFIG.magic_number:
            continue
        if d.entry == mt5.DEAL_ENTRY_IN:
            entries += 1
            continue
        if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
            pnl = float(d.profit) + float(d.swap) + float(d.commission)
            closed.append(pnl)

    current_consecutive_losses = 0
    for pnl in reversed(closed):
        if pnl < 0:
            current_consecutive_losses += 1
        else:
            break

    return {
        "entries": float(entries),
        "closed": float(len(closed)),
        "current_consecutive_losses": float(current_consecutive_losses),
    }


def update_activity_guards(now_utc: datetime) -> None:
    refresh_daily_state(now_utc)
    if bool(RUNTIME_STATE.get("halted")):
        return

    stats = get_today_trade_stats(now_utc)
    opened = int(stats["entries"])
    consecutive_losses = int(stats["current_consecutive_losses"])
    RUNTIME_STATE["today_opened_trades"] = opened
    RUNTIME_STATE["today_consecutive_losses"] = consecutive_losses

    if CONFIG.max_new_trades_per_day > 0 and opened >= CONFIG.max_new_trades_per_day:
        halt_trading(
            f"Daily trade cap reached. opened={opened}, cap={CONFIG.max_new_trades_per_day}",
            "ALL",
        )
        return

    if CONFIG.max_consecutive_losses > 0 and consecutive_losses >= CONFIG.max_consecutive_losses:
        halt_trading(
            (
                "Consecutive loss cap reached. "
                f"loss_streak={consecutive_losses}, cap={CONFIG.max_consecutive_losses}"
            ),
            "ALL",
        )


def connection_is_healthy() -> bool:
    terminal = mt5.terminal_info()
    account = mt5.account_info()
    if terminal is None or account is None:
        return False
    if CONFIG.require_market_connection and not bool(getattr(terminal, "connected", True)):
        return False
    if CONFIG.require_terminal_trade_allowed and not bool(getattr(terminal, "trade_allowed", True)):
        return False
    return True


def get_today_realized_pnl(now_utc: datetime) -> float:
    day_start = datetime(
        year=now_utc.year,
        month=now_utc.month,
        day=now_utc.day,
        tzinfo=timezone.utc,
    )
    deals = mt5.history_deals_get(day_start, now_utc)
    if deals is None:
        return 0.0

    exit_entries = {mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY}
    pnl = 0.0
    for d in deals:
        if d.magic != CONFIG.magic_number:
            continue
        if d.entry not in exit_entries:
            continue
        pnl += float(d.profit) + float(d.swap) + float(d.commission)
    return pnl


def update_daily_loss_guard(now_utc: datetime) -> None:
    if not CONFIG.use_daily_loss_limit:
        return

    refresh_daily_state(now_utc)
    if RUNTIME_STATE["halted"]:
        return

    start_balance = float(RUNTIME_STATE.get("start_balance") or 0.0)
    if CONFIG.daily_loss_limit_amount > 0:
        max_loss = CONFIG.daily_loss_limit_amount
    else:
        max_loss = start_balance * (CONFIG.daily_loss_limit_pct / 100.0)

    if max_loss <= 0:
        return

    realized_pnl = get_today_realized_pnl(now_utc)
    if realized_pnl <= -max_loss:
        RUNTIME_STATE["halted"] = True
        RUNTIME_STATE["halt_reason"] = (
            f"Daily loss limit reached. pnl={realized_pnl:.2f}, limit={max_loss:.2f}"
        )
        log(str(RUNTIME_STATE["halt_reason"]))


def ensure_symbol(symbol: str) -> bool:
    info = mt5.symbol_info(symbol)
    if info is None:
        log(f"Symbol not found: {symbol}")
        return False
    if not info.visible:
        selected = mt5.symbol_select(symbol, True)
        if not selected:
            log(f"Could not enable symbol in Market Watch: {symbol}")
            return False
    return True


def get_rates_df(symbol: str) -> Optional[pd.DataFrame]:
    timeframe = TIMEFRAME_MAP.get(CONFIG.timeframe_minutes)
    if timeframe is None:
        log(f"Unsupported timeframe_minutes={CONFIG.timeframe_minutes}")
        return None

    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, CONFIG.bars_to_fetch)
    if rates is None or len(rates) < max(CONFIG.ema_slow_period + 10, 100):
        return None

    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)

    last_bar_time = df.iloc[-1]["time"]
    if pd.isna(last_bar_time):
        return None

    age_minutes = (utc_now() - pd.Timestamp(last_bar_time).to_pydatetime()).total_seconds() / 60.0
    if age_minutes > CONFIG.max_data_staleness_minutes:
        log(
            f"{symbol}: stale data detected. bar_age={age_minutes:.1f}m max={CONFIG.max_data_staleness_minutes}m"
        )
        append_event("stale_data", symbol, f"bar_age_minutes={age_minutes:.1f}")
        return None

    return df


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["ema_fast"] = out["close"].ewm(span=CONFIG.ema_fast_period, adjust=False).mean()
    out["ema_slow"] = out["close"].ewm(span=CONFIG.ema_slow_period, adjust=False).mean()

    high_low = out["high"] - out["low"]
    high_prev_close = (out["high"] - out["close"].shift(1)).abs()
    low_prev_close = (out["low"] - out["close"].shift(1)).abs()
    true_range = np.maximum(high_low, np.maximum(high_prev_close, low_prev_close))
    out["atr"] = pd.Series(true_range).rolling(CONFIG.atr_period).mean()

    return out


def trend_signal_with_quality(ind_df: pd.DataFrame, symbol: str) -> Optional[Tuple[str, float]]:
    if len(ind_df) < 5:
        return None

    last = ind_df.iloc[-1]
    prev1 = ind_df.iloc[-2]
    prev2 = ind_df.iloc[-3]

    bullish_trend = (
        last["ema_fast"] > last["ema_slow"]
        and prev1["ema_fast"] > prev1["ema_slow"]
        and prev1["ema_fast"] > prev2["ema_fast"]
        and prev1["ema_slow"] >= prev2["ema_slow"]
    )
    bearish_trend = (
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
    if bullish_trend and last["close"] > (prev1["high"] + breakout_buffer):
        side = "buy"
        breakout_strength_atr = (float(last["close"]) - float(prev1["high"])) / atr_value
    elif bearish_trend and last["close"] < (prev1["low"] - breakout_buffer):
        side = "sell"
        breakout_strength_atr = (float(prev1["low"]) - float(last["close"])) / atr_value
    else:
        return None

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


def trend_signal(ind_df: pd.DataFrame) -> Optional[str]:
    setup = trend_signal_with_quality(ind_df, "")
    if setup is None:
        return None
    side, _ = setup
    return side


def spread_is_ok(symbol: str) -> bool:
    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)
    if tick is None or info is None:
        return False

    spread_points = int((tick.ask - tick.bid) / info.point)
    max_spread = CONFIG.max_spread_points_by_symbol.get(symbol, 100)
    if spread_points > max_spread:
        log(f"{symbol} spread too high: {spread_points} points (max {max_spread})")
        return False
    return True


def symbol_has_open_position(symbol: str) -> bool:
    positions = mt5.positions_get(symbol=symbol)
    if positions is None:
        return False

    for p in positions:
        if p.magic == CONFIG.magic_number:
            return True
    return False


def count_bot_positions() -> int:
    positions = mt5.positions_get()
    if positions is None:
        return 0
    return sum(1 for p in positions if p.magic == CONFIG.magic_number)


def normalize_volume(symbol: str, requested_lot: float) -> float:
    info = mt5.symbol_info(symbol)
    if info is None:
        return requested_lot

    volume = max(info.volume_min, min(requested_lot, info.volume_max))
    steps = round((volume - info.volume_min) / info.volume_step)
    normalized = info.volume_min + steps * info.volume_step
    return round(normalized, 2)


def get_dynamic_lot(symbol: str, entry: float, sl: float) -> float:
    if not CONFIG.use_dynamic_risk_sizing:
        return normalize_volume(symbol, CONFIG.fixed_lot_by_symbol.get(symbol, 0.01))

    info = mt5.symbol_info(symbol)
    account = mt5.account_info()
    if info is None or account is None:
        return normalize_volume(symbol, CONFIG.fixed_lot_by_symbol.get(symbol, 0.01))

    stop_distance = abs(entry - sl)
    if stop_distance <= 0:
        return normalize_volume(symbol, CONFIG.fixed_lot_by_symbol.get(symbol, 0.01))

    tick_size = float(info.trade_tick_size) if info.trade_tick_size > 0 else float(info.point)
    tick_value = abs(float(info.trade_tick_value))
    if tick_size <= 0 or tick_value <= 0:
        return normalize_volume(symbol, CONFIG.fixed_lot_by_symbol.get(symbol, 0.01))

    loss_per_lot = (stop_distance / tick_size) * tick_value
    if loss_per_lot <= 0:
        return normalize_volume(symbol, CONFIG.fixed_lot_by_symbol.get(symbol, 0.01))

    baseline_equity = float(RUNTIME_STATE.get("initial_balance") or account.balance or account.equity)
    effective_risk_pct = scaled_risk_pct(float(account.equity), baseline_equity)
    risk_money = float(account.equity) * (effective_risk_pct / 100.0)
    if risk_money <= 0:
        return normalize_volume(symbol, CONFIG.fixed_lot_by_symbol.get(symbol, 0.01))

    raw_lot = risk_money / loss_per_lot
    return normalize_volume(symbol, raw_lot)


def build_order_prices(symbol: str, side: str, atr_value: float) -> Optional[Tuple[float, float, float]]:
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None

    entry = tick.ask if side == "buy" else tick.bid
    stop_distance = atr_value * CONFIG.stop_atr_multiplier
    tp_distance = stop_distance * CONFIG.takeprofit_rr

    if side == "buy":
        sl = entry - stop_distance
        tp = entry + tp_distance
    else:
        sl = entry + stop_distance
        tp = entry - tp_distance

    return entry, sl, tp


def send_market_order(symbol: str, side: str, lot: float, sl: float, tp: float, score: float = 0.0) -> None:
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return

    price = tick.ask if side == "buy" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": order_type,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": CONFIG.slippage_points,
        "magic": CONFIG.magic_number,
        "comment": "m5_trend_scalper",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    log(
        f"ORDER {symbol} {side.upper()} lot={lot} price={price:.5f} "
        f"sl={sl:.5f} tp={tp:.5f} score={score:.2f}"
    )

    if CONFIG.dry_run:
        log("DRY_RUN: order not sent")
        append_event(
            "order_dry_run",
            symbol,
            f"side={side} lot={lot} sl={sl:.5f} tp={tp:.5f} score={score:.2f}",
        )
        return

    result = mt5.order_send(request)
    if result is None:
        log(f"order_send failed: {mt5.last_error()}")
        append_event("order_error", symbol, f"side={side} lot={lot} result=None")
        return

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"order_send retcode={result.retcode} comment={result.comment}")
        append_event(
            "order_rejected",
            symbol,
            f"side={side} lot={lot} score={score:.2f} retcode={result.retcode} comment={result.comment}",
        )
        return

    log(f"Order placed successfully. ticket={result.order}")
    append_event("order_filled", symbol, f"side={side} lot={lot} score={score:.2f} ticket={result.order}")


def update_position_sl(position, new_sl: float) -> bool:
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": position.ticket,
        "symbol": position.symbol,
        "sl": new_sl,
        "tp": position.tp,
        "magic": CONFIG.magic_number,
        "comment": "m5_manage",
    }

    if CONFIG.dry_run:
        log(f"DRY_RUN: would modify SL ticket={position.ticket} -> {new_sl:.5f}")
        append_event("sl_modify_dry_run", position.symbol, f"ticket={position.ticket} sl={new_sl:.5f}")
        return True

    result = mt5.order_send(request)
    if result is None:
        log(f"SL modify failed (None): {mt5.last_error()}")
        append_event("sl_modify_error", position.symbol, f"ticket={position.ticket} sl={new_sl:.5f}")
        return False

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"SL modify retcode={result.retcode} comment={result.comment}")
        append_event(
            "sl_modify_rejected",
            position.symbol,
            f"ticket={position.ticket} retcode={result.retcode} comment={result.comment}",
        )
        return False

    log(f"SL updated ticket={position.ticket} -> {new_sl:.5f}")
    append_event("sl_modified", position.symbol, f"ticket={position.ticket} sl={new_sl:.5f}")
    return True


def write_status_snapshot(now_utc: datetime) -> None:
    positions = mt5.positions_get()
    bot_positions = []
    if positions is not None:
        for p in positions:
            if p.magic != CONFIG.magic_number:
                continue
            bot_positions.append(
                {
                    "ticket": int(p.ticket),
                    "symbol": p.symbol,
                    "type": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
                    "volume": float(p.volume),
                    "price_open": float(p.price_open),
                    "sl": float(p.sl),
                    "tp": float(p.tp),
                    "profit": float(p.profit),
                }
            )

    account = mt5.account_info()
    status = {
        "timestamp_utc": now_utc.isoformat(),
        "halted": bool(RUNTIME_STATE.get("halted")),
        "halt_reason": str(RUNTIME_STATE.get("halt_reason") or ""),
        "guard_state": {
            "today_opened_trades": int(RUNTIME_STATE.get("today_opened_trades") or 0),
            "today_consecutive_losses": int(RUNTIME_STATE.get("today_consecutive_losses") or 0),
            "mt5_failure_streak": int(RUNTIME_STATE.get("mt5_failure_streak") or 0),
            "stale_data_streak": int(RUNTIME_STATE.get("stale_data_streak") or 0),
            "unhandled_error_streak": int(RUNTIME_STATE.get("unhandled_error_streak") or 0),
        },
        "dry_run": CONFIG.dry_run,
        "magic_number": CONFIG.magic_number,
        "symbols": CONFIG.symbols,
        "strict_symbol_names": CONFIG.strict_symbol_names,
        "account": {
            "login": int(account.login) if account is not None else 0,
            "server": str(account.server) if account is not None else "",
            "balance": float(account.balance) if account is not None else 0.0,
            "equity": float(account.equity) if account is not None else 0.0,
            "margin_free": float(account.margin_free) if account is not None else 0.0,
        },
        "bot_positions": bot_positions,
    }

    try:
        Path(CONFIG.bot_status_file).write_text(
            json.dumps(status, indent=2),
            encoding="utf-8",
        )
    except Exception as ex:
        log(f"Status write error: {ex}")


def write_signal_snapshot(now_utc: datetime, signals: List[Dict[str, object]]) -> None:
    payload = {
        "timestamp_utc": now_utc.isoformat(),
        "halted": bool(RUNTIME_STATE.get("halted")),
        "halt_reason": str(RUNTIME_STATE.get("halt_reason") or ""),
        "signals": signals,
    }
    try:
        Path(CONFIG.bot_signals_file).write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
    except Exception as ex:
        log(f"Signal snapshot write error: {ex}")

    if not CONFIG.signals_webhook_enabled or not CONFIG.signals_webhook_url:
        return

    try:
        headers = {
            "Content-Type": "application/json",
        }
        if CONFIG.signals_webhook_token:
            headers["Authorization"] = f"Bearer {CONFIG.signals_webhook_token}"

        req = request.Request(
            CONFIG.signals_webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with request.urlopen(req, timeout=8) as resp:
            if getattr(resp, "status", 200) >= 400:
                log(f"Signal webhook HTTP error: status={resp.status}")
    except HTTPError as ex:
        log(f"Signal webhook HTTPError: code={ex.code}")
    except URLError as ex:
        log(f"Signal webhook URLError: {ex.reason}")
    except Exception as ex:
        log(f"Signal webhook send error: {ex}")


def manage_open_positions() -> None:
    positions = mt5.positions_get()
    if positions is None:
        return

    for p in positions:
        if p.magic != CONFIG.magic_number:
            continue

        info = mt5.symbol_info(p.symbol)
        tick = mt5.symbol_info_tick(p.symbol)
        if info is None or tick is None:
            continue

        is_buy = p.type == mt5.POSITION_TYPE_BUY
        point = info.point
        current_price = tick.bid if is_buy else tick.ask
        profit_points = (current_price - p.price_open) / point if is_buy else (p.price_open - current_price) / point

        # Breakeven: move SL to entry +/- lock points after threshold.
        if profit_points >= CONFIG.breakeven_trigger_points:
            be_price = p.price_open + CONFIG.breakeven_lock_points * point if is_buy else p.price_open - CONFIG.breakeven_lock_points * point
            should_move_be = (is_buy and (p.sl == 0 or p.sl < be_price)) or (not is_buy and (p.sl == 0 or p.sl > be_price))
            if should_move_be:
                update_position_sl(p, be_price)

        # Trailing stop: tighten SL behind current price in strong profit.
        if profit_points >= CONFIG.trailing_start_points:
            trail_price = current_price - CONFIG.trailing_distance_points * point if is_buy else current_price + CONFIG.trailing_distance_points * point
            should_trail = (is_buy and trail_price > p.sl) or (not is_buy and (p.sl == 0 or trail_price < p.sl))
            if should_trail:
                update_position_sl(p, trail_price)


def evaluate_symbol_candidate(symbol: str) -> Tuple[Optional[EntryCandidate], bool, Dict[str, object]]:
    now_utc = utc_now()
    signal_state: Dict[str, object] = {
        "symbol": symbol,
        "status": "wait",
        "side": "",
        "score": 0.0,
        "min_required_score": (
            CONFIG.min_quality_score
            + CONFIG.quality_score_offset_by_symbol.get(symbol.upper(), 0.0)
        ),
        "lot": 0.0,
        "reason": "no_setup",
    }

    if not session_is_open(now_utc):
        signal_state["status"] = "blocked"
        signal_state["reason"] = "session_closed"
        return None, False, signal_state

    if is_news_blocked(symbol, now_utc):
        signal_state["status"] = "blocked"
        signal_state["reason"] = "news_window"
        return None, False, signal_state

    if not ensure_symbol(symbol):
        signal_state["status"] = "error"
        signal_state["reason"] = "symbol_unavailable"
        return None, False, signal_state

    if symbol_has_open_position(symbol):
        signal_state["status"] = "blocked"
        signal_state["reason"] = "open_position_exists"
        return None, False, signal_state

    if not spread_is_ok(symbol):
        signal_state["status"] = "blocked"
        signal_state["reason"] = "spread_too_high"
        return None, False, signal_state

    df = get_rates_df(symbol)
    if df is None:
        log(f"{symbol}: not enough market data")
        signal_state["status"] = "wait"
        signal_state["reason"] = "no_fresh_data"
        return None, False, signal_state

    has_fresh_data = True

    ind = compute_indicators(df)
    setup = trend_signal_with_quality(ind, symbol)
    if setup is None:
        signal_state["status"] = "wait"
        signal_state["reason"] = "quality_or_breakout_not_met"
        return None, has_fresh_data, signal_state
    signal, score = setup
    signal_state["side"] = signal
    signal_state["score"] = float(score)

    atr = ind.iloc[-1]["atr"]
    if pd.isna(atr) or atr <= 0:
        signal_state["status"] = "wait"
        signal_state["reason"] = "invalid_atr"
        return None, has_fresh_data, signal_state

    prices = build_order_prices(symbol, signal, atr)
    if prices is None:
        signal_state["status"] = "wait"
        signal_state["reason"] = "price_build_failed"
        return None, has_fresh_data, signal_state

    entry, sl, tp = prices
    lot = get_dynamic_lot(symbol, entry, sl)
    if lot <= 0:
        signal_state["status"] = "wait"
        signal_state["reason"] = "invalid_lot"
        return None, has_fresh_data, signal_state

    signal_state["status"] = "signal"
    signal_state["lot"] = float(lot)
    signal_state["sl"] = float(sl)
    signal_state["tp"] = float(tp)
    signal_state["reason"] = "entry_ready"

    return (
        EntryCandidate(
            symbol=symbol,
            side=signal,
            score=float(score),
            lot=lot,
            sl=sl,
            tp=tp,
        ),
        has_fresh_data,
        signal_state,
    )


def run_loop() -> None:
    log("Bot loop started.")
    while True:
        try:
            now_utc = utc_now()
            if not connection_is_healthy():
                RUNTIME_STATE["mt5_failure_streak"] = int(RUNTIME_STATE.get("mt5_failure_streak") or 0) + 1
                streak = int(RUNTIME_STATE["mt5_failure_streak"])
                log(f"MT5 connection unhealthy. streak={streak}")
                append_event("connection_issue", "ALL", f"streak={streak}")
                if streak >= CONFIG.max_mt5_failures_before_halt:
                    halt_trading(
                        (
                            "MT5 connection watchdog triggered. "
                            f"failures={streak}, cap={CONFIG.max_mt5_failures_before_halt}"
                        ),
                        "ALL",
                    )
                time.sleep(CONFIG.loop_interval_seconds)
                continue

            RUNTIME_STATE["mt5_failure_streak"] = 0

            update_daily_loss_guard(now_utc)
            update_activity_guards(now_utc)

            manage_open_positions()

            if bool(RUNTIME_STATE.get("halted")):
                last_log = RUNTIME_STATE.get("last_halt_log")
                if not isinstance(last_log, datetime) or (now_utc - last_log) >= timedelta(minutes=5):
                    log(str(RUNTIME_STATE.get("halt_reason") or "Trading halted for the day."))
                    RUNTIME_STATE["last_halt_log"] = now_utc
                write_signal_snapshot(now_utc, [])
                write_status_snapshot(now_utc)
                time.sleep(CONFIG.loop_interval_seconds)
                continue

            had_fresh_data = False
            candidates: List[EntryCandidate] = []
            signal_rows: List[Dict[str, object]] = []
            for symbol in CONFIG.symbols:
                candidate, symbol_has_fresh_data, signal_state = evaluate_symbol_candidate(symbol)
                had_fresh_data = had_fresh_data or symbol_has_fresh_data
                signal_state["timestamp_utc"] = now_utc.isoformat()
                signal_rows.append(signal_state)
                if candidate is not None:
                    candidates.append(candidate)

            if candidates:
                candidates.sort(key=lambda c: c.score, reverse=True)
                open_positions = count_bot_positions()
                free_slots = max(0, CONFIG.max_positions_total - open_positions)
                max_cycle_entries = max(0, CONFIG.max_new_entries_per_cycle)
                to_open = min(free_slots, max_cycle_entries)
                for candidate in candidates[:to_open]:
                    if symbol_has_open_position(candidate.symbol):
                        continue
                    send_market_order(
                        candidate.symbol,
                        candidate.side,
                        candidate.lot,
                        candidate.sl,
                        candidate.tp,
                        candidate.score,
                    )

            if had_fresh_data:
                RUNTIME_STATE["stale_data_streak"] = 0
            else:
                RUNTIME_STATE["stale_data_streak"] = int(RUNTIME_STATE.get("stale_data_streak") or 0) + 1
                stale_streak = int(RUNTIME_STATE["stale_data_streak"])
                log(f"Data freshness watchdog: no fresh bars this cycle. streak={stale_streak}")
                if stale_streak >= CONFIG.max_stale_data_cycles_before_halt:
                    halt_trading(
                        (
                            "Data freshness watchdog triggered. "
                            f"stale_cycles={stale_streak}, cap={CONFIG.max_stale_data_cycles_before_halt}"
                        ),
                        "ALL",
                    )

            RUNTIME_STATE["unhandled_error_streak"] = 0

            write_signal_snapshot(now_utc, signal_rows)
            write_status_snapshot(now_utc)
        except Exception as ex:
            log(f"Unhandled error: {ex}")
            RUNTIME_STATE["unhandled_error_streak"] = int(RUNTIME_STATE.get("unhandled_error_streak") or 0) + 1
            err_streak = int(RUNTIME_STATE["unhandled_error_streak"])
            append_event("unhandled_error", "ALL", f"streak={err_streak} error={ex}")
            if err_streak >= CONFIG.max_unhandled_errors_before_halt:
                halt_trading(
                    (
                        "Unhandled error circuit breaker triggered. "
                        f"errors={err_streak}, cap={CONFIG.max_unhandled_errors_before_halt}"
                    ),
                    "ALL",
                )

        time.sleep(CONFIG.loop_interval_seconds)


def main() -> None:
    if not initialize_mt5():
        return
    try:
        run_loop()
    finally:
        mt5.shutdown()
        log("MT5 shutdown complete.")


if __name__ == "__main__":
    main()
