from dataclasses import dataclass, field
from typing import Dict, List
import os
from dotenv import load_dotenv

load_dotenv()


def _profile_name() -> str:
    value = os.getenv("TRADING_PROFILE", "aggressive").strip().lower()
    if value in {"growth", "aggressive"}:
        return value
    return "growth"


def _profile_default_float(key: str) -> float:
    profile = _profile_name()
    defaults = {
        "growth": {
            "risk_per_trade_pct": 0.45,
            "daily_loss_limit_pct": 2.50,
            "min_quality_score": 3.30,
        },
        "aggressive": {
            "risk_per_trade_pct": 0.90,
            "daily_loss_limit_pct": 4.00,
            "min_quality_score": 3.10,
        },
    }
    return float(defaults[profile][key])


def _profile_default_int(key: str) -> int:
    profile = _profile_name()
    defaults = {
        "growth": {
            "max_new_trades_per_day": 8,
            "max_positions_total": 2,
            "max_new_entries_per_cycle": 2,
        },
        "aggressive": {
            "max_new_trades_per_day": 12,
            "max_positions_total": 3,
            "max_new_entries_per_cycle": 3,
        },
    }
    return int(defaults[profile][key])


def _parse_symbols_from_env() -> List[str]:
    raw = os.getenv("SYMBOLS", "").strip()
    if not raw:
        return [
            "EURUSD",
            "GBPUSD",
            "USDJPY",
            "AUDUSD",
            "NZDUSD",
            "USDCHF",
            "EURCHF",
            "GOLD",
        ]
    return [s.strip().upper() for s in raw.split(",") if s.strip()]


