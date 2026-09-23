"""Placement with and without sub-pixel refinement, on the SAME detections.

    python -u tools/score_subpixel.py --level 2

One inference per tile, one peak selection, two coordinate sets. The counts are
asserted equal rather than reported: refinement runs after the gates, so if they
ever differ it has been wired into the wrong place and the run should stop.

Three things the 2026-09-18 council required, and why each is here:

  * PAIRED, per point. Refinement moves each marker a fraction of a pixel; a
    difference of tile means would drown that in between-tile variance. Every
    comparison below is over the SAME matched pairs, before and after.

  * SPLIT BY CROWDING. At min_dist 6 a neighbour's shoulder contaminates the 3x3
    neighbourhood, so the parabola can pull peaks TOWARD each other - a
    systematic inward bias exactly where counting is hardest. A pooled mean would
    show a win while clumps regress, so the split is not optional.

  * PER LEVEL. ml/infer.py pads to a multiple of 8 on the bottom and right only,
    so the 8 dihedral TTA views do not see identical context. That is invisible
    at integer decode and exposed at sub-pixel. A Finest-only (TTA, level 3; level 4
    before the 2026-09-21 renumbering) regression is the signature; the answer
    would be to leave that level unrefined, not to drop this.

Expected effect, stated before measuring: errors add in quadrature, so removing a
0.38 px quantisation floor from 0.716 px leaves ~0.61 px - about 0.1 px. A much
larger gain means something other than quantisation moved and needs explaining.

Note the ceiling: data/gt is stored as INTEGERS (all 22164 points), so the ruler
carries its own ~0.29 px of quantisation noise. That noise is independent and
adds in quadrature rather than blocking the measurement, but no result here can
be read as the true placement error.
"""
import argparse
import json
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pipeline
import score
from ml import data, infer
from ml.peaks import heat_to_points, refine

RADIUS = 13.2


def paired(det_int, det_sub, gt):
    """-> (d_int, d_sub, nn) over pairs matched IDENTICALLY in both sets.

    The match is computed once, on the integer points, and reused: re-matching
    the refined points could pair a marker with a different GT cell and turn a
    matching change into a fake placement change.
    """
    pairs = score.match(det_int, gt, RADIUS)
    if not pairs:
        return np.empty(0), np.empty(0), np.empty(0)
    i = np.array([p[0] for p in pairs])
    j = np.array([p[1] for p in pairs])
    d_int = np.linalg.norm(det_int[i] - gt[j], axis=1)
    d_sub = np.linalg.norm(det_sub[i] - gt[j], axis=1)
    # nearest OTHER detection, as the crowding axis
    if len(det_int) > 1:
        nn = cKDTree(det_int).query(det_int[i], k=2)[0][:, 1]
    else:
        nn = np.full(len(i), np.inf)
    return d_int, d_sub, nn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", type=int, default=2, choices=sorted(pipeline.LEVELS))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = a.out or f"ml/runs/subpixel_l{a.level}.json"

    lv = pipeline.LEVELS[a.level]
    thr = infer.thr_for(a.level)
    crowd_b, crowd_r = infer.crowd_for(a.level)
    print(f"level {a.level}: thr {thr}  crowd_b {crowd_b}  crowd_r {crowd_r}")

    rows, D_int, D_sub, NN = [], [], [], []
    deg = clamp = npts = 0
    for name in data.TILES:
        t = data.load_tile(name)
        if "frame" not in t or not len(t["points"]):
            continue
        gt = score.inside_frame(np.asarray(t["points"], float), t["frame"])
        # models and TTA come from pipeline.LEVELS, the same map thr_for/crowd_for
        # are keyed on; a hard-coded copy went stale at the 2026-09-21 renumbering
        heat = infer.predict_stack(t["channels"][data.chan_idx("C")],
                                   infer.weights_for(lv["models"]), tta=lv["tta"])
        pts = heat_to_points(heat, thr, crowd_b=crowd_b, crowd_r=crowd_r)
        sub, rep = refine(heat, pts, report=True)
        deg += rep["degenerate"]; clamp += rep["clamped"]; npts += rep["n"]

        pi = np.array(pts, float).reshape(-1, 2)
        ps = np.array(sub, float).reshape(-1, 2)
        # The frame gate runs on the INTEGER points and the same mask then
        # selects both sets. That reproduces here what pipeline.count_cells gets
        # structurally by refining after the gate: filtering the refined points
        # on their own would let a 0.5 px shift carry one across the half-open
        # boundary, which is the count change this whole design exists to avoid.
        f = t["frame"]
        keep = ((pi[:, 0] >= f["x0"]) & (pi[:, 0] < f["x1"]) &
                (pi[:, 1] >= f["y0"]) & (pi[:, 1] < f["y1"]))
        pi, ps = pi[keep], ps[keep]
        assert len(pi) == len(ps), "refinement changed the detection count"

        d_int, d_sub, nn = paired(pi, ps, gt)
        if not len(d_int):
            continue
        D_int.append(d_int); D_sub.append(d_sub); NN.append(nn)
        rows.append({"tile": name, "n_det": int(len(pi)), "n_pairs": int(len(d_int)),
                     "loc_int": float(d_int.mean()), "loc_sub": float(d_sub.mean())})
        print(f"  {name[:46]:46} n {len(pi):5d}  {d_int.mean():.3f} -> {d_sub.mean():.3f} px")

    d_int = np.concatenate(D_int); d_sub = np.concatenate(D_sub); nn = np.concatenate(NN)
    delta = d_sub - d_int

    print(f"\ncounts identical on {len(rows)}/{len(rows)} tiles (asserted per tile)")
    print(f"refined peaks: {npts}   degenerate {100*deg/max(1,npts):.1f} %   "
          f"clamped-axis {100*clamp/max(1,2*npts):.1f} %")
    print(f"\nPAIRED over {len(d_int)} matched points")
    print(f"  integer   mean {d_int.mean():.4f} px   median {np.median(d_int):.4f}")
    print(f"  sub-pixel mean {d_sub.mean():.4f} px   median {np.median(d_sub):.4f}")
    print(f"  change    mean {delta.mean():+.4f} px   improved {100*(delta<0).mean():.1f} % "
          f"of points")
    # paired sign test: how likely is this split under 'refinement does nothing'
    n_better, n_worse = int((delta < 0).sum()), int((delta > 0).sum())
    print(f"  sign test  better {n_better}  worse {n_worse}  ties {len(delta)-n_better-n_worse}")

    print("\nBY CROWDING (nearest other detection)")
    edges = [(0, 8), (8, 12), (12, 20), (20, np.inf)]
    for lo, hi in edges:
        m = (nn >= lo) & (nn < hi)
        if m.sum() < 20:
            continue
        lab = f"{lo}-{hi} px" if np.isfinite(hi) else f"{lo}+ px"
        print(f"  nn {lab:10} n {m.sum():6d}   {d_int[m].mean():.4f} -> {d_sub[m].mean():.4f} px"
              f"   ({delta[m].mean():+.4f})")

    json.dump({"level": a.level, "tiles": rows,
               "paired": {"n": int(len(d_int)),
                          "loc_int": float(d_int.mean()), "loc_sub": float(d_sub.mean()),
                          "delta_mean": float(delta.mean()),
                          "better": n_better, "worse": n_worse},
               "degenerate_pct": 100 * deg / max(1, npts),
               "clamped_pct": 100 * clamp / max(1, 2 * npts)},
              open(out, "w"), indent=1)
    print(f"\n-> {out}")


if __name__ == "__main__":
    main()
