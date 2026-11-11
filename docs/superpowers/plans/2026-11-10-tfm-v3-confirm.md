# TFM v3, 30-second refresh, TimesFM as confirmer in Strategy Lab and Cloud Analysis

> For agentic workers: two builders work in parallel on disjoint files. Part A = Tasks A1-A4, Part B = Tasks B1-B3.
> Each builder does only its own part. Steps use checkbox syntax. Write the tests first.

**Goal:** (1) TimesFM 3.0 instead of 2.5 (2.5 stays selectable). (2) The TFM tab refreshes every 30 s or 1 min and
shows how TimesFM's P(Up) moved during the hour. (3) In `/jev-analysis/v2` (Strategy Lab) and `/cloud-analysis`,
TimesFM can be the signal model (already possible: model `tfm`) and a confirmer of any other model's signal, and
both work in backtests and in the Strategy Lab optimizer.

**Background:** read `docs/superpowers/plans/2026-11-10-tfm-forecast.md` ("What is being built", "Global Constraints",
"Verified facts") and the existing code in `src/lib/tfm/`. Everything in that plan is built and working.

## Global Constraints (in addition to the first plan's)

- Next.js 16.3.4: read the matching guide in `node_modules/next/dist/docs/` before editing a route or a client
  component (`AGENTS.md`).
- No `git commit`/`push`/`stash`/`reset`/`checkout`, no branch changes. Leave everything uncommitted.
- Do not stop, restart or start a Next.js server; the owner's `next dev` runs on port 8000 and reloads by itself.
- Do not touch: `src/lib/bot/**`, `scripts/bot.ts`, `src/lib/forwardSnapshot.ts`, `.env*`, `*.db`, the data folders
  `jev/history`, `jev/cl`, `public/jev`, `ticks`, and the data files under `jev/tfm/` (the manager migrates them).
- Frozen strategies (`STRATEGY_HISTORY`, `FROZEN_STRATEGY*`) must keep producing exactly the same trades.
- New config fields default to "off". With the TimesFM service stopped, every page works as before.
- Checks at the end: `npx tsc --noEmit` clean, `npx vitest run` all pass (45 files, 474 tests now), `npm run lint`
  adds nothing (214 problems now).

## Verified facts (checked on this machine, 2026-11-10)

- The venv `tfm/.venv` has `timesfm` 3.0.2, which contains TimesFM 3.0. The weights `google/timesfm-3.0-pytorch` are
  public (not gated) and download on first load (about 1.3 GB).
- API: `m = timesfm.TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch", device="cpu")`, then
  `outs = list(m.predict_batch(contexts, horizon=60, return_quantiles=True))`. Each output has `.forecast` shape
  `(60,)` (the median) and `.quantiles` shape `(60, 9)` = deciles 0.1 ... 0.9. There is no mean: use `.forecast`.
- Speed on CPU: 1 series 0.2 s, 8 series 0.29 s, 16 series 0.54 s (MPS is slower for small batches: use CPU).
- Licence: TimesFM 3.0 weights are "non-commercial, non-production". The owner chose 3.0; the README must state the
  licence and how to switch back to 2.5.

---

## Part A: model switch, store per model, refresh and hour track

Files: `tfm/server.py`, `tfm/README.md`, `src/lib/tfm/config.ts` (new), `src/lib/tfm/store.ts`,
`src/lib/tfm/service.ts`, `src/lib/tfm/live.ts`, `src/lib/tfm/snapshot.ts` (only if needed),
`scripts/backfill_tfm.ts`, `src/components/updown/TfmForecastTab.tsx`, `src/lib/updownRecorder.ts`, `package.json`
(scripts only), `README.md` (TFM section only), tests `test/tfmConfig.test.ts` (new), `test/tfmStore.test.ts`,
`test/tfmApi.test.ts`, `test/tfmService.test.ts`.

### Task A1: model config, server, store per model

**Interfaces:**

