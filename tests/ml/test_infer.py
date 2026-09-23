import pytest

# Skipped, not collected, without the training/runtime extras. A module-scope
# import here aborts the whole FILE, which reads as "no tests" rather than as
# "these tests did not run" - the same class of silence rtk once produced.
pytest.importorskip("torch")
pytest.importorskip("onnxruntime")

import json, numpy as np, torch, cv2
from ml import model as M, infer
import pipeline


def _weights(tmp_path, ch="B"):
    net = M.UNet(len(ch) if ch != "C" else 3).eval()
    p = tmp_path / "cellnet.onnx"; M.export_onnx(net, {"A": 1, "B": 2, "C": 3}[ch], str(p))
    (tmp_path / "cellnet.json").write_text(json.dumps({"thr": 0.5, "channels": ch}))
    return str(p)


def test_predict_shapes(tmp_path):
    w = _weights(tmp_path, "C")
    g = np.full((120, 160), 80, np.uint8); lm = np.zeros_like(g); sm = np.zeros(g.shape, np.float32)
    heat, thr = infer.predict(g, lm, sm, 80.0, weights=w)
    assert heat.shape == g.shape and heat.dtype == np.float32 and thr == 0.5


@pytest.mark.data
def test_count_cells_engine_ml_runs(tmp_path):
    w = _weights(tmp_path, "C")
    bgr = cv2.imread("data/tif/10x tile picture 3; first three rows.tif", cv2.IMREAD_COLOR)
    r = pipeline.count_cells(bgr, {"engine": 1}, ml_weights=w)
    assert "count" in r and isinstance(r["centers"], list)
    assert "05|Split|ML heatmap" in (lambda s: (pipeline.count_cells(bgr, {"engine": 1}, ml_weights=w, stages=s), s)[1])({})


def test_pipeline_does_not_import_torch():
    import subprocess, sys
    code = "import pipeline, ml.infer, ml.peaks, sys; assert 'torch' not in sys.modules"
    assert subprocess.run([sys.executable, "-c", code]).returncode == 0


def test_dihedral_roundtrip_is_exact():
    """All 8 symmetries must invert exactly, on a non-square map, or TTA smears
    the averaged heatmap instead of sharpening it."""
    from ml import infer
    rng = np.random.default_rng(0)
    a = rng.random((37, 53)).astype(np.float32)
    for k in range(4):
        for f in (False, True):
            back = infer._undihedral(infer._dihedral(a[None], k, f)[0], k, f)
            assert back.shape == a.shape
            assert np.array_equal(back, a), (k, f)


def test_shipped_default_is_the_ensemble_named_in_the_manifest():
    """cellnet.json names the models to average and carries the ensemble's own
    threshold. If a model file goes missing from a release, predict() must fail
    loudly rather than quietly counting with fewer models than it was tuned for."""
    import json, os
    from ml import infer
    w = infer._default_weights()
    assert isinstance(w, list) and len(w) == 3, w
    with open(os.path.join(os.path.dirname(infer.__file__), "weights", "cellnet.json")) as f:
        cfg = json.load(f)
    assert [os.path.basename(p) for p in w] == cfg["ensemble"]
    assert cfg["channels"] == "C" and 0.1 <= cfg["thr"] <= 0.9
    for p in w:
        assert os.path.exists(p), p


def test_every_ml_level_has_its_own_measured_threshold():
    """The three rungs average a different number of heatmaps, which moves the
    peak heights. Reusing one level's threshold on another silently drops the
    detections that level exists to recover - the bug this map exists to prevent.
    Each entry is picked by tools/pick_ensemble_thr.py through that level's own
    inference path."""
    from ml import infer
    import pipeline
    for lvl, cfg in pipeline.LEVELS.items():
        thr = infer.thr_for(lvl)
        assert thr is not None and 0.1 <= thr <= 0.9, (lvl, thr)
        assert len(infer.weights_for(cfg["models"])) == cfg["models"], lvl


