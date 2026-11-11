# TFM Forecast (TimesFM) Implementation Plan

> **For agentic workers:** the owner chose the execution method: Antigravity builds this plan task by task, a manager
> reviews. Steps use checkbox (`- [ ]`) syntax for tracking. Do the tasks in order; each ends with a passing test run.

**Goal:** Forecast the 5-minute, 15-minute and 1-hour Up/Down markets with Google's TimesFM, show the live forecast in a
new "TFM Forecast" tab on `/updown`, and store one forecast per history snapshot so `/jev-analysis` can use TimesFM as
columns, filters and a signal model.

**Architecture:** A small local Python service (`tfm/server.py`) holds the TimesFM model and answers "series in,
deciles out" over HTTP on `127.0.0.1:8002`. All app logic stays in TypeScript under `src/lib/tfm/`: build the 1-minute
price context as of a time, call the service, turn the deciles into P(Up) for each market window. Three callers share
that library: a live API route for the tab, the snapshot collector, and a backfill script. Forecasts for snapshots go to
an append-only file `jev/tfm/forecasts.jsonl`; `/api/jev/history` merges them into its rows by file name. History
snapshot files are never modified.

**Tech Stack:** Next.js 16.3.4 (App Router, route handlers), React 19, TypeScript, vitest, Tailwind 4. Python 3.12 venv
at `tfm/.venv` with `timesfm[torch]==3.0.2` (torch 2.15.0, numpy 2.5.4). No new npm dependency.

**Spec:** this document. The section "What is being built" is the spec; the tasks implement it.

## What is being built

The owner trades hourly BTC Up/Down markets with rules built on LLM "decision models". Every model so far only echoes
the market price. The owner wants one more, different kind of input, a time-series foundation model, and wants to test
on the analysis page whether it can improve the strategies. Success is: the tab shows a live forecast, and on
`/jev-analysis` the owner can pick TimesFM as the signal model or add conditions such as "TFM edge at least 3¢" to an
existing rule and see the win/loss numbers change.

- **Goals:** live forecast per coin for the three current windows (5m, 15m, 1H): forecast closing price with a 10-90%
  band and P(Up); the same numbers stored for every history snapshot, computed only from data that existed at the
  snapshot's time; those numbers usable in `/jev-analysis`, Cloud Analysis and the Strategy Lab.
- **Non-goals:** no trading on TimesFM, no change to the bot, to frozen strategies, to alerts or to the LLM calls; no
  deployment to the production server (it has 908 MB of RAM and cannot hold the model); no fine-tuning.
- **Anti-goals (failure even if it works):** anything that slows or breaks the collector or the bot; any forecast for a
  past snapshot that used prices from after that snapshot; any page that worked before and now errors when the Python
  service is not running.

## Global Constraints

- Next.js here is 16.3.4 and differs from older versions. Before writing a route handler or a client component, read the
  matching guide in `node_modules/next/dist/docs/` (required by `AGENTS.md`).
- Do not run `git commit`, `git push`, `git stash`, `git reset`, `git checkout`, or create or switch branches. Leave all
  changes uncommitted in the working tree.
- Do not modify: `src/lib/bot/**`, `scripts/bot.ts`, `src/lib/forwardSnapshot.ts`, any `STRATEGY_HISTORY` /
  `FROZEN_STRATEGY*` rule in `src/lib/signalAnalysis.ts`, `.env*`, `*.db` files, or anything under `jev/history`,
  `jev/cl`, `public/jev`, `ticks`. Those data folders are read-only.
