"""tools/sweep_decode.py --adaptive-thr: the fit helpers and the no-leakage
guarantee. No GPU, no inference, no torch - pure numpy on synthetic peak
lists, so this stays a fast unit test."""
import numpy as np

from tools.sweep_decode import (bg_contrast, count_above, det_above,
                                 fit_thr_line, optimal_tile_thr)


def peaks(intensities):
    """[(x, y, intensity)] rows, one per intensity, spaced far apart so
    crowding never kicks in."""
    n = len(intensities)
    xs = np.arange(n, dtype=np.float32) * 1000.0
    ys = np.zeros(n, dtype=np.float32)
    return np.stack([xs, ys, np.asarray(intensities, np.float32)], 1)


def test_count_above_plain_threshold():
    q = peaks([0.9, 0.7, 0.5, 0.3])
    assert count_above(q, 0.6, 0.0, 30.0) == 2
    assert count_above(q, 0.1, 0.0, 30.0) == 4
    assert count_above(q, 0.95, 0.0, 30.0) == 0


def test_optimal_tile_thr_picks_grid_value_matching_gt_count():
    # 5 peaks at descending heights; asking for 3 detections should land the
    # threshold between the 3rd and 4th tallest peak.
    q = peaks([0.9, 0.8, 0.7, 0.4, 0.2])
    grid = np.round(np.arange(0.10, 0.91, 0.01), 2)
    thr = optimal_tile_thr(q, n_gt=3, grid=grid, b=0.0, r=30.0)
    assert count_above(q, thr, 0.0, 30.0) == 3


def test_fit_thr_line_recovers_a_known_linear_relationship():
    xs = np.array([1.0, 2.0, 3.0, 4.0])
    ys = 0.2 + 0.05 * xs  # exact line, no noise
    b1, b0 = fit_thr_line(xs, ys)
    assert abs(b1 - 0.05) < 1e-9
    assert abs(b0 - 0.2) < 1e-9


def test_fit_thr_line_falls_back_to_constant_without_spread():
    # every training tile has the same statistic - nothing to regress against
    xs = np.array([0.5, 0.5, 0.5])
    ys = np.array([0.3, 0.4, 0.5])
    b1, b0 = fit_thr_line(xs, ys)
    assert b1 == 0.0
    assert abs(b0 - 0.4) < 1e-9


def test_bg_contrast_is_percentile_spread_of_the_frame_only():
    gray = np.zeros((20, 20), np.uint8)
    gray[5:15, 5:15] = 200          # the "frame"
    gray[0:5, :] = 250              # outside the frame - must not count
    frame = {"y0": 5, "y1": 15, "x0": 5, "x1": 15}
    assert bg_contrast(gray, frame) == 0.0  # uniform inside the frame


def test_det_above_matches_count_above():
    q = peaks([0.9, 0.7, 0.5, 0.3])
    det = det_above(q, 0.6, 0.0, 30.0)
    assert len(det) == count_above(q, 0.6, 0.0, 30.0) == 2