def test_levels_map_onto_the_engine_switch():
    """The UI sends a level and nothing else. Level 0 is the escape hatch every
    existing caller uses: score.py --params '{"engine": 0}' and ml/loo.py must
    keep meaning exactly what they meant before levels existed."""
    import numpy as np
    import pipeline
    img = np.full((80, 80, 3), 40, np.uint8)

    # Every rung is an ML rung since the classical one was removed 2026-09-21.
    for lvl in pipeline.LEVELS:
        assert pipeline.LEVELS[lvl]["params"]["engine"] == 1, lvl

    # Level 0 leaves the caller's own engine choice alone - the classical
    # engine's only remaining door. This also stops someone moving app.py's
    # HTTP range check (which refuses level 0) into pipeline.py.
    r = pipeline.count_cells(img, {"level": 0, "engine": 0})
    assert r["params"]["level"] == 0
    assert r["params"]["engine"] == 0


def test_a_short_ensemble_is_refused_rather_than_silently_averaged(monkeypatch):
    """A release missing a model must not run "Three looks" as one model while
    still using the threshold picked for three - that reads as the level working
    and counts with a threshold measured against different peak heights."""
    import pytest
    from ml import infer
    keep = infer._default_weights()
    monkeypatch.setattr(infer, "_default_weights", lambda: keep[:1])
    assert infer.weights_for(1) == keep[:1]
    with pytest.raises(FileNotFoundError, match="only 1 are installed"):
        infer.weights_for(3)


def test_onnx_sessions_run_with_the_cpu_arena_off():
    """onnxruntime's CPU arena grows to the largest activation it ever saw and
    frees only at teardown: measured 2026-09-05, one level-4 count on tile 3
    took the process from 0.09 GB to 3.91 GB and it stayed there (0.13 GB with
    the arena off, same count). The app is a long-lived local server, so the
    arena must stay off - guard the option, not the megabytes."""
    from ml import infer
    assert infer._session_options().enable_cpu_mem_arena is False
    sess = infer._session(infer._default_weights()[0])
    assert sess.get_session_options().enable_cpu_mem_arena is False


def test_manifest_crowding_reaches_the_count(monkeypatch):
    """cellnet.json's crowd_level must actually change what count_cells returns.

    thr_level was wired years before crowd_level, and the crowding coefficient
    rides the same path: manifest -> ml.infer.crowd_for -> pipeline.count_cells
    -> heat_to_points. A break anywhere in that chain is SILENT - the count just
    comes back uncrowded, which is exactly the +3.9 % over-count the rule exists
    to remove. Verified end to end 2026-09-15 (188 -> 143 -> 103 cells on a
    crowded KGN tile as crowd_b went 0 -> 0.02 -> 0.05).
    """
    import json
    import numpy as np
    from ml import infer

    # The manifest is swapped in memory, never on disk: an earlier version of
    # this test rewrote the shipped ml/weights/cellnet.json and restored it in
    # `finally`, so a killed run left the real weights manifest modified.
    shipped = json.loads(open("ml/weights/cellnet.json").read())
    manifest = {}
    monkeypatch.setattr(infer, "_manifest", lambda: manifest)
    # a synthetic heat map: one lonely peak, and a tight cluster of four. The
    # cluster is what a crowding coefficient is supposed to thin out.
    heat = np.zeros((120, 120), np.float32)
    heat[20, 20] = 0.80
    for dy, dx in ((0, 0), (0, 9), (9, 0), (9, 9)):
        heat[70 + dy, 70 + dx] = 0.80
    counts = {}
    # 0.08 is chosen so the rule bites: a cluster peak has 3 neighbours,
    # so it must clear 0.60 + 0.08*3 = 0.84 and its height is 0.80. At
    # 0.05 it would clear 0.75 and correctly survive - the coefficient
    # has to exceed (peak - thr)/neighbours to reject anything at all.
    for b in (0.0, 0.08):
        manifest.clear()
        manifest.update(shipped, crowd_level={"1": b, "2": b, "3": b}, crowd_r=29)
        assert infer.crowd_for(3) == (b, 29.0)
        counts[b] = len(infer.peaks.heat_to_points(
            heat, 0.60, crowd_b=infer.crowd_for(3)[0], crowd_r=infer.crowd_for(3)[1]))
    assert counts[0.0] == 5, counts
    assert counts[0.08] == 1, counts   # only the lonely peak survives
    # and a manifest written before the rule existed must behave exactly as before
    manifest.pop("crowd_level", None)
    manifest.pop("crowd_r", None)
    assert infer.crowd_for(3) == (0.0, infer.peaks.CROWD_R)
