import argparse
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional

import MetaTrader5 as mt5
import numpy as np
import pandas as pd

import backtest_mt5 as bt
from config import CONFIG


@dataclass
class Position:
    symbol: str
    side: str
    entry_time: pd.Timestamp
    entry: float
    sl: float
    tp: float
    lot: float


@dataclass
class ClosedTrade:
    symbol: str
    side: str
    entry_time: str
    exit_time: str
    entry: float
    exit: float
    sl: float
    tp: float
    lot: float
    pnl: float
    reason: str


@dataclass
class EntryCandidate:
    symbol: str
    side: str
    score: float
    entry_time: pd.Timestamp
    entry: float
    sl: float
    tp: float
    lot: float


def load_symbol_frame(symbol: str, days: int) -> Optional[pd.DataFrame]:
    if mt5.symbol_info(symbol) is None:
        return None
    if not mt5.symbol_select(symbol, True):
        return None

    frame = bt.get_rates(symbol, days)
    if frame is None:
        return None
    frame = bt.compute_indicators(frame)
    frame = frame.reset_index(drop=True)
    return frame


def run_portfolio_backtest(days: int, initial_equity: float, symbols: List[str], output_dir: Path) -> None:
    if not bt.initialize_mt5():
        print("INIT_FAILED")
        return

    try:
        events = bt.load_news_events()
        frames: Dict[str, pd.DataFrame] = {}
        for symbol in symbols:
            if CONFIG.strict_symbol_names and mt5.symbol_info(symbol) is None:
                print(f"{symbol}: ERROR=symbol_not_found_exact")
                continue
            frame = load_symbol_frame(symbol, days)
            if frame is None:
                print(f"{symbol}: ERROR=no_rates")
                continue
            frames[symbol] = frame

        if not frames:
            print("No valid symbols for portfolio backtest.")
            return

        timeline = sorted({ts for f in frames.values() for ts in f["time"].iloc[3:-1]})
        ptr: Dict[str, int] = {s: 3 for s in frames.keys()}
        open_pos: Dict[str, Position] = {}

        equity = initial_equity
        max_equity = initial_equity
        max_drawdown = 0.0
        day_start_equity = initial_equity
        current_day = None
        halted_today = False

        by_symbol_pnl: Dict[str, float] = {s: 0.0 for s in frames.keys()}
        by_symbol_trades: Dict[str, int] = {s: 0 for s in frames.keys()}
        by_symbol_wins: Dict[str, int] = {s: 0 for s in frames.keys()}
        by_symbol_losses: Dict[str, int] = {s: 0 for s in frames.keys()}
        by_symbol_gp: Dict[str, float] = {s: 0.0 for s in frames.keys()}
        by_symbol_gl: Dict[str, float] = {s: 0.0 for s in frames.keys()}

        closed: List[ClosedTrade] = []

        for ts in timeline:
            day = ts.date()
            if current_day != day:
                current_day = day
                day_start_equity = equity
                halted_today = False

            if CONFIG.use_daily_loss_limit and not halted_today:
                max_loss = (
                    CONFIG.daily_loss_limit_amount
                    if CONFIG.daily_loss_limit_amount > 0
                    else day_start_equity * (CONFIG.daily_loss_limit_pct / 100.0)
                )
                if max_loss > 0 and (day_start_equity - equity) >= max_loss:
                    halted_today = True

            for symbol, frame in frames.items():
                i = ptr[symbol]
                if i >= len(frame) - 1:
                    continue
                if frame.iloc[i]["time"] != ts:
                    continue

                row = frame.iloc[i]
                nxt = frame.iloc[i + 1]
                info = mt5.symbol_info(symbol)
                if info is None:
                    ptr[symbol] += 1
                    continue

                # Manage open trade first
                if symbol in open_pos:
                    pos = open_pos[symbol]
                    bt.apply_position_management(pos, row, info.point)

                    if pos.side == "buy":
                        sl_hit = float(nxt["low"]) <= pos.sl
                        tp_hit = float(nxt["high"]) >= pos.tp
                        if sl_hit:
                            exit_price, reason = pos.sl, "sl"
                        elif tp_hit:
                            exit_price, reason = pos.tp, "tp"
                        else:
                            exit_price, reason = None, ""
                    else:
                        sl_hit = float(nxt["high"]) >= pos.sl
                        tp_hit = float(nxt["low"]) <= pos.tp
                        if sl_hit:
                            exit_price, reason = pos.sl, "sl"
                        elif tp_hit:
                            exit_price, reason = pos.tp, "tp"
                        else:
                            exit_price, reason = None, ""

                    if exit_price is not None:
                        pnl = bt.pnl_money(symbol, pos.side, pos.entry, exit_price, pos.lot)
                        equity += pnl
                        by_symbol_pnl[symbol] += pnl
                        by_symbol_trades[symbol] += 1
                        if pnl >= 0:
                            by_symbol_wins[symbol] += 1
                            by_symbol_gp[symbol] += pnl
                        else:
                            by_symbol_losses[symbol] += 1
                            by_symbol_gl[symbol] += abs(pnl)

                        closed.append(
                            ClosedTrade(
                                symbol=symbol,
                                side=pos.side,
                                entry_time=pos.entry_time.isoformat(),
                                exit_time=nxt["time"].isoformat(),
                                entry=pos.entry,
                                exit=exit_price,
                                sl=pos.sl,
                                tp=pos.tp,
                                lot=pos.lot,
                                pnl=pnl,
                                reason=reason,
                            )
                        )
                        del open_pos[symbol]

                        if equity > max_equity:
                            max_equity = equity
                        dd = (max_equity - equity) / max_equity if max_equity > 0 else 0.0
                        if dd > max_drawdown:
                            max_drawdown = dd

                ptr[symbol] += 1

                # Entry selection: score all symbols first, then take top-quality setups.
                if not halted_today:
                    candidates: List[EntryCandidate] = []
                    for symbol, frame in frames.items():
                        i = ptr[symbol] - 1
                        if i < 3 or i >= len(frame) - 1:
                            continue
                        if frame.iloc[i]["time"] != ts:
                            continue
                        if symbol in open_pos:
                            continue

                        now = frame.iloc[i]["time"].to_pydatetime()
                        if not bt.session_is_open(now):
                            continue
                        if bt.is_news_blocked(symbol, now, events):
                            continue

                        setup = bt.trend_signal_with_quality(frame, i, symbol)
                        if setup is None:
                            continue
                        signal, score = setup

                        row = frame.iloc[i]
                        nxt = frame.iloc[i + 1]
                        atr = float(row["atr"]) if not pd.isna(row["atr"]) else np.nan
                        if not np.isfinite(atr) or atr <= 0:
                            continue

                        entry = float(nxt["open"])
                        stop_dist = atr * CONFIG.stop_atr_multiplier
                        tp_dist = stop_dist * CONFIG.takeprofit_rr
                        if signal == "buy":
                            sl = entry - stop_dist
                            tp = entry + tp_dist
                        else:
                            sl = entry + stop_dist
                            tp = entry - tp_dist

                        lot = bt.dynamic_lot(symbol, equity, entry, sl, baseline_equity=initial_equity)
                        if lot <= 0:
                            continue

                        candidates.append(
                            EntryCandidate(
                                symbol=symbol,
                                side=signal,
                                score=float(score),
                                entry_time=nxt["time"],
                                entry=entry,
                                sl=sl,
                                tp=tp,
                                lot=lot,
                            )
                        )

                    if candidates and len(open_pos) < CONFIG.max_positions_total:
                        candidates.sort(key=lambda c: c.score, reverse=True)
                        free_slots = CONFIG.max_positions_total - len(open_pos)
                        max_this_cycle = min(CONFIG.max_new_entries_per_cycle, free_slots)
                        for candidate in candidates[:max_this_cycle]:
                            if candidate.symbol in open_pos:
                                continue
                            open_pos[candidate.symbol] = Position(
                                symbol=candidate.symbol,
                                side=candidate.side,
                                entry_time=candidate.entry_time,
                                entry=candidate.entry,
                                sl=candidate.sl,
                                tp=candidate.tp,
                                lot=candidate.lot,
                            )

        # Force close remaining positions at last close
        for symbol, pos in list(open_pos.items()):
            frame = frames[symbol]
            last = frame.iloc[-1]
            exit_price = float(last["close"])
            pnl = bt.pnl_money(symbol, pos.side, pos.entry, exit_price, pos.lot)
            equity += pnl
            by_symbol_pnl[symbol] += pnl
            by_symbol_trades[symbol] += 1
            if pnl >= 0:
                by_symbol_wins[symbol] += 1
                by_symbol_gp[symbol] += pnl
            else:
                by_symbol_losses[symbol] += 1
                by_symbol_gl[symbol] += abs(pnl)

            closed.append(
                ClosedTrade(
                    symbol=symbol,
                    side=pos.side,
                    entry_time=pos.entry_time.isoformat(),
                    exit_time=last["time"].isoformat(),
                    entry=pos.entry,
                    exit=exit_price,
                    sl=pos.sl,
                    tp=pos.tp,
                    lot=pos.lot,
                    pnl=pnl,
                    reason="eod",
                )
            )

        output_dir.mkdir(parents=True, exist_ok=True)

        summary_rows = []
        total_trades = sum(by_symbol_trades.values())
        total_gp = sum(by_symbol_gp.values())
        total_gl = sum(by_symbol_gl.values())
        total_win = sum(by_symbol_wins.values())

        for symbol in frames.keys():
            trades = by_symbol_trades[symbol]
            gp = by_symbol_gp[symbol]
            gl = by_symbol_gl[symbol]
            pf = (gp / gl) if gl > 0 else float("inf")
            wr = (by_symbol_wins[symbol] / trades * 100.0) if trades > 0 else 0.0
            summary_rows.append(
                {
                    "scope": "symbol",
                    "symbol": symbol,
                    "start_equity": initial_equity,
                    "end_equity": initial_equity + by_symbol_pnl[symbol],
                    "net_profit": by_symbol_pnl[symbol],
                    "trade_count": trades,
                    "win_rate": round(wr, 2),
                    "profit_factor": round(pf, 3) if np.isfinite(pf) else "inf",
                    "max_drawdown_pct": "",
                }
            )

        overall_pf = (total_gp / total_gl) if total_gl > 0 else float("inf")
        overall_wr = (total_win / total_trades * 100.0) if total_trades > 0 else 0.0

        summary_rows.insert(
            0,
            {
                "scope": "portfolio",
                "symbol": "ALL",
                "start_equity": initial_equity,
                "end_equity": equity,
                "net_profit": equity - initial_equity,
                "trade_count": total_trades,
                "win_rate": round(overall_wr, 2),
                "profit_factor": round(overall_pf, 3) if np.isfinite(overall_pf) else "inf",
                "max_drawdown_pct": round(max_drawdown * 100.0, 2),
            },
        )

        pd.DataFrame(summary_rows).to_csv(output_dir / "summary.csv", index=False)
        pd.DataFrame([asdict(t) for t in closed]).to_csv(output_dir / "trades.csv", index=False)

        print(f"WROTE {output_dir / 'summary.csv'}")
        print(
            f"PORTFOLIO start={initial_equity:.2f} end={equity:.2f} net={equity - initial_equity:.2f} "
            f"trades={total_trades} win_rate={overall_wr:.2f}% pf={overall_pf:.2f} max_dd={max_drawdown*100.0:.2f}%"
        )

    finally:
        mt5.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser(description="Shared-equity portfolio MT5 backtest")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--initial-equity", type=float, default=200.0)
    parser.add_argument("--symbols", type=str, default=",".join(CONFIG.symbols))
    parser.add_argument("--output", type=str, default="backtest_results_portfolio_200")
    args = parser.parse_args()

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    run_portfolio_backtest(
        days=args.days,
        initial_equity=args.initial_equity,
        symbols=symbols,
        output_dir=Path(args.output),
    )


if __name__ == "__main__":
    main()
