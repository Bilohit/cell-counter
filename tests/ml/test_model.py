import pytest

# Skipped, not collected, without the training/runtime extras. A module-scope
# import here aborts the whole FILE, which reads as "no tests" rather than as
# "these tests did not run" - the same class of silence rtk once produced.
pytest.importorskip("torch")

import numpy as np
import torch

from ml import model as M
from ml.peaks import heat_to_points


def test_unet_shape_and_padding():
    net = M.UNet(3)
    y = net(torch.zeros(1, 3, 100, 130))
    assert y.shape == (1, 1, 100, 130) and 0 <= float(y.min()) and float(y.max()) <= 1


def test_heat_to_points_separates_close_peaks():
    h = np.zeros((64, 64), np.float32); h[20, 20] = 1; h[20, 32] = 1; h[40, 40] = 0.2
    pts = heat_to_points(h, thr=0.5, min_dist=8)
    assert sorted(pts) == [(20, 20), (32, 20)]


def test_peaks_above_a_threshold_are_a_subset_of_the_peaks_below_it():
    """tools/sweep_decode.py sweeps the whole threshold axis from ONE
    peak_local_max call per (tile, min_dist), which is only valid because the
    picker is greedy in descending intensity: adding weaker candidates can never
    unseat a stronger one. If that ever stops holding, the sweep is silently
    measuring the wrong configs, so it is pinned here rather than assumed."""
    rng = np.random.default_rng(0)
    h = rng.random((128, 128)).astype(np.float32)
    for md in (4, 6, 8):
        low = set(heat_to_points(h, thr=0.10, min_dist=md))
        for thr in (0.3, 0.5, 0.75):
            assert set(heat_to_points(h, thr=thr, min_dist=md)) == {
                p for p in low if h[p[1], p[0]] >= thr}


def test_crowding_threshold_rejects_the_crowded_peak_only():
    """A crowd_b of 0 must be the plain global threshold, and a non-zero one must
    raise the bar only where peaks are packed. Two peaks of identical height, one
    alone and one inside a cluster: the lonely one survives, the crowded one does
    not."""
    h = np.zeros((200, 200), np.float32)
    h[20, 20] = 0.62                                  # alone
    for i, (y, x) in enumerate([(120, 120), (120, 132), (132, 120), (132, 132)]):
        h[y, x] = 0.62 if i == 0 else 0.9             # in a cluster of four
    assert (20, 20) in heat_to_points(h, 0.60)
    assert (120, 120) in heat_to_points(h, 0.60)      # b=0: both survive
    pts = heat_to_points(h, 0.60, crowd_b=0.02, crowd_r=30)
    assert (20, 20) in pts and (120, 120) not in pts
    assert (132, 132) in pts                          # 0.9 clears 0.60 + 0.02*3


def test_export_onnx_roundtrip(tmp_path):
    import onnxruntime as ort
    net = M.UNet(2).eval(); p = tmp_path / "m.onnx"
    M.export_onnx(net, 2, str(p))
    x = np.random.rand(1, 2, 72, 88).astype(np.float32)
    ref = net(torch.from_numpy(x)).detach().numpy()
    out = ort.InferenceSession(str(p)).run(None, {"x": x})[0]
    assert np.allclose(ref, out, atol=1e-4)


