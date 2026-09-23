"""Directional safety check on a decode-constant change. NOT an accuracy tool.

Every number here is measured on the 69 tiles the models were trained on, so it
is optimistic by construction and is never quotable as accuracy - ml/loo.py is
the only accuracy ruler. What this CAN see, which mean |count error| cannot, is
a DIRECTIONAL defect:

  A. plateau   is the fitted threshold on a flat region or a spike? A spike means
               the fit found a lucky pixel and will not survive a new capture.
  B. sign      thr moved DOWN 0.06 and crowd_b moved UP 50 %. Those cancel where
               neighbour density is high and do NOT cancel where it is low: on a
               sparse tile the crowd term is ~0, so the change is pure threshold
               lowering, i.e. monotonic over-count. Mean |err| averages that away.
               Signed error per density bucket is what exposes it.

Peaks are cached once at CROWD_FLOOR and re-thresholded in numpy. Peak picking is
greedy in descending intensity, so extracting at the floor and filtering after is
exactly what a direct call at the higher threshold gives (tests/ml/test_model.py
pins this) - which is what makes the sweep free after one inference pass.

  python tools/decode_check.py
"""
import os
import pickle
import sys

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import score
from ml import data, infer, peaks
from skimage.feature import peak_local_max

RADIUS = 13.2
R = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ml", "runs")
CACHE = os.path.join(R, "decode_check.pkl")

# The shipped ensemble and the one it replaced. Both are durable locations: the
# scratch copies this first ran against (ml/runs/retrain3_s*.onnx) were deleted
# in the 2026-09-18 cleanup, and they were byte-identical to ml/weights anyway.
_NAMES = ("cellnet.onnx", "cellnet_s1.onnx", "cellnet_s2.onnx")
NEW = [os.path.join(os.path.dirname(R), "weights", n) for n in _NAMES]
OLD = [os.path.join(os.path.dirname(os.path.dirname(R)),
                    "backup", "2026-09-18-pre-retrain3", n) for n in _NAMES]

# Per quality level: how many models are averaged, whether TTA runs, the
# constants fitted 2026-09-18 on the corrected GT, and what cellnet.json ships
# today. Level 2 (3-model ensemble, no TTA) is the default the UI opens on.
# Renumbered 2026-09-21 with the rungs themselves (old 2/3/4 -> 1/2/3); the
# constants are unchanged, each one still belonging to the same inference path.
LEVELS = {
    1: dict(n=1, tta=False, new=(0.54, 0.030), old=(0.59, 0.020)),
    2: dict(n=3, tta=False, new=(0.51, 0.030), old=(0.58, 0.020)),
    3: dict(n=3, tta=True,  new=(0.52, 0.025), old=(0.57, 0.020)),
}
LEVEL = int(sys.argv[sys.argv.index("--level") + 1]) if "--level" in sys.argv else 2
CFG = LEVELS[LEVEL]
NEW_C, OLD_C = CFG["new"], CFG["old"]
GRID = np.arange(0.10, 0.90 + 1e-9, 0.01)
if LEVEL != 3:
    CACHE = os.path.join(R, f"decode_check_l{LEVEL}.pkl")


def build():
    """-> {set: {tile: (xy Nx2, val N, frame, gt_in_frame)}}, cached."""
    if os.path.exists(CACHE):
        with open(CACHE, "rb") as f:
            return pickle.load(f)
    idx = data.chan_idx("C")
    out = {}
    for tag, w in (("new", NEW[:CFG["n"]]), ("old", OLD[:CFG["n"]])):
        out[tag] = {}
        for i, name in enumerate(data.TILES):
            t = data._cached_tile(name)
            heat = infer.predict_stack(t["channels"][idx], w, CFG["tta"])
            c = peak_local_max(heat, min_distance=peaks.MIN_DIST,
                               threshold_abs=peaks.CROWD_FLOOR)
            out[tag][name] = (c[:, ::-1].astype(float), heat[c[:, 0], c[:, 1]],
                              t["frame"],
                              score.inside_frame(t["points"], t["frame"]))
            print(f"  {tag} {i + 1}/{len(data.TILES)} {name}", flush=True)
    with open(CACHE, "wb") as f:
        pickle.dump(out, f)
    return out


