# TimesFM service (TFM)

A small local HTTP service that holds Google's TimesFM model (TimesFM 3.0 by default, or TimesFM 2.5) and answers
"price series in, deciles out". All forecast logic (context, windows, probability of Up) lives in TypeScript under
`src/lib/tfm/`; this service only runs the model.

It is local only: it binds to `127.0.0.1` and is not deployed to the production server (908 MB of RAM, too small for
the model).

## Commands

```bash
npm run tfm:setup   # once: creates tfm/.venv (Python 3.12) and installs tfm/requirements.txt (uses uv)
npm run tfm         # starts the service on http://127.0.0.1:8002 with TimesFM 3.0 (default)
npm run tfm:2.5     # starts the service with TimesFM 2.5
npm run backfill:tfm -- --coin=btc --limit=40   # forecasts for existing history snapshots (needs the service up)
```

The first start downloads the model weights if they are not cached (about 1.3 GB for 3.0); later starts take a few seconds.
Run `npm run backfill:tfm` after switching models so the active model has historical forecasts.

## Store and Live Track Files

- History forecasts are stored per model in `jev/tfm/forecasts-<key>.jsonl` (e.g. `forecasts-timesfm-3.0.jsonl` or
  `forecasts-timesfm-2.5.jsonl`). The app reads the active model's store.
- Live track points are written to `jev/tfm/live/<coin>-<YYYY-MM-DD>.jsonl` on each successful poll.

## API

- `GET /health` -> `{"ok": true, "model": "...", "family": "3.0" | "2.5", "max_context": 1024, "max_horizon": 64}`
- `POST /forecast` with `{"series": [[number, ...], ...], "horizon": 60}` ->
  `{"model", "horizon", "quantile_levels": [0.1 ... 0.9], "mean": [[h] per series], "quantiles": [[[9] x h] per series]}`.
  Answers 400 `{"error": "..."}` for: no series, more than 64 series, a series shorter than 32 points, a value that is
  not a finite number above 0, a horizon outside 1..max_horizon. A series longer than the max context is cut to its
  last points.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TFM_HOST` | `127.0.0.1` | Bind host |
| `TFM_PORT` | `8002` | Port |
| `TFM_MODEL` | `google/timesfm-3.0-pytorch` | Model id or key (`timesfm-3.0`, `timesfm-2.5`) |
| `TFM_DEVICE` | `cpu` | PyTorch device (`cpu`) |
| `TFM_MAX_CONTEXT` | `1024` | Maximum context points sent to the model |
| `TFM_MAX_HORIZON` | `64` | Maximum horizon steps |
| `TFM_BATCH` | `16` | Per-core batch size |

The app side reads `TFM_URL` (default `http://127.0.0.1:8002`), `TFM_MODEL` (key or HF id) and `TFM_AUTOSTART`
(set to `0` so the app never starts the service itself).

## Licence

- **TimesFM 3.0** (`google/timesfm-3.0-pytorch`, default): weights are under a non-commercial, non-production licence.
- **TimesFM 2.5** (`google/timesfm-2.5-200m-pytorch`): weights are licensed under Apache-2.0. To switch back to 2.5, run
  `npm run tfm:2.5` (or set `TFM_MODEL=google/timesfm-2.5-200m-pytorch`).
