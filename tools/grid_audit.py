"""Grid/frame audit over a folder of EVOS captures - the ruler for grid changes.

Groups captures into pairs exactly as /api/pairs does, counts each field at
quality level 1 (classical - the grid stage is identical at every level and
this avoids the ONNX cost), and prints what the API would report to the
calculator: grid_cols, grid_rows, which triple sides were detected, and
whether isFullSquare (web/src/lib/concentration.ts) would accept the field.

    python tools/grid_audit.py "hemo run 1"
    python tools/grid_audit.py data/tif --lone     # never pair, one row per file
"""
import argparse
import collections
import glob
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pipeline  # noqa: E402


def field_row(tag, gray):
    r = pipeline.count_cells(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), {"level": 1}, require_grid=True)
    s = r["frame"]["sides"]
    cols, rows = len(r["grid_x"]) - 1, len(r["grid_y"]) - 1
    full = cols == 4 and rows == 4 and all(s.values())
    sides = "L%dR%dT%dB%d" % (s["left"], s["right"], s["top"], s["bottom"])
    return full, f"  {tag:34s} cols={cols} rows={rows} sides={sides} FULL={int(full)} n={r['count']:4d} gy={r['grid_y']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--lone", action="store_true", help="do not pair; one row per capture")
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(a.folder, "*.tif")) + glob.glob(os.path.join(a.folder, "*.png")))
    by = collections.defaultdict(list)
    for f in files:
        # "KA1 sq1.1.tif" -> bundle "KA1"; a file with no space is its own bundle
        by[os.path.basename(f).split(" ")[0]].append(f)
    tot_full = tot = 0
    for bundle, fs in by.items():
        grays = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in fs]
        print("===", bundle)
        groups = [[i] for i in range(len(fs))]
        stitched = {}
        if not a.lone:
            groups, stitched = pipeline.group_captures(grays)
        n_full = 0
        for g in groups:
            if len(g) == 2:
                tag = "PAIR " + os.path.basename(fs[g[0]])[:-4] + "+" + os.path.basename(fs[g[1]]).split(" ")[-1][:-4]
                full, line = field_row(tag, stitched[tuple(g)][0])
            else:
                full, line = field_row("LONE " + os.path.basename(fs[g[0]])[:-4], grays[g[0]])
            print(line)
            n_full += full
        print(f"  -> {n_full}/{len(groups)} fields FULL")
        tot_full += n_full
        tot += len(groups)
    print(f"TOTAL {tot_full}/{tot} fields FULL")


if __name__ == "__main__":
    main()
