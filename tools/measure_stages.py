"""Measure each progress step's share of a count's wall clock, per quality rung.

The progress ring fills against these weights (`pipeline.PROGRESS_STEPS`), so
they have to be measured, not guessed: the detector is most of a count and the
grid/gate steps are nearly free, and a bar that gave each step a tenth would
sprint to 80 % and then stand still for seconds - which users read as a crash
(council, 2026-09-21).

    python tools/measure_stages.py [--repeat 3] [--image PATH]

Prints one table per rung and a PROGRESS_WEIGHTS block to paste into
pipeline.py. Steps 1 and 10 (decode/stitch in, JPEG encode out) are measured
here the same way app.py spends them, so the weights cover the whole request.
"""
import argparse
import io
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, ".")
import pipeline


def measure(bgr, level, repeat):
    """Seconds spent in each step, averaged over `repeat` runs."""
    totals = {n: 0.0 for n, _ in pipeline.PROGRESS_STEPS}
    for _ in range(repeat):
        marks = []

        t0 = time.perf_counter()
        # Step 1 is what app.py does before count_cells: decode is already done
        # here, so the honest stand-in is the colour conversion it performs.
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
        _ = gray.copy()
        t_in = time.perf_counter()

        def on_progress(step, frac, marks=marks):
            # Only the FIRST tick of a step opens it; the detector's sub-ticks
            # are progress within step 7, not new steps.
            if frac == 0.0:
                marks.append((step, time.perf_counter()))

        r = pipeline.count_cells(bgr, {"level": level}, require_grid=True,
                                 on_progress=on_progress)
        t_done = time.perf_counter()

        # Step 10 is app.py's encode: the base JPEG it stores per field.
        ok, buf = cv2.imencode(".jpg", r["image"], [cv2.IMWRITE_JPEG_QUALITY, 88])
        assert ok
        t_out = time.perf_counter()

        totals[1] += t_in - t0
        # Each marked step runs until the next mark; the last one runs to the
        # end of count_cells.
        for i, (step, at) in enumerate(marks):
            end = marks[i + 1][1] if i + 1 < len(marks) else t_done
            totals[step] += end - at
        totals[10] += t_out - t_done

    return {n: t / repeat for n, t in totals.items()}, r["count"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--image", default="data/png/hemo1 HNT sq1.1.png")
    a = ap.parse_args()

    bgr = cv2.imread(a.image, cv2.IMREAD_UNCHANGED)
    if bgr is None:
        sys.exit(f"could not read {a.image}")
    if bgr.ndim == 2:
        bgr = cv2.cvtColor(bgr, cv2.COLOR_GRAY2BGR)

    names = dict(pipeline.PROGRESS_STEPS)
    weights = {}
    for level in sorted(pipeline.LEVELS):
        secs, count = measure(bgr, level, a.repeat)
        total = sum(secs.values())
        weights[level] = [secs[n] / total for n, _ in pipeline.PROGRESS_STEPS]
        print(f"\n=== level {level}  ({pipeline.LEVELS[level]['models']} model(s), "
              f"tta {pipeline.LEVELS[level]['tta']})  {total:.2f} s, {count} cells, "
              f"mean of {a.repeat}")
        print(f"{'step':>4}  {'seconds':>8}  {'share':>6}  name")
        for n, label in pipeline.PROGRESS_STEPS:
            print(f"{n:>4}  {secs[n]:>8.3f}  {secs[n] / total * 100:>5.1f}%  {names[n]}")

    print("\n# MEASURED %s, %s, mean of %d runs each."
          % (time.strftime("%Y-%m-%d"), a.image.split("/")[-1], a.repeat))
    print("PROGRESS_WEIGHTS = {")
    for level, ws in weights.items():
        print("    %d: [%s]," % (level, ", ".join(f"{w:.4f}" for w in ws)))
    print("}")


if __name__ == "__main__":
    main()
