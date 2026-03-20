# MT5 Multi-Pair Trend Scalper (M5)

This project is a Python MetaTrader 5 bot template for 5-minute trend scalp trading on:
- XAUUSD
- GBPJPY
- EURUSD
- BTCUSD
- USDJPY

## Important Risk Note
No strategy can guarantee zero losses or "make lots of money" quickly. Markets can gap, slip, disconnect, or trend against positions. This bot includes risk controls (stop loss, breakeven, trailing stop), but losses are still possible.

## Features
- Multi-symbol scanning on M5
- Trend-based entry using EMA(20/50) + ATR filter
- Quality-first setup ranking with multi-factor confluence score
- One position per symbol (per magic number)
- Automatic stop loss and take profit
- Breakeven lock-in after profit threshold
- Trailing stop once position is in profit
- London/New York session filter (UTC)
- News blackout filter from local CSV calendar
- Dynamic risk-per-trade lot sizing from stop distance
- Daily loss limit with automatic stop-trading mode
- Spread filter and max open-position guard
- Top-ranked entries per cycle (selects strongest setups first)
- Dry-run mode for safe testing
- Strict exact-symbol mode (no automatic alias trading)
- Local monitoring dashboard (Streamlit)

## Setup
1. Install Python 3.11+.
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Copy env file:
   ```bash
   copy .env.example .env
   ```
4. Edit `.env` with your MT5 credentials.
5. Ensure your broker symbols match names in `config.py`.
6. Optional: copy `news_events.example.csv` to `news_events.csv` and edit with upcoming events.
7. Open MT5 terminal and allow algo trading.

## Run
```bash
python mt5_trend_scalper.py
```

## Symbol Policy (Exact Names Only)
By default, the bot is in strict mode (`strict_symbol_names=True`).

- It will only trade symbols exactly as written in `config.py`.
- If your broker does not provide an exact symbol (example `XAUUSD`), bot startup is blocked.
- To keep strict behavior and still trade metals, update `symbols` to your broker's exact names.

This applies to both live trading and backtesting.

## Watch Interface
Run the dashboard in a new terminal:

```bash
streamlit run dashboard.py
```

The dashboard shows:
- Account metrics
- Bot status snapshot
- Exact symbol availability check
- Live spreads
- Open bot positions
- Recent bot events and logs

## Vercel Hosting + Email Signals (Resend)
If you want a hosted signal website and email alerts:

1. Deploy `vercel-signals` folder to Vercel.
2. Add Vercel KV integration.
3. Set Vercel env vars:
   - `SIGNALS_WEBHOOK_TOKEN`
   - `RESEND_API_KEY`
   - `SIGNAL_EMAIL_FROM`
   - `SIGNAL_EMAIL_TO`
4. In Python `.env`, enable webhook publishing:
   - `SIGNALS_WEBHOOK_ENABLED=true`
   - `SIGNALS_WEBHOOK_URL=https://your-vercel-app.vercel.app/api/ingest`
   - `SIGNALS_WEBHOOK_TOKEN=...same token as Vercel...`

See setup details in `vercel-signals/README.md`.

## Deep Backtest
Run multi-symbol historical backtest from MT5 data:

```bash
python backtest_mt5.py --days 365 --initial-equity 200
```

Optional flags:
- `--symbols XAUUSD,GBPJPY,EURUSD,BTCUSD,USDJPY`
- `--output backtest_results`

Backtest output files:
- `backtest_results/summary.csv`
- `backtest_results/trades.csv`

Notes:
- It applies session filter, news blackout, dynamic lot sizing, breakeven/trailing, and daily loss guard.
- Fill quality is simulated from OHLC bars and may differ from live tick execution.

## Shared-Equity Portfolio Backtest (Single Account)
Use this when you want one account balance (for example 200 USD) shared across all pairs at the same time:

```bash
python backtest_portfolio.py --days 30 --initial-equity 200 --symbols GOLD,GBPJPY,EURUSD,BTCUSD,USDJPY --output backtest_results_portfolio_200
```

This is different from running symbols independently because all trades draw from the same equity curve.

## Safety Workflow
1. Keep `DRY_RUN=true` first.
2. Run on a demo account for at least several weeks.
3. Check journal logs and broker execution behavior.
4. Only then consider small live size.

## New Risk Controls
- Session filter: trades only during London or New York windows (UTC) when enabled.
- News filter: blocks entries around configured high-impact events.
- Dynamic lot sizing: lots are sized by account equity, risk percent, and stop distance.
- Daily loss guard: if realized bot PnL for the day drops below limit, new entries are paused until next UTC day.
- Daily trade cap guard: halts new entries after N opened trades in a UTC day.
- Consecutive loss guard: halts after N consecutive losing closed deals.
- MT5 connection watchdog: halts if terminal/account connectivity fails repeatedly.
- Data freshness watchdog: halts if bar data remains stale for multiple loops.
- Unhandled error circuit breaker: halts after repeated runtime exceptions.

Environment overrides for live guards (optional):
- `MAX_NEW_TRADES_PER_DAY`
- `MAX_CONSECUTIVE_LOSSES`
- `MAX_MT5_FAILURES_BEFORE_HALT`
- `MAX_STALE_DATA_CYCLES_BEFORE_HALT`
- `MAX_DATA_STALENESS_MINUTES`
- `MAX_UNHANDLED_ERRORS_BEFORE_HALT`
- `REQUIRE_MARKET_CONNECTION`

Quality-first selection overrides (optional):
- `MIN_QUALITY_SCORE`
- `MAX_NEW_ENTRIES_PER_CYCLE`
- `MAX_POSITIONS_TOTAL`
- `SYMBOLS`

## News CSV Format
File name defaults to `news_events.csv`.

Columns:
- `timestamp_utc` in ISO format (example `2026-03-20T12:30:00Z`)
- `symbols` separated by `|` (examples: `USD|EUR`, `XAUUSD|USD`, `ALL`)
- `impact` (`high`, `medium`, `low`)
- `title` (free text)

When `news_only_high_impact=true`, only `high` events block entries.

## Strategy Logic (Simple)
- Bullish trend: EMA fast > EMA slow and both sloping upward.
- Bearish trend: EMA fast < EMA slow and both sloping downward.
- Entry trigger: breakout of recent candle extreme in trend direction.
- Confluence score: trend strength + breakout strength + EMA slope + candle body quality.
- Execution policy: at each cycle, all symbols are scored and only top-ranked setups are executed.
- Initial stop: ATR-based.
- Take profit: risk-reward multiple.
- Management: breakeven then trailing stop.

This is a starter framework, not financial advice.
