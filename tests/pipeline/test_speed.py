import pytest
import glob
import io
import json
import threading
import time
import types
import cv2
import numpy as np
from scipy import ndimage
import pipeline
from ml import infer
import app as app_module
from fastapi.testclient import TestClient

client = TestClient(app_module.app)


def test_sessions_do_not_spin():
    so = infer._session_options()
    assert so.get_session_config_entry("session.intra_op.allow_spinning") == "0"
    assert so.enable_cpu_mem_arena is False


def _grays(n=10):
    fs = sorted(glob.glob("data/tif/*.tif"))[:n]
    return [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in fs]


@pytest.mark.data
def test_parallel_sweep_matches_serial():
    g = _grays()
    pipeline._STITCH_CACHE.clear()
    s1 = []; p1 = []
    ref = pipeline.group_captures(g, skipped=s1, progress=lambda d, t: p1.append((d, t)), workers=1)
    pipeline._STITCH_CACHE.clear()
    s2 = []; p2 = []
    got = pipeline.group_captures(g, skipped=s2, progress=lambda d, t: p2.append((d, t)), workers=8)
    assert ref[0] == got[0]
    assert ref[1].keys() == got[1].keys()
    for k in ref[1]:
        assert (ref[1][k][0] == got[1][k][0]).all() and ref[1][k][1] == got[1][k][1]
    assert s1 == s2 and p1 == p2


