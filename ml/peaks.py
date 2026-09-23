"""Heatmap -> point picker. numpy/skimage/scipy only, no torch (inference time)."""
import numpy as np
from scipy.spatial import cKDTree
from skimage.feature import peak_local_max


# NMS radius in px. A module global so ml/loo.py can sweep it without threading
# a parameter through pipeline.count_cells: too small splits one cell into two
# (a FP, and the project over-counts), too large merges touching cells (a FN).
MIN_DIST = 6

# Crowding-adaptive threshold. A peak must clear `thr + CROWD_B * n`, where n is
# how many other candidate peaks sit within CROWD_R px of it. Measured
# 2026-09-14, grouped 4-fold CV on the 69-tile GT, parameters fitted per fold on
# training tiles only (plan 2026-09-14 Track D2):
#
#   ensemble  global thr 0.62        mean |err| 3.55 %  p90 16.0 %  worst 17.3 %
#   ensemble  thr 0.58 + 0.015 n     mean |err| 2.98 %  p90 10.0 %  worst 12.8 %
#
# and it wins on every seed (3.78 -> 3.20, 3.42 -> 2.69, 4.13 -> 3.02). A single
# global threshold can only CENTRE the error distribution - raising it to cancel
# the over-count in the dense groups (KGN, KNT, KA2) strips marginal cells off
# the sparse ones that were already under-counting. This asks each peak how
# crowded its own neighbourhood is instead, which is the axis the two regimes
# actually differ on. CROWD_B = 0 restores the plain global threshold exactly.
CROWD_B = 0.0
CROWD_R = 30.0
# Crowding is counted over peaks above this floor, not above the final adaptive
# threshold: the neighbours that make a region dense include the ones the
# threshold is about to reject. Peak picking is greedy in descending intensity,
# so extracting at the floor and filtering afterwards gives exactly the peaks a
# direct call at the higher threshold would (tests/ml/test_model.py pins this).
CROWD_FLOOR = 0.30


def heat_to_points(heat: np.ndarray, thr: float, min_dist: int = None,
                   crowd_b: float = None, crowd_r: float = None) -> list:
    """Local maxima of `heat` above `thr`, at least `min_dist` px apart.

    With `crowd_b` non-zero the threshold is `thr + crowd_b * n` per peak, n
    being its neighbours within `crowd_r` px among peaks above CROWD_FLOOR.

    Returns [(x, y), ...] in image coordinates (row/col -> x=col, y=row).
    """
    md = MIN_DIST if min_dist is None else min_dist
    b = CROWD_B if crowd_b is None else crowd_b
    r = CROWD_R if crowd_r is None else crowd_r
    if not b:
        coords = peak_local_max(heat, min_distance=md, threshold_abs=thr)
        return [(int(c[1]), int(c[0])) for c in coords]

    floor = min(thr, CROWD_FLOOR)
    coords = peak_local_max(heat, min_distance=md, threshold_abs=floor)
    if not len(coords):
        return []
    v = heat[coords[:, 0], coords[:, 1]]
    xy = coords[:, ::-1].astype(float)          # (row, col) -> (x, y)
    ref = xy[v >= CROWD_FLOOR]
    if len(ref) < 2:
        n = np.zeros(len(xy))
    else:
        n = cKDTree(ref).query_ball_point(xy, r, return_length=True).astype(float)
        n -= (v >= CROWD_FLOOR)                 # a peak is its own neighbour
    keep = v >= thr + b * n
    return [(int(p[0]), int(p[1])) for p in xy[keep]]


# ------------------------------------------------------- sub-pixel placement

def _vertex(a, b, c, max_shift):
    """Offset of the parabola's vertex from the centre sample -> (offset, degenerate).

    The guard is RELATIVE to the peak's own height, not an absolute epsilon. An
    absolute floor (-1e-12, say) passes every peak whose curvature is merely
    tiny, which on an averaged heatmap is the common case: 3 models, and 8 more
    dihedral views on the TTA rung, flatten peak tops toward a plateau. The division
    then explodes and the clamp turns it into a maximal shift in whichever
    direction float noise happened to fall - strictly worse than not refining.
    Scaling the floor to `b` rejects a flat peak as flat while still refining a
    faint but genuine one.
    """
    den = a - 2.0 * b + c
    if den > -1e-3 * max(abs(b), 1e-6):
        return 0.0, True
    d = 0.5 * (a - c) / den
    return float(np.clip(d, -max_shift, max_shift)), False


def refine(heat, pts, max_shift=0.5, report=False):
    """Sub-pixel positions for peaks ALREADY selected by heat_to_points.

    Fits a parabola through the three samples either side of the peak on each
    axis independently and returns the vertex - standard 3-point quadratic
    interpolation. Selection, thresholding, crowding and NMS all ran before this
    and all saw integer coordinates, so this cannot add or remove a marker; it
    only moves one inside its own pixel. pipeline.count_cells applies it after
    every gate AND after the tally, which is what makes that structural rather
    than a promise (tests/pipeline/test_subpixel.py pins it).

    Integer decode is the placement floor: for a true centre uniformly placed
    within its pixel, rounding alone costs ~0.38 px of mean error, which is most
    of the 0.481 px the 2026-09-05 build scores - so that build's better
    placement is not a technique to port, it is that floor. Measured 2026-09-18.

    A peak on the image border has no 3x3 neighbourhood and is returned
    unchanged. With `report`, also returns {"n", "degenerate", "clamped"}: a high
    degenerate or clamped rate means the heatmap is too flat for this to be
    meaningful, which is the tell for the averaged-peak failure above.
    """
    h, w = heat.shape
    out, deg, clamp = [], 0, 0
    for x, y in pts:
        x, y = int(x), int(y)
        if not (0 < x < w - 1 and 0 < y < h - 1):
            out.append((float(x), float(y)))
            deg += 1
            continue
        b = float(heat[y, x])
        dx, gx = _vertex(float(heat[y, x - 1]), b, float(heat[y, x + 1]), max_shift)
        dy, gy = _vertex(float(heat[y - 1, x]), b, float(heat[y + 1, x]), max_shift)
        deg += gx and gy
        clamp += (abs(dx) == max_shift) + (abs(dy) == max_shift)
        out.append((x + dx, y + dy))
    if report:
        return out, {"n": len(pts), "degenerate": deg, "clamped": clamp}
    return out
