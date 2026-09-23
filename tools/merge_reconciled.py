"""Merge reconciled_clumps.json (from tools/reconcile_clumps.html) back into the
ground truth, so the zoomed pass and the whole-tile pass stop contradicting each
other inside the clump boxes.

For every source tif:
  - reconciled chunk points are lifted to image coords (+ box x/y) and deduped,
    because 19 pairs of clump boxes overlap and a cell in an overlap is marked twice;
  - whole-tile GT points inside ANY of that tile's boxes are dropped and replaced
    by the reconciled set (the zoomed view is the higher-fidelity judgement there);
  - whole-tile GT points outside every box are kept untouched.
data/gt/cluster_gt.json is rewritten with the same reconciled points, so
ml/data.py's chunk samples and whole-tile samples now carry identical targets.

Pass the browser's download by its own path; do not copy it to the repo root,
where it would sit beside the tracked data/gt/reconciled_clumps.json as a
second, ambiguous ground truth.

  python tools/merge_reconciled.py ~/Downloads/reconciled_clumps.json          # dry run, prints the diff
  python tools/merge_reconciled.py ~/Downloads/reconciled_clumps.json --write  # apply
  python tools/merge_reconciled.py --selftest
"""
import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GT = os.path.join(ROOT, "data/gt")
DEDUP = 8.0      # px; cells sit ~22 px apart, so 8 catches an overlap double-mark only


def dedupe(points, r=DEDUP):
    """Greedy: keep a point unless an already-kept one is within r px."""
    kept = []
    for p in points:
        if all((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > r * r for q in kept):
            kept.append(p)
    return kept


def inside_any(pts, boxes):
    """Boolean mask: pts (N,2) falling inside at least one [x,y,w,h] box."""
    m = np.zeros(len(pts), bool)
    for x, y, w, h in boxes:
        m |= (pts[:, 0] >= x) & (pts[:, 0] < x + w) & (pts[:, 1] >= y) & (pts[:, 1] < y + h)
    return m


def merge(chunks):
    """-> {stem: {"old": n, "new": n, "points": [[x, y], ...]}} for every source tile."""
    out = {}
    for source in sorted({c["source"] for c in chunks}):
        mine = [c for c in chunks if c["source"] == source]
        boxes = [c["box"] for c in mine]
        lifted = [[p[0] + c["box"][0], p[1] + c["box"][1]] for c in mine for p in c["points"]]
        lifted = dedupe(lifted)

        stem = os.path.splitext(source)[0]
        with open(os.path.join(GT, stem + ".json")) as f:
            gt = np.array(json.load(f)["points"], float).reshape(-1, 2)
        outside = gt[~inside_any(gt, boxes)]
        pts = [[float(a), float(b)] for a, b in outside] + [[float(a), float(b)] for a, b in lifted]
        out[stem] = {"old": len(gt), "new": len(pts), "points": pts,
                     "replaced": int(inside_any(gt, boxes).sum()), "with": len(lifted)}
    return out


def selftest():
    # Two overlapping boxes on one tile; the shared cell is marked in both.
    chunks = [{"id": "a", "source": "t.tif", "box": [0, 0, 20, 20], "points": [[5, 5], [15, 15]]},
              {"id": "b", "source": "t.tif", "box": [10, 10, 20, 20], "points": [[5, 5], [18, 18]]}]
    lifted = dedupe([[p[0] + c["box"][0], p[1] + c["box"][1]] for c in chunks for p in c["points"]])
    # (15,15) and (10+5,10+5) are the same cell -> one survives; (5,5) and (28,28) stay.
    assert sorted(lifted) == [[5, 5], [15, 15], [28, 28]], lifted
    pts = np.array([[5., 5.], [15., 15.], [100., 100.]])
    assert list(inside_any(pts, [[0, 0, 20, 20]])) == [True, True, False]
    assert list(inside_any(pts, [[0, 0, 20, 20], [90, 90, 20, 20]])) == [True, True, True]
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("reconciled", nargs="?", help="reconciled_clumps.json from the review page")
    ap.add_argument("--write", action="store_true", help="apply; otherwise dry run")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.reconciled:
        ap.error("give reconciled_clumps.json (or --selftest)")

    with open(a.reconciled, encoding="utf-8") as f:
        chunks = json.load(f)["chunks"]
    have = {c["id"] for c in chunks}
    with open(os.path.join(GT, "cluster_gt.json"), encoding="utf-8") as f:
        orig = json.load(f)["chunks"]
    missing = {c["id"] for c in orig} - have
    if missing:
        print(f"WARNING: {len(missing)} chunk ids absent from the reconciled file; "
              f"their cluster_gt points are kept as-is: {sorted(missing)[:8]}")
        chunks = chunks + [c for c in orig if c["id"] in missing]

    res = merge(chunks)
    total_old = total_new = 0
    for stem, r in sorted(res.items()):
        total_old += r["old"]; total_new += r["new"]
        print(f"{stem[:40]:40} gt {r['old']:4d} -> {r['new']:4d} "
              f"({r['new'] - r['old']:+d})   in boxes {r['replaced']:4d} -> {r['with']:4d}")
    print(f"{'TOTAL':40} gt {total_old:4d} -> {total_new:4d} ({total_new - total_old:+d})")

    if not a.write:
        print("\ndry run; re-run with --write to apply")
        return
    for stem, r in res.items():
        p = os.path.join(GT, stem + ".json")
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        d["points"] = [[int(round(x)), int(round(y))] for x, y in r["points"]]
        with open(p, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1)
    with open(os.path.join(GT, "cluster_gt.json"), "w", encoding="utf-8") as f:
        json.dump({"chunks": [{"id": c["id"], "source": c["source"], "box": c["box"],
                               "points": [[int(round(p[0])), int(round(p[1]))] for p in c["points"]]}
                              for c in chunks]}, f, indent=1)
    print("\nwritten. re-run: python -m ml.loo --channels C --iters 3000")


if __name__ == "__main__":
    sys.exit(main())