@pytest.mark.data
def test_rotation_estimate_is_deterministic_across_threads():
    fs = sorted(glob.glob("data/tif/*.tif"))
    a = cv2.imread(fs[2], cv2.IMREAD_GRAYSCALE)      # tiles 2 and 3 are a true pair
    b = cv2.imread(fs[3], cv2.IMREAD_GRAYSCALE)
    _, info = pipeline.stitch_pair(a, b)
    if info["swapped"]:
        a, b = b, a
    h, w = b.shape
    tilt = cv2.getRotationMatrix2D((w / 2, h / 2), 0.8, 1.0)
    b = cv2.warpAffine(b, tilt, (w, h), borderValue=int(np.median(b)))
    ref = pipeline._estimate_rotation_deg(a, b, info["dx"], info["dy"])
    # If this fires the fit was judged untrustworthy and returned 0.0: the
    # branch was NOT exercised. Raise the 0.8 deg tilt (stay under 2.0) until it is.
    assert abs(ref) >= pipeline.ROTATION_DEG_MIN
    got = []
    ts = [threading.Thread(target=lambda: got.append(
        pipeline._estimate_rotation_deg(a, b, info["dx"], info["dy"]))) for _ in range(8)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert got == [ref] * 8


def test_machine_decision_is_remembered(tmp_path, monkeypatch):
    f = tmp_path / "machine.json"
    monkeypatch.setattr(app_module, "_MACHINE_FILE", str(f))
    monkeypatch.setattr(app_module, "_total_ram_gb", lambda: 64.0)
    assert app_module._machine_slots() == 2
    monkeypatch.setattr(app_module, "_total_ram_gb", lambda: 4.0)   # later runs never re-decide
    assert app_module._machine_slots() == 2
    assert json.loads(f.read_text())["count_slots"] == 2


def test_small_machine_gets_one_slot(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_MACHINE_FILE", str(tmp_path / "m.json"))
    monkeypatch.setattr(app_module, "_total_ram_gb", lambda: 4.0)
    assert app_module._machine_slots() == 1


def test_sweep_takes_every_slot():
    with app_module._all_slots():
        assert app_module._slots_free() == 0
    assert app_module._slots_free() == app_module.COUNT_SLOTS


def test_params_reports_slots():
    assert client.get("/api/params").json()["count_slots"] == app_module.COUNT_SLOTS


def test_parallel_passes_sum_identically():
    rng = np.random.default_rng(0)
    stack = rng.standard_normal((3, 256, 320)).astype(np.float32)
    w = infer.weights_for(3)
    for tta in (False, True):
        a = infer.predict_stack(stack, w, tta=tta)
        b = infer.predict_stack(stack, w, tta=tta, parallel=True)
        assert a.dtype == b.dtype and np.array_equal(a, b)


def _inputs():
    rng = np.random.default_rng(1)
    gray = rng.integers(0, 255, (256, 320), dtype=np.uint8)
    line = np.zeros_like(gray); sm = rng.random((256, 320)).astype(np.float32)
    return gray, line, sm, 120.0


def test_cache_hit_is_identical_and_a_copy():
    infer.clear_heat_cache()
    a, _ = infer.predict(*_inputs())
    b, _ = infer.predict(*_inputs())
    assert np.array_equal(a, b) and a is not b


def test_any_input_change_misses():
    infer.clear_heat_cache()
    base, _ = infer.predict(*_inputs())
    g, l, s, bg = _inputs()
    for args in ((g ^ 1, l, s, bg), (g, l + 1, s, bg), (g, l, s + 0.001, bg), (g, l, s, bg + 1)):
        h, _ = infer.predict(*args)
        assert not np.array_equal(h, base)
    h, _ = infer.predict(*_inputs(), tta=True)
    assert not np.array_equal(h, base)


def _ref(m):
    return ndimage.binary_fill_holes(m).astype(np.uint8) * 255


def test_fill_holes_matches_scipy_on_edge_cases():
    ring = np.zeros((40, 50), np.uint8); ring[10:30, 10:40] = 255; ring[15:25, 15:35] = 0
    border_hole = np.zeros((40, 50), np.uint8); border_hole[0:20, 5:30] = 255; border_hole[0:10, 10:20] = 0
    diag = np.zeros((9, 9), np.uint8)          # a "hole" closed only diagonally is NOT a hole (4-connected background)
    for i in range(1, 8):
        diag[i, 8 - i] = 255; diag[i, i] = 255
    cases = [ring, border_hole, diag, np.zeros((7, 9), np.uint8), np.full((7, 9), 255, np.uint8),
             np.full((1, 1), 255, np.uint8)]
    rng = np.random.default_rng(0)
    cases += [(rng.random((64, 80)) > t).astype(np.uint8) * 255 for t in (0.3, 0.5, 0.7)]
    for m in cases:
        got = pipeline._fill_holes(m)
        assert got.dtype == np.uint8 and np.array_equal(got, _ref(m))


def test_median_u8_equals_numpy():
    rng = np.random.default_rng(0)
    for shape in ((1024, 1360), (295, 515), (1, 1), (2, 1), (3, 3)):
        a = rng.integers(0, 256, shape, dtype=np.uint8)
        assert pipeline._median_u8(a) == float(np.median(a))
    flat = np.full((10, 10), 200, np.uint8)
    assert pipeline._median_u8(flat) == 200.0
    f = rng.random((50, 50)).astype(np.float32)          # not uint8: falls back, still equal
    assert pipeline._median_u8(f) == float(np.median(f))


@pytest.mark.data
def test_cache_key_is_the_same_with_and_without_digests():
    g = _grays(2)
    a, b = g[0], g[1]
    da, db = pipeline._image_digest(a), pipeline._image_digest(b)
    assert pipeline._stitch_cache_key(a, b, 20) == pipeline._stitch_cache_key(a, b, 20, da, db)
    assert pipeline._image_digest(a) != pipeline._image_digest(b)


def test_decode_all_reports_the_first_bad_upload(monkeypatch):
    def fake(data, name):
        if name.startswith("bad"):
            time.sleep(0.2 if name == "bad-first" else 0.0)     # the first failure finishes LAST
            return None, f"cannot read {name}"
        return np.zeros((4, 4), np.uint8), None
    monkeypatch.setattr(app_module, "_decode_raw", fake)
    ups = [types.SimpleNamespace(filename=n, file=io.BytesIO(b"x"))
           for n in ("ok-1", "bad-first", "ok-2", "bad-second")]
    out, err = app_module._decode_all(ups, share=False)
    assert out is None and err == "cannot read bad-first"
