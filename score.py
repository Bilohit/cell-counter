"""Score pipeline.count_cells against data/gt/*.json.

Usage: python score.py [--dia 22] [--params '{"sensitivity": 80}'] [--gt data/gt]
Optimal (Hungarian) one-to-one match of detected centres to GT points within an
absolute radius in pixels.
"""
import argparse
import glob
import json
import os

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from imaging import decode_image
from pipeline import count_cells


def load_gt(path, data=None):
    """Returns (image_basename, points (N,2), pale_points (M,2)).

    'pale' is optional: files written before pale annotation existed have no
    such key and yield an empty array. Pale points are real cells (user ruling
    2026-09-02) scored separately, because the original three GT files skipped
    them and a detection there is not an error.

    `data`: the already-`json.load`ed dict, when the caller has one (avoids
    re-reading and re-parsing a file it just opened to check for "points").
    """
    d = data
    if d is None:
        with open(path) as f:
            d = json.load(f)
    pts = np.array(d["points"], dtype=float).reshape(-1, 2)
    pale = np.array(d.get("pale", []), dtype=float).reshape(-1, 2)
    return d["image"], pts, pale


def inside_frame(points, frame):
    """Ground-truth points inside the triple-line frame.

    The ruler must measure the region the pipeline counts. 11-14 % of every
    ground-truth file lies outside the frame (measured 2026-09-02: 46 of 337
    points on tile 1, 57 of 498 on tile 2, 29 of 251 on tile 3), and those
    cells are correctly excluded from the count, so scoring them as misses
    reports a recall collapse that never happened - 0.856 -> 0.773 pooled.

    Half-open, matching count_cells and per_square_counts(rule="L") exactly,
    so a point on a boundary is treated the same way on both sides.
    """
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    if not frame or len(pts) == 0:
        return pts
    keep = ((pts[:, 0] >= frame["x0"]) & (pts[:, 0] < frame["x1"]) &
            (pts[:, 1] >= frame["y0"]) & (pts[:, 1] < frame["y1"]))
    return pts[keep]