- Do not stop, restart or reconfigure the process on port 8000 (the owner's running `next dev`) or any collector or bot
  process. Do not use SSH. Network access is limited to `api.binance.com`, `fapi.binance.com` and `127.0.0.1`.
- Python: use the existing venv `tfm/.venv`. Do not `pip install` anything else and install nothing globally.
- Model: `google/timesfm-2.5-200m-pytorch` only (Apache-2.0, already downloaded). Do not download
  `google/timesfm-3.0-pytorch`: its weights are under a non-commercial licence.
- With the Python service absent or stopped, every existing page, route, script and test behaves exactly as before.
- UI text in English, same dark style as the neighbouring panels. TimesFM colour everywhere: `#5ad1e6`.
- Probabilities are stored as 0-1 in `jev/tfm/forecasts.jsonl` and shown as 0-100 in rows, like the other models.
- The working tree already holds uncommitted work from another tool (the Strategy Lab): `src/app/jev-analysis/v2/`,
  `src/components/jev-lab/`, `src/lib/jevLab.ts`, `test/jevLab.test.ts`, and edits in
  `src/app/api/jev/history/route.ts`, `src/components/Navigation.tsx`, `test/jevHistoryApi.test.ts`. Keep all of it
  and build on top of it.
- Checks that must pass at the end: `npx tsc --noEmit` (clean now), `npx vitest run` (38 files, 417 tests pass now),
  `npm run lint` (214 problems now: 120 errors, 94 warnings; add none).

## Verified facts (checked on this machine on 2026-11-10)

- `tfm/.venv/bin/python` is Python 3.12.12 with timesfm 3.0.2, torch 2.15.0, numpy 2.5.4. The model weights are cached.
- API:
  `model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")`, then
  `model.compile(timesfm.ForecastConfig(max_context=1024, max_horizon=64, normalize_inputs=True, use_continuous_quantile_head=True, force_flip_invariance=True, infer_is_positive=True, fix_quantile_crossing=True, per_core_batch_size=16))`,
  then `point, quant = model.forecast(horizon=60, inputs=[np.ndarray, ...])`.
- Shapes: `point` is `(batch, 60)` and equals the median. `quant` is `(batch, 60, 10)`: index 0 is the mean, indexes
  1-9 are the deciles q10 ... q90.
- Speed on CPU: load about 3 s once cached, one series about 145 ms, 32 series about 2.6 s.
- A snapshot file in `jev/history` has `timestamp` (ISO, UTC), `coin`, `spot_price`, `open_price` (1H open) and
  `model_inputs: { s0, sa, sa5, st, t }` where `sa` is the 15m window open and `sa5` the 5m window open. Records from
  before 2026-09-26 have none of the price fields.
- The 5m, 15m and 1H market windows are aligned to UTC multiples of 300 s, 900 s and 3600 s.

## Review Focus

1. Service stopped or not installed: `/api/jev/history` with no `jev/tfm/forecasts.jsonl` returns rows with every
   `tfm_*` field null and no error (test in Task 7); `/api/updown/tfm` answers 200 with `service.ok = false` (Task 5).
2. No look-ahead: the close of the minute that contains the snapshot time is never in the context (test in Task 2).
3. A half-written last line in `forecasts.jsonl` is skipped, not a crash (test in Task 4).
4. Legacy snapshots without spot or open prices still get a forecast from closed bars and kline opens (test in Task 4).
5. The last seconds of a window (`minutesLeft` under 1) and the exact window boundary give a finite probability inside
   0.001-0.999 (tests in Task 1).

## File map

| File | Responsibility |
|---|---|
| `tfm/server.py`, `tfm/requirements.txt`, `tfm/README.md` | the model service |
| `src/lib/tfm/types.ts` | shared types and the decile levels |
| `src/lib/tfm/math.ts` | windows, deciles to probability (pure) |
| `src/lib/tfm/series.ts` | context as of a time, window opens (pure) |
| `src/lib/tfm/klines.ts` | Binance 1-minute bars |
| `src/lib/tfm/client.ts` | HTTP client of the service |
| `src/lib/tfm/service.ts` | "is it installed, is it up, start it once" |
| `src/lib/tfm/store.ts` | `jev/tfm/forecasts.jsonl`, row fields |
| `src/lib/tfm/snapshot.ts` | forecast a batch of snapshots |
| `src/app/api/updown/tfm/route.ts` | live forecast for the tab |
| `src/components/updown/TfmForecastTab.tsx` | the tab |
| `scripts/backfill_tfm.ts` | forecasts for existing history files |

---

### Task 1: Types and math

**Files:** Create `src/lib/tfm/types.ts`, `src/lib/tfm/math.ts`. Test: `test/tfmMath.test.ts`.

**Interfaces (produces):**

```ts
// types.ts
export const TFM_QUANTILE_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const TFM_HORIZON = 60;        // minutes forecast on every call
export const TFM_MAX_CONTEXT = 1024;  // 1-minute points sent to the model
export const TFM_MIN_CONTEXT = 256;
export type TfmWindowKey = 'h1' | 'm15' | 'm5';
export interface MinuteBar { openTime: number; open: number; close: number } // openTime in ms
export interface TfmWindowForecast { open: number; minutesLeft: number; probUp: number; median: number; q10: number; q90: number }
export interface TfmRecord {
  file: string; coin: string; ts: string; model: string; context: number; last: number;
  h1: TfmWindowForecast | null; m15: TfmWindowForecast | null; m5: TfmWindowForecast | null;
  source: 'live' | 'backfill';
}
// math.ts
export function windowsAt(tMs: number): Record<TfmWindowKey, { startMs: number; endMs: number; minutesLeft: number }>;
export function probAtOrAbove(level: number, last: number, deciles: number[], scale?: number): number;
export function windowForecast(a: { open: number; last: number; minutesLeft: number; quantiles: number[][] }): TfmWindowForecast;
```

- [ ] **Step 1: Write the failing tests** in `test/tfmMath.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { normInv } from '@/lib/normal';
import { TFM_QUANTILE_LEVELS } from '@/lib/tfm/types';
import { probAtOrAbove, windowForecast, windowsAt } from '@/lib/tfm/math';

const Z = TFM_QUANTILE_LEVELS.map((q) => normInv(q));
const deciles = (last: number, sigma: number) => Z.map((z) => last * Math.exp(sigma * z));

describe('probAtOrAbove', () => {
  const d = deciles(100, 0.004);
  it('reads a normal forecast exactly, inside and outside the deciles', () => {
    expect(probAtOrAbove(100, 100, d)).toBeCloseTo(0.5, 4);
    expect(probAtOrAbove(100 * Math.exp(0.004), 100, d)).toBeCloseTo(0.158655, 3);
    expect(probAtOrAbove(100 * Math.exp(-0.008), 100, d)).toBeCloseTo(0.97725, 3);
  });
  it('shrinks the spread with scale', () => {
    expect(probAtOrAbove(100 * Math.exp(0.002), 100, d, 0.5)).toBeCloseTo(0.158655, 3);
  });
  it('stays inside 0.001-0.999 and finite on extreme or flat input', () => {
    expect(probAtOrAbove(100 * Math.exp(0.1), 100, d)).toBe(0.001);
    expect(probAtOrAbove(100 * Math.exp(-0.1), 100, d)).toBe(0.999);
    const flat = probAtOrAbove(100.01, 100, Array(9).fill(100));
    expect(Number.isFinite(flat) && flat >= 0.001 && flat <= 0.999).toBe(true);
  });
});

describe('windowsAt', () => {
  it('finds the three UTC-aligned windows and the minutes left', () => {
    const w = windowsAt(Date.parse('2026-11-05T19:34:28.881Z'));
    expect(w.h1.startMs).toBe(Date.parse('2026-11-05T19:00:00.000Z'));
    expect(w.h1.endMs).toBe(Date.parse('2026-11-05T20:00:00.000Z'));
    expect(w.h1.minutesLeft).toBeCloseTo(25.51865, 4);
    expect(w.m15.startMs).toBe(Date.parse('2026-11-05T19:30:00.000Z'));
    expect(w.m15.minutesLeft).toBeCloseTo(10.51865, 4);
    expect(w.m5.endMs).toBe(Date.parse('2026-11-05T19:35:00.000Z'));
    expect(w.m5.minutesLeft).toBeCloseTo(0.51865, 4);
  });
  it('puts an exact boundary in the new window', () => {
    const w = windowsAt(Date.parse('2026-11-05T19:35:00.000Z'));
    expect(w.m5.startMs).toBe(Date.parse('2026-11-05T19:35:00.000Z'));
    expect(w.m5.minutesLeft).toBe(5);
  });
});

describe('windowForecast', () => {
  const last = 76000;
  const quantiles = Array.from({ length: 60 }, (_, i) => deciles(last, 0.0005 * Math.sqrt(i + 1)));
  it('uses the step that covers the time left, scaled by the square root of time', () => {
    const m = 25.51865;
    const even = windowForecast({ open: last, last, minutesLeft: m, quantiles });
    expect(even.probUp).toBeCloseTo(0.5, 4);
    expect(even.median).toBeCloseTo(last, 4);
    expect(Math.log(even.q10 / last)).toBeCloseTo(-0.0005 * Math.sqrt(m) * 1.2815516, 6);
    const ahead = windowForecast({ open: last * Math.exp(-0.0005 * Math.sqrt(m)), last, minutesLeft: m, quantiles });
    expect(ahead.probUp).toBeCloseTo(0.841345, 3);
    expect(ahead.minutesLeft).toBe(m);
  });
  it('handles the last seconds of a window and a time beyond the horizon', () => {
    expect(windowForecast({ open: last, last, minutesLeft: 0.51865, quantiles }).probUp).toBeCloseTo(0.5, 4);
    const far = windowForecast({ open: last, last, minutesLeft: 75, quantiles });
    expect(Math.log(far.q90 / last)).toBeCloseTo(0.0005 * Math.sqrt(60) * Math.sqrt(75 / 60) * 1.2815516, 6);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/tfmMath.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** `probAtOrAbove`: work in log-return space `y_i = ln(deciles[i] / last) * scale` with
  probit knots `z_i = normInv(level_i)`. Force `y` strictly increasing (`y_i = max(y_i, y_{i-1} + 1e-9)`). Find `z*` for
  `y* = ln(level / last)` by linear interpolation of `z` over `y`, extending the first and last segment as straight
  lines beyond the ends. Return `1 - normCdf(z*)` clamped to `[0.001, 0.999]`. `windowForecast`: step
  `k = min(quantiles.length, max(1, ceil(minutesLeft)))`, `scale = sqrt(minutesLeft / k)`, `probUp =
  probAtOrAbove(open, last, quantiles[k - 1], scale)`, and `median`, `q10`, `q90` are `last * exp(ln(q / last) * scale)`
  for deciles 5, 1 and 9. `windowsAt` floors `tMs` to 3,600,000 / 900,000 / 300,000 ms.
- [ ] **Step 4:** Run `npx vitest run test/tfmMath.test.ts`. Expected: PASS.

### Task 2: Context and bars

**Files:** Create `src/lib/tfm/series.ts`, `src/lib/tfm/klines.ts`. Test: `test/tfmSeries.test.ts`.

**Interfaces (produces):**

```ts
// series.ts
export function contextAsOf(bars: MinuteBar[], tMs: number, spot: number | null, maxLen?: number): number[];
export function openAt(bars: MinuteBar[], startMs: number): number | null;
// klines.ts
export const TFM_SYMBOLS: Record<string, { symbol: string; futures: boolean }>; // btc, eth, sol, xrp, doge, bnb spot; hype futures
export async function fetchMinuteBars(coin: string, fromMs: number, toMs: number): Promise<MinuteBar[]>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { contextAsOf, openAt } from '@/lib/tfm/series';

const bars = (n: number) => Array.from({ length: n }, (_, m) => ({ openTime: m * 60_000, open: 100 + m - 0.5, close: 100 + m }));

describe('contextAsOf', () => {
  it('keeps only bars that closed by the time, then the spot price', () => {
    const t = 5 * 60_000 + 28_000; // inside bar 5
    expect(contextAsOf(bars(10), t, 104.7)).toEqual([100, 101, 102, 103, 104, 104.7]);
    expect(contextAsOf(bars(10), t, null)).toEqual([100, 101, 102, 103, 104]);
    expect(contextAsOf(bars(10), t, 104.7)).not.toContain(105); // bar 5 closes after t
  });
  it('counts a bar that closes exactly at the time', () => {
    expect(contextAsOf(bars(10), 5 * 60_000, null)).toEqual([100, 101, 102, 103, 104]);
  });
  it('keeps the most recent maxLen points', () => {
    const c = contextAsOf(bars(2000), 1500 * 60_000 + 1, 9999, 1024);
    expect(c.length).toBe(1024);
    expect(c[1023]).toBe(9999);
    expect(c[1022]).toBe(100 + 1499);
    expect(c[0]).toBe(100 + 1499 - 1022);
  });
  it('ignores a spot price that is not a positive number', () => {
    expect(contextAsOf(bars(10), 5 * 60_000, NaN)).toEqual([100, 101, 102, 103, 104]);
    expect(contextAsOf(bars(10), 5 * 60_000, 0)).toEqual([100, 101, 102, 103, 104]);
  });
});

describe('openAt', () => {
  it('returns the open of the bar that starts at that time, or null', () => {
    expect(openAt(bars(10), 3 * 60_000)).toBe(102.5);
    expect(openAt(bars(10), 3 * 60_000 + 1000)).toBeNull();
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/tfmSeries.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `bars` are sorted by `openTime`. Find the last closed bar (`openTime + 60000 <= tMs`) with
  a binary search, not a scan: the backfill calls this 18,000 times on 67,000 bars. `maxLen` defaults to
  `TFM_MAX_CONTEXT`. `fetchMinuteBars` pages `GET {host}/klines?symbol=..&interval=1m&startTime=..&limit=1000` until
  `toMs` (spot host `https://api.binance.com/api/v3`, futures host `https://fapi.binance.com/fapi/v1`), 8 s timeout per
  request, 3 tries, returns ascending bars without duplicates, and `[]` for a coin not in `TFM_SYMBOLS`.
- [ ] **Step 4:** Run `npx vitest run test/tfmSeries.test.ts`. Expected: PASS.

### Task 3: The Python service, its client and its launcher

**Files:** Create `tfm/server.py`, `tfm/requirements.txt` (`timesfm[torch]==3.0.2`), `tfm/README.md`,
`src/lib/tfm/client.ts`, `src/lib/tfm/service.ts`. Modify `package.json` (scripts), `.gitignore`. Test:
`test/tfmService.test.ts`.

**Interfaces (produces):**

```
GET  /health    -> 200 {"ok": true, "model": "google/timesfm-2.5-200m-pytorch", "max_context": 1024, "max_horizon": 64}
POST /forecast  body {"series": [[number, ...], ...], "horizon": 60}
                -> 200 {"model": "...", "horizon": 60, "quantile_levels": [0.1, ..., 0.9],
                        "mean": [[60 numbers] per series], "quantiles": [[[9 numbers] x 60] per series]}
                -> 400 {"error": "..."} for: no series, more than 64 series, a series shorter than 32 points,
                       a value that is not a finite number above 0, horizon outside 1..max_horizon
```

```ts
// client.ts
export const TFM_URL: string; // process.env.TFM_URL || 'http://127.0.0.1:8002'
export async function tfmHealth(timeoutMs?: number): Promise<{ ok: boolean; model?: string }>; // default 1500 ms, never throws
export async function tfmForecast(series: number[][], horizon: number, timeoutMs?: number):
  Promise<{ model: string; mean: number[][]; quantiles: number[][][] } | null>;             // default 60 s, null on any failure
// service.ts
export type TfmServiceState = 'ready' | 'starting' | 'offline' | 'not-installed';
export interface TfmServiceDeps { health: () => Promise<{ ok: boolean }>; installed: () => boolean; spawnServer: () => void; now: () => number; autostart: boolean }
export function tfmInstalled(): boolean; // tfm/.venv/bin/python and tfm/server.py both exist under process.cwd()
export async function ensureTfmService(deps?: Partial<TfmServiceDeps>): Promise<TfmServiceState>;
export function resetTfmServiceForTests(): void;
```

- [ ] **Step 1: Write `tfm/server.py`** with the standard library only (`http.server.ThreadingHTTPServer`, `json`) plus
  `timesfm`, `numpy`. Settings from the environment: `TFM_HOST` (127.0.0.1), `TFM_PORT` (8002), `TFM_MODEL`
  (`google/timesfm-2.5-200m-pytorch`), `TFM_MAX_CONTEXT` (1024), `TFM_MAX_HORIZON` (64), `TFM_BATCH` (16). Load and
  compile the model once at start as in "Verified facts". A series longer than `TFM_MAX_CONTEXT` is cut to its last
  points. One lock around `model.forecast`. Map the output: `mean = quant[..., 0]`, `quantiles = quant[..., 1:10]`.
  Print `[tfm] ready on http://127.0.0.1:8002 model=<id> load=<s>s` when it can serve. Bind to `TFM_HOST` only.
- [ ] **Step 2: Check it by hand.** Start `tfm/.venv/bin/python tfm/server.py`, wait for the ready line, then run:

```bash
node -e "fetch('http://127.0.0.1:8002/health').then(r=>r.json()).then(console.log)"
node -e "const s=Array.from({length:600},(_,i)=>100+Math.sin(i/20));fetch('http://127.0.0.1:8002/forecast',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({series:[s,s],horizon:60})}).then(r=>r.json()).then(d=>console.log(d.mean.length,d.mean[0].length,d.quantiles[0][0].length,d.quantiles[0][59][0]<d.quantiles[0][59][8]))"
node -e "fetch('http://127.0.0.1:8002/forecast',{method:'POST',body:JSON.stringify({series:[[1,2]],horizon:60})}).then(r=>console.log(r.status))"
```

  Expected: `{ ok: true, ... }`, then `2 60 9 true`, then `400`. Leave the service running for the later tasks.
- [ ] **Step 3: Add the scripts** to `package.json`:
  `"tfm:setup": "uv venv --python 3.12 tfm/.venv && uv pip install --python tfm/.venv/bin/python -r tfm/requirements.txt"`,
  `"tfm": "tfm/.venv/bin/python tfm/server.py"`, `"backfill:tfm": "tsx scripts/backfill_tfm.ts"`. Add `/tfm/.venv/`
  and `__pycache__/` to `.gitignore`. `tfm/README.md`: what the service is, the three commands, the port and
  environment variables, and the licence note from Global Constraints.
- [ ] **Step 4: Write the failing tests** for the launcher

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureTfmService, resetTfmServiceForTests } from '@/lib/tfm/service';

const deps = (over: Record<string, unknown> = {}) => {
  const spawnServer = vi.fn();
  let t = 1_000_000;
  return { spawnServer, tick: (ms: number) => { t += ms; },
    d: { health: async () => ({ ok: false }), installed: () => true, spawnServer, now: () => t, autostart: true, ...over } };
};

describe('ensureTfmService', () => {
  beforeEach(() => resetTfmServiceForTests());
  it('does nothing when the service answers', async () => {
    const x = deps({ health: async () => ({ ok: true }) });
    expect(await ensureTfmService(x.d)).toBe('ready');
    expect(x.spawnServer).not.toHaveBeenCalled();
  });
  it('never starts what is not installed, or when autostart is off', async () => {
    const a = deps({ installed: () => false });
    expect(await ensureTfmService(a.d)).toBe('not-installed');
    const b = deps({ autostart: false });
    expect(await ensureTfmService(b.d)).toBe('offline');
    expect(a.spawnServer).not.toHaveBeenCalled();
    expect(b.spawnServer).not.toHaveBeenCalled();
  });
  it('starts it once, and again only after 90 seconds without an answer', async () => {
    const x = deps();
    expect(await ensureTfmService(x.d)).toBe('starting');
    expect(await ensureTfmService(x.d)).toBe('starting');
    expect(x.spawnServer).toHaveBeenCalledTimes(1);
    x.tick(91_000);
    expect(await ensureTfmService(x.d)).toBe('starting');
    expect(x.spawnServer).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 5:** Run `npx vitest run test/tfmService.test.ts`. Expected: FAIL.
- [ ] **Step 6: Implement `client.ts` and `service.ts`.** The real `spawnServer` runs `tfm/.venv/bin/python
  tfm/server.py` with `cwd` at the project root, `detached: true`, output appended to `logs/tfm.log` (create `logs/` if
  missing), then `unref()`. The real `autostart` is `process.env.TFM_AUTOSTART !== '0'`. The time of the last start is
  module state.
- [ ] **Step 7:** Run `npx vitest run test/tfmService.test.ts`. Expected: PASS.

### Task 4: Store and snapshot forecasts

**Files:** Create `src/lib/tfm/store.ts`, `src/lib/tfm/snapshot.ts`. Tests: `test/tfmStore.test.ts`,
`test/tfmSnapshot.test.ts`.

**Interfaces (consumes):** Task 1 types and math, Task 2 `contextAsOf`, `openAt`, `fetchMinuteBars`, Task 3
`tfmForecast`, `tfmHealth`.

**Interfaces (produces):**

```ts
// store.ts
export function tfmStorePath(): string; // <cwd>/jev/tfm/forecasts.jsonl
export function appendTfmRecords(records: TfmRecord[]): void;
export function loadTfmStore(): Map<string, TfmRecord>; // key = TfmRecord.file, the last line for a file wins
export interface TfmRowFields {
  tfm_direction: 'UP' | 'DOWN' | null; tfm_score: number | null; tfm_prob_up: number | null;
  tfm_score_confidence: number | null; tfm_direction_confidence: number | null; tfm_confidence: number | null;
  tfm_up_15m: number | null; tfm_up_5m: number | null; tfm_ret_1h: number | null;
}
export function tfmRowFields(rec: TfmRecord | undefined): TfmRowFields;
// snapshot.ts
export interface SnapshotInput { file: string; coin: string; tsMs: number; spot: number | null; open1h: number | null; open15m: number | null; open5m: number | null }
export function snapshotInputOf(file: string, content: any): SnapshotInput | null;
export async function forecastSnapshots(inputs: SnapshotInput[], barsOf: (coin: string) => MinuteBar[], source: 'live' | 'backfill',
  forecast?: typeof tfmForecast): Promise<TfmRecord[]>;
export async function recordTfmForSnapshot(file: string, content: any): Promise<'saved' | 'skipped'>; // never throws
```

Row field rules (`p` = `h1.probUp`): `tfm_prob_up = Number((p * 100).toFixed(1))`, `tfm_direction = p >= 0.5 ? 'UP' :
'DOWN'`, `tfm_score = Number((4 * p).toFixed(2))`, the three confidences `= Math.round(Math.max(p, 1 - p) * 100)`,
`tfm_up_15m` / `tfm_up_5m` = the same percentage of `m15` / `m5`, `tfm_ret_1h = Number(((h1.median / last - 1) *
100).toFixed(3))`. No record, or `h1` null: the 1H fields are null.

- [ ] **Step 1: Write the failing store tests.** Use a temp directory and `vi.spyOn(process, 'cwd')` as
  `test/jevHistoryApi.test.ts` does. Assert, with `const rec = (file, p) => ({ file, coin: 'BTC', ts:
  '2026-10-02T14:00:00.000Z', model: 'm', context: 1024, last: 100, h1: { open: 99, minutesLeft: 20, probUp: p, median:
  100.05, q10: 99.5, q90: 100.6 }, m15: { open: 99, minutesLeft: 5, probUp: 0.6, median: 100, q10: 99.8, q90: 100.2 },
  m5: null, source: 'backfill' })`:
  - missing file: `loadTfmStore().size === 0`;
  - after `appendTfmRecords([rec('a.json', 0.8126), rec('b.json', 0.3)])`: size 2;
  - after `appendTfmRecords([rec('a.json', 0.9)])`: `loadTfmStore().get('a.json')!.h1!.probUp === 0.9`, size still 2;
  - after appending the raw text `{"file":"c.json","coin` (no newline end) to the file: size still 2, no throw;
  - `tfmRowFields(rec('a.json', 0.8126))` equals `{ tfm_direction: 'UP', tfm_score: 3.25, tfm_prob_up: 81.3,
    tfm_score_confidence: 81, tfm_direction_confidence: 81, tfm_confidence: 81, tfm_up_15m: 60, tfm_up_5m: null,
    tfm_ret_1h: 0.05 }`;
  - `tfmRowFields(rec('b.json', 0.3))` has `tfm_direction: 'DOWN'`, `tfm_score: 1.2`, `tfm_prob_up: 30`,
    `tfm_confidence: 70`;
  - `tfmRowFields(undefined)` has every field null.
- [ ] **Step 2: Write the failing snapshot tests.** Bars: 2,000 one-minute bars ending after the snapshot time, built so
  that `close = 50000 + m` and `open = close - 0.5`. A fake `forecast(series, horizon)` records its arguments and returns
  for every series `quantiles[k] = deciles(last, 0.0005 * sqrt(k + 1))` (as in Task 1) and `mean = last`. Assert:
  - `snapshotInputOf('btc_updown_x.json', { timestamp: '2026-11-05T19:34:28.881Z', coin: 'BTC', spot_price: 76142,
    open_price: 76090.01, model_inputs: { sa: 76034.01, sa5: 76030 } })` equals `{ file: 'btc_updown_x.json', coin:
    'BTC', tsMs: Date.parse('2026-11-05T19:34:28.881Z'), spot: 76142, open1h: 76090.01, open15m: 76034.01, open5m:
    76030 }`; a content without `timestamp` gives `null`; a content without `coin` takes it from the file name prefix
    in upper case;
  - `forecastSnapshots` with two inputs (one with spot and opens, one legacy with all four null) calls `forecast` once
    with two series and horizon 60; the first series ends with the spot, the second with the last closed close; the
    legacy record's `h1.open` equals `openAt(bars, hourStart)`; both records carry `file`, upper-case `coin`, ISO `ts`,
    `source`, `context` (the series length), `last`;
  - an input whose context has fewer than 256 points is left out of the call and of the result;
  - when `forecast` returns `null` the result is `[]`.
- [ ] **Step 3:** Run `npx vitest run test/tfmStore.test.ts test/tfmSnapshot.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** `loadTfmStore` caches the parsed map in module state and re-reads only when the file's size
  or `mtimeMs` changed; it skips lines that do not parse. `forecastSnapshots`: one context per input with
  `contextAsOf(barsOf(coin), tsMs, spot)`; `last` is the final context value; each window's open is the snapshot's own
  value, else `openAt(bars, windowStart)`, else the window is `null`; `model` is the name the service returned.
  `recordTfmForSnapshot`: returns `'skipped'` unless `tfmHealth()` is ok; fetches bars for `[tsMs - 1030 min, tsMs]`,
  forecasts with source `'live'`, appends; the whole call is capped at 10 s and catches every error.
- [ ] **Step 5:** Run the two test files. Expected: PASS.

### Task 5: Live route

**Files:** Create `src/app/api/updown/tfm/route.ts`. Test: `test/tfmApi.test.ts`.

**Interfaces (produces):** `GET /api/updown/tfm?coin=btc` answers 200 with

```ts
{ coin: string; serverTime: number /* s */;
  service: { ok: boolean; state: TfmServiceState; latencyMs: number | null; model: string | null };
  context: number | null; last: number | null;
  windows: Record<TfmWindowKey, (TfmWindowForecast & { endSec: number }) | null> | null;
  path: { step: number; mean: number; q: number[] }[] | null;   // 60 steps, q = 9 deciles
  history: number[] | null }                                     // the last 60 context values
```

and 400 `{ error: 'unknown coin' }` for a coin not in `TFM_SYMBOLS`.

- [ ] **Step 1: Write the failing tests.** Mock `@/lib/tfm/klines` (`fetchMinuteBars` returns 1,000 bars ending at the
  current minute), `@/lib/tfm/service` (`ensureTfmService`) and `@/lib/tfm/client` (`tfmForecast` as the fake of
  Task 4). Assert: state `'ready'` gives `service.ok === true`, `path.length === 60`, `history.length === 60`,
  `windows.h1.probUp` between 0 and 1, `windows.m5.endSec % 300 === 0`; state `'not-installed'` gives 200,
  `service.ok === false`, `service.state === 'not-installed'`, `windows === null`, and `tfmForecast` was not called;
  `tfmForecast` returning `null` gives `service.ok === false` with state `'offline'`; `?coin=zzz` gives 400.
- [ ] **Step 2:** Run `npx vitest run test/tfmApi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `export const dynamic = 'force-dynamic'`. One Binance request (`now - 1000 min` to `now`).
  The spot is the close of the newest bar; the context is `contextAsOf(bars, now, spot)`; opens come from `openAt`.
  Keep the last answer per coin in module state for 10 s so several open tabs make one forecast.
- [ ] **Step 4:** Run the test. Expected: PASS. With the service from Task 3 still running, open
  `http://127.0.0.1:8000/api/updown/tfm?coin=btc` (the owner's dev server reloads by itself) and check `service.ok`.

### Task 6: The tab

**Files:** Create `src/components/updown/TfmForecastTab.tsx`. Modify `src/app/updown/page.tsx`.

- [ ] **Step 1: Add the tab bar** to `src/app/updown/page.tsx`, directly under the three market cards: two buttons,
  "Overview" and "TFM Forecast". State `tab: 'overview' | 'tfm'`, read once from `location.hash === '#tfm'` in an
  effect and written back to the hash on change. Everything now below the market cards (from the "Jev Decision Model"
  card to the end) renders only for `overview`; `tfm` renders `<TfmForecastTab coin={coin} data={data} />`. The clock
  bar, the coin selector and the three market cards stay visible in both tabs. Change nothing else in that file.
- [ ] **Step 2: Build `TfmForecastTab`** (client component, props `{ coin: string; data: any }`, where `data` is the
  page's `/api/updown` answer). It polls `/api/updown/tfm?coin=<coin>` every 15 s and on coin change. It shows:
  1. A status line: "TimesFM 2.5 (200M)", a dot with ready / starting / offline / not installed, the latency, the
     context length. For `starting`: "Loading the model, about 20 seconds". For `offline`: the command `npm run tfm`.
     For `not-installed`: the commands `npm run tfm:setup` then `npm run tfm`.
  2. Three cards, 1H, 15m and 5m. Each: the window's open price ("price to beat"), the current price, the time left
     (mm:ss, counting down every second), the forecast close (median) with its 10-90% range, the TimesFM P(Up) as the
     large number in cents, the market Up price (`data.m1h.live`, `data.m15.live`, `data.m5.live`), and the edge
     (TimesFM minus market) coloured green above +3¢ and red below -3¢, as the Claude panel does. The 1H card also
     lists `data.modelClaude?.fairUp` and `data.modelA?.fairUp` for comparison.
  3. A fan chart in plain SVG (no library): the last 60 minutes of prices, then the median path for the next 60
     minutes with a 10-90% band and a darker 30-70% band, dashed horizontal lines at the three window opens and
     vertical marks where the 5m, 15m and 1H windows end.
  4. A table for +5, +15 and +60 minutes from now: median, 10% and 90% prices, the median move in percent, and the
     probability of ending above the current price.
  5. One line of small print: "TimesFM is a general time-series model. Its edge against the market is not validated."
- [ ] **Step 3:** Run `npx tsc --noEmit` and `npm run lint`. Open `http://127.0.0.1:8000/updown#tfm`, switch coins and
  tabs, and check the page with the service stopped and started again.

### Task 7: History rows, signal model and filter fields

**Files:** Modify `src/app/api/jev/history/route.ts`, `src/lib/signalAnalysis.ts` (only `ModelSource`, `SnapshotRow`,
`detectSignal`), `src/lib/snapshotFilterFields.ts`. Tests: extend `test/jevHistoryApi.test.ts`,
`test/signalAnalysis.test.ts`, `test/snapshotFilterFields.test.ts`.

**Interfaces (produces):** every history row carries the nine `TfmRowFields`. `ModelSource` gains `"tfm"`.
`snapshotFilterFields` gains, in a group "TimesFM": the model fields from `model("TimesFM", "TFM", "tfm_", conf3)`,
`tfm_up_15m`, `tfm_up_5m` (unit `%`), `tfm_ret_1h` (unit `%`), and three edges in cents: `tfm_edge` (`tfm_prob_up -
up_1h_num`), `tfm_edge_15m` (`tfm_up_15m - up_15m_num`), `tfm_edge_5m` (`tfm_up_5m - up_5m_num`). It exports
`tfmEdge(r: FilterableRow): number | null` for the first one, built like `claudeEdge`. `tradeFilterFields` gains
`trade_tfm_prob` ("TFM probability of side bought", `%`: `tfm_prob_up` for UP, `100 - tfm_prob_up` for DOWN) and
`trade_tfm_edge` ("TFM edge toward the trade", `¢`: that probability minus `quote * 100`, two decimals, null when either
is missing).

- [ ] **Step 1: Write the failing tests.**
  - `jevHistoryApi.test.ts`: write `jev/tfm/forecasts.jsonl` in the temp root with one record for
    `btc_updown_2026-10-02_10-00-00_ET.json` (`h1.probUp` 0.8126). The default request's row has `tfm_prob_up: 81.3`,
    `tfm_direction: 'UP'`, `tfm_score: 3.25`. With `?set=cl`, the row `CL-btc_updown_2026-10-02_10-00-00_ET.json` has
    the same values and the ETH row has `tfm_prob_up: null`. A second `describe` with a temp root that has no `jev/tfm`
    folder returns its row with `tfm_prob_up: null` and status 200.
  - `signalAnalysis.test.ts`: `detectSignal(row({ tfm_score: 3.4, tfm_score_confidence: 85 }), cfg({ model: 'tfm',
    bullishScore: 3.25, bullishMinConf: 80 }))?.dir` is `'UP'`; with `tfm_score` missing it is `null`.
  - `snapshotFilterFields.test.ts`: `tfmEdge(row({ tfm_prob_up: 62.5, up_1h_num: 55 }))` is `7.5` and null without
    either; the ids `tfm_score`, `tfm_prob_up`, `tfm_edge`, `tfm_edge_15m`, `tfm_up_5m`, `tfm_ret_1h` exist; for a
    trade `{ dir: 'DOWN', quote: 0.7, row: { tfm_prob_up: 20 } }`, `trade_tfm_prob` is `80` and `trade_tfm_edge` is
    `10`.
- [ ] **Step 2:** Run the three test files. Expected: the new cases FAIL, the old ones PASS.
- [ ] **Step 3: Implement.** In the route call `loadTfmStore()` once per request and spread `tfmRowFields(store.get(isCl
  ? f.replace(/^CL-/, '') : f))` into each row. In `detectSignal` add the `tfm` branch next to `liquid` (`score =
  r.tfm_score`, confidence as for `liquid`). Do not touch `agreeCount`, the consensus, or any frozen rule.
- [ ] **Step 4:** Run `npx vitest run`. Expected: every test passes.

### Task 8: Analysis pages

**Files:** Modify `src/app/jev-analysis/page.tsx`, `src/app/cloud-analysis/page.tsx`,
`src/components/jev-lab/StrategyLab.tsx`.

- [ ] **Step 1: `jev-analysis/page.tsx`.** Mirror what the file does for `liquid` and for `fair_claude` /
  `claude_edge`:
  - `JevFileRecord`: the nine `TfmRowFields`.
  - `SignalMarkerConfig.modelSource`: add `"tfm"`; `evaluateSignal`: a `tfm` branch (model name "TimesFM"); the
    "AI model for signal basis" select: `<option value="tfm">TimesFM model (score = 4 × prob UP)</option>`.
  - `ALL_COLUMNS`: `tfm_direction` and `tfm_score` (as the `liquid_*` pair), `...extraModelColumns("tfm", "TimesFM",
    "TFM", "#5ad1e6")` (widen its prefix type), `tfm_up_15m`, `tfm_up_5m`, `tfm_ret_1h`, and `tfm_edge` (as
    `claude_edge`, using `tfmEdge`, with `sortVal`).
  - `COLUMN_GROUPS`: a group `{ id: "tfm", title: "TimesFM", dot: "#5ad1e6" }` listing those columns.
  - `PRESETS`: `{ id: "tfm", title: "TimesFM", cols: ["coin", "signal", "signal_result", "direction", "score",
    "tfm_direction", "tfm_score", "tfm_prob_up", "tfm_edge", "up_1h", "market_outcome"] }`.
  - `buildFilterFields`: one more lead field `{ id: "signal_tfm_edge", label: "TFM edge toward the signal", group:
    "Signal", kind: "number", unit: "¢" }`: for an UP signal `tfm_prob_up - up_1h_num`, for a DOWN signal `up_1h_num -
    tfm_prob_up`, null with no signal or a missing value.
- [ ] **Step 2: `cloud-analysis/page.tsx`.** Add `{ value: "tfm", label: "TimesFM" }` to the model picker before "Avg
  of 3", and `"trade_tfm_edge"` to `QUICK_FILTER_FIELDS`.
- [ ] **Step 3: `StrategyLab.tsx`.** Add `tfm: "TimesFM"` to `MODEL_NAMES`.
- [ ] **Step 4:** Run `npx tsc --noEmit` (it finds any other place that lists every `ModelSource`), `npm run lint`,
  `npx vitest run`. Open `http://127.0.0.1:8000/jev-analysis`: the TimesFM preset shows the columns (empty until the
  backfill has run), the filter panel offers the TimesFM group, and choosing TimesFM as the signal model does not
  error.

### Task 9: Collector hook and backfill

**Files:** Create `scripts/backfill_tfm.ts`. Modify `scripts/jev.ts` (one call), `README.md` (one section).

- [ ] **Step 1: Collector.** In `scripts/jev.ts`, inside `if (!skippedDuplicate) { ... }` and after the existing log
  line, add a call that is not awaited: `void recordTfmForSnapshot(filename, snapshot).then((r) => { if (r === 'saved')
  console.log(...) })`. It must not delay or stop the loop: no `await`, and `recordTfmForSnapshot` never throws.
- [ ] **Step 2: Backfill.** `npm run backfill:tfm -- [--coin=btc] [--since=YYYY-MM-DD] [--limit=N] [--batch=16]
  [--force]`. It exits with code 1 and one clear line when `tfmHealth()` is not ok. It lists `jev/history/*.json`,
  takes the coin from the file name, drops files already in the store (unless `--force`) and coins not in
  `TFM_SYMBOLS` (it prints how many), reads each file into a `SnapshotInput`, and for each coin fetches the bars once
  for `[first snapshot - 1030 min, last snapshot]`, then forecasts in time order in batches and appends after every
  batch, so a stopped run resumes where it ended. It prints progress every 500 records and a final count with the
  records per second.
- [ ] **Step 3: Try it:** `npm run backfill:tfm -- --coin=btc --limit=40`. Expected: 40 lines in
  `jev/tfm/forecasts.jsonl`; a second run of the same command adds the next 40, not the same ones. Do not run the full
  backfill: the manager runs it.
- [ ] **Step 4: README.** A section "TimesFM forecast (TFM)": what it is, `npm run tfm:setup`, `npm run tfm`, `npm run
  backfill:tfm`, where the tab and the analysis columns are, that the service is local only, and the licence note.

### Task 10: Final checks and report

- [ ] **Step 1:** Run `npx tsc --noEmit`, `npx vitest run`, `npm run lint`. All clean, or only the lint errors that
  existed before.
- [ ] **Step 2:** Run `git status --short` and `git diff --stat`. Confirm no file from the "Do not modify" list changed
  and nothing was committed.
- [ ] **Step 3:** Write the report file named in the build brief: the files created and changed, the last lines of the
  three check commands, what you verified by hand in the browser, anything you could not do or did differently from
  this plan and why.