```ts
// src/lib/tfm/config.ts
export const TFM_MODELS = { 'timesfm-3.0': 'google/timesfm-3.0-pytorch', 'timesfm-2.5': 'google/timesfm-2.5-200m-pytorch' } as const;
export type TfmModelKey = keyof typeof TFM_MODELS;
export const DEFAULT_TFM_MODEL: TfmModelKey = 'timesfm-3.0';
export function tfmModelKeyOf(idOrKey: string | null | undefined): TfmModelKey | null; // accepts a key or a Hugging Face id
export function activeTfmModelKey(): TfmModelKey; // process.env.TFM_MODEL (key or id), else DEFAULT_TFM_MODEL; unknown value -> default
// src/lib/tfm/store.ts (changed)
export function tfmStorePath(key?: TfmModelKey): string;            // <cwd>/jev/tfm/forecasts-<key>.jsonl, key defaults to activeTfmModelKey()
export function appendTfmRecords(records: TfmRecord[]): void;       // each record goes to the store of tfmModelKeyOf(record.model) ?? active
export function loadTfmStore(key?: TfmModelKey): Map<string, TfmRecord>; // cache per key (size + mtime), as now
```

- [ ] Tests first: `test/tfmConfig.test.ts`: `tfmModelKeyOf('google/timesfm-3.0-pytorch') === 'timesfm-3.0'`,
  `tfmModelKeyOf('timesfm-2.5') === 'timesfm-2.5'`, `tfmModelKeyOf('x') === null`, `tfmModelKeyOf(null) === null`;
  `activeTfmModelKey()` is `'timesfm-3.0'` without `TFM_MODEL`, `'timesfm-2.5'` with
  `TFM_MODEL=google/timesfm-2.5-200m-pytorch`, and `'timesfm-3.0'` with `TFM_MODEL=garbage` (use `vi.stubEnv`).
  Extend `test/tfmStore.test.ts`: a record with `model: 'google/timesfm-2.5-200m-pytorch'` lands in
  `forecasts-timesfm-2.5.jsonl` and one with the 3.0 id in `forecasts-timesfm-3.0.jsonl`; `loadTfmStore('timesfm-2.5')`
  sees only the first; `loadTfmStore()` (active = 3.0) only the second. Keep every existing store test passing (update
  file names where they assert a path).
- [ ] `tfm/server.py`: `TFM_MODEL` default `google/timesfm-3.0-pytorch`; new env `TFM_DEVICE` (default `cpu`). If the
  id contains `timesfm-3`, load `timesfm.TimesFM3Forecaster.from_pretrained(id, device=TFM_DEVICE)` and forecast with
  `predict_batch(arrays, horizon=h, return_quantiles=True)`; `quantiles` = each output's `.quantiles`, `mean` = each
  output's `.forecast`. Otherwise keep the 2.5 path exactly as it is. Same HTTP contract as now. `/health` adds
  `"family": "3.0"` or `"2.5"`. Keep the lock, the input checks and the 1024-point cut (`TFM_MAX_CONTEXT`).
- [ ] `service.ts`: the spawned server gets `TFM_MODEL = TFM_MODELS[activeTfmModelKey()]` in its environment.
- [ ] `scripts/backfill_tfm.ts`: "already stored" is read from `loadTfmStore()` of the active model; print the active
  model on the first line. If the running service reports a different model in `/health` than the active key, stop with
  a clear message (exit 1).
- [ ] `package.json`: keep `"tfm"`, add `"tfm:2.5": "TFM_MODEL=google/timesfm-2.5-200m-pytorch tfm/.venv/bin/python tfm/server.py"`.
- [ ] Run the tests. Then stop the TimesFM process on port 8002 (it is `tfm/.venv/bin/python tfm/server.py` and was
  started by an earlier builder; find its pid with `lsof -nP -iTCP:8002 -sTCP:LISTEN -t`), start the new server
  (`nohup tfm/.venv/bin/python tfm/server.py >> logs/tfm.log 2>&1 &`), wait for its ready line (the first start
  downloads the 3.0 weights), and run the three service checks of the first plan's Task 3 Step 2. `/health` must report
  the 3.0 model. Leave it running.

### Task A2: live refresh every 30 s and the hour track

**Interfaces (changed):**

