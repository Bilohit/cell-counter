"""Copy a capture folder into data/tif + data/png so it can be annotated.

    python tools/ingest_captures.py "hemo run 1" --prefix hemo1

Each "<name>.tif" becomes "data/tif/<prefix> <name>.tif" (byte copy, the TIF is
the pixel source of truth) and "data/png/<prefix> <name>.png" (8-bit grayscale,
lossless - tools/annotate.html and ml/make_review.py read the PNG, and a point
clicked there must land on the same pixel the pipeline sees).
Existing files are skipped unless --force; GT is keyed on the stem, so a rename
orphans annotations.
"""
import argparse
import glob
import os
import shutil
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--prefix", required=True, help='stem prefix, e.g. "hemo1"')
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    os.makedirs("data/tif", exist_ok=True)
    os.makedirs("data/png", exist_ok=True)
    n_new = n_skip = 0
    for src in sorted(glob.glob(os.path.join(a.folder, "*.tif"))):
        stem = f"{a.prefix} {os.path.basename(src)[:-4]}"
        tif, png = f"data/tif/{stem}.tif", f"data/png/{stem}.png"
        if os.path.exists(tif) and os.path.exists(png) and not a.force:
            n_skip += 1
            continue
        gray = cv2.imread(src, cv2.IMREAD_GRAYSCALE)
        if gray is None:
            print("UNREADABLE", src)
            continue
        shutil.copyfile(src, tif)
        cv2.imwrite(png, gray)
        # the annotator clicks on the PNG; if it is not the TIF's pixels, every
        # point is silently wrong
        back = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
        assert back is not None and (back == gray).all(), f"png != tif for {stem}"
        n_new += 1
        print(f"{stem}  {gray.shape[1]}x{gray.shape[0]}")
    print(f"-> {n_new} ingested, {n_skip} already present")


if __name__ == "__main__":
    main()