def test_train_smoke(tmp_path, monkeypatch):
    # ml/train.py's H2D copy is unconditional: `.pin_memory().to(dev, ...)` calls
    # into torch.accelerator regardless of `dev`, so a CPU-only torch wheel raises
    # "Cannot access accelerator device when none is available" here even though
    # that message names no cause. Skip loudly instead of failing opaquely: this
    # is a legitimate CPU dev machine, but the whole ml/ path is untestable on it
    # until a CUDA build is installed (see requirements-train.txt's torch pin,
    # e.g. `pip install -r requirements-train.txt`).
    if not torch.cuda.is_available():
        pytest.skip(
            "no CUDA accelerator: torch is a CPU-only build, so ml/train.py's "
            "pin_memory()/.to(dev, non_blocking=True) call raises 'Cannot access "
            "accelerator device when none is available' and training cannot run. "
            "Fix: pip install -r requirements-train.txt (installs torch==2.11.0+cu128 "
            "from the cu128 index)."
        )
    from ml import train as T, data
    s = {"name": "syn", "x": np.random.rand(3, 128, 128).astype(np.float32), "heat": np.zeros((128, 128), np.float32), "w": np.ones((128, 128), np.float32)}
    s["heat"][64, 64] = 1
    monkeypatch.setattr(data, "build_samples", lambda fold, ch: [s])
    monkeypatch.setattr(T, "pick_threshold", lambda *a, **k: 0.5)
    r = T.train(fold=0, channels="C", iters=3, out=str(tmp_path / "m"))
    assert (tmp_path / "m.onnx").exists() and r["thr"] == 0.5


def test_predict_stack_odd_size():
    """A stitched field is an arbitrary height; the U-Net pools three times, so
    a side that is not a multiple of 8 used to fail the ONNX concat
    ("mismatched dimensions of 681 and 680"). infer pads and crops back."""
    import numpy as np
    from ml import infer
    stack = np.random.rand(3, 681, 1017).astype(np.float32)
    assert infer.predict_stack(stack, infer.weights_for(1)).shape == (681, 1017)


def test_predict_missing_sidecar_is_weights_missing(tmp_path, monkeypatch):
    """predict() opens the per-model .json sidecar with a bare open() - if a
    hand-pruned release ships the .onnx but drops its .json, that bare open()
    used to raise a plain FileNotFoundError, which app.py's narrowed
    `except WeightsMissing` does not catch, so the user got a 500 traceback
    instead of the same 400 every other missing-weights case gets. The .onnx
    file only has to exist (predict must fail before ever loading it)."""
    import numpy as np
    from ml import infer
    onnx = tmp_path / "fake.onnx"
    onnx.write_bytes(b"not a real model")   # never read: fails on the sidecar first
    with pytest.raises(infer.WeightsMissing):
        infer.predict(np.zeros((4, 4), np.uint8), np.zeros((4, 4), np.uint8),
                      np.zeros((4, 4), np.float32), 0.0, weights=str(onnx))


def test_weights_for_reports_which_models_are_missing():
    """The realistic failure the original audit named: a quality level asks to
    average 3 models, but the release only shipped 1. weights_for is the one
    place that decides this, and only predict()/_session() were pinned before -
    not weights_for itself."""
    from ml import infer
    d = infer._default_weights()
    installed = d if isinstance(d, list) else [d]   # however many actually ship
    want = len(installed) + 1
    with pytest.raises(infer.WeightsMissing, match=f"{want} models"):
        infer.weights_for(want)


def test_session_cache_is_locked_against_concurrent_loads(tmp_path, monkeypatch):
    """_sessions is an unsynchronised dict, and now app.py runs up to
    COUNT_SLOTS counts concurrently (audit-backend.md #16), so this cache's
    own lock is load-bearing for real, not just accidentally safe. Two
    threads racing _session() for the same not-yet-cached weights path must
    get the same session object, and the underlying loader must run exactly
    once - not just "eventually converge to one dict entry"."""
    import threading
    import time
    from ml import infer

    onnx = tmp_path / "fake.onnx"
    onnx.write_bytes(b"not a real model")   # never actually parsed - loader is faked
    assert str(onnx) not in infer._sessions   # a fresh tmp_path is never cached

    load_count = 0
    load_lock = threading.Lock()

    class FakeSession:
        pass

    def fake_ctor(weights, sess_options=None, providers=None):
        nonlocal load_count
        with load_lock:
            load_count += 1
        time.sleep(0.05)   # widen the race window
        return FakeSession()

    monkeypatch.setattr(infer.ort, "InferenceSession", fake_ctor)

    results = []

    def worker():
        results.append(infer._session(str(onnx)))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert load_count == 1
    assert len({id(r) for r in results}) == 1
