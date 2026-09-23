"""Bit-identity ruler for the 2026-09-22 speed pass.

Fingerprints every field count_cells returns (arrays by dtype+shape+bytes,
floats by repr) for every data/tif tile at levels 1-3 and at level 0 (the
classical engine the accuracy rulers use), plus the pairing sweep's groups and
stitched outputs over the first 24 tiles - which hold 10 true pairs, so the
whole stitch path is covered, not just the first gate. `contours` is excluded
from day one: it is never sent to the browser and Task 3 deletes it.

    python tools/identity_check.py --save  ml/runs/speed_baseline.json
    python tools/identity_check.py --compare ml/runs/speed_baseline.json [--time]
"""
import argparse, glob, hashlib, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2
import numpy as np
import pipeline

SKIP = {"contours"}


def _feed(h, v):
    if isinstance(v, np.ndarray):
        h.update(f"nd{v.dtype}{v.shape}".encode()); h.update(np.ascontiguousarray(v).tobytes())
    elif isinstance(v, dict):
        h.update(b"{")
        for k in sorted(v, key=str):
            if k in SKIP:
                continue
            h.update(repr(k).encode()); _feed(h, v[k])
        h.update(b"}")
    elif isinstance(v, (list, tuple)):
        h.update(b"[" if isinstance(v, list) else b"(")
        for x in v:
            _feed(h, x)
        h.update(b"]")
    else:
        h.update(repr(v).encode())


def fp(v):
    h = hashlib.sha256(); _feed(h, v); return h.hexdigest()


def run(part=0, parts=1):
    files = sorted(glob.glob("data/tif/*.tif"))
    imgs = [cv2.imread(f, cv2.IMREAD_COLOR) for f in files]
    out, times = {}, {}
    n = 0
    for lvl in (0, 1, 2, 3):
        # Level 0 is the classical engine - the path score.py and ml/loo.py
        # rule with. Tasks 10-11 change stages it runs, so it is fingerprinted too.
        p = {"level": lvl} if lvl else {"level": 0, "engine": 0}
        mine = []
        for f, im in zip(files, imgs):
            if n % parts == part:                    # round-robin, so every part gets some Finest
                mine.append((f, im))
            n += 1
        if not mine:
            continue
        pipeline.count_cells(imgs[0], p)               # warm the sessions
        t = time.perf_counter()
        for f, im in mine:
            out[f"L{lvl}:{os.path.basename(f)}"] = fp(pipeline.count_cells(im, p))
        times[f"L{lvl} s/img"] = (time.perf_counter() - t) / len(mine)
    if part != parts - 1:
        return out, times
    grays = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for im in imgs[:24]]
    pipeline._STITCH_CACHE.clear()
    t = time.perf_counter()
    skipped = []
    groups, stitched = pipeline.group_captures(grays, skipped=skipped)
    times["sweep ms/pair"] = 1000 * (time.perf_counter() - t) / (24 * 23 // 2)
    out["sweep"] = fp([groups, sorted(stitched.items()), skipped])
    return out, times


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--save"); g.add_argument("--compare")
    ap.add_argument("--time", action="store_true")
    # Untimed checks only: counts are bit-identical when run concurrently
    # (docs/speed-report-2026-09-21.md, #2), so the fingerprints are the same
    # sharded or not. Timings from a sharded run would be contended, hence refused.
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--part", type=int, default=None, help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.part is not None:                               # worker: print fingerprints as JSON
        print(json.dumps(run(a.part, a.jobs)[0]))
        return
    if a.jobs > 1:
        if a.time:
            ap.error("--time needs --jobs 1: a sharded run shares the CPU")
        import subprocess
        procs = [subprocess.Popen([sys.executable, os.path.abspath(__file__), "--compare", "-",
                                   "--jobs", str(a.jobs), "--part", str(k)],
                                  stdout=subprocess.PIPE, text=True) for k in range(a.jobs)]
        out, times = {}, {}
        for pr in procs:
            o, _ = pr.communicate()
            if pr.returncode:
                sys.exit(f"worker failed ({pr.returncode})")
            out.update(json.loads(o.strip().splitlines()[-1]))
    else:
        out, times = run()
    if a.time or a.save:
        for k, v in times.items():
            print(f"{k}: {v:.3f}")
    if a.save:
        os.makedirs(os.path.dirname(a.save) or ".", exist_ok=True)
        json.dump(out, open(a.save, "w"), indent=0)
        print(f"saved {len(out)} fingerprints")
        return
    base = json.load(open(a.compare))
    bad = sorted(k for k in base if out.get(k) != base[k])
    print("IDENTICAL" if not bad else f"MISMATCH ({len(bad)}): {bad[:20]}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
