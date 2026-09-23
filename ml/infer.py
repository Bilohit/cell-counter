"""ONNX runtime wrapper for the learned cell-detector heatmap.

onnxruntime only - never imports torch, so this module is safe to import from
the classical pipeline without pulling torch into a shipped release.
"""
import hashlib
import json
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import onnxruntime as ort

from ml import peaks

_W = os.path.join(os.path.dirname(__file__), "weights")

# cellnet.json is the manifest: {"thr","channels"} plus, since 2026-09-04, an
# "ensemble" list naming every model to average. The shipped default is the
# 3-seed ensemble ("three looks"): LOO F1 0.955 / worst tile 2.0 % against
# 0.947-0.952 / 2.3-3.2 % for the single models it averages, and it removes the
# training-seed lottery, which is worth more than the 0.003 - a single shipped
# model's own seed draw cannot be measured, only inherited. cellnet.json's thr
# belongs to the ensemble; tools/pick_ensemble_thr.py picks it.
def _manifest():
    try:
        with open(os.path.join(_W, "cellnet.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _default_weights():
    names = _manifest().get("ensemble")
    if not names:
        return os.path.join(_W, "cellnet.onnx")     # pre-ensemble weights
    return [os.path.join(_W, n) for n in names]


class WeightsMissing(FileNotFoundError):
    """Raised only for a missing/incomplete ML weights install - never for an
    unrelated missing file. app.py catches this specific class (not bare
    FileNotFoundError) to surface it as a 400 the user can act on, while any
    other FileNotFoundError still falls through to the generic 500 handler."""


def weights_for(n_models):
    """The first `n_models` of the shipped ensemble - the quality levels differ
    only in how many of the same models they average (and whether they use TTA).
    Never fewer than one, and never more than are shipped."""
    d = _default_weights()
    w = d if isinstance(d, list) else [d]
    n = max(1, int(n_models))
    if len(w) < n:
        # Never quietly: the level's threshold was picked for n models, and
        # averaging fewer raises the peak heights it was measured against.
        raise WeightsMissing(
            f"this quality level averages {n} models, but only {len(w)} are "
            f"installed ({', '.join(os.path.basename(p) for p in w)}). Counting "
            f"with fewer would use a threshold picked for more.")
    return w[:n]


def thr_for(level):
    """The peak threshold measured for one quality level, from the manifest's
    `thr_level` map. Averaging heatmaps lowers peak heights, so every level was
    picked through its own inference path by tools/pick_ensemble_thr.py; a level
    with no entry falls back to the ensemble's own threshold rather than
    guessing. Returns None when the manifest carries neither, which leaves
    predict() reading the threshold beside the weights file as it always did."""
    m = _manifest()
    return (m.get("thr_level") or {}).get(str(int(level)), m.get("thr"))


def crowd_for(level):
    """(crowd_b, crowd_r) for one quality level, from the manifest's
    `crowd_level` map and `crowd_r`. A peak must clear `thr + crowd_b * n` with
    n its neighbours within crowd_r px - measured 2026-09-14 to cut mean
    per-tile count error from 3.55 % to 2.98 % on grouped CV, because one global
    threshold cannot serve both the dense groups (which over-count) and the
    sparse ones (which under-count). Returns (0.0, default) for a manifest
    written before the rule existed, which is the old behaviour exactly."""
    m = _manifest()
    b = (m.get("crowd_level") or {}).get(str(int(level)), m.get("crowd_b", 0.0))
    return float(b or 0.0), float(m.get("crowd_r") or peaks.CROWD_R)


_sessions = {}   # weights path -> cached ort.InferenceSession
# Guards _sessions: two request threads racing on a not-yet-cached weights
# path would otherwise both load the same ONNX session (audit-backend.md #16).
# This was safe by accident only because app.py used to serialise every count
# end-to-end behind a single lock, which nothing here stated or tested. Now
# app.py runs up to COUNT_SLOTS counts concurrently, so this lock is load-
# bearing for real. Lock ordering: the caller may hold a count slot (app.py
# `_count_slot`) while entering `_session()`; `_sessions_lock` never waits on
# a slot, so the two cannot deadlock.
_sessions_lock = threading.Lock()

_CHANS = {"A": ["norm"], "B": ["norm", "line"], "C": ["norm", "line", "ncc"]}
_CHAN_ORDER = ["norm", "line", "ncc"]


def chan_names(spec):
    """-> the input channel names, in tensor order, for a manifest's "channels".

    Mirrors ml.data.chan_idx deliberately rather than importing it: ml.data
    pulls in pipeline and the whole training-side stack, and this module is the
    one that must stay importable with nothing but onnxruntime. The two must
    agree - a model trained on [0, 2] and fed ["norm", "line"] would score
    silently wrong rather than raise - so tests/ml/test_chan_idx.py checks them
    against each other.
    """
    if spec in _CHANS:
        return _CHANS[spec]
    if not spec or not all(c in "012" for c in spec):
        raise ValueError(f"channels must be A/B/C or digits from 012, got {spec!r}")
    return [_CHAN_ORDER[i] for i in sorted({int(c) for c in spec})]


def _dihedral(x, k, flip):
    """The 8 square symmetries, applied to a CxHxW stack."""
    v = np.rot90(x, k, axes=(1, 2))
    if flip:
        v = v[:, :, ::-1]
    return np.ascontiguousarray(v)


def _undihedral(heat, k, flip):
    """Inverse of _dihedral on an HxW map: undo the flip first, then the rotation."""
    if flip:
        heat = heat[:, ::-1]
    return np.ascontiguousarray(np.rot90(heat, -k))


def _session_options():
    """SessionOptions with the CPU arena OFF.

    Measured 2026-09-05 on tile 3 (1360x1024) in one process: with the arena on,
    RSS went 0.09 -> 3.91 GB after a single top-rung (ensemble + TTA) count and never came back
    (onnxruntime's BFC arena grows to the largest activation it has ever seen
    and only frees at session teardown). A lab laptop with 8 GB dies on the
    ensemble rungs or on a large capture. Off, the same run peaks far lower and returns.
    The cost is malloc/free per activation, which is noise beside the conv time.
    """
    so = ort.SessionOptions()
    so.enable_cpu_mem_arena = False
    # Spinning OFF, measured 2026-09-22 on all 69 data/tif tiles: every output
    # field bit-identical, and a count went Quick 0.86 -> 0.73 s, Normal 2.43 ->
    # 1.62 s, Finest 13.4 -> 12.0 s (i7-14650HX). Each model is its own session
    # with its own intra-op pool; with spinning on, the idle pools of the other
    # two models keep spinning and steal cores from the one that is running -
    # which is why Quick (one session) gains least. A scheduling flag only: it
    # cannot change arithmetic. Load-bearing - do not remove as "dead config".
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return so


def _session(weights):
    with _sessions_lock:
        if weights not in _sessions:
            if not os.path.exists(weights):
                raise WeightsMissing(f"ML weights not found: {weights}")
            _sessions[weights] = ort.InferenceSession(
                weights, sess_options=_session_options(), providers=["CPUExecutionProvider"])
        return _sessions[weights]


class _HeatCache:
    """Byte-bounded LRU of averaged heatmaps, keyed by the exact bytes of the
    built input stack + the weight paths + TTA. The boundary switch and a
    Show-pipeline Reprocess feed the detector the same stack as the count before
    them, and used to re-run it in full (Normal ~2 s, Finest ~11 s). Only the RAW
    heatmap is cached; thr and the crowding decode are applied after, every time.
    Cleared by app.py's /api/reset."""

    def __init__(self, max_bytes):
        self.max_bytes, self._d, self._n = max_bytes, OrderedDict(), 0
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            v = self._d.get(key)
            if v is not None:
                self._d.move_to_end(key)
            return None if v is None else v.copy()

    def put(self, key, heat):
        with self._lock:
            if key in self._d or heat.nbytes > self.max_bytes:
                return
            self._d[key] = heat.copy(); self._n += heat.nbytes
            while self._n > self.max_bytes:
                _, old = self._d.popitem(last=False); self._n -= old.nbytes

    def clear(self):
        with self._lock:
            self._d.clear(); self._n = 0


_HEAT = _HeatCache(128 * 1024 * 1024)     # ~22 full-size heatmaps


def clear_heat_cache():
    _HEAT.clear()


def predict(gray, line_mask, sm, bg, weights=None, tta=None, thr=None, on_view=None,
            parallel=False):
    """Run the ONNX heatmap model. Returns (heat float32 HxW, thr float).

    Channel recipe duplicated from ml.data.load_tile: norm = clip((gray-bg)/32,-4,4);
    line = line_mask/255; ncc = sm.

    `weights` may be one path or a list of paths; several are averaged in heatmap
    space (a deep ensemble), and default to the shipped ensemble. `tta` averages
    the 8 square symmetries as well; it defaults to off. Both cost inference
    time only.

    `thr` overrides the threshold stored beside the weights. Both averaging
    passes lower peak heights, so a caller changing `weights` or `tta` must pass
    the threshold measured for THAT combination - thr_for(level) has it.

    `on_view(done, total)` is called after each model/symmetry pass, for a
    progress bar: this loop is most of a count's wall clock, and without a
    sub-tick the bar sits still for seconds at the one point a user is most
    likely to think the app has hung. Optional and default None, so every
    offline caller (score.py, ml/loo.py, the tests) is unaffected.

    `parallel` runs the model passes on separate threads (see predict_stack).
    Default False, so every existing caller is unaffected.
    """
    if weights is None:
        weights = _default_weights()
    paths = [weights] if isinstance(weights, str) else list(weights)
    if tta is None:
        tta = False
    for p in paths:
        if not os.path.exists(p):
            raise WeightsMissing(f"ML weights not found: {p}")
    sidecar = os.path.splitext(paths[0])[0] + ".json"
    try:
        with open(sidecar) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        # Same weights install as the .onnx files just checked above - a
        # hand-pruned release that dropped the sidecar is exactly the scenario
        # WeightsMissing exists for, so this must surface as the same plain
        # 400, not fall through to the generic 500 handler.
        raise WeightsMissing(
            f"ML weights not found: {sidecar}. Reinstall or repair the "
            "release - a model file is missing its settings.")
    if thr is None:
        thr = cfg["thr"]
    channels = cfg["channels"]

    norm = np.clip((gray.astype(np.float32) - bg) / 32.0, -4, 4)
    line = line_mask.astype(np.float32) / 255.0
    ncc = sm.astype(np.float32)
    by_name = {"norm": norm, "line": line, "ncc": ncc}
    stack = np.stack([by_name[name] for name in chan_names(channels)]).astype(np.float32)

    key = (hashlib.sha256(stack.tobytes()).hexdigest(), stack.shape, str(stack.dtype),
           tuple(paths), bool(tta))
    heat = _HEAT.get(key)
    if heat is None:
        heat = predict_stack(stack, paths, tta, on_view=on_view, parallel=parallel)
        _HEAT.put(key, heat)
    elif on_view is not None:
        on_view(1, 1)
    return heat, thr


def predict_stack(stack, weights, tta=False, on_view=None, parallel=False):
    """Heatmap for an already-built CxHxW channel stack, averaged over `weights`
    and, if `tta`, over the 8 square symmetries. Split out so the threshold
    sweep in ml/loo.py can score training tiles through the exact same path.

    `parallel` (default False) runs the (model, view) passes on one thread per
    model instead of serially - InferenceSession.run is documented thread-safe
    by onnxruntime, and passes are still summed in the SAME model-then-view
    order as the serial path below, so the float32 result is bit-identical
    either way (tests/pipeline/test_speed.py checks this). Only worth it with more than
    one model: app.py gates it to Finest (3 models + TTA, always faster split
    up) or to whichever level is running when it is the only count in flight -
    measured 2026-09-22: Finest 11.34 -> 9.31 s alone, 9.59 -> 8.71 s two at
    once; Normal (3 models, no TTA) two-at-once got SLOWER (1.42 -> 1.48 s),
    hence the single-count-only rule for non-Finest levels.
    """
    paths = [weights] if isinstance(weights, str) else list(weights)
    views = [(k, f) for k in range(4) for f in (False, True)] if tta else [(0, False)]
    passes = len(paths) * len(views)
    jobs = [(p, k, f) for p in paths for (k, f) in views]

    def one(job):
        p, k, f = job
        sess = _session(p)
        name = sess.get_inputs()[0].name
        v = _dihedral(stack, k, f)
        # The U-Net pools three times, so a side that is not a multiple of 8
        # comes back one pixel short of its skip connection and onnxruntime
        # fails the concat ("mismatched dimensions of 681 and 680"). A
        # stitched field is an arbitrary height, so pad by edge replication
        # and crop the heatmap back - measured identical on multiple-of-8
        # tiles, where the pad is zero.
        h, w = v.shape[1:]
        ph, pw = (-h) % 8, (-w) % 8
        if ph or pw:
            v = np.pad(v, ((0, 0), (0, ph), (0, pw)), mode="edge")
        out = sess.run(None, {name: v[np.newaxis]})[0][0, 0].astype(np.float32)
        return _undihedral(out[:h, :w], k, f)

    acc = np.zeros(stack.shape[1:], np.float32)
    if parallel and len(paths) > 1:
        with ThreadPoolExecutor(len(paths)) as ex:
            for done, out in enumerate(ex.map(one, jobs), 1):
                acc += out
                if on_view is not None:
                    on_view(done, passes)
    else:
        for done, job in enumerate(jobs, 1):
            acc += one(job)
            if on_view is not None:
                on_view(done, passes)
    return acc / passes