def match(det, gt, radius):
    """Optimal one-to-one matching of detections to GT within `radius`.

    Returns the list of matched (det_index, gt_index) pairs. Hungarian, not
    greedy: greedy starves reachable pairs by taking the globally shortest
    first, which cost 4 TP at the shipped radius (measured 2026-09-02) - the
    same order as the accuracy deltas this scorer is used to judge.
    """
    if len(det) == 0 or len(gt) == 0:
        return []
    d = np.linalg.norm(det[:, None, :] - gt[None, :, :], axis=2)
    big = radius * 1000.0                     # cost of a forbidden pairing
    cost = np.where(d <= radius, d, big)
    rows, cols = linear_sum_assignment(cost)
    return [(int(i), int(j)) for i, j in zip(rows, cols) if d[i, j] <= radius]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dia", type=float, default=None)
    ap.add_argument("--params", default="{}")
    ap.add_argument("--gt", default="data/gt")
    ap.add_argument("--tif", default="data/tif")
    ap.add_argument("--dump-candidates", action="store_true",
                    help="write <candidates-dir>/<name>.candidates.json per tile: "
                         "existing GT plus unmatched detections appended as pale "
                         "points, for human review in tools/annotate.html (never "
                         "auto-merged into GT — that would tune the ruler to the "
                         "model); read back by ml/data.py:load_tile as pale-ignore "
                         "zones for training")
    ap.add_argument("--candidates-dir", default="data/candidates",
                    help="where --dump-candidates writes; never data/gt/ - that is "
                         "the ruler, and generated files must not live in it")
    ap.add_argument("--radius", type=float, default=13.2,
                    help="match radius in px, absolute so tuning `diameter` "
                         "cannot move the ruler (13.2 = 0.6 * 22)")
    a = ap.parse_args()
    params = json.loads(a.params)
    if a.dia:
        params["diameter"] = a.dia

    rows, tot = [], np.zeros(4)
    for gp in sorted(glob.glob(os.path.join(a.gt, "*.json"))):
        # --dump-candidates no longer writes here (data/candidates/ instead), so
        # this filter is not exercised by this script's own output any more; kept
        # as a guard against a candidates file left in data/gt/ by an old build
        # or a manual copy, since reading one as ground truth is silent and wrong.
        if gp.endswith(".candidates.json"):
            continue
        with open(gp) as f:
            d = json.load(f)
        if "points" not in d:   # cluster_gt.json holds "chunks"
            continue
        name, gt, pale = load_gt(gp, d)
        bgr = decode_image(os.path.join(a.tif, name))
        if bgr is None:
            print(f"skip {name}: not found"); continue
        r = count_cells(bgr, params)
        det = np.array(r["centers"], dtype=float).reshape(-1, 2)
        n_before = len(gt) + len(pale)
        gt, pale = inside_frame(gt, r["frame"]), inside_frame(pale, r["frame"])
        dropped = n_before - len(gt) - len(pale)
        if dropped:
            print(f"  {name[:44]}: {dropped} of {n_before} GT points lie outside "
                  f"the triple frame and are not scored")
        pairs = match(det, gt, a.radius)
        tp = len(pairs)
        # A detection that hits a pale GT point is correct (user ruling
        # 2026-09-02) but is not a TP against the solid set; it is removed
        # from the FP tally and reported in its own column instead.
        used = {i for i, _ in pairs}
        rest = np.array([det[i] for i in range(len(det)) if i not in used]).reshape(-1, 2)
        pale_pairs = match(rest, pale, a.radius)
        pale_tp = len(pale_pairs)
        fp, fn = len(det) - tp - pale_tp, len(gt) - tp
        if a.dump_candidates:
            pale_used = {i for i, _ in pale_pairs}
            cand = [[round(float(x), 1), round(float(y), 1)]
                    for i, (x, y) in enumerate(rest) if i not in pale_used]
            out = {"image": name,
                   "points": [[float(x), float(y)] for x, y in gt],
                   "pale": [[float(x), float(y)] for x, y in pale] + cand}
            os.makedirs(a.candidates_dir, exist_ok=True)
            cp = os.path.join(a.candidates_dir,
                               os.path.basename(gp)[:-5] + ".candidates.json")
            with open(cp, "w") as f:
                json.dump(out, f)
            print(f"  wrote {len(cand)} candidates -> {cp}")
        tot += (tp, fp, fn, pale_tp)
        rows.append((name, len(gt), len(pale), len(det), tp, pale_tp, fp, fn))

    if not rows:
        print("no ground truth found in", a.gt); return
    print(f"{'image':44} {'gt':>4} {'pale':>4} {'det':>5} {'tp':>4} {'ptp':>4} "
          f"{'fp':>4} {'fn':>4} {'prec':>6} {'rec':>6} {'err%':>7}")
    for name, g, pl, d, tp, ptp, fp, fn in rows:
        real = g + pl        # every real cell, solid and pale: what the app counts
        print(f"{name[:44]:44} {g:4d} {pl:4d} {d:5d} {tp:4d} {ptp:4d} {fp:4d} {fn:4d} "
              f"{tp/max(d,1):6.3f} {tp/max(g,1):6.3f} {100*(d-real)/max(real,1):7.1f}")
    tp, fp, fn, ptp = tot
    p, rc = tp / max(tp + fp + ptp, 1), tp / max(tp + fn, 1)
    print(f"TOTAL precision {p:.3f} recall {rc:.3f} F1 {2*p*rc/max(p+rc,1e-9):.3f} "
          f"(pale hits {int(ptp)})")
    print("Per-tile |err%| is the headline; FP and FN cancel ~99 % pooled, "
          "so a pooled count error is meaningless.")


if __name__ == "__main__":
    main()