```ts
// src/lib/tfm/live.ts
export interface TfmTrackPoint { t: number /* s */; h1: number | null; m15: number | null; m5: number | null } // probUp 0-1
export interface TfmLiveResponse { /* all current fields */ track: TfmTrackPoint[] } // points since the start of the current 1H window, oldest first
export function tfmLivePath(coin: string, dayUtc: string): string; // <cwd>/jev/tfm/live/<coin>-<YYYY-MM-DD>.jsonl
```

- [ ] Tests first, in `test/tfmApi.test.ts` (temp cwd as in the other tests): a fresh computation appends one line
  `{ ts, model, last, h1, m15, m5 }` (ts in ms, windows as `TfmWindowForecast` or null) to the coin's live file of the
  current UTC day; a second call within the cache time does not append; the response's `track` contains points of the
  current hour only (write one line from the previous hour and one from this hour to the file first: only the second,
  plus the new one, come back), oldest first, at most 240 points; an unwritable live folder does not break the response.
- [ ] `live.ts`: cache time 25 s (so a 30 s poll always gets a fresh forecast). Append only on a fresh, successful
  computation; swallow write errors. A 1H window never crosses UTC midnight, so the track reads only today's file.
- [ ] `TfmForecastTab.tsx`:
  - Refresh control "Refresh every: 30 s / 1 min" (default 30 s; remembered in `localStorage` key `tfm-refresh-sec`,
    every read and write in try/catch), a "Refresh now" button, and in the status line "updated hh:mm:ss · next in Ns".
    While the state is `starting` keep polling every 3 s.
  - New panel "P(Up) during this hour": SVG, x from the start to the end of the current 1H window, y 0-100¢. Lines:
    TimesFM 1H P(Up) from `track` (#5ad1e6, solid); TimesFM 15m and 5m P(Up) only for points inside their current
    window (thin, dashed, colours of their cards); the 1H market Up price (`data.m1h.live`) sampled by the tab on every
    page update while it is open (grey; reset on coin change and at the hour change; label it "market (sampled while
    this tab is open)"). A vertical "now" line. Empty track: a short note instead of the chart.
- [ ] `src/lib/updownRecorder.ts`: each coin's tick line gains
  `tfm: { model, h1, m15, m5 } | null` (probUp values 0-1) from `GET {PMP_BASE_URL}/api/updown/tfm?coin=<coin>`
  (20 s timeout, fetched in parallel with the snapshots). Any failure gives `null`; it must never stop or delay a tick
  line beyond that timeout.

### Task A3: README and tfm/README

- [ ] Update both: 3.0 is the default; `npm run tfm` (3.0) and `npm run tfm:2.5`; `TFM_MODEL`, `TFM_DEVICE`; the store
  is per model (`jev/tfm/forecasts-<key>.jsonl`) and the app reads the active model's store; run
  `npm run backfill:tfm` after switching; the live track files; the 3.0 licence (non-commercial, non-production) next
  to the 2.5 licence (Apache-2.0).

### Task A4: checks and report (see the brief)

---

## Part B: TimesFM as confirmer in backtests (Strategy Lab, Cloud Analysis)

Files: `src/lib/signalAnalysis.ts` (only what is listed), `src/lib/jevLab.ts`,
`src/components/jev-lab/StrategyLab.tsx`, `src/components/jev-lab/*.css` or `src/app/jev-analysis/v2/lab.css` (styles
only), `src/app/cloud-analysis/page.tsx`, tests `test/signalAnalysis.test.ts`, `test/jevLab.test.ts`.

### Task B1: the rule

**Interfaces:**

```ts
// AnalysisConfig gains
tfmMinProb: number; // TimesFM P(side traded) must be >= this, in %. 0 = off. 50 = "TimesFM agrees".
tfmMinEdge: number; // TimesFM P(side traded) minus the quoted price of that side, in cents, must be >= this. -100 = off.
// DEFAULT_ANALYSIS_CONFIG: tfmMinProb 0, tfmMinEdge -100
// Trade gains
tfmProb: number | null; // TimesFM P(side traded), 0-100, one decimal: tfm_prob_up for UP, 100 - tfm_prob_up for DOWN
tfmEdge: number | null; // tfmProb - quote * 100, two decimals; null when either is missing
```

- [ ] Tests first in `test/signalAnalysis.test.ts` (use the file's helpers):
  - a DOWN trade with `tfm_prob_up: 20`, quote 0.7 has `tfmProb === 80`, `tfmEdge === 10`; without `tfm_prob_up` both
    are null;
  - `tfmMinProb: 50` keeps a UP signal with `tfm_prob_up: 60`, drops one with 40, drops a row without TimesFM;
  - `tfmMinEdge: 5` keeps a UP signal at quote 0.70 with `tfm_prob_up: 76`, drops it with 74; `tfmMinEdge: -100` keeps
    a row without TimesFM;
  - with the TimesFM filter on, `afterFilters` takes the first snapshot of the hour that passes it (a later snapshot
    where TimesFM agrees becomes the trade);
  - every rule in `STRATEGIES_BY_ID` has `tfmMinProb === 0` and `tfmMinEdge === -100`.
- [ ] Implement in `signalAnalysis.ts`: the two config fields and defaults, the two Trade fields (set in
  `buildCandidate`), and the two checks in `passesFilters` right after the Solar checks. Nothing else in that file.
- [ ] `jevLab.ts`: `sanitizeLabConfig` keeps `tfmMinProb` in 0..100 and `tfmMinEdge` in -100..100 (defaults when
  missing). `LabOptimizationOptions` gains optional `tfmMinProb?: LabRange` (0..100) and `tfmMinEdge?: LabRange`
  (-100..100); when absent the config's value is the only value. The combination count multiplies; candidate `id` gets
  `-p<prob>-e<edge>` appended only when at least one of the two ranges is given. Tests in `test/jevLab.test.ts`: the
  sanitizer clamps (`tfmMinProb: 150` -> 100, `tfmMinEdge: -500` -> -100, missing -> defaults); an optimization with
  `tfmMinProb: { min: 0, max: 50, step: 50 }` evaluates twice as many combinations as without it and its candidates
  carry the two values.

### Task B2: Strategy Lab (`/jev-analysis/v2`)

- [ ] In the rule editor, a new section "TimesFM · تأیید یا سیگنال" after the model confirmation section:
  - a short note: TimesFM as the signal = choose "TimesFM" as the model above (score = 4 × P(Up); for example UP above
    3.4 means P(Up) above 85%);
  - "حداقل احتمال TimesFM برای سمت معامله (%)": 0-100, hint "۰ = خاموش · ۵۰ = فقط وقتی TimesFM موافق است";
  - "حداقل edge TimesFM نسبت به قیمت (¢)": -100..100, hint "‎-100 = خاموش";
  - a coverage line: "X از Y اسنپ‌شاتِ محدودهٔ فعلی دادهٔ TimesFM دارند" (rows with `tfm_prob_up` not null, after the
    coin/date/hour scope). When a TimesFM filter is on and coverage is under 100%, add "اسنپ‌شات‌های بدون TimesFM
    حذف می‌شوند".
- [ ] In the trades table, a column "TFM": `tfmProb` in % and `tfmEdge` in ¢ ("—" when null).
- [ ] In the optimizer panel, an optional block "جست‌وجوی TimesFM" (off by default) with min/max/step for the two
  values, passed to `optimizeLab` as the new ranges; the candidate list shows the two values when used.
- [ ] Saved experiments from before (no TimesFM fields) still load (the sanitizer fills defaults).

### Task B3: Cloud Analysis (`/cloud-analysis`)

- [ ] After "Solar min confidence %": "TimesFM min prob for traded side %" (hint: 0 = off, 50 = TimesFM agrees; rows
  without TimesFM are excluded when on) and "TimesFM min edge ¢" (hint: TimesFM probability of the side minus its
  price; -100 = off). Add both keys wherever the page lists config keys (around line 79) and wherever it builds the
  config summary or resets signal settings, so they persist, reset and show like the Solar fields. A saved config from
  before still loads (it merges with `DEFAULT_ANALYSIS_CONFIG`).
- [ ] If the page lists trades in a table, add the "TFM" column as in Task B2.
