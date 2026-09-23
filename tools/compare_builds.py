"""Old build vs new build over every GT tile, on count error AND localisation.

The two builds ship IDENTICAL weights - only cellnet.json's decode constants
differ - so inference runs once per tile and the heatmap is decoded twice. That
makes the comparison exact (same heatmap, same GT, same matcher) and ~2x cheaper
than counting each tile twice.

  python tools/compare_builds.py --level 3 --out ml/runs/compare.json

Levels here use the numbering the two compared builds shipped with (2 = one
model, 3 = three, 4 = three + TTA), not today's 1/2/3: OLD and NEW below are
frozen tables from those builds, so the whole tool stays in that numbering.

Localisation is the mean distance of Hungarian-matched pairs, in pixels. A build
can hold its count error steady while placing its dots better or worse, and the
count metric alone cannot see that.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pipeline
import score
from ml import data, infer
from ml.peaks import heat_to_points

RADIUS = 13.2

# what each build shipped, from git: cdca795 (previous) and 13ec45c (current)
OLD = {"thr": {2: 0.63, 3: 0.60, 4: 0.61}, "crowd": {2: 0.015, 3: 0.020, 4: 0.020}, "r": 30.0}
NEW = {"thr": {2: 0.59, 3: 0.58, 4: 0.57}, "crowd": {2: 0.020, 3: 0.020, 4: 0.020}, "r": 30.0}


def metrics(det, gt):
    """-> dict. Count error is the headline; loc_* answer 'are the dots in the
    right place', which a count that cancels a miss against a false positive
    cannot show."""
    pairs = score.match(det, gt, RADIUS)
    tp, fp, fn = len(pairs), len(det) - len(pairs), len(gt) - len(pairs)
    d = [float(np.linalg.norm(det[i] - gt[j])) for i, j in pairs]
    return {
        "gt": len(gt), "det": len(det), "tp": tp, "fp": fp, "fn": fn,
        "err_pct": 100.0 * (len(det) - len(gt)) / max(1, len(gt)),
        "prec": tp / max(1, tp + fp), "rec": tp / max(1, tp + fn),
        "f1": 2 * tp / max(1, 2 * tp + fp + fn),
        "loc_mean": float(np.mean(d)) if d else None,
        "loc_median": float(np.median(d)) if d else None,
        "loc_p90": float(np.percentile(d, 90)) if d else None,
        "loc_sub2px": 100.0 * float(np.mean(np.array(d) < 2.0)) if d else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", type=int, default=3, help="quality rung to compare (3 is the default rung)")
    ap.add_argument("--out", default="ml/runs/compare.json")
    # Which ensemble to decode. The builds up to 2026-09-17 share one weight set
    # and differ only in decode constants, which is what the old/new split here
    # means. The 2026-09-18 retrain changed the WEIGHTS at unchanged constants,
    # so that build is scored by pointing this at it and reading the "new" rows.
    ap.add_argument("--weights", default=None,
                    help="directory holding cellnet{,_s1,_s2}.onnx; default is the shipped ml/weights")
    a = ap.parse_args()
    if a.weights:
        w = [os.path.join(a.weights, n)
             for n in ("cellnet.onnx", "cellnet_s1.onnx", "cellnet_s2.onnx")]
        missing = [p for p in w if not os.path.exists(p)]
        if missing:
            sys.exit("missing weights: " + ", ".join(missing))
    else:
        w = None

    rows = []
    names = data.TILES
    for k, name in enumerate(names):
        t = data.load_tile(name)
        if "frame" not in t or not len(t["points"]):
            continue
        gt = score.inside_frame(np.asarray(t["points"], float), t["frame"])
        # one inference, two decodes: the builds differ only after the heatmap
        # predict_stack, not predict: load_tile already built the channel stack,
        # and re-deriving it needs the background estimate that lives inside
        # texture_map. Passing bg=0.0 to predict() reads -79 % error.
        n_models = 3 if a.level >= 3 else 1
        heat = infer.predict_stack(t["channels"][data.chan_idx("C")],
                                   (w[:n_models] if w else infer.weights_for(n_models)),
                                   tta=(a.level == 4))
        row = {"tile": name, "group": data.group_of(name)}
        for tag, cfg in (("old", OLD), ("new", NEW)):
            pts = np.array(heat_to_points(heat, cfg["thr"][a.level],
                                          crowd_b=cfg["crowd"][a.level],
                                          crowd_r=cfg["r"]), float).reshape(-1, 2)
            row[tag] = metrics(score.inside_frame(pts, t["frame"]), gt)
        rows.append(row)
        print(f"  {k + 1}/{len(names)} {name}: "
              f"old {row['old']['err_pct']:+.1f} % / {row['old']['loc_mean']:.2f} px   "
              f"new {row['new']['err_pct']:+.1f} % / {row['new']['loc_mean']:.2f} px", flush=True)

    out = {"level": a.level, "radius": RADIUS, "old": OLD, "new": NEW,
           "weights": a.weights or "ml/weights", "tiles": rows}
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\n-> {a.out}  ({len(rows)} tiles)")

    for tag in ("old", "new"):
        e = np.array([abs(r[tag]["err_pct"]) for r in rows])
        s = np.array([r[tag]["err_pct"] for r in rows])
        L = np.array([r[tag]["loc_mean"] for r in rows if r[tag]["loc_mean"] is not None])
        tp = sum(r[tag]["tp"] for r in rows); fp = sum(r[tag]["fp"] for r in rows)
        fn = sum(r[tag]["fn"] for r in rows)
        print(f"{tag:4} mean |err| {e.mean():5.2f} %  median {np.median(e):5.2f} %  "
              f"signed {s.mean():+5.2f} %  <=2% {100 * (e <= 2).mean():4.0f} %  "
              f"F1 {2 * tp / (2 * tp + fp + fn):.4f}  loc {L.mean():.2f} px")


if __name__ == "__main__":
    main()
