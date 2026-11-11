"""Local TimesFM service: price series in, deciles out.

Standard library HTTP server plus timesfm and numpy. Supports TimesFM 3.0 (default)
and TimesFM 2.5. Settings come from the environment:
TFM_HOST (127.0.0.1), TFM_PORT (8002), TFM_MODEL (google/timesfm-3.0-pytorch),
TFM_DEVICE (cpu), TFM_MAX_CONTEXT (1024), TFM_MAX_HORIZON (64), TFM_BATCH (16).

GET  /health   -> {"ok": true, "model": ..., "family": "3.0" | "2.5", "max_context": ..., "max_horizon": ...}
POST /forecast -> {"series": [[...], ...], "horizon": 60}
               <- {"model", "horizon", "quantile_levels", "mean": [[h] per series],
                   "quantiles": [[[9] x h] per series]}
"""

import json
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import timesfm

HOST = os.environ.get("TFM_HOST", "127.0.0.1")
PORT = int(os.environ.get("TFM_PORT", "8002"))
MODEL_ID = os.environ.get("TFM_MODEL", "google/timesfm-3.0-pytorch")
DEVICE = os.environ.get("TFM_DEVICE", "cpu")
MAX_CONTEXT = int(os.environ.get("TFM_MAX_CONTEXT", "1024"))
MAX_HORIZON = int(os.environ.get("TFM_MAX_HORIZON", "64"))
BATCH = int(os.environ.get("TFM_BATCH", "16"))

IS_TFM3 = "timesfm-3" in MODEL_ID
FAMILY = "3.0" if IS_TFM3 else "2.5"

MAX_SERIES = 64
MIN_POINTS = 32
MAX_BODY = 32 * 1024 * 1024
QUANTILE_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

_lock = threading.Lock()
_model = None


def load_model():
    if IS_TFM3:
        return timesfm.TimesFM3Forecaster.from_pretrained(MODEL_ID, device=DEVICE)
    else:
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
        model.compile(
            timesfm.ForecastConfig(
                max_context=MAX_CONTEXT,
                max_horizon=MAX_HORIZON,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
                per_core_batch_size=BATCH,
            )
        )
        return model


class BadRequest(Exception):
    pass


def parse_request(body):
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("body is not valid JSON")
    if not isinstance(data, dict):
        raise BadRequest("body must be a JSON object")
    series = data.get("series")
    if not isinstance(series, list) or len(series) == 0:
        raise BadRequest("series must be a non-empty list")
    if len(series) > MAX_SERIES:
        raise BadRequest("at most %d series per call" % MAX_SERIES)
    horizon = data.get("horizon", 60)
    if isinstance(horizon, bool) or not isinstance(horizon, int) or horizon < 1 or horizon > MAX_HORIZON:
        raise BadRequest("horizon must be an integer from 1 to %d" % MAX_HORIZON)
    arrays = []
    for i, s in enumerate(series):
        if not isinstance(s, list) or len(s) < MIN_POINTS:
            raise BadRequest("series %d must be a list of at least %d points" % (i, MIN_POINTS))
        for v in s:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
                raise BadRequest("series %d has a value that is not a finite number above 0" % i)
        arrays.append(np.asarray(s[-MAX_CONTEXT:], dtype=np.float32))
    return arrays, horizon


def forecast(arrays, horizon):
    with _lock:
        if IS_TFM3:
            outs = list(_model.predict_batch(arrays, horizon=horizon, return_quantiles=True))
            mean = [np.asarray(o.forecast)[:horizon].astype(float).tolist() for o in outs]
            quantiles = [np.asarray(o.quantiles)[:horizon].astype(float).tolist() for o in outs]
        else:
            _point, quant = _model.forecast(horizon=horizon, inputs=arrays)
            quant = np.asarray(quant)
            mean = quant[:, :horizon, 0].astype(float).tolist()
            quantiles = quant[:, :horizon, 1:10].astype(float).tolist()
    return {
        "model": MODEL_ID,
        "horizon": horizon,
        "quantile_levels": QUANTILE_LEVELS,
        "mean": mean,
        "quantiles": quantiles,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "model": MODEL_ID,
                    "family": FAMILY,
                    "max_context": MAX_CONTEXT,
                    "max_horizon": MAX_HORIZON,
                },
            )
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/forecast":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self._send(400, {"error": "bad or too large body"})
            return
        body = self.rfile.read(length)
        try:
            arrays, horizon = parse_request(body)
        except BadRequest as e:
            self._send(400, {"error": str(e)})
            return
        try:
            result = forecast(arrays, horizon)
        except Exception as e:  # keep serving after a model error
            print("[tfm] forecast failed: %r" % (e,), file=sys.stderr, flush=True)
            self._send(500, {"error": "forecast failed"})
            return
        self._send(200, result)


def main():
    global _model
    t0 = time.time()
    _model = load_model()
    load_s = time.time() - t0
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("[tfm] ready on http://%s:%d model=%s family=%s load=%.1fs" % (HOST, PORT, MODEL_ID, FAMILY, load_s), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
