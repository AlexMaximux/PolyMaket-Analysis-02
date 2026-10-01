# Polymarket Up/Down

A lightweight, standalone app for Polymarket **Up/Down (hourly crypto) markets**: live signals, the Jev / Kev / Span decision-model collector (plus Solar, Tev and Mercury as extra, non-voting models), forward-test analysis, and the control panel for the workers and the trading bot.

It was split out of *Polymarket Pulse*. It has **no wallet crawler, no wallet backfill and no whale/starred alerts**, and it keeps its own database (`updown.db`).

## What is in it

| Page | What it does |
|---|---|
| `/updown` | Live Up/Down board: prices, fair values, order books |
| `/jev-analysis` | Every recorded multi-model snapshot, signals, charts, exports |
| `/cloud-analysis` | Honest backtest and the two frozen forward tests (Strategy 1 and Strategy 2, Solar ≥ 80%) |
| `/alerts` | Telegram rules for Jev and Up/Down signals |
| `/control` | Workers, logs, settings, heartbeat alerts, trading-bot status |

| Worker (`scripts/`) | Job |
|---|---|
| `jev.ts` | Snapshot every 30 s; every 5 min one record with Jev, Kev, Span, Solar, Tev and Mercury; resolves market outcomes |
| `alerts.ts` | Records a per-minute Up/Down tick to `ticks/`, evaluates alert rules |
| `bot.ts` | Trading bot: forward test of the frozen strategy, Telegram control, redemption (off by default) |
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

## Safety

- The trading bot is off by default and starts in simulation mode; it never autostarts.
- Bot secrets are encrypted at rest with a key file next to the database (`updown.db.bot-key`). Do not commit or copy the database without it.
- New buys are blocked from locations Polymarket restricts (see `src/lib/bot/geo.ts`).