@dataclass
class BotConfig:
    # Trading universe
    symbols: List[str] = field(
        default_factory=_parse_symbols_from_env
    )
    strict_symbol_names: bool = True

    # Strategy timeframe (M5)
    timeframe_minutes: int = 5
    bars_to_fetch: int = 400

    # Trend filter
    ema_fast_period: int = 20
    ema_slow_period: int = 50
    atr_period: int = 14

    # Entry and exit model
    stop_atr_multiplier: float = 1.4
    takeprofit_rr: float = 0.80
    min_ema_distance_atr: float = 0.16
    breakout_atr_buffer: float = 0.05

    # Quality-first setup ranking (higher = stricter selection)
    min_quality_score: float = float(
        os.getenv("MIN_QUALITY_SCORE", "3.40")
    )
    max_new_entries_per_cycle: int = int(
        os.getenv(
            "MAX_NEW_ENTRIES_PER_CYCLE",
            "2",
        )
    )
    quality_score_offset_by_symbol: Dict[str, float] = field(
        default_factory=lambda: {
            # Historically weaker symbols need extra confirmation quality.
            "USDCAD": 0.40,
            "GBPJPY": 0.35,
            "BTCUSD": 0.20,
        }
    )

    # Position sizing (keep risk conservative)
    fixed_lot_by_symbol: Dict[str, float] = field(
        default_factory=lambda: {
            "XAUUSD": 0.02,
            "GOLD": 0.02,
            "GBPJPY": 0.02,
            "EURUSD": 0.03,
            "BTCUSD": 0.01,
            "USDJPY": 0.03,
        }
    )
    use_dynamic_risk_sizing: bool = True
    risk_per_trade_pct: float = float(
        os.getenv("RISK_PER_TRADE_PCT", "1.00")
    )
    use_profit_risk_scaling: bool = os.getenv("USE_PROFIT_RISK_SCALING", "true").lower() == "true"
    profit_risk_step_pct: float = float(os.getenv("PROFIT_RISK_STEP_PCT", "5.0"))
    profit_risk_increment_pct: float = float(os.getenv("PROFIT_RISK_INCREMENT_PCT", "0.25"))
    max_risk_per_trade_pct: float = float(os.getenv("MAX_RISK_PER_TRADE_PCT", "2.60"))

    # Management rules in points
    breakeven_trigger_points: int = 240
    breakeven_lock_points: int = 30
    trailing_start_points: int = 340
    trailing_distance_points: int = 180

    # Execution
    slippage_points: int = 20
    magic_number: int = 26031926
    loop_interval_seconds: int = 15

    # Session filter (UTC clock)
    only_trade_london_newyork: bool = os.getenv("ONLY_TRADE_LONDON_NEWYORK", "true").lower() == "true"
    london_start_hour_utc: int = int(os.getenv("LONDON_START_HOUR_UTC", "7"))
    london_end_hour_utc: int = int(os.getenv("LONDON_END_HOUR_UTC", "16"))
    newyork_start_hour_utc: int = int(os.getenv("NEWYORK_START_HOUR_UTC", "12"))
    newyork_end_hour_utc: int = int(os.getenv("NEWYORK_END_HOUR_UTC", "21"))

    # News filter
    use_news_filter: bool = True
    news_events_file: str = os.getenv("NEWS_EVENTS_FILE", "news_events.csv")
    news_block_before_minutes: int = 20
    news_block_after_minutes: int = 20
    news_only_high_impact: bool = True

    # Daily risk stop
    use_daily_loss_limit: bool = True
    daily_loss_limit_pct: float = float(
        os.getenv("DAILY_LOSS_LIMIT_PCT", str(_profile_default_float("daily_loss_limit_pct")))
    )
    daily_loss_limit_amount: float = 0.0

    # Live safety guards
    max_new_trades_per_day: int = int(
        os.getenv("MAX_NEW_TRADES_PER_DAY", str(_profile_default_int("max_new_trades_per_day")))
    )
    max_consecutive_losses: int = int(os.getenv("MAX_CONSECUTIVE_LOSSES", "2"))
    max_mt5_failures_before_halt: int = int(os.getenv("MAX_MT5_FAILURES_BEFORE_HALT", "3"))
    max_stale_data_cycles_before_halt: int = int(os.getenv("MAX_STALE_DATA_CYCLES_BEFORE_HALT", "3"))
    max_data_staleness_minutes: int = int(os.getenv("MAX_DATA_STALENESS_MINUTES", "20"))
    max_unhandled_errors_before_halt: int = int(os.getenv("MAX_UNHANDLED_ERRORS_BEFORE_HALT", "3"))
    require_market_connection: bool = os.getenv("REQUIRE_MARKET_CONNECTION", "true").lower() == "true"
    require_terminal_trade_allowed: bool = os.getenv("REQUIRE_TERMINAL_TRADE_ALLOWED", "true").lower() == "true"

    # Safety
    max_positions_total: int = int(
        os.getenv("MAX_POSITIONS_TOTAL", "3")
    )
    max_spread_points_by_symbol: Dict[str, int] = field(
        default_factory=lambda: {
            "XAUUSD": 250,
            "GOLD": 250,
            "GBPJPY": 120,
            "EURUSD": 50,
            "EURCHF": 70,
            "CADJPY": 90,
            "BTCUSD": 2500,
            "USDJPY": 70,
        }
    )
    dry_run: bool = os.getenv("DRY_RUN", "true").lower() == "true"

    # Monitoring outputs for dashboard
    bot_log_file: str = "bot.log"
    bot_status_file: str = "bot_status.json"
    bot_events_file: str = "bot_events.csv"
    bot_signals_file: str = "bot_signals.json"

    # Optional remote signal publishing (Vercel webhook)
    signals_webhook_enabled: bool = os.getenv("SIGNALS_WEBHOOK_ENABLED", "false").lower() == "true"
    signals_webhook_url: str = os.getenv("SIGNALS_WEBHOOK_URL", "")
    signals_webhook_token: str = os.getenv("SIGNALS_WEBHOOK_TOKEN", "")

    # MT5 account
    mt5_login: int = int(os.getenv("MT5_LOGIN", "0"))
    mt5_password: str = os.getenv("MT5_PASSWORD", "")
    mt5_server: str = os.getenv("MT5_SERVER", "")
    mt5_path: str = os.getenv("MT5_PATH", "")


CONFIG = BotConfig()


def scaled_risk_pct(current_equity: float, baseline_equity: float) -> float:
    base = max(float(CONFIG.risk_per_trade_pct), 0.0)
    if not CONFIG.use_profit_risk_scaling:
        return base

    if baseline_equity <= 0 or current_equity <= baseline_equity:
        return base

    step = max(float(CONFIG.profit_risk_step_pct), 0.0)
    if step <= 0:
        return base

    growth_pct = ((current_equity - baseline_equity) / baseline_equity) * 100.0
    growth_steps = int(growth_pct // step)
    if growth_steps <= 0:
        return base

    boosted = base + growth_steps * float(CONFIG.profit_risk_increment_pct)
    cap = max(float(CONFIG.max_risk_per_trade_pct), base)
    return min(boosted, cap)
