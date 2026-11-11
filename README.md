# Polymarket Up/Down

A lightweight, standalone app for Polymarket **Up/Down (hourly crypto) markets**: live signals, the Jev / Kev / Span decision-model collector (plus Solar, Tev, Mercury and Liquid D1 as extra, non-voting models), forward-test analysis, and the control panel for the workers and the trading bot.

It was split out of *Polymarket Pulse*. It has **no wallet crawler, no wallet backfill and no whale/starred alerts**, and it keeps its own database (`updown.db`).

## What is in it

| Page | What it does |
|---|---|
| `/updown` | Live Up/Down board: prices, fair values, order books |
| `/jev-analysis` | Every recorded multi-model snapshot, signals, charts, exports |
| `/cloud-analysis` | Honest backtest and the frozen forward tests (strategies 1–4 and Strategy 1 + Optimised, which the bot trades by default) |
| `/alerts` | Telegram rules for Jev and Up/Down signals |
| `/control` | Workers, logs, settings, heartbeat alerts, trading-bot status |

| Worker (`scripts/`) | Job |
|---|---|
| `jev.ts` | Snapshot every 30 s; every 5 min one record with Jev, Kev, Span, Solar, Tev, Mercury and Liquid; resolves market outcomes |
| `alerts.ts` | Records a per-minute Up/Down tick to `ticks/`, evaluates alert rules |
| `bot.ts` | Trading bot: forward test of the frozen strategy chosen in the control panel (Frozen strategy 1 + Optimised by default), Telegram control, redemption (off by default) |
| `supervisor.ts` | Starts and restarts the web app and the workers, serves the control API, sends heartbeat alerts |

## Run

```bash
npm install
cp .env.example .env.local      # or fill the same values on /control
npm run dev                      # web only, http://127.0.0.1:8000
npm run supervisor               # web + workers (use `next build` first for production)
npm test
```

Production: `npm run build`, then run `npm run supervisor` with `NODE_ENV=production` (for example under pm2). Set `ALLOW_REMOTE_ACCESS=true` to serve the dashboard to other machines.

## Data

- `updown.db` (SQLite): settings, alert rules, worker heartbeats, bot ledger. Created on first run.
- `jev/history/*.json`: one record per coin every 5 minutes. This is the source of truth for the analysis pages and the bot.
- `ticks/updown-*.jsonl`: per-minute Up/Down ticks.

## TimesFM forecast (TFM)

Google's TimesFM time-series model forecasts the next hour of each coin's price from its 1-minute Binance bars. From that forecast the app derives a closing price with a 10-90% band and P(Up) for the 5-minute, 15-minute and 1-hour Up/Down markets. It is an extra input to test, not a trading signal: the bot, the frozen strategies and the alerts do not use it.

```bash
npm run tfm:setup                 # once: Python 3.12 venv in tfm/.venv with timesfm and torch
npm run tfm                       # starts the model service on http://127.0.0.1:8002 (TimesFM 3.0 by default)
npm run tfm:2.5                   # starts the model service with TimesFM 2.5
npm run backfill:tfm -- --coin=btc --limit=40
```

`backfill:tfm` forecasts the history snapshots that have no forecast yet for the active model, using only prices that existed at each snapshot's time. Flags: `--coin=btc,eth` (default every coin), `--since=YYYY-MM-DD` (file-name date, inclusive), `--limit=N` (snapshots forecast in this run), `--batch=16` (series per call, 1-64), `--force` (redo snapshots that are already stored). It needs the service to be running, prints progress every 500 records and can be stopped and started again: it continues where it ended. While the service is up, `scripts/jev.ts` also forecasts every new snapshot; with the service down the collector is unaffected.

- `/updown` has a **TFM Forecast** tab with the live forecast, refresh controls (30 s / 1 min), and an hour track chart.
- Forecasts are stored per model in `jev/tfm/forecasts-<key>.jsonl` (e.g. `forecasts-timesfm-3.0.jsonl`, append-only; the app reads the active model's store; run `npm run backfill:tfm` after switching). Live track points are written to `jev/tfm/live/<coin>-<YYYY-MM-DD>.jsonl`. Nothing in `jev/history` is changed.
- Model selection and configuration: `TFM_MODEL` (`google/timesfm-3.0-pytorch` by default, or `google/timesfm-2.5-200m-pytorch` / model keys `timesfm-3.0`, `timesfm-2.5`) and `TFM_DEVICE` (`cpu` by default).
- The service is local only (127.0.0.1:8002) and is not meant for the small production server: it needs far more memory than that machine has. Without it every page and script works as before; the TimesFM fields are just empty.
- Licences: TimesFM 3.0 weights (`google/timesfm-3.0-pytorch`) are under a non-commercial, non-production licence. TimesFM 2.5 weights (`google/timesfm-2.5-200m-pytorch`) are licensed under Apache-2.0.

## Safety

- The trading bot is off by default and starts in simulation mode; it never autostarts.
- Bot secrets are encrypted at rest with a key file next to the database (`updown.db.bot-key`). Do not commit or copy the database without it.
- New buys are blocked from locations Polymarket restricts (see `src/lib/bot/geo.ts`).
