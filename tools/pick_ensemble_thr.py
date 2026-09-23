"""Pick the peak threshold for the SHIPPED ensemble.

ml/train.py picks a threshold per model, from that one model's heatmap.
Averaging several heatmaps lowers peak heights, so reusing a single model's
threshold on the ensemble silently rejects exactly the marginal detections
averaging exists to recover. This sweeps the same grid train.pick_threshold
uses, but through the real ensemble inference path.

Like train.pick_threshold, this sweeps over the tiles the models were trained
on - unavoidable for a shipped all-tile model, and the reason score.py at
defaults is a training-set number. The accuracy claim comes from ml/loo.py.

  python tools/pick_ensemble_thr.py ml/runs/ship_s0.onnx ml/runs/ship_s1.onnx ml/runs/ship_s2.onnx
"""
import concurrent.futures as cf
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import score
from ml import data, infer, peaks
from ml.peaks import heat_to_points

RADIUS = 13.2


def pick(weights, channels="C", tta=False, crowd_b=(0.0,), crowd_r=None):
    """-> (thr, crowd_b, mean |count err| %, pooled F1) for this inference mode.

    Picked on mean per-tile |count error|, not F1: F1 is indifferent to a false
    positive and a miss that cancel, a count is not, and picking on F1 is what
    left the 2026-09-14 baseline over-counting 42 of 53 tiles. F1 is printed
    alongside so a collapse would be visible.
    """
    idx = data.chan_idx(channels)
    r = peaks.CROWD_R if crowd_r is None else crowd_r
    preds = []
    for name in data.TILES:
        t = data._cached_tile(name)
        heat = infer.predict_stack(t["channels"][idx], weights, tta)
        preds.append((heat, t["frame"], score.inside_frame(t["points"], t["frame"])))

    def score_thr(b, thr):
        tp = fp = fn = 0
        errs = []
        for heat, frame, gt in preds:
            pts = np.array(heat_to_points(heat, float(thr), crowd_b=b, crowd_r=r),
                           float).reshape(-1, 2)
            pts = score.inside_frame(pts, frame)
            n = len(score.match(pts, gt, RADIUS))
            tp += n; fp += len(pts) - n; fn += len(gt) - n
            errs.append(abs(len(pts) - len(gt)) / max(1, len(gt)))
        return (float(thr), float(b), 100.0 * float(np.mean(errs)),
                2 * tp / max(1, 2 * tp + fp + fn))

    # The sweep is 8 crowd_b x 80 thresholds x 69 tiles of peak_local_max +
    # Hungarian match, and it ran single-threaded: measured 2026-09-18 at 4 % of
    # a 24-core box, i.e. one core, while 87 idle onnxruntime pool threads sat
    # around it. Threads, not processes: the heatmaps are ~1.7 GB of shared
    # read-only state and only 3 GB was free, and both hot calls (skimage
    # peak_local_max, scipy linear_sum_assignment) drop the GIL in C.
    # Deterministic: every (b, thr) is scored independently and the winner is
    # taken by min() over the ordered list, so the result does not depend on
    # completion order.
    workers = min(12, os.cpu_count() or 1)
    best = (0.5, 0.0, 1e9, 0.0)
    grid = np.arange(0.10, 0.90 + 1e-9, 0.01)
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        for b in crowd_b:
            for cand in pool.map(lambda thr: score_thr(b, thr), grid):
                if cand[2] < best[2]:
                    best = cand
            print(f"  crowd_b {b:.3f}: best so far thr {best[0]:.2f} b {best[1]:.3f} "
                  f"mean |err| {best[2]:.2f} %  F1 {best[3]:.4f}", flush=True)
    return best


if __name__ == "__main__":
    # --tta scores through the same 8 square symmetries the top rung runs with. TTA
    # averages 8 more heatmaps, so it lowers peak heights again and needs its
    # own threshold for exactly the reason the ensemble does.
    args = sys.argv[1:]
    tta = "--tta" in args
    w = [a for a in args if not a.startswith("--")]
    if not w:
        sys.exit(__doc__)
    # The crowding coefficient is picked per level for the same reason the
    # threshold is: averaging more heatmaps changes peak heights, and the
    # penalty a crowded peak should pay moves with them.
    bs = (0.0,) if "--no-crowd" in args else (0.0, 0.01, 0.015, 0.02, 0.023, 0.025, 0.03, 0.05)
    thr, b, mean, f1 = pick(w, tta=tta, crowd_b=bs)
    print(f"\nensemble of {len(w)}{' + TTA' if tta else ''}: "
          f"thr {thr:.2f}, crowd_b {b:.3f} @ {peaks.CROWD_R:.0f} px  "
          f"(mean per-tile |count err| {mean:.2f} %, pooled F1 {f1:.4f}, on the training tiles)")
    print(f'  cellnet.json:  "thr_level": {{..., "<level>": {thr:.2f}}}, '
          f'"crowd_level": {{..., "<level>": {b:.3f}}}, "crowd_r": {peaks.CROWD_R:.0f}')