def neighbours(xy, val, r):
    """Peers within r px among peaks above CROWD_FLOOR, self excluded - the same
    count ml/peaks.heat_to_points applies."""
    ref = xy[val >= peaks.CROWD_FLOOR]
    if len(ref) < 2:
        return np.zeros(len(xy))
    n = cKDTree(ref).query_ball_point(xy, r, return_length=True).astype(float)
    return n - (val >= peaks.CROWD_FLOOR)


def decode(rec, nb, thr, b):
    """-> (detected in frame, gt in frame) for one tile at (thr, b)."""
    xy, val, frame, gt = rec
    keep = xy[val >= thr + b * nb]
    return len(score.inside_frame(keep, frame)), len(gt)


def main():
    cache = build()
    r = peaks.CROWD_R
    nb = {(tag, n): neighbours(cache[tag][n][0], cache[tag][n][1], r)
          for tag in cache for n in cache[tag]}
    tiles = list(data.TILES)

    # ---- A. plateau -----------------------------------------------------
    print(f"\n=== A. threshold plateau, NEW weights, level {LEVEL} "
          f"({CFG['n']} model(s){', TTA' if CFG['tta'] else ''}) ===")
    for b in (NEW_C[1], OLD_C[1]):
        curve = []
        for thr in GRID:
            e = [abs(d - g) / max(1, g)
                 for d, g in (decode(cache["new"][n], nb[("new", n)], thr, b)
                              for n in tiles)]
            curve.append(100.0 * float(np.mean(e)))
        curve = np.array(curve)
        lo = curve.min()
        flat = GRID[curve <= lo + 0.10]        # within 0.10 pp of the best
        print(f"\ncrowd_b {b:.3f}:  best {lo:.2f} % at thr {GRID[curve.argmin()]:.2f}")
        print(f"  within 0.10 pp of best: thr {flat.min():.2f} .. {flat.max():.2f} "
              f"(width {flat.max() - flat.min():.2f})")
        for thr in (0.48, 0.51, 0.54, 0.58, 0.62):
            print(f"    thr {thr:.2f}  {curve[int(round((thr - 0.10) / 0.01))]:.2f} %")

    # ---- B. sign x density ----------------------------------------------
    print("\n=== B. signed error by tile density (training tiles) ===")
    dens = np.array([len(cache["new"][n][3]) for n in tiles], float)
    q = np.quantile(dens, [1 / 3, 2 / 3])
    bucket = np.digitize(dens, q)
    names = ("sparse", "mid", "dense")

    for label, tag, (thr, b) in (("new weights + NEW constants", "new", NEW_C),
                                 ("new weights + OLD constants", "new", OLD_C),
                                 ("old weights + OLD constants", "old", OLD_C)):
        print(f"\n{label}   thr {thr:.2f} b {b:.3f}")
        print(f"  {'bucket':8} {'n':>3} {'gt/tile':>8} {'signed %':>9} "
              f"{'signed cells':>13} {'|err| %':>8}")
        for k in range(3):
            sel = [n for n, kk in zip(tiles, bucket) if kk == k]
            pct, cells, ae = [], [], []
            g_all = []
            for n in sel:
                d, g = decode(cache[tag][n], nb[(tag, n)], thr, b)
                pct.append(100.0 * (d - g) / max(1, g))
                cells.append(d - g)
                ae.append(100.0 * abs(d - g) / max(1, g))
                g_all.append(g)
            print(f"  {names[k]:8} {len(sel):>3} {np.mean(g_all):>8.0f} "
                  f"{np.mean(pct):>+8.2f} % {np.mean(cells):>+12.1f} "
                  f"{np.mean(ae):>7.2f} %")


if __name__ == "__main__":
    main()
