"""Validate downloaded annotation JSON from ml/runs/annotate.html into data/gt/.

    python tools/merge_gt.py *.json          # the per-tile downloads
    python tools/merge_gt.py ~/Downloads/*.json --dry-run

The page downloads one file per tile when you mark it done, already in the
data/gt format: {"image": "<stem>.tif", "points": [[x, y], ...], "pale": [...],
"whole_image": true}. A {"tiles": [...]} wrapper is also accepted, so files saved
by the earlier batch-export build still merge.

This is not a copy: it checks every tile against its capture before writing, and
the same tile downloaded twice (Chrome's "name (1).json") resolves to whichever
file is newer, since the tile identity comes from the "image" field and not from
the filename.

Refuses rather than guesses: an unknown image name, a point outside the image, or a
tile with no points at all stops that tile (the whole batch if --strict). The GT is
the project's ruler - a silently mangled entry is worse than a missing one.
An existing data/gt file is overwritten only with --force, and the old point count
is printed either way so a re-annotation that loses cells is visible.
"""
import argparse
import json
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GT, TIF = "data/gt", "data/tif"


def check(tile):
    """-> (stem, points, pale, error or None)."""
    name = tile.get("image", "")
    if not name.endswith(".tif"):
        return None, None, None, f"image is not a .tif name: {name!r}"
    stem = name[:-4]
    path = os.path.join(TIF, name)
    if not os.path.exists(path):
        return stem, None, None, f"no such capture: {path}"
    gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    h, w = gray.shape
    pts = [[int(round(p[0])), int(round(p[1]))] for p in tile.get("points", [])]
    pale = [[int(round(p[0])), int(round(p[1]))] for p in tile.get("pale", [])]
    if not pts:
        return stem, pts, pale, "no points - an empty tile is almost always a mistake"
    for x, y in pts + pale:
        if not (0 <= x < w and 0 <= y < h):
            return stem, pts, pale, f"point ({x}, {y}) outside the {w}x{h} image"
    return stem, pts, pale, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", help="downloaded <stem>.json files (globs are fine)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="overwrite existing data/gt files")
    ap.add_argument("--strict", action="store_true", help="write nothing if any tile is bad")
    a = ap.parse_args()

    # oldest first, so a re-download of the same tile ("name (1).json") wins
    seen = {}
    for path in sorted(a.files, key=lambda p: os.path.getmtime(p)):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        for t in (doc["tiles"] if isinstance(doc, dict) and "tiles" in doc else [doc]):
            if t.get("image") in seen:
                print(f"  newer copy of {t['image']} in {os.path.basename(path)}")
            seen[t.get("image")] = t
    tiles = list(seen.values())
    print(f"{len(tiles)} tiles from {len(a.files)} file(s)")

    ok, bad, skipped = [], [], []
    for t in tiles:
        stem, pts, pale, err = check(t)
        if err:
            bad.append((stem, err))
            print(f"  SKIP {stem}: {err}")
            continue
        out = os.path.join(GT, stem + ".json")
        if os.path.exists(out) and not a.force:
            with open(out) as f:
                had = len(json.load(f).get("points", []))
            skipped.append(stem)
            print(f"  EXISTS {stem}: {had} points on disk, {len(pts)} in batch - "
                  f"pass --force to overwrite")
            continue
        ok.append((stem, out, pts, pale, bool(t.get("whole_image"))))

    if a.strict and bad:
        raise SystemExit(f"--strict: {len(bad)} bad tiles, nothing written")

    for stem, out, pts, pale, whole in ok:
        print(f"  {'would write' if a.dry_run else 'write'} {stem}: "
              f"{len(pts)} points, {len(pale)} pale" + (", whole_image" if whole else ""))
        if a.dry_run:
            continue
        body = {"image": stem + ".tif", "points": pts, "pale": pale}
        if whole:
            body["whole_image"] = True
        with open(out, "w") as f:
            json.dump(body, f)

    print(f"-> {len(ok)} {'would be ' if a.dry_run else ''}written, "
          f"{len(skipped)} already present, {len(bad)} rejected")


if __name__ == "__main__":
    main()
