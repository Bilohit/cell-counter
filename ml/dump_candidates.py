"""Run the ML engine on tiles and write its detections for human review, so a
person can confirm / correct them into real GT.

    python -m ml.dump_candidates                      # the 5 old 10x tiles
    python -m ml.dump_candidates --glob "hemo1*"      # everything ingested

Output per tile: ml/runs/<stem>.ml.json
  {"image", "points": [[x, y], ...], "pale": [[x, y], ...],
   "grid_x": [...], "grid_y": [...], "frame": {...}}
"points" are peaks at the shipped threshold - the reviewer DELETES the wrong ones.
"pale" are extra peaks found only by a lowered threshold (--thr-hint, default 0.30
against the shipped 0.60) - the reviewer PROMOTES the real ones and ignores the
rest. That second pass fights preseeding bias: a cell the shipped model misses
would otherwise never be shown, stay unmarked, and be taught as background.
`grid_x`/`grid_y`/`frame` are overlay data for ml/make_review.py, never targets.

Peaks come from the raw heatmap (`infer.predict_stack`), NOT from
`count_cells`["centers"], because the counting path filters detections to inside
the triple frame and annotation covers the whole image - a frame-filtered preseed
left the outer band (11-45 % of a tile's cells on the old GT) with no dots at all.
Measured 2026-09-12 on picture 1 last-three-rows: outside the frame the model
scores recall 0.83 / precision 0.96, so preseeding out there is worth having.

Never writes into data/gt/ - a model must not edit its own ruler.
"""
import argparse
import glob
import json
import os

import numpy as np

import pipeline
from ml import data, infer
from ml.peaks import heat_to_points

LEVEL = 3          # the shipped path: 3-model ensemble, no TTA
HINT_MIN_DIST = 6  # ml.peaks.heat_to_points min_distance; closer than this is the same peak


def dump(stem, thr_hint):
    t = data.load_tile(stem)
    # level 1 is the classical engine: it costs 0.5 s and is the cheapest way to
    # get grid_x / grid_y / frame, which the ML path computes identically.
    geom = pipeline.count_cells(t["gray"], {"level": 1})

    weights = infer.weights_for(pipeline.LEVELS[LEVEL]["models"])
    heat = infer.predict_stack(t["channels"], weights, tta=False)
    thr = infer.thr_for(LEVEL)

    pts = np.array(heat_to_points(heat, float(thr)), float).reshape(-1, 2)
    cand = np.array(heat_to_points(heat, float(thr_hint)), float).reshape(-1, 2)
    if len(cand) and len(pts):
        d = np.linalg.norm(cand[:, None] - pts[None], axis=2).min(1)
        hints = cand[d > HINT_MIN_DIST]
    else:
        hints = cand

    out = {"image": stem + ".tif",
           "points": [[float(x), float(y)] for x, y in pts],
           "pale": [[float(x), float(y)] for x, y in hints],
           "grid_x": [int(v) for v in geom["grid_x"]],
           "grid_y": [int(v) for v in geom["grid_y"]],
           "frame": {k: (v if isinstance(v, dict) else int(v))
                     for k, v in geom["frame"].items()}}
    op = os.path.join("ml/runs", stem + ".ml.json")
    with open(op, "w") as f:
        json.dump(out, f)
    f = geom["frame"]
    outside = sum(1 for x, y in pts
                  if not (f["x0"] <= x < f["x1"] and f["y0"] <= y < f["y1"]))
    print(f"{stem}: {len(pts)} detections ({outside} outside the frame) "
          f"+ {len(hints)} hints -> {op}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glob", default="10x*", help="filename glob inside data/tif")
    ap.add_argument("--thr-hint", type=float, default=0.30,
                    help="lowered threshold for the unconfirmed hint pass")
    a = ap.parse_args()

    os.makedirs("ml/runs", exist_ok=True)
    paths = sorted(glob.glob(os.path.join("data/tif", a.glob + ".tif")))
    if not paths:
        raise SystemExit(f"no tiles match data/tif/{a.glob}.tif")
    for path in paths:
        dump(os.path.basename(path)[:-4], a.thr_hint)


if __name__ == "__main__":
    main()
