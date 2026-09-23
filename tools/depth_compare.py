"""TIF vs PNG vs a synthetic 16-bit round-trip, same detector, all 69 tiles.

The plan asked for an 8-bit vs 16-bit comparison. No 16-bit capture exists in
data/: every tile is uint8 (EVOS exports 8-bit). Upcasting 8->16 adds no
information, so the honest version of that deliverable is two questions we can
actually answer:
  1. does the shipped .tif and its .png export count the same?  (users supply both)
  2. does a 16-bit round-trip change the count?                 (a no is the result)
"""
import glob, os, sys
import cv2, numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pipeline

LEVEL = 3


def count(img):
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return len(pipeline.count_cells(img, {"level": LEVEL})["centers"])


def main():
    rows = []
    for tp in sorted(glob.glob("data/tif/*.tif")):
        stem = os.path.basename(tp)[:-4]
        pp = os.path.join("data/png", stem + ".png")
        if not os.path.exists(pp):
            continue
        tif = cv2.imread(tp, cv2.IMREAD_UNCHANGED)
        png = cv2.imread(pp, cv2.IMREAD_UNCHANGED)
        # 8 -> 16 -> 8. Exact by construction; a non-zero delta here is a bug in
        # the normalisation path, which is the only reason to run it.
        rt = ((tif.astype(np.uint16) * 257) / 257.0).round().astype(np.uint8)
        a, b, c = count(tif), count(png), count(rt)
        rows.append((stem, a, b, c))
        print(f"{a:5d} {b:5d} {c:5d}   {stem}", flush=True)

    t = np.array([r[1] for r in rows], float)
    p = np.array([r[2] for r in rows], float)
    r16 = np.array([r[3] for r in rows], float)
    print(f"\n{len(rows)} tiles, quality level {LEVEL}")
    for name, v in (("png", p), ("16-bit round-trip", r16)):
        d = v - t
        print(f"  tif vs {name:18s} identical on {int((d == 0).sum())}/{len(rows)} tiles, "
              f"mean |delta| {np.abs(d).mean():.2f} cells, "
              f"mean rel {100 * np.abs(d / np.maximum(t, 1)).mean():.2f} %, "
              f"pooled {100 * (v.sum() - t.sum()) / t.sum():+.2f} %")


if __name__ == "__main__":
    main()
