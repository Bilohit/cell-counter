"""Merge the boundary re-annotation exports back into data/gt/.

    python tools/merge_boundary.py --dry-run     # report only, writes nothing
    python tools/merge_boundary.py               # writes, after backing up

Reads every boundary_*.json in the repo root (whatever the review pages
downloaded), and replaces the matching data/gt/*.json point lists.

data/gt is the ruler. Three guards, because a bad merge is silent and poisons
every measurement taken afterwards:
  1. every file is copied to data/gt/_backup_<stamp>/ first;
  2. a tile whose new list has FEWER points than the old one is refused unless
     --allow-removals - this pass is meant to add boundary dots, and a drop
     means a page was saved before its dots were loaded;
  3. the existing points must survive: every old point needs a new point
     within MOVED px, or the tile is refused. The page loads the old dots and
     the user only adds to them, so a vanished old dot is a bug, not an edit.

Refusals are per tile and never partial: a refused tile is left exactly as it
was and the rest still merge.
"""
import argparse
import datetime
import glob
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GT = "data/gt"
# px an existing dot may shift and still count as the same cell. 13.2 is the
# radius score.py matches a detection to a GT point within, so it is already
# this project's definition of "the same cell"; re-placing a dot inside it is a
# nudge, not a deletion. Measured 2026-09-16 on the boundary pass: the shifts
# were 4.5-18 px, i.e. mostly repositioning, with one true deletion at 90 px.
MOVED = 13.2


def nearest_ok(old, new, tol=MOVED):
    """Every old point has a new point within tol -> (ok, how many lost)."""
    if not len(old):
        return True, 0
    if not len(new):
        return False, len(old)
    o = np.asarray(old, float).reshape(-1, 2)
    n = np.asarray(new, float).reshape(-1, 2)
    d = np.linalg.norm(o[:, None] - n[None], axis=2).min(1)
    lost = int((d > tol).sum())
    return lost == 0, lost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-removals", action="store_true",
                    help="accept a tile whose point count went down")
    ap.add_argument("--moved", type=float, default=MOVED,
                    help="px an existing dot may be repositioned and still count as the same cell")
    ap.add_argument("--max-lost", type=int, default=0,
                    help="existing dots a tile may lose. The pages load the old dots and the "
                         "user only edits on top, so a few deliberate deletions are normal; a "
                         "large number means a page was reloaded and its edits lost.")
    ap.add_argument("--glob", default="boundary_*.json",
                    help="exports to read, relative to the repo root")
    a = ap.parse_args()

    exports = sorted(glob.glob(a.glob))
    if not exports:
        raise SystemExit(f"no exports match {a.glob} in {os.getcwd()}")

    tiles = []
    for p in exports:
        d = json.load(open(p, encoding="utf-8"))
        for t in d.get("tiles", []):
            tiles.append((p, t))
    print(f"{len(exports)} export(s), {len(tiles)} tiles\n")

    plan, refused = [], []
    for src, t in tiles:
        stem = t.get("stem") or os.path.splitext(t["image"])[0]
        gp = os.path.join(GT, stem + ".json")
        if not os.path.exists(gp):
            refused.append((stem, "no such GT file"))
            continue
        old = json.load(open(gp, encoding="utf-8"))
        op, np_ = old.get("points", []), t.get("points", [])
        opl, npl = old.get("pale", []), t.get("pale", [])
        dp, dpl = len(np_) - len(op), len(npl) - len(opl)

        if dp < -a.max_lost and not a.allow_removals:
            refused.append((stem, f"point count fell {len(op)} -> {len(np_)}"))
            continue
        ok, lost = nearest_ok(op, np_, a.moved)
        if lost > a.max_lost:
            refused.append((stem, f"{lost} existing dot(s) vanished (>{a.moved:.0f} px from any new one)"))
            continue
        plan.append((stem, gp, old, np_, npl, dp, dpl, t.get("reviewed", False), lost))

    w = max((len(s) for s, *_ in plan), default=10)
    add = 0
    for stem, _, old, np_, npl, dp, dpl, rev, lost in plan:
        add += max(0, dp)
        flag = f"   {lost} removed" if lost else ""
        print(f"{stem:{w}s}  points {len(old.get('points', [])):5d} -> {len(np_):5d} "
              f"({dp:+4d})   pale {dpl:+3d}{flag}")
    print(f"\n{len(plan)} tiles mergeable, {add} points added")

    if refused:
        print("\nREFUSED, left untouched:")
        for stem, why in refused:
            print(f"  {stem}: {why}")

    if a.dry_run:
        print("\n--dry-run: nothing written")
        return
    if not plan:
        print("\nnothing to write")
        return

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bdir = os.path.join(GT, f"_backup_{stamp}")
    os.makedirs(bdir, exist_ok=True)
    for stem, gp, old, np_, npl, *_ in plan:
        shutil.copy2(gp, os.path.join(bdir, os.path.basename(gp)))
        old["points"] = [[int(round(x)), int(round(y))] for x, y in np_]
        old["pale"] = [[int(round(x)), int(round(y))] for x, y in npl]
        with open(gp, "w", encoding="utf-8") as f:
            json.dump(old, f)
    print(f"\nwrote {len(plan)} GT files, originals in {bdir}")
    print("Every accuracy number in the repo is now stale: re-run python -m ml.loo")


if __name__ == "__main__":
    main()
