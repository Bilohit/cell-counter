"""Sub-pixel refinement of already-selected peaks.

Selection stays integer and stays in heat_to_points; this only moves an accepted
marker inside its own pixel, so it can never change how many markers there are.

The degeneracy guard gets its own tests because getting it wrong is worse than
not refining at all: an averaged heatmap (3 models, and 8 TTA views at level 4)
produces near-plateau peaks in quantity, and a guard that lets those through
turns a division by ~0 into a clamped half-pixel kick in an arbitrary direction.
"""
import numpy as np
import pytest

from ml.peaks import refine


def gauss(h, w, cx, cy, sigma=3.0):
    y, x = np.mgrid[0:h, 0:w]
    return np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2)).astype(np.float32)


def test_recovers_a_known_offset():
    # a Gaussian centred at (20.3, 15.7): the integer argmax is (20, 16), and
    # refinement must move toward the true centre, not away from it
    heat = gauss(40, 40, 20.3, 15.7)
    (x, y), = refine(heat, [(20, 16)])
    assert abs(x - 20.3) < abs(20 - 20.3)
    assert abs(y - 15.7) < abs(16 - 15.7)


def test_centred_peak_does_not_move():
    heat = gauss(40, 40, 20.0, 15.0)
    (x, y), = refine(heat, [(20, 15)])
    assert x == pytest.approx(20.0, abs=1e-6)
    assert y == pytest.approx(15.0, abs=1e-6)


def test_shift_is_bounded():
    rng = np.random.default_rng(0)
    heat = rng.random((64, 64)).astype(np.float32)
    pts = [(int(x), int(y)) for x, y in rng.integers(2, 62, size=(50, 2))]
    for (x, y), (px, py) in zip(refine(heat, pts), pts):
        assert abs(x - px) <= 0.5 and abs(y - py) <= 0.5


def test_border_peaks_are_left_alone():
    # no 3x3 neighbourhood exists, so there is nothing to fit
    heat = gauss(40, 40, 0.0, 39.0)
    assert refine(heat, [(0, 39)]) == [(0.0, 39.0)]


def test_flat_neighbourhood_does_not_divide_by_zero():
    heat = np.ones((20, 20), np.float32)
    (x, y), = refine(heat, [(10, 10)])
    assert (x, y) == (10.0, 10.0)


def test_near_plateau_peak_is_rejected_not_kicked():
    """The defect the council caught.

    An absolute `den >= -1e-12` guard passes a peak whose curvature is merely
    tiny, and 0.5*(a-c)/den then explodes into a clamped half-pixel shift. A
    plateau with a whisker of asymmetry must produce NO shift, not a maximal one.
    """
    heat = np.full((20, 20), 0.9, np.float32)
    heat[10, 9] = 0.9 - 1e-7          # den ~ -1e-7: negative, but not curvature
    heat[10, 11] = 0.9 - 3e-7
    (x, y), = refine(heat, [(10, 10)])
    assert x == 10.0, f"near-plateau peak was kicked to {x}"
    assert y == 10.0


def test_a_real_peak_is_still_refined_at_low_amplitude():
    # the guard is relative to peak height, so a small but genuine peak must
    # still refine - otherwise the fix for the plateau case breaks faint cells
    heat = 0.01 * gauss(40, 40, 20.3, 15.0)
    (x, y), = refine(heat, [(20, 15)])
    assert x > 20.0


def test_count_and_order_are_preserved():
    heat = gauss(40, 40, 20.3, 15.7)
    pts = [(20, 16), (5, 5), (30, 30)]
    out = refine(heat, pts)
    assert len(out) == len(pts)
    assert [(round(x), round(y)) for x, y in out][1:] == [(5, 5), (30, 30)]


def test_report_counts_degenerate_and_clamped():
    heat = np.ones((20, 20), np.float32)
    heat[5, 5] = 2.0                       # one genuine peak
    pts = [(5, 5), (10, 10), (12, 12)]
    out, rep = refine(heat, pts, report=True)
    assert len(out) == 3
    assert rep["degenerate"] == 2          # the two flat ones
    assert rep["n"] == 3
