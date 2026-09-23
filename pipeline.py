"""Cell counting for EVOS haemocytometer captures (8-bit gray, 10x/4x tiles).

Chain: gray -> grid lines -> paint lines with background -> texture |gray-bg|
-> MAD threshold -> one seed per cell (self-templated NCC peaks) -> debris filter
-> faint second pass (pale cells outside the mask) -> per-square counts.
Count = number of seeds.
Every stage is parameterised through PARAMS so the UI builds a slider each.
"""

import functools
import hashlib
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from skimage.feature import peak_local_max

VERSION = "1.1 (2026-09-23): release zips fixed and slimmed; engine unchanged since the 2026-09-22 speed pass"   # shown in the UI so a stale server is visible

# key, label, min, max, default, step, group (= pipeline stage)
PARAMS = [
    ("diameter",         "Cell diameter (px)",            6,    60,   22,    1,     "Detect"),
    ("sensitivity",      "Sensitivity",                   40,   95,   60,    1,     "Threshold"),

    ("tophat_size",      "Line top-hat size",             5,    31,   21,    2,     "Grid"),
    ("line_len_frac",    "Line length (of image)",        0.02, 0.30, 0.06,  0.005, "Grid"),
    ("line_dilate",      "Line paint width (px)",         0,    9,    5,     1,     "Grid"),
    ("line_min_level",   "Line brightness over bg",       2,    30,   6,     1,     "Grid"),
    ("line_min_frac",    "Min line coverage (fraction)",  0.05, 0.9,  0.25,  0.05,  "Grid"),
    ("grid_edge_margin", "Ignore lines near edge (px)",   0,    60,   12,    1,     "Grid"),
    ("line_reject",      "Reject band around lines (px)",  0,   9,    3,     1,     "Grid"),
    ("line_fill",        "Interpolate across lines (0/1)", 0,    1,    1,     1,     "Grid"),
    ("line_gate",        "Extra match needed on lines",   0.0,  0.4,  0.08,  0.01,  "Grid"),
    # Boundary = run mass (sum of the coverage profile over the run), not width.
    # Measured 2026-09-12 over the 64 captures of hemo run 1 plus the 5 reference
    # tiles, unclipped on-lattice runs only: boundary mass 16.9-23.5 (stitched
    # pairs 16.8-21.4), interior 0.3-10.3. Width stopped separating them on
    # that run (KA1/KA2 boundaries 20-24 px vs the old 22 px floor; KGN/KNT
    # defocused interior lines 16-29 px). 14 sits >= 2.7 from both sides.
    ("triple_min_mass",  "Triple-line mass",              6,    30,   14,    1,     "Grid"),
    ("triple_relax_mass", "Triple-line mass, on lattice",  6,    30,   12,    1,     "Grid"),
    ("boundary",         "Count inside triple frame (0/1)", 0,  1,    1,     1,     "Grid"),

    ("bg_sigma_frac",    "Illumination sigma (0 = off)",  0,    0.20, 0,     0.005, "Texture"),
    ("tex_sigma",        "Texture smoothing (x dia)",     0.05, 0.40, 0.18,  0.01,  "Texture"),

    ("open_iter",        "Open iterations",               0,    3,    1,     1,     "Threshold"),
    ("fill_holes",       "Fill holes",                    0,    1,    1,     1,     "Threshold"),

    ("ncc_thr",          "Seed match (NCC)",              0.05, 0.50, 0.21,  0.01,  "Split"),
    ("ncc_thr2",         "Faint match (NCC)",             0.20, 0.60, 0.33,  0.01,  "Split"),
    ("seed_dist",        "Seed spacing (x dia)",          0.15, 1.00, 0.21,  0.01,  "Split"),

    # Default 1 since 2026-09-04: leave-one-tile-out on the 3 GT tiles, two seeds,
    # F1 0.935 / 0.938 (worst tile 2.1 % / 1.4 %) against classical 0.892 / 2.1 %,
    # and F1 0.795 vs 0.760 inside picture 4's held-out cluster chunks. See docs/accuracy-evidence.md.
    ("engine",           "Detector engine (0 classical, 1 ML)", 0, 1, 1, 1, "Cell check"),
    # Quality level, the only detector control the UI exposes since 2026-09-04.
    # 0 means "no level": engine is used exactly as passed, which is what
    # score.py --params '{"engine": 0}' and ml/loo.py rely on. 1-3 select a
    # measured configuration and overwrite that key - see LEVELS.
    ("level",            "Quality level (0 raw, 1-3)",    0,    3,    0,     1,     "Cell check"),
    ("focus_min",        "Out-of-focus rejection",        0,    300,  60,    5,     "Cell check"),
    ("rim_min",          "Boundary strictness",           0.60, 1.00, 1.00,  0.025, "Cell check"),
    ("min_area_frac",    "Min blob area (x cell area)",   0.02, 1.0,  0.20,  0.01,  "Filter"),
    ("edge_margin",      "Edge margin (px)",              0,    40,   4,     1,     "Filter"),
]
DEFAULTS = {p[0]: p[4] for p in PARAMS}
GROUPS = ["Cell check", "Detect", "Grid", "Texture", "Threshold", "Split", "Filter"]

# The three quality rungs the UI offers. `models` and `tta` apply to the ML path
# only; `params` is merged over the caller's params.
#
# PROVENANCE OF THE INLINE NUMBERS BELOW: measured leave-one-tile-out against the
# reconciled 2113-cell ruler (docs/accuracy-evidence.md "ML detector", ml/runs/loo.md 2026-09-04
# evening). BOTH halves of that are superseded:
#   - leave-one-tile-out leaked (the `.1`/`.2` captures of a pair overlap
#     physically), and was replaced by ml.data.group_of's grouped CV on
#     2026-09-12;
#   - the GT itself was re-annotated in 44da00d, so the 5 original tiles went
#     2113 -> 2048 points.
# They are kept as the record of what shipped, and are NOT comparable to any
# number measured after 2026-09-12. The retrain in progress (docs/plans/
# 2026-09-14-accuracy-to-2pct.md) replaces them together with the weights.
#
# Sub-pixel marker placement on the ML path. Applied at the very END of
# count_cells - after every gate and after per_square_counts - so the counted
# number is computed from integer coordinates and cannot move; see the comment
# there and tests/pipeline/test_subpixel.py. Default OFF until the measurement
# in ml/runs/loo.md says otherwise (plan docs/plans/2026-09-18-subpixel-placement.md).
SUBPIXEL = False

# The trailing numbers are F1, worst-tile |count error| and wall time. The TIME IS FOR ONE
# 1360x1024 TILE (measured on tile 3). README.md tabulates the same three rungs at roughly
# double these figures because it times a stitched TWO-CAPTURE FIELD - a different unit, not
# a contradiction.
LEVELS = {
    1: {"params": {"engine": 1}, "models": 1, "tta": False},   # F1 0.952, worst 2.3 %, 0.76 s
    2: {"params": {"engine": 1}, "models": 3, "tta": False},   # 0.955, 2.0 %, 2.02 s
    3: {"params": {"engine": 1}, "models": 3, "tta": True},    # 0.958, 1.7 %, 7.38 s
}
# Renumbered 2026-09-21: the old rung 1 (classical engine + cluster reprocess,
# F1 0.872, worst tile 19.8 %) was removed along with the cluster pass, and the
# remaining three moved down one. Each rung runs the SAME inference path its old
# number ran, so the decode constants in ml/weights/cellnet.json only changed
# key - no refit, and the shipped models are untouched. The classical engine is
# still reachable at level 0 (score.py --params '{"engine": 0}').


def _odd(v, lo=1):
    v = max(lo, int(round(v)))
    return v if v % 2 else v + 1


def _median_u8(a):
    """float(np.median(a)), from a histogram when `a` is uint8 - exact, because
    the two middle order statistics are integers (2026-09-22: equal on all 69
    data/tif tiles and on odd-sized crops; 4.95 -> 3.55 ms on a 1360x1024
    capture). Anything that is not uint8 takes np.median as before."""
    if a.dtype != np.uint8:
        return float(np.median(a))
    c = np.cumsum(np.bincount(a.ravel(), minlength=256))
    n = int(c[-1])
    lo = int(np.searchsorted(c, (n - 1) // 2 + 1))   # value at sorted index (n-1)//2
    hi = int(np.searchsorted(c, n // 2 + 1))         # value at sorted index n//2
    return (lo + hi) / 2.0


def auto_crop_frame(bgr, p):
    """Crop to the triple-line frame, plus one cell diameter of margin.

    Correctness beats aggressiveness (user ruling 2026-09-02): the margin
    means a cell sitting on the boundary survives the crop, and a frame with
    no detected side at all is declined rather than guessed at. Cropping is
    only a speed win; losing a readable region is not recoverable.

    Returns (crop, (ox, oy)): the crop and its top-left in the input image,
    so the UI can map hand-placed points between the two coordinate spaces.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    f = triple_frame(gray, p)
    if not any(f["sides"].values()):
        return bgr, (0, 0)
    h, w = gray.shape
    m = int(p["diameter"])
    x0, y0 = max(0, f["x0"] - m), max(0, f["y0"] - m)
    x1, y1 = min(w, f["x1"] + m), min(h, f["y1"] + m)
    out = bgr[y0:y1, x0:x1]
    return (out, (x0, y0)) if out.size else (bgr, (0, 0))


def warp_quad(bgr, quad):
    """Deskew the quadrilateral `quad` into an upright rectangle.

    The four corners arrive in any order from the UI, so they are sorted by
    the usual sum/difference trick: top-left has the smallest x+y, bottom-right
    the largest, top-right the smallest y-x, bottom-left the largest. The
    output is sized from the mean of each pair of opposite edges, so a
    moderately skewed capture keeps its scale.
    """
    M, (W, H) = quad_matrix(quad)
    return cv2.warpPerspective(bgr, M, (W, H))


def quad_matrix(quad):
    """The 3x3 perspective matrix a quad crop applies, plus the output size.

    Exposed separately so the API can hand the browser the original->warped
    transform and hand-placed points can follow the crop.
    """
    q = np.array(quad, np.float32).reshape(-1, 2)
    if q.shape != (4, 2):
        raise ValueError("A skewed crop needs exactly four corners.")
    s = q.sum(axis=1)
    d = q[:, 1] - q[:, 0]
    src = np.array([q[np.argmin(s)], q[np.argmin(d)],
                    q[np.argmax(s)], q[np.argmax(d)]], np.float32)
    tl, tr, br, bl = src
    W = int(round((np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2))
    H = int(round((np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2))
    if W < 16 or H < 16:
        raise ValueError("The selected area is too small to straighten.")
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    return cv2.getPerspectiveTransform(src, dst), (W, H)


# ---------------------------------------------------------------- grid

def _imaged(gray, k=5):
    """Where the frame actually holds a picture, as opposed to stitch padding.

    `stitch_pair` lays two captures on a canvas big enough for both and fills
    what neither covers with one constant grey. That fill is perfectly flat, and
    a microscope capture never is, so "the local min equals the local max" finds
    it exactly. Measured 2026-09-18 over all 69 captures and all 32 stitched
    fields of data/tif: a raw capture reads at most 0.0001 flat, and every
    stitched field reads 0.0000 to 0.0044 except HNT sq2, whose dx = 102 offset
    pads 6.8 % of the canvas. A 5x5 window also erodes the pad by 2 px at its
    boundary, which costs nothing and keeps a real line beside the seam.
    """
    return cv2.dilate(gray, np.ones((k, k), np.uint8)) != cv2.erode(gray, np.ones((k, k), np.uint8))


def _line_profiles(gray, p):
    """Per-column and per-row fraction of IMAGED pixels that look like a grid line.

    A 3-px dilation lets a 1-px line that wobbles across rows still cover its
    row. Also returns the opened top-hat images the mask is thresholded from,
    so `detect_grid` does the morphology exactly once.

    The denominator counts imaged pixels, not all of them (2026-09-18). A line
    cannot be painted on stitch padding, so scoring it against the full height
    charges it for rows that do not exist: HNT sq2's right boundary lies in the
    102 px strip only one of its two captures covers, and read mass 9.16 against
    a floor of 14 while the same line over its imaged rows reads 17.60, inside
    the 16.8-21.4 band every other boundary in the folder sits in. This is the
    same quantity measured over the right support, not a new one - on a field
    with no padding, which is every other field measured, it is unchanged to the
    bit.
    """
    h, w = gray.shape
    th = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(
        cv2.MORPH_RECT, (_odd(p["tophat_size"], 3),) * 2))
    L = max(9, int(min(h, w) * p["line_len_frac"]))
    horiz = cv2.morphologyEx(th, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (L, 1)))
    vert = cv2.morphologyEx(th, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, L)))
    t = int(p["line_min_level"])
    bh = cv2.dilate((horiz > t).astype(np.uint8), np.ones((3, 1), np.uint8))
    bv = cv2.dilate((vert > t).astype(np.uint8), np.ones((1, 3), np.uint8))
    # Clamped at 1: a column that is padding end to end has no line to find and
    # must read 0, not divide by nothing.
    seen = _imaged(gray)
    return (bv.sum(axis=0) / np.maximum(seen.sum(axis=0), 1),
            bh.sum(axis=1) / np.maximum(seen.sum(axis=1), 1), horiz, vert)


# Grid pitch of a 10x EVOS capture of this haemocytometer: 313-317 px on every
# tile measured (5 reference tiles 2026-09-02, 64 captures of hemo run 1
# 2026-09-12). Used only as the fallback when fewer than two lattice lines
# are found; otherwise the pitch is measured from the lines themselves.
NOMINAL_PITCH = 315.0


def _pitch_from_diffs(cs):
    """Median of consecutive differences that land in the nominal pitch band
    (0.8-1.2 x NOMINAL_PITCH), requiring at least 2 such diffs before trusting
    the median - a single diff is one noisy sample, not a measurement (see
    _lattice_lines and _frame_side for the measurements that required this).
    Falls back to NOMINAL_PITCH otherwise. Shared by both."""
    diffs = [d for d in np.diff(cs) if 0.8 * NOMINAL_PITCH <= d <= 1.2 * NOMINAL_PITCH]
    return float(np.median(diffs)) if len(diffs) >= 2 else NOMINAL_PITCH


def _on_lattice(pos, pitch, tol_frac):
    """Which entries of `pos` sit an integer multiple k in (1, 2, 3) of pitch
    from another entry, within an ABSOLUTE tolerance (`tol_frac * pitch`,
    never scaled by k - the pitch is rigid at 313-317 px, so k pitches of
    error stays small and scaling by k would admit the junk this rule exists
    to reject). Shared by _lattice_lines and _frame_side."""
    tol = tol_frac * pitch
    return [any(j != i and any(abs(abs(pos[j] - c) - k * pitch) <= tol for k in (1, 2, 3))
                for j in range(len(pos)))
            for i, c in enumerate(pos)]


def _lattice_lines(prof, thr, n, margin, gap=12):
    """Grid-line positions along one axis, restricted to the ruled lattice.

    Runs above `thr` are candidate lines (as before). Three corrections,
    all measured 2026-09-12 on the 64 captures of hemo run 1 (see
    tools/grid_audit.py and docs/plans/2026-09-12-hemo-run-1-grid-frame.md):

    1. MERGE. A defocused single line comes out as a 25-29 px run plus a
       1-3 px sliver 17-19 px away - past the 12 px run merge - and read as
       two lines (KNT sq1.1 y = 680 + 698; stitched KNT sq1 reported 6 rows).
       Candidates closer than 0.15 pitch collapse to their MASS-WEIGHTED
       CENTRE, `(c1*m1 + c2*m2) / (m1 + m2)`, carrying the combined mass
       forward. Measured 2026-09-12 on hemo1 KNT sq1.1.tif: the two runs are
       680 (1 px, mass 0.254) and 697-699 (3 px, mass 0.874), 18 px apart.
       Keeping the heavier run's own centroid (698) landed 9 px from the
       true line (tested against 689, tol 6 - a real miss); the mass-weighted
       centre (680*0.254 + 698*0.874)/(0.254+0.874) = 693.6 is the one line's
       actual position and is what test_detect_grid_merges_a_split_faint_line
       checks against.
    2. LATTICE. Keep a candidate only if another candidate sits an integer
       multiple k of the pitch away, k in (1, 2, 3), within the SAME absolute
       tolerance (not scaled by k - the pitch is rigid at 313-317 px, so
       three pitches of error is only ~6 px, well inside 0.06 x pitch ~ 19 px,
       and scaling the tolerance by k would admit the very junk this rule
       exists to reject). A single-pitch-only rule drops an outer boundary
       whenever the interior line nearest it is the one missing: measured on
       hemo1 KGN sq3.1.tif, candidates are 60, 375.56, 991 (pitch 315.56,
       tol 18.9); 991 is ~2 pitches (615.44) from its only neighbour 375.56,
       so a single-pitch test rejects it and FILL - which needs exactly that
       boundary to detect the 2-pitch gap - never runs. The k in (1, 2, 3)
       rule keeps 991 (|615.44 - 2*315.56| = 15.68 <= 18.9) so FILL can then
       insert the missing line between 375.56 and 991. The companion line is
       still rejected: on hemo1 KA2 sq1.1.tif (which is the one axis on that
       tile carrying a companion line above threshold) it sits ~63 px (0.2
       pitch) outside the double boundary, so its distance to a real line is
       ~378 or ~252 px - neither is within 18.9 px of 315, 630 or 945 px, so
       it stays off-lattice. This also still catches cracks and border smears
       (tile 4's x = 5) and subsumes the old edge-margin rescue: a boundary
       line clipped by the border (tile 1's y = 10, tile 2's x = 1351) sits
       one pitch from its neighbour and is kept on that account. The old
       margin filter is applied only to candidates that are NOT on the
       lattice AND have no other candidate to be tested against at all
       (`len(pos) < 2`) - which is what it was for: a lone, unpaired line has
       nothing for the lattice test to confirm it against, so the margin is
       the only check available. With 2+ candidates, an off-lattice one is
       rejected outright rather than rescued by the margin.
    3. FILL. Interior lines at coverage 0.24-0.35 hover on the 0.25
       threshold (KGN sq3.1 lost y ~ 686, KNT sq2.1 lost y ~ 700, KGN sq4.1
       lost y ~ 686) and stitch_pair then had no seam line. Lowering the
       threshold globally does not work - measured: 0.18 recovers 3 lines and
       admits 14 off-lattice peaks across the run. Instead, for every gap of
       exactly 2 or 3 pitches between kept lines, look for the best run at
       0.4 x thr within +/- 0.04 pitch of each predicted position and take
       its centre; if there is none, insert the predicted position - the
       grid is physically periodic and a line strictly between two found
       lines is not in doubt. Nothing is ever extrapolated beyond the
       outermost kept line; whether that is a boundary is triple_frame's
       question.
    """
    runs = _profile_runs(prof, thr, gap)
    if not runs:
        return []
    cand = [(float(np.mean(r)), float(prof[r].sum())) for r in runs]

    # 1. merge near-doubles to their mass-weighted centre, sized off
    # NOMINAL_PITCH rather than a candidate-measured pitch - the true pitch
    # is not yet known at this point, and a split run's own tiny diff is
    # exactly what would skew a pitch estimated from the raw candidates (see
    # _frame_side, fixed the same way 2026-09-12 pass 4 for the same reason).
    merged = []
    for c, m in cand:
        if merged and c - merged[-1][0] < 0.15 * NOMINAL_PITCH:
            pc, pm = merged[-1]
            merged[-1] = ((pc * pm + c * m) / (pm + m), pm + m)
        else:
            merged.append((c, m))

    # pitch from the MERGED candidates, falling back to the nominal one.
    # A single in-band diff is not a measurement, just one noisy sample: on the
    # KGN sq4 stitched pair only 3 raw candidates clear thr, giving one diff of
    # 307.5 (true pitch ~315-316), which then missed the k=3 lattice check for
    # the far boundary by 29.5 px against an 18.45 px tolerance and dropped it.
    # Require at least 2 in-band diffs before trusting their median.
    pos = [c for c, _ in merged]
    pitch = _pitch_from_diffs(pos)

    # 2. lattice membership; the edge margin only prunes the off-lattice rest
    on = [c for c, keep in zip(pos, _on_lattice(pos, pitch, 0.06)) if keep]
    for i, c in enumerate(pos):
        if c not in on and margin <= c < n - margin and len(pos) < 2:
            on.append(c)          # a lone line: nothing to test it against, keep it
    on.sort()

    # 3. fill missed interior lattice positions
    weak_runs = _profile_runs(prof, 0.4 * thr, gap)
    filled = []
    for i, c in enumerate(on):
        filled.append(c)
        if i + 1 == len(on):
            break
        k = int(round((on[i + 1] - c) / pitch))
        if k in (2, 3):
            step = (on[i + 1] - c) / k
            for s in range(1, k):
                pred = c + s * step
                lo, hi = int(pred - 0.04 * pitch), int(pred + 0.04 * pitch)
                weak = [r for r in weak_runs if lo <= np.mean(r) <= hi]
                filled.append(float(np.mean(max(weak, key=lambda r: prof[r].sum())))
                              if weak else pred)
    return [int(c) for c in filled]


def detect_grid(gray, p, profiles=None):
    """Bright long straight lines -> (line_mask, xs, ys).

    top-hat isolates thin bright structures, opening with a long 1-D SE keeps
    only lines, Otsu binarises, projection peaks give line positions.
    """
    h, w = gray.shape
    prof_v, prof_h, horiz, vert = profiles if profiles is not None else _line_profiles(gray, p)
    _, mh = cv2.threshold(horiz, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, mv = cv2.threshold(vert, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.max(mh, mv)
    d = int(p["line_dilate"])
    if d > 0:
        mask = cv2.dilate(mask, np.ones((_odd(d), _odd(d)), np.uint8))
    m = int(p["grid_edge_margin"])
    xs = _lattice_lines(prof_v, p["line_min_frac"], w, m)
    ys = _lattice_lines(prof_h, p["line_min_frac"], h, m)
    return mask, xs, ys


def _profile_runs(prof, thr, gap=12):
    """Runs of the 1-D profile above `thr`, each as its list of indices.
    Runs closer than `gap` px merge, so a triple line yields one run."""
    idx = np.where(prof > thr)[0]
    runs = []
    for i in idx:
        if runs and i - runs[-1][-1] <= gap:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


def _merged_runs(prof, runs):
    """Runs as (centre, mass, lo, hi), near-doubles collapsed into one.

    Split runs are merged to their mass-weighted centre, carrying the combined
    mass and span, BEFORE anything estimates the pitch - a split run would skew
    it otherwise. The merge distance is sized off NOMINAL_PITCH because the true
    pitch is not yet known at this point. Shared by `_frame_side` and
    `_lattice_boundary`, which have to agree about what a candidate is.
    """
    cand = [(float(np.mean(r)), float(prof[r].sum()), int(r[0]), int(r[-1])) for r in runs]
    merged = []
    for c, m, lo, hi in cand:
        if merged and c - merged[-1][0] < 0.15 * NOMINAL_PITCH:
            pc, pm, plo, phi = merged[-1]
            merged[-1] = ((pc * pm + c * m) / (pm + m), pm + m, min(plo, lo), max(phi, hi))
        else:
            merged.append((c, m, lo, hi))
    return merged


def _frame_side(prof, runs, n, min_mass, tol=0.10):
    """One axis of the triple-line frame -> (lo, hi, lo_detected, hi_detected).

    A run is a boundary candidate only if it sits on the grid lattice, does
    not touch the image border, and carries at least `min_mass` of the
    coverage profile (sum of prof over the run = width x mean coverage).
    Mass replaced width on 2026-09-12: hemo run 1 rules its boundary as a
    double line 20-24 px wide (KA1/KA2 read 21 px against the old 22 px
    floor, so every KA square was "partial") while its defocused KGN/KNT
    interior lines run 16-29 px (KNT sq3.1's 682 line became a false bottom
    and cut off a row). Measured on all 64 captures + the 5 reference tiles:
    boundary mass 16.9-23.5, interior <= 10.3; on the 30 stitched pairs
    16.8-21.4 vs <= 10.1 - a horizontal stitch offset (dx 102 on HNT sq2)
    spreads a vertical line thinner across more columns, which is the other
    reason width was the wrong measure. (That note used to end "and leaves
    the mass alone". It does not: the offset PADS the canvas, and scoring a
    line standing in the padded strip against the full height halved its
    mass - HNT sq2's right boundary read 9.16. Corrected 2026-09-18 in
    `_line_profiles`, which now divides by the imaged rows; it reads 18.70.)
    The
    reference-tile traps still hold: tile 4's x = 0..11 artefact is off
    lattice, so it is caught by the lattice test above and never reaches the
    border-clip guard below. A run clipped by the border IS still rejected,
    but only when its mass falls under `min_mass` (narrowed 2026-09-12, pass
    5) - see that guard's own comment for the reasoning and the two
    boundaries it recovered. A side with no accepted run falls back to 0/n
    here and `triple_frame` clamps it to the outermost grid line.

    2026-09-12 (pass 4): the lattice test carried the same two defects
    `_lattice_lines` had before this task - a single, unfiltered
    `np.median(np.diff(c))` pitch (vulnerable to a split run's tiny diff) and
    membership tested at exactly one pitch away. On hemo run 1's KGN bundle
    this threw away a real, in-view boundary with ample mass: KGN sq2's
    bottom run (mass 17.76) and KGN sq3's (mass 17.56) both clear
    min_mass=14 easily but were rejected as "off-lattice" because each sits
    2-3 pitches from its nearest RAW neighbour, and the raw pitch itself was
    skewed by an unmerged split interior line - KGN sq2's candidates include
    362.7/378 (15.3 px apart) and 683.4/700.5 (17.1 px apart), which used to
    enter `np.median(np.diff(c))` unfiltered and pull the pitch to 305.4; KGN
    sq3's median of 318.7 was skewed by an edge-artefact gap of 51 px. Fixed
    the same way as `_lattice_lines`: merge near-doubles to their
    mass-weighted centre first (sizing the merge distance off NOMINAL_PITCH,
    since the true pitch is not yet known - `_pitch_from_diffs` needs the
    merge done first so a split cannot skew it), then accept a candidate on
    an integer multiple k in (1, 2, 3) of that pitch, at the SAME `tol` (not
    scaled by k, same reasoning as `_lattice_lines`). Re-measured after the
    fix: KGN sq2's bottom run is kept (k=2, its 614.5 px gap to the nearest
    merged candidate lands within `tol * pitch` of 2x pitch); KGN sq3's
    likewise (k=3, its 940.8 px gap lands within tol of 3x pitch). KGN sq1's
    bottom run is on-lattice too, but at this pass it still touched the
    stitched image's border (mass 17.93, run within 3 px of the edge) and
    the border-clip guard below then rejected any clipped run outright,
    regardless of mass - narrowed in pass 5 (see that guard's comment).

    2026-09-12 (pass 6): a CORNER clip - the vertical and the horizontal
    triple both cut by the border on one field - is judged by two entirely
    INDEPENDENT single-axis calls, and there is deliberately no joint rule.
    The case is real, not hypothetical: `4x tile picture 1` carries one (its
    right run has mass 18.98 over x = 1299..1359 of 1360, its bottom run mass
    29.04 over y = 886..1023 of 1024, and both are accepted), though none of
    hemo run 1's 32 stitched fields does - 2 clipped accepts in the whole
    folder, on two different fields, never both axes of one. Three reasons to
    leave the axes uncoupled. Nothing physically couples them: the two
    triples are separate rulings on the slide, so accepting one is no
    evidence about the other, and a joint rule would have to invent a
    correlation that is not there. The artefact such a rule would exist to
    catch cannot reach this function anyway: `_line_profiles` opens with an
    (L, 1) / (1, L) kernel, L = max(9, int(min(h, w) * line_len_frac)) ~ 80 px
    on a 10x capture, so a compact corner blob or vignette smear never
    becomes a run on either axis - the same finding that emptied the pass-5
    blanket guard. And the error direction is safe: a clipped run's centre is
    the centre of its VISIBLE part, biased INWARD of the true line, so a
    corner accept shrinks the counted frame rather than widening it, while a
    joint refusal would turn a detected frame into a partial field that the
    concentration calculator drops without telling anyone. Pinned by
    test_frame_side_accepts_a_corner_clipped_boundary_on_both_axes.
    """
    if len(runs) < 2:
        return (0, n, False, False)
    merged = _merged_runs(prof, runs)
    pos = [c for c, _, _, _ in merged]
    pitch = _pitch_from_diffs(pos)
    on = _on_lattice(pos, pitch, tol)

    keep = []
    for (c, m, lo, hi), is_on in zip(merged, on):
        if not is_on:
            continue                                        # off-lattice artefact
        # Border clipping can only REMOVE mass (a truncated run's coverage
        # profile is a subset of the untruncated one), never add it, so a
        # clipped run that already clears min_mass is a lower bound on the
        # true mass, not a false positive - reject it only when clipping
        # could be what pushed it under. Narrowed 2026-09-12 (pass 5): the
        # old blanket rejection cited tile 4's x = 0..11 smear as its reason,
        # but that artefact is off-lattice and is already caught by the `not
        # is_on` check above - it never reached this guard, so the blanket
        # form was protecting against nothing demonstrable. Re-measured on
        # hemo run 1: this recovers KGN sq1's bottom run (mass 17.93) and KGN
        # sq4's right run (mass 17.43), both on-lattice and previously
        # refused purely for touching the image edge; score.py was
        # byte-identical on both engines before/after.
        if (lo <= 2 or hi >= n - 3) and m < min_mass:
            continue                                        # clipped below threshold: unreliable
        if m >= min_mass:
            keep.append(int(c))
    mid = n / 2.0
    lows = [k for k in keep if k < mid]
    highs = [k for k in keep if k >= mid]
    return (min(lows) if lows else 0, max(highs) if highs else n,
            bool(lows), bool(highs))


# The counting area is four small squares on a side, so the two triple lines of
# one axis stand four pitches apart. Measured on all 32 stitched fields of
# data/tif, both axes: the span between detected triples is 1257.5-1263.0 px
# (mean 1260.2, sd 1.4), and four lattice pitches predicts it to within 14 px
# worst case (mean +0.3, sd 2.8).
FULL_SPAN = 4


def _lattice_boundary(prof, runs, n, expect, pitch, min_mass, tol=0.10):
    """The boundary the lattice says sits at `expect`, if a real run is there.

    This is a SECOND look at a side `_frame_side` already refused, and it exists
    because that refusal is made on one number - the run's coverage mass - with
    no use of the fact that a haemocytometer's counting area is a square of
    known size. KNT sq2's right triple is tilted about 0.6 degrees and rides the
    frame edge, so its per-column coverage peaks at 0.72 where an upright line
    reaches 1.00; it read mass 14.29 against a floor of 14 (2026-09-18), which
    is a pass by luck, not by measurement. Knowing WHERE the line has to be is
    worth more than the last two points of mass, so a run standing there is
    accepted at the lower `triple_relax_mass`.

    Three things keep this from inventing a boundary:

    - It only runs on an axis with exactly one side found, so there is a
      measured line to count four pitches from.
    - `expect` must land inside the image. This is what keeps the 10x rule
      intact: a lone capture shows three of the four rows, so its missing
      horizontal triple is predicted a full pitch outside a 1024-tall frame and
      refused. Pinned by test_lone_capture_is_never_a_full_square - if this ever
      passes, every concentration from a lone capture is silently halved.
    - A real run must be at `expect`, within `tol` of a pitch, carrying
      `min_mass`. An interior line cannot be mistaken for one: interior lines
      stand one to three pitches away, 295 px or more from `expect`, while the
      window is 0.10 pitch (~31 px). The relaxed floor of 12 still sits clear of
      the interior ceiling, measured at 10.09 over the 32 stitched fields.
    """
    if not 0 <= expect <= n - 1:
        return None
    win = tol * pitch
    best = None
    for c, m, _, _ in _merged_runs(prof, runs):
        if abs(c - expect) <= win and m >= min_mass:
            if best is None or abs(c - expect) < abs(best - expect):
                best = c
    return None if best is None else int(best)


def triple_frame(gray, p, xs=None, ys=None, profiles=None):
    """The outer triple-line frame: the only area whose cells are counted.

    A haemocytometer grid is ruled with single lines inside and triple lines
    around the counting area. Cells outside the triple frame are outside the
    known volume and must not count (user ruling 2026-09-02). A side with no
    detected triple is normal here - the microscope shows 3 of the 4 rows so
    only one horizontal triple is in view - and used to fall back to the image
    edge. Overruled 2026-09-02: only FULL grid boxes count, so an undetected
    side now clamps to the outermost detected grid line on that axis (`xs`/
    `ys` from `detect_grid`) when one exists, else keeps the image edge.
    Measured trigger: tile 4 first-three-rows, grid_y [47, 360, 674, 990],
    bottom undetected -> y1 was 1024 and 9 cells in the y = 990..1024 partial
    row-4 boxes were wrongly counted; clamping y1 to 990 excludes them. The
    `sides` flags still mean "triple really detected", never "clamped".
    Boundary recognition is by run mass since 2026-09-12; see _frame_side.
    """
    h, w = gray.shape
    prof_v, prof_h, _, _ = profiles if profiles is not None else _line_profiles(gray, p)
    mm = float(p["triple_min_mass"])
    runs_v = _profile_runs(prof_v, p["line_min_frac"])
    runs_h = _profile_runs(prof_h, p["line_min_frac"])
    x0, x1, ld, rd = _frame_side(prof_v, runs_v, w, mm)
    y0, y1, td, bd = _frame_side(prof_h, runs_h, h, mm)

    # Second look where the lattice says a boundary MUST be. See
    # `_lattice_boundary`: this only ever fires on an axis with exactly one side
    # found, and only accepts a real run that is really there.
    rx = float(p["triple_relax_mass"])
    # Whether the second look was what made a side true. It is a real boundary
    # either way - nothing here accepts a line that is not there - but it cleared
    # a lower floor than the rest, so the field is the one to look at first when
    # a number looks wrong. The UI marks it; no stage reads it.
    rec = False
    if ld != rd and xs is not None and len(xs) >= 2:
        pitch = _pitch_from_diffs(sorted(xs))
        if ld:
            c = _lattice_boundary(prof_v, runs_v, w, x0 + FULL_SPAN * pitch, pitch, rx)
            if c is not None:
                x1, rd, rec = c, True, True
        else:
            c = _lattice_boundary(prof_v, runs_v, w, x1 - FULL_SPAN * pitch, pitch, rx)
            if c is not None:
                x0, ld, rec = c, True, True
    if td != bd and ys is not None and len(ys) >= 2:
        pitch = _pitch_from_diffs(sorted(ys))
        if td:
            c = _lattice_boundary(prof_h, runs_h, h, y0 + FULL_SPAN * pitch, pitch, rx)
            if c is not None:
                y1, bd, rec = c, True, True
        else:
            c = _lattice_boundary(prof_h, runs_h, h, y1 - FULL_SPAN * pitch, pitch, rx)
            if c is not None:
                y0, td, rec = c, True, True

    if xs is not None and len(xs):
        if not ld:
            x0 = int(min(xs))
        if not rd:
            x1 = int(max(xs))
    if ys is not None and len(ys):
        if not td:
            y0 = int(min(ys))
        if not bd:
            y1 = int(max(ys))
    return {"x0": x0, "x1": x1, "y0": y0, "y1": y1, "recovered": rec,
            "sides": {"left": ld, "right": rd, "top": td, "bottom": bd}}


def line_reject_mask(line_mask, p):
    """The band where a seed is refused, eroded back from the paint mask.

    `line_mask` is deliberately fat (line_dilate 9) so the bright line is
    fully painted out before the texture and NCC stages see it. Refusing
    seeds over that whole band also deleted every cell lying beside a line:
    9.8 % of ground-truth cells sit inside it, and recall there was 0.34
    against 0.89 elsewhere (measured 2026-09-02). Seeds are refused only
    within `line_reject` px of the line core instead.
    """
    r = int(p["line_reject"])
    if r <= 0:
        return np.zeros_like(line_mask)
    k = int(p["line_dilate"])
    core = cv2.erode(line_mask, np.ones((_odd(k), _odd(k)), np.uint8)) if k > 0 else line_mask
    return cv2.dilate(core, np.ones((_odd(r), _odd(r)), np.uint8))


# ---------------------------------------------------------------- texture

def paint_lines(gray, line_mask, p):
    """Remove the bright grid line before the texture and NCC stages.

    Both stages must see the same image, so this is the one place a line is
    removed. Flat-filling the mask with the background level (line_fill 0)
    forces a choice with no good answer: a wide paint mask erases the cells
    that overlap it (in-band recall 0.53 against 0.95 elsewhere), while a
    narrow one leaves a bright ridge that becomes a chain of seeds along
    every line. Inpainting (line_fill 1) interpolates the band from the
    pixels either side instead, so a cell lying across the line keeps its
    texture and no ridge survives. Measured 2026-09-02.
    """
    bg = _median_u8(gray)
    if p["line_fill"]:
        g = cv2.inpaint(gray.astype(np.uint8, copy=False), (line_mask > 0).astype(np.uint8),
                        3, cv2.INPAINT_TELEA).astype(np.float32)
        return g, bg
    g = gray.astype(np.float32).copy()
    g[line_mask > 0] = bg
    return g, bg


def texture_map(gray, line_mask, p, g=None, bg=None):
    """|gray - background| smoothed at sub-cell scale. Lines removed first."""
    if g is None or bg is None:
        g, bg = paint_lines(gray, line_mask, p)
    if p["bg_sigma_frac"] > 0:  # only for uneven illumination; EVOS captures are flat
        sigma = max(3.0, min(g.shape) * p["bg_sigma_frac"])
        g = g - cv2.GaussianBlur(g, (0, 0), sigma) + bg
    tex = cv2.GaussianBlur(np.abs(g - bg), (0, 0), max(0.6, p["diameter"] * p["tex_sigma"]))
    return tex, bg


def noise_threshold(tex, line_mask, p):
    """median + k*MAD of the texture map off the grid lines; k from sensitivity.

    Capped at 0.7 * the 95th percentile of the texture (scaled with the
    sensitivity so the slider keeps working), so a slightly defocused capture
    (cell contrast down, MAD estimate still propped up by the cells
    themselves) cannot push the threshold above the cells: without the cap a
    1.5 px blur halved the count (F1 0.844 -> 0.573 on blurred GT tiles;
    0.760 with the cap, sharp tiles unchanged, measured 2026-09-02)."""
    px = tex[line_mask == 0]
    if px.size == 0:
        px = tex
    med = np.median(px)
    mad = np.median(np.abs(px - med)) + 1e-4
    k = max(1.0, 8.0 - p["sensitivity"] * (4.0 / 75.0))  # sens 75 -> 4 MADs
    return float(min(med + k * 1.4826 * mad, 0.7 * (k / 4.8) * np.quantile(px, 0.95)))


def _fill_holes(mask):
    """Holes filled, exactly as ndimage.binary_fill_holes (4-connected
    background, its default structure) - measured 2026-09-22: the mask is
    bit-equal on all 69 data/tif tiles and a whole count goes 846.6 -> 819.0
    ms/img. A hole is background that cannot reach the border, so: pad one
    pixel of background all round, flood it from the corner, and everything
    the flood did not reach is cell or hole. The pad is what lets one seed
    cover every border-connected region, and what keeps a hole that touches
    the image edge unfilled, as scipy leaves it."""
    h, w = mask.shape
    pad = np.zeros((h + 2, w + 2), np.uint8)
    pad[1:-1, 1:-1] = mask
    cv2.floodFill(pad, None, (0, 0), 128, flags=4)
    return np.where(pad[1:-1, 1:-1] == 128, 0, 255).astype(np.uint8)


def cell_mask(tex, thr, p):
    mask = (tex > thr).astype(np.uint8) * 255
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    if p["open_iter"]:
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kern, iterations=int(p["open_iter"]))
    if p["fill_holes"]:
        mask = _fill_holes(mask)
    return mask


def focus_map(gray, dia):
    """Local variance of the Laplacian - how sharp the detail is here.

    The only measurement that tells a pale but in-focus cell from a blurry
    out-of-plane ghost (user ruling 2026-09-02: the first counts, the second
    does not). Measured over 58 real cells and 8 hand-labelled ghosts:
    AUC 0.983, ghost median 160 against real median 2489. NCC scores ghosts
    HIGHER than the median real cell (AUC 0.601, inverted), so the matched
    filter cannot make this call however it is thresholded - which is also
    why this gate must never be tuned against the ground-truth files, whose
    "false positives" are 53 % real cells.
    """
    lap = cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F)
    k = max(3, 2 * int(round(0.6 * dia)) + 1)
    m1 = cv2.boxFilter(lap, -1, (k, k))
    m2 = cv2.boxFilter(lap * lap, -1, (k, k))
    return np.maximum(m2 - m1 * m1, 0.0)


# ---------------------------------------------------------------- seeds

def ring_template(dia):
    """Synthetic starting template: bright disc centre inside a dark ring —
    the round, soft-edged look of a cell here. Zero-mean for NCC."""
    R = int(round(dia * 0.7))
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    rad = np.sqrt(xx * xx + yy * yy)
    t = np.zeros((2 * R + 1, 2 * R + 1), np.float32)
    t[rad <= dia * 0.3] = 1.0
    t[(rad > dia * 0.3) & (rad <= dia * 0.5)] = -1.0
    t = cv2.GaussianBlur(t, (0, 0), dia * 0.08)
    return t - t.mean()


def _ncc(g, tmpl):
    """Normalised cross-correlation map of g with tmpl, same size as g."""
    ncc = cv2.matchTemplate(g, tmpl, cv2.TM_CCOEFF_NORMED)
    pad = tmpl.shape[0] // 2
    return cv2.copyMakeBorder(ncc, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=-1)


def seed_response(gray, line_mask, mask, p, iters=2, g=None):
    """Matched-filter response: NCC of gray (grid lines painted out) with a
    cell template. Starts from the synthetic ring, then twice refines the
    template as the mean patch around the image's own confident detections —
    learned per image, no training data. Replaced the LoG on 2026-09-02:
    F1 0.804 -> 0.844 on the 3 annotated tiles."""
    dia = p["diameter"]
    if g is None:
        g, _ = paint_lines(gray, line_mask, p)
    tmpl = ring_template(dia)
    R = tmpl.shape[0] // 2
    H, W = g.shape
    labels = (mask > 0).astype(np.int32)
    for _ in range(iters):
        r = _ncc(g, tmpl)
        pk = peak_local_max(r, min_distance=max(2, int(dia * p["seed_dist"])),
                            labels=labels, exclude_border=False)
        conf = sorted(((r[y, x], x, y) for y, x in pk), reverse=True)
        conf = [(x, y) for v, x, y in conf if v >= 0.35][:200]
        acc, n = np.zeros(tmpl.shape, np.float64), 0
        for x, y in conf:
            if R <= x < W - R and R <= y < H - R:
                acc += g[y - R:y + R + 1, x - R:x + R + 1]
                n += 1
        if n < 20:      # too few clear cells to learn from; keep the ring
            break
        tmpl = (acc / n).astype(np.float32)
        tmpl -= tmpl.mean()
    return _ncc(g, tmpl)


def seed_points(sm, mask, p):
    """Response peaks above ncc_thr inside the cell mask -> list of (x, y).
    Seeds in blobs smaller than min_area_frac * cell area are debris and dropped."""
    dia = p["diameter"]
    peaks = peak_local_max(sm, min_distance=max(2, int(dia * p["seed_dist"])),
                           threshold_abs=p["ncc_thr"],
                           labels=(mask > 0).astype(np.int32), exclude_border=False)
    n, cc, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8))
    min_area = p["min_area_frac"] * np.pi * (dia / 2) ** 2
    return [(int(x), int(y)) for y, x in peaks
            if stats[cc[y, x], cv2.CC_STAT_AREA] >= min_area]


def faint_points(sm, mask, xs, ys, base, p):
    """Second seed channel for pale, out-of-plane cells (user ruling
    2026-09-02: they count). The texture-mask gate keeps precision for sharp
    cells, but pale cells never make it into the mask — so their NCC peaks
    are read straight off the response (>= ncc_thr2), outside the mask, away
    from grid lines, and no closer than seed spacing to an existing seed."""
    dia = p["diameter"]
    if dia < 15:      # 4x: template too small for reliable NCC — the pass
        return []     # fires on background noise (measured 2026-09-02)
    rej = int(p["line_reject"])
    md = max(2, int(dia * p["seed_dist"]))
    pk = peak_local_max(sm, min_distance=md, threshold_abs=p["ncc_thr2"],
                        exclude_border=False)
    bp = np.array(base, np.float32).reshape(-1, 2)
    out = []
    for y, x in pk:
        if mask[y, x] > 0:
            continue
        if any(abs(x - gx) <= rej for gx in xs) or any(abs(y - gy) <= rej for gy in ys):
            continue
        if len(bp) and np.min(np.hypot(bp[:, 0] - x, bp[:, 1] - y)) < md:
            continue
        out.append((int(x), int(y)))
    return out


def rim_fraction(g, bg, x, y, dia, level=3.0, nsec=16):
    """How much of the cell's boundary circle actually shows a rim.

    Sampled on the annulus r = 0.45..0.60 * dia in `nsec` directions; a
    sector counts if any of its radii deviates from the background by
    `level` gray levels. Chosen over annulus mean deviation and
    annulus-vs-core contrast (AUC 0.532, useless): completeness is the only
    rim measure that recovers missed cells at better than one true positive
    per false one (measured 2026-09-02).
    """
    h, w = g.shape
    hits = 0
    for k in range(nsec):
        a = 2.0 * np.pi * k / nsec
        ca, sa = np.cos(a), np.sin(a)
        for f in (0.45, 0.525, 0.60):
            xi, yi = int(round(x + f * dia * ca)), int(round(y + f * dia * sa))
            if 0 <= yi < h and 0 <= xi < w and abs(float(g[yi, xi]) - bg) >= level:
                hits += 1
                break
    return hits / float(nsec)


def rim_points(sm, gray, mask, base, bg, p):
    """Seeds for in-focus cells the template misses: peaks below ncc_thr,
    inside the cell mask, whose boundary circle is complete enough.

    87.7 % of missed ground-truth cells sit below ncc_thr while 92.1 % of
    them still show a rim over half the circle - they are cluster members,
    not edgeless cells (measured 2026-09-02).
    """
    dia = p["diameter"]
    md = max(2, int(dia * p["seed_dist"]))
    pk = peak_local_max(sm, min_distance=md, threshold_abs=0.0,
                        labels=(mask > 0).astype(np.int32), exclude_border=False)
    bp = np.array(base, np.float32).reshape(-1, 2)
    out = []
    for y, x in pk:
        if sm[y, x] >= p["ncc_thr"]:
            continue
        if len(bp) and np.min(np.hypot(bp[:, 0] - x, bp[:, 1] - y)) < md:
            continue
        if rim_fraction(gray, bg, x, y, dia) >= p["rim_min"]:
            out.append((int(x), int(y)))
            bp = np.vstack([bp, [[float(x), float(y)]]])
    return out


# ---------------------------------------------------------------- results

def per_square_counts(centers, xs, ys, rule="center", tol=3):
    """Assign centres to grid squares. Returns ({(col,row): count}, xs, ys).

    rule="L": a centre within `tol` px of a vertical line belongs to the square
    on its right, within `tol` of a horizontal line to the square below — the
    haemocytometer convention 'count top/left lines, skip bottom/right'.
    """
    if len(xs) < 2 or len(ys) < 2:
        return {}, xs, ys
    counts = {}
    for cx, cy in centers:
        if rule == "L":
            for gx in xs:
                if abs(cx - gx) <= tol:
                    cx = gx + tol + 1
                    break
            for gy in ys:
                if abs(cy - gy) <= tol:
                    cy = gy + tol + 1
                    break
        col = int(np.searchsorted(xs, cx, side="right")) - 1
        row = int(np.searchsorted(ys, cy, side="right")) - 1
        if 0 <= col < len(xs) - 1 and 0 <= row < len(ys) - 1:
            counts[(col, row)] = counts.get((col, row), 0) + 1
    return counts, xs, ys


class NoGridError(ValueError):
    """No haemocytometer grid in the capture, so there is nothing to count in."""


# The ten steps a count is reported as, in order. Uneven by design: `weight` is
# this step's measured share of the wall clock, so a bar driven by them fills at
# the rate the work actually finishes rather than jumping a tenth per step.
#
# MEASURED 2026-09-21 on this workstation, 1360x1024 capture, one run per rung
# (tools/measure_stages.py writes these numbers). Steps 1 and 10 belong to
# app.py - decode/stitch on the way in, JPEG encode on the way out - and are
# reported by it; count_cells reports 2 through 9.
#
# Step 7 (the detector) dominates, which is exactly why it emits a sub-tick per
# model/symmetry pass: without one the bar sits still for most of the run.
PROGRESS_STEPS = [
    (1,  "Reading the capture"),
    (2,  "Trimming to the grid"),
    (3,  "Finding the grid lines"),
    (4,  "Removing the ruled lines"),
    (5,  "Separating cells from background"),
    (6,  "Measuring cell texture"),
    (7,  "Running the detector"),
    (8,  "Picking out each cell"),
    (9,  "Checking the counting area"),
    (10, "Drawing the result"),
]
PROGRESS_TOTAL = len(PROGRESS_STEPS)

# Each step's share of the wall clock, per rung, in PROGRESS_STEPS order.
#
# MEASURED 2026-09-22 by tools/measure_stages.py on this workstation
# (hemo1 HNT sq1.1.png, 1360x1024, mean of 3 runs): level 1 0.49 s, level 2
# 1.15 s, level 3 7.87 s end to end. Re-run that tool if the engine changes.
#
# Read the numbers before changing the UI: the detector is 49.8 % / 68.4 % /
# 94.8 % of the run. A bar that gave each of the ten steps a tenth would reach
# 60 % in a fraction of a second and then not move for up to eighteen seconds,
# which is read as a crash. This is why the ring fills on the weights and why
# step 7 emits a sub-tick per model/symmetry pass.
#
# A lab laptop is slower than this machine, but these are SHARES, and the shape
# (one dominant step) is a property of the pipeline, not of the CPU.
PROGRESS_WEIGHTS = {
    1: [0.0019, 0.0006, 0.0302, 0.1189, 0.0514, 0.2326, 0.4980, 0.0558, 0.0047, 0.0059],
    2: [0.0009, 0.0003, 0.0178, 0.0686, 0.0273, 0.1578, 0.6842, 0.0344, 0.0036, 0.0050],
    3: [0.0002, 0.0000, 0.0032, 0.0106, 0.0042, 0.0274, 0.9483, 0.0049, 0.0005, 0.0007],
}


def progress_fraction(level, step, frac=0.0):
    """How much of a count at `level` is done, at `step` and `frac` within it.

    Every step before this one, in full, plus this step's own share times how
    far into it we are. Monotonic by construction, which the UI relies on: a bar
    that goes backwards is worse than one that stands still.
    """
    w = PROGRESS_WEIGHTS.get(int(level)) or PROGRESS_WEIGHTS[max(PROGRESS_WEIGHTS)]
    i = max(0, min(len(w) - 1, int(step) - 1))
    # Normalised, because the stored shares are rounded to four places and sum
    # to 0.9998: without this the last step ends just short of 1 and the ring
    # never quite closes.
    total = sum(w) or 1.0
    return min(1.0, (sum(w[:i]) + w[i] * max(0.0, min(1.0, frac))) / total)


def count_cells(bgr, params=None, autocrop=False, stages=None, require_grid=False,
                 ml_weights=None, ml_tta=None, ml_thr=None, on_progress=None,
                 ml_parallel=False):
    """Full pipeline. Returns dict with count, centers, grid, image used.

    on_progress: optional `f(step, frac)` called as each of PROGRESS_STEPS 2-9
        begins, with `frac` in 0..1 WITHIN that step (the detector reports one
        per model/symmetry pass; every other step reports 0.0 once). Steps 1 and
        10 are the caller's - app.py decodes on the way in and encodes on the
        way out. Default None, so every offline caller (score.py, ml/loo.py, the
        tests) runs the identical code path it always has.

    params: partial dict of PARAMS keys (missing keys take DEFAULTS).
    stages: pass {} to collect stage images keyed "NN|Group|Name".
    require_grid: refuse (NoGridError) a capture with no ruled line at all
        instead of answering with a zero-area frame and grid_cols/rows 0. The
        app passes True: a thumbnail-sized or non-hemocytometer upload used to
        come back as a cheerful HTTP 200 with a count and no grid, which reads
        as "0 cells in this slide" rather than "this is not a slide". It
        defaults to False because the chunk tools (ml/score_chunks.py) count
        small crops that legitimately hold no whole ruled line.
    ml_weights/ml_tta/ml_thr: override the model/TTA/threshold the ML engine
        would otherwise resolve from `level` (or the shipped default at level
        0). For ml/loo.py only, so a leave-one-tile-out fold can score its own
        trained weights through this same path instead of the shipped ones -
        added with item 13 (one mechanism for these three settings) so loo.py
        no longer has to reach into ml.infer's module globals to do that.
    ml_parallel: run the ensemble's model passes on separate threads instead of
        serially (ml.infer.predict_stack) - same float sum order, so the
        result is bit-identical. Default False; app.py is the only caller that
        passes True.
    """
    p = dict(DEFAULTS)
    p.update({k: v for k, v in (params or {}).items() if k in DEFAULTS})

    # A quality level overwrites the engine key it owns, so the UI
    # never has to send them. Level 0 leaves them exactly as passed.
    # Clamp first: an out-of-range level used to be accepted, silently run as
    # raw engine params, and echoed back unchanged, so a field could report a
    # rung the app does not have.
    # Range enforcement for REQUESTS now lives at the API boundary, in
    # api_count (app.py), which rejects anything outside 1..3 with a 422 - a
    # restored session file could otherwise ask for level 0 over HTTP and get a
    # different detector engine than any rung. This clamp stays for in-process
    # callers only (score.py, ml/loo.py), which pass level 0 on purpose.
    p["level"] = max(0, min(max(LEVELS), int(p["level"])))
    level = LEVELS.get(p["level"])
    if level:
        p.update(level["params"])

    # One call per step boundary. A no-op when nobody is watching, and never
    # allowed to break a count: a progress callback is telemetry, and a bad one
    # must not cost the user their number.
    def step(n, frac=0.0):
        if on_progress is None:
            return
        try:
            on_progress(n, frac)
        except Exception:       # noqa: BLE001
            pass

    step(2)
    # autocrop: "frame" (to the triple line), or falsy.
    if autocrop == "frame":
        img, offset = auto_crop_frame(bgr, p)
    else:
        img, offset = bgr, (0, 0)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img

    step(3)
    profiles = _line_profiles(gray, p)
    line_mask, xs, ys = detect_grid(gray, p, profiles=profiles)
    if require_grid and not len(xs) and not len(ys):
        raise NoGridError(
            "No hemocytometer grid was found in this image, so there is nothing "
            "to count in. Send the microscope capture of the ruled slide at the "
            "size it came off the microscope - a thumbnail, a photo of something "
            "else, or a crop with no ruled line in it cannot be counted.")
    step(4)
    g, bg = paint_lines(gray, line_mask, p)
    tex, bg = texture_map(gray, line_mask, p, g=g, bg=bg)
    step(5)
    thr = noise_threshold(tex, line_mask, p)
    mask = cell_mask(tex, thr, p)
    reject = line_reject_mask(line_mask, p)
    mask[reject > 0] = 0
    step(6)
    sm = seed_response(gray, line_mask, mask, p, g=g)
    ml_heat = None
    step(7)
    if int(p.get("engine", 0)) == 1:
        # ML engine: learned heatmap replaces the seeder and the rim/faint passes
        # and the line/focus gates (it was trained with the line mask as an input
        # channel and on in-focus annotations). Edge margin and frame still apply.
        try:
            import ml.infer as infer          # onnxruntime only; torch never loads here
            from ml.peaks import heat_to_points
        except ImportError as e:
            # Never a silent fall back to the classical engine: that would answer
            # with a count from a detector the user did not choose.
            raise RuntimeError(
                f"every quality level needs onnxruntime ({e}). Install it, or "
                "repair the release - the classical engine is no longer a rung "
                "the app offers.") from e
        # Levels 2 and 4 average a different number of heatmaps than the shipped
        # 3-model ensemble, which moves the peak heights, so each carries its own
        # threshold from the manifest. Reusing the ensemble's would silently drop
        # exactly the detections those levels exist to recover.
        lvl = int(p["level"])
        weights = ml_weights if ml_weights is not None else (infer.weights_for(level["models"]) if level else None)
        heat, thr_ml = infer.predict(
            gray, line_mask, sm, bg,
            # The detector is most of the wall clock, so it reports each pass.
            # Without this the bar stands still for seconds here, which reads as
            # a crash however truthful the number is.
            on_view=lambda done, total: step(7, done / total),
            weights=weights,
            tta=ml_tta if ml_tta is not None else (level["tta"] if level else None),
            thr=ml_thr if ml_thr is not None else (infer.thr_for(lvl) if level else None),
            parallel=ml_parallel,
        )
        # The crowding coefficient rides with the threshold: both are properties
        # of this level's inference mode, and a threshold measured with one
        # crowd_b is wrong with another (see ml.infer.crowd_for).
        crowd_b, crowd_r = infer.crowd_for(lvl) if level else (0.0, None)
        step(8)
        centers = heat_to_points(heat, thr_ml, crowd_b=crowd_b, crowd_r=crowd_r)
        ml_heat = heat
    else:
        step(8)
        centers = seed_points(sm, mask, p)
        if p["rim_min"] < 1.0:
            centers += rim_points(sm, gray, mask, centers, bg, p)
        centers += faint_points(sm, mask, xs, ys, centers, p)

        # A seed on the painted line band must clear a higher NCC. The band is a
        # 2-D mask, so unlike the scalar xs/ys guard it follows the lines' ~1 deg
        # tilt and their 28 px triple borders: 15 of tile 2's 16 line false
        # positives sat 6-13 px off the scalar position, on the same physical
        # line. Measured 2026-09-02: line-FPs 25 -> 7 over the 3 GT tiles.
        if p["line_gate"] > 0:
            gate = p["ncc_thr"] + p["line_gate"]
            centers = [(x, y) for x, y in centers
                       if line_mask[y, x] == 0 or sm[y, x] >= gate]

        if p["focus_min"] > 0:
            fm = focus_map(gray, p["diameter"])
            centers = [(x, y) for x, y in centers if fm[y, x] >= p["focus_min"]]

    step(9)
    h, w = gray.shape
    m = int(p["edge_margin"])
    centers = [(x, y) for x, y in centers if m <= x < w - m and m <= y < h - m]

    # Only cells inside the outer triple line are inside the known volume.
    # Half-open on purpose: a cell on the top or left boundary counts, one on
    # the bottom or right does not - the same convention per_square_counts
    # uses with rule="L", so the two can never disagree.
    frame = None
    if p["boundary"]:
        frame = triple_frame(gray, p, xs, ys, profiles=profiles)
        centers = [(x, y) for x, y in centers
                   if frame["x0"] <= x < frame["x1"] and frame["y0"] <= y < frame["y1"]]
        # A grid line outside the counting area bounds no countable square. The
        # OUTER line of the triple boundary is a real ruled line and detect_grid
        # reports it, so it invented a whole empty column: "10x tile picture 2;
        # first three rows" read 5 x 3 with column 0 at 0/0/0, because its
        # left-hand x=27 sits outside frame x0=91. Clipped only on the sides the
        # frame REALLY detected - a side that fell back to the image edge is not
        # a ruled line and must not trim anything. Measured over data/tif:
        # only that one capture changes (5 x 3 -> 4 x 3); every other 10x tile
        # is untouched, and no centre moves, so the count is identical.
        sd = frame["sides"]
        xs = [x for x in xs if (not sd["left"] or x >= frame["x0"])
              and (not sd["right"] or x <= frame["x1"])]
        ys = [y for y in ys if (not sd["top"] or y >= frame["y0"])
              and (not sd["bottom"] or y <= frame["y1"])]

    if stages is not None:
        stages["01|Detect|Original"] = img
        stages["02|Grid|Grid-line mask"] = line_mask
        stages["03|Texture|Texture (gray minus background)"] = cv2.normalize(
            tex, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        stages["04|Threshold|Cell mask"] = mask
        if ml_heat is not None:   # the ML path's seed map is the heatmap, one stage either way
            stages["05|Split|ML heatmap"] = cv2.normalize(ml_heat, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        else:
            stages["05|Split|Seed response"] = cv2.normalize(sm, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        seeds_vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        for x, y in centers:
            cv2.circle(seeds_vis, (x, y), 3, (60, 140, 255), -1)
        stages["06|Split|Seeds (one per cell)"] = seeds_vis
        # 2026-09-22: the "Kept blobs" stage and the contours behind it were removed.
        # Contours fed nothing but that picture (the overlay they served went
        # 2026-09-21) and cost 25-31 ms per count; counts, centres and tallies were
        # identical without them on all 69 data/tif tiles (docs/speed-report-2026-09-21.md).
        grid_vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        for x in xs:
            cv2.line(grid_vis, (x, 0), (x, h), (200, 120, 255), 1)
        for y in ys:
            cv2.line(grid_vis, (0, y), (w, y), (200, 120, 255), 1)
        stages["07|Grid|Grid lines"] = grid_vis
        stages["08|Detect|Background level %d, threshold %.1f" % (bg, thr)] = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    squares, xs, ys = per_square_counts(centers, xs, ys, rule="L")

    # Sub-pixel placement goes LAST, on purpose. Everything that can turn a
    # coordinate into a count has already run: the edge margin and the triple
    # frame are half-open tests on x and y, per_square_counts owns the tally,
    # and the stage overlays index arrays with (x, y). A fractional coordinate
    # reaching any of those could move a marker across a boundary and change the
    # number. Here it cannot - `count` is len(centers), already fixed above.
    # Measured 2026-09-18: integer decode is the placement floor at ~0.38 px.
    if SUBPIXEL and ml_heat is not None:
        from ml.peaks import refine
        centers = refine(ml_heat, centers)

    return {
        "image": img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR),
        "count": len(centers),
        "centers": centers,
        "grid_x": xs,
        "grid_y": ys,
        "squares": squares,
        "frame": frame,
        "offset": [int(offset[0]), int(offset[1])],
        "params": p,
    }


def _overlap_ncc(a, b, ox, oy):
    """Normalised cross-correlation of the region a and b share at (ox, oy).

    oy >= 0 means b sits below a. Returns -1.0 when the shared region is too
    small to mean anything.
    """
    h, w = a.shape
    if oy < 0 or oy >= h or abs(ox) >= w:
        return -1.0
    A = a[oy:h, max(0, ox):w + min(0, ox)]
    B = b[0:h - oy, max(0, -ox):w - max(0, ox)]
    n0, n1 = min(A.shape[0], B.shape[0]), min(A.shape[1], B.shape[1])
    A = A[:n0, :n1].astype(np.float32)
    B = B[:n0, :n1].astype(np.float32)
    if A.size < 5000:
        return -1.0
    a0, b0 = A - A.mean(), B - B.mean()
    return float((a0 * b0).sum() / (np.sqrt((a0 * a0).sum() * (b0 * b0).sum()) + 1e-9))


# Real stage rotation measured at 0.018 deg (tile 3) - well inside the jitter
# an ORB/RANSAC fit has on its own. Only correct once a fit clears this, so a
# genuinely unrotated pair (the exact-reconstruction test included) never
# takes the resampling path.
ROTATION_DEG_MIN = 0.15


def _estimate_rotation_deg(a, b, ox, oy):
    """Small-rotation of b relative to a, from ORB matches inside their
    overlap only (classical CV - no ML). Returns 0.0 whenever the fit isn't
    trustworthy, which is the "assume no rotation" status quo.
    """
    h, w = a.shape
    A = a[oy:h, max(0, ox):w + min(0, ox)]
    B = b[0:h - oy, max(0, -ox):w - max(0, ox)]
    n0, n1 = min(A.shape[0], B.shape[0]), min(A.shape[1], B.shape[1])
    A, B = A[:n0, :n1], B[:n0, :n1]
    if min(n0, n1) < 50:
        return 0.0
    orb = cv2.ORB_create(500)
    k1, d1 = orb.detectAndCompute(A, None)
    k2, d2 = orb.detectAndCompute(B, None)
    if d1 is None or d2 is None or len(k1) < 8 or len(k2) < 8:
        return 0.0
    matches = cv2.BFMatcher(cv2.NORM_HAMMING).match(d1, d2)
    if len(matches) < 8:
        return 0.0
    pts1 = np.float32([k1[m.queryIdx].pt for m in matches])
    pts2 = np.float32([k2[m.trainIdx].pt for m in matches])
    M, inliers = cv2.estimateAffinePartial2D(pts2, pts1, method=cv2.RANSAC)
    if M is None or inliers is None or inliers.sum() < 8:
        return 0.0
    angle = float(np.degrees(np.arctan2(M[1, 0], M[0, 0])))
    return angle if abs(angle) < 2.0 else 0.0   # implausible fit, not a real tilt


class _StitchCache:
    """Bytes-bounded LRU cache of stitch_pair results, keyed by a content hash
    of the exact gray arrays handed in (not the upload bytes: /api/pairs
    stretches a batch per-image while /api/count shares one stretch across a
    field, see app.py's _decode_all RULE, so the same upload can legitimately
    reach stitch_pair as two different arrays - hashing the arrays themselves,
    not the file, is what keeps this correct either way). The hash is built
    from each array's own `_image_digest`, computed once per image rather than
    per comparison (`_stitch_cache_key`'s `da`/`db`) - group_captures' sweep is
    the only caller that passes them; every other call site still gets the
    same key by hashing `a`/`b` there instead. Caches the raised
    ValueError too - group_captures' own O(n^2) sweep, and a later api_count
    call replaying the same confirmed pair, both re-ask a candidate that was
    already found to not stitch. In-process only; safe under concurrent
    /api/pairs and /api/count requests because every method holds `_lock` for
    its whole body, and this lock is never held across a call into anything
    that could want a count slot (app.py's `_count_slot`/`_all_slots`), so the
    two cannot deadlock in either acquisition order.
    """

    def __init__(self, max_bytes):
        self._max_bytes = max_bytes
        self._data = OrderedDict()   # key -> ("ok", out, info) | ("err", message)
        self._bytes = 0
        self._lock = threading.Lock()

    @staticmethod
    def _size(entry):
        return entry[1].nbytes if entry[0] == "ok" else 0

    def get(self, key):
        with self._lock:
            if key not in self._data:
                return None, False
            self._data.move_to_end(key)
            return self._data[key], True

    def put(self, key, entry):
        with self._lock:
            if key in self._data:
                self._bytes -= self._size(self._data[key])
                del self._data[key]
            self._data[key] = entry
            self._bytes += self._size(entry)
            while self._bytes > self._max_bytes and self._data:
                _, old = self._data.popitem(last=False)
                self._bytes -= self._size(old)

    def clear(self):
        with self._lock:
            self._data.clear()
            self._bytes = 0


# A stitched field is at most ~2x an EVOS tile (app.py's MAX_PIXELS caps the
# result), so a handful of live entries already covers every field in a batch
# the UI lets a researcher build; 256 MiB gives headroom without pinning an
# unbounded amount of memory across requests.
#
# This is one of three independent byte-bounded caches: this 256 MiB, plus
# app.py's _DECODE_CACHE (256 MiB) and _IMAGE_STORE (128 MiB), sum to 640 MiB
# of steady-state cache the process may hold at once, on top of live request
# data. Each bound is justified where it is defined; this total is not itself
# a limit anywhere, just the number the next person raising one of the three
# should look at first.
_STITCH_CACHE = _StitchCache(256 * 1024 * 1024)


def _image_digest(a):
    """sha256 of one array's exact shape + bytes. `_stitch_cache_key` used to
    hash both images' bytes on every comparison; a sweep re-hashes the same
    image up to n-1 times. Computing this once per image and passing it in
    turns that into one digest per image per sweep (2026-09-22: 1.893 ->
    0.0007 ms/pair)."""
    h = hashlib.sha256()
    h.update(repr(a.shape).encode())
    h.update(a.tobytes())
    return h.hexdigest()


def _stitch_cache_key(a, b, margin, da=None, db=None):
    """`da`/`db` are `a`/`b`'s own `_image_digest`, when the caller already
    has it - group_captures' sweep is the only such caller. Any other caller
    (a confirmed-pair stitch, a direct `stitch_pair` call) omits them and the
    digest is taken from `a`/`b` here instead, so the key means the same
    thing either way - the S1 condition: one key builder, same key at every
    call site."""
    h = hashlib.sha256()
    h.update(repr(margin).encode())
    h.update((da or _image_digest(a)).encode())
    h.update((db or _image_digest(b)).encode())
    return h.hexdigest()


def stitch_pair(a, b, margin=20, af=None, bf=None, da=None, db=None):
    """Cached wrapper around _stitch_pair_uncached - see _StitchCache. Keyed on
    the exact pixels of `a` and `b`, so this is correct regardless of which
    caller (or which stretch) produced them. `af`/`bf` are optional
    pre-converted float32 copies of `a`/`b`, and `da`/`db` optional
    pre-computed `_image_digest`s, passed through / used for the key only -
    the cache key's meaning is unaffected either way."""
    key = _stitch_cache_key(a, b, margin, da, db)
    cached, hit = _STITCH_CACHE.get(key)
    if hit:
        if cached[0] == "err":
            raise ValueError(cached[1])
        return cached[1], cached[2]
    try:
        out, info = _stitch_pair_uncached(a, b, margin, af=af, bf=bf)
    except ValueError as e:
        _STITCH_CACHE.put(key, ("err", str(e)))
        raise
    _STITCH_CACHE.put(key, ("ok", out, info))
    return out, info


@functools.lru_cache(maxsize=4)
def _hann(w, h):
    # Built once per size (2026-09-22: 35.1 -> 33.1 ms/pair, stitches identical).
    # phaseCorrelate only reads the window; never write into the returned array.
    return cv2.createHanningWindow((w, h), cv2.CV_32F)


def _stitch_pair_uncached(a, b, margin=20, af=None, bf=None):
    """Stitch two captures of the same field taken one stage-scroll apart.

    Registration by phase correlation on the full frames, then translation
    only (the stage moves, the camera does not rotate - measured 0.018 deg on
    tile 3) unless a real tilt is found (see ROTATION_DEG_MIN), in which case
    the lower image is rotated back to square before the seam is cut. The
    lower image is otherwise pasted unresampled below a seam placed on a
    horizontal grid line inside the overlap, so no cell is cut, blended or
    duplicated. Returns (stitched uint8, info dict). Raises ValueError if the
    pair does not look like two vertically overlapping views.

    The info dict's `overlap_err` and `pitch` are diagnostics only - for
    tests and tools/ scripts to inspect, never a quality or confidence
    signal. Phase correlation aliases on this grid's own periodicity at high
    response (see the aliasing note below), so `overlap_err` reads fine on a
    misaligned stitch exactly when that aliasing happens; nothing in app.py
    or the UI reads either field, and that must stay true.
    """
    if a.shape != b.shape:
        raise ValueError(f"Both images must be the same size (got {a.shape} and {b.shape}).")
    h, w = a.shape
    win = _hann(w, h)
    af = a.astype(np.float32) if af is None else af
    bf = b.astype(np.float32) if bf is None else bf
    (fx, fy), resp = cv2.phaseCorrelate(af, bf, win)
    ox, oy = int(round(-fx)), int(round(-fy))   # b's origin in a's coordinates
    swapped = oy < 0
    if swapped:                                  # b is the upper image
        a, b, ox, oy = b, a, -ox, -oy
    if resp < 0.05 or abs(ox) > abs(oy) or oy >= h - 2 * margin:
        raise ValueError(
            "These two images do not look like an upper and a lower view of the same "
            f"field (shift {fx:+.0f},{fy:+.0f} px, match {resp:.2f}). Count them "
            "separately.")
    # The same file dropped twice registers at (0, 0) with response 1.0 and used
    # to clear every gate above: the review screen showed a perfect pair (ncc
    # 1.0, dy 0) and the merge silently halved the batch. A stage scroll moves
    # the field by hundreds of pixels, and a seam needs `margin` rows of room on
    # each side anyway, so nothing below 2*margin can be a second view.
    if oy < 2 * margin:
        raise ValueError(
            f"These two captures are the same view ({oy} px apart), not an upper and a "
            "lower view of one field. Count them separately.")

    # Correct real stage tilt, if any, before the pitch/NCC gates below see b -
    # they assume translation-only alignment.
    angle = _estimate_rotation_deg(a, b, ox, oy)
    if abs(angle) >= ROTATION_DEG_MIN:
        M = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
        b = cv2.warpAffine(b, M, (w, h), borderValue=int(_median_u8(b)))
        (fx, fy), resp = cv2.phaseCorrelate(a.astype(np.float32), b.astype(np.float32), win)
        ox, oy = int(round(-fx)), int(round(-fy))
        if resp < 0.05 or abs(ox) > abs(oy) or oy < 0 or oy >= h - 2 * margin:
            raise ValueError(
                "These two images do not look like an upper and a lower view of the same "
                f"field after correcting a {angle:+.2f} deg tilt (shift {fx:+.0f},{fy:+.0f} px, "
                f"match {resp:.2f}). Count them separately.")

    # The grid is periodic, so phase correlation aliases by whole pitches once
    # the overlap gets short - and the response stays high while it does.
    # Measured 2026-09-02 by splitting a real tile at known offsets: at 264 px
    # overlap the shift came out 112 px wrong with response 0.222, giving a +13
    # count error and no error raised; at 144 px it was 280 px wrong and -33.
    # Two independent gates: enough overlap to be unambiguous (376 px is a
    # valid stitch and must pass, 264 px is not), and a shift that actually
    # beats its own +/- one pitch alternatives (1.000 against 0.479 there).
    # One detect_grid per stitch: the pitch gate here and the seam below both
    # need a's horizontal lines, and a is never modified in between (2026-09-22:
    # ~50 ms per true pair, stitches identical). pitch is the median spacing of
    # the horizontal grid lines - the period the phase correlation can alias
    # by, 315 px on every 10x tile measured (the fallback below).
    _, _, ys = detect_grid(a, DEFAULTS)
    pitch = float(np.median(np.diff(ys))) if len(ys) >= 2 else 315.0
    if h - oy < pitch:
        raise ValueError(
            f"These two captures overlap by only {h - oy} px. At least {int(pitch)} px "
            f"is needed to line them up unambiguously on a {int(pitch)} px grid - "
            "scroll the stage less between captures.")
    ncc = _overlap_ncc(a, b, ox, oy)
    rival = max(_overlap_ncc(a, b, ox, oy - int(pitch)),
                _overlap_ncc(a, b, ox, oy + int(pitch)))
    if ncc < 0.6 or ncc < rival + 0.10:
        raise ValueError(
            "These two captures cannot be lined up reliably: the grid repeats every "
            f"{int(pitch)} px and the best fit ({ncc:.2f}) is not clearly better than "
            f"the one a whole square away ({rival:.2f}).")

    bg = int(_median_u8(a))
    H, W = h + oy, w + abs(ox)
    A = np.full((H, W), bg, np.uint8)
    A[:h, max(0, -ox):max(0, -ox) + w] = a
    B = np.full((H, W), bg, np.uint8)
    B[oy:, max(0, ox):max(0, ox) + w] = b
    shared = (slice(oy, h), slice(abs(ox), w))   # rows and columns present in both
    err = float(cv2.absdiff(A[shared], B[shared]).mean())
    mid = (oy + h) // 2
    # A cell straddling the seam is the only way the hard cut can lose one, so
    # the seam must sit well inside the overlap on both sides, not just inside it.
    clear = max(margin, int(1.5 * DEFAULTS["diameter"]))
    inside = [y for y in ys if oy + clear <= y < h - clear]
    if not inside:
        raise ValueError(
            f"No grid line sits at least {clear} px inside the overlap, so the two "
            "captures cannot be joined without cutting through cells.")
    seam = min(inside, key=lambda y: abs(y - mid))
    out = np.vstack([A[:seam], B[seam:]])
    return out, {"dx": ox, "dy": oy, "response": float(resp), "seam_y": int(seam),
                 "overlap_err": err, "swapped": swapped,
                 "ncc": float(ncc), "pitch": float(pitch), "rotation_deg": angle}


def group_captures(grays, skipped=None, progress=None, workers=None):
    """Work out which captures are two views of one field -> groups of indices.

    progress: pass a callable to be told `(done, total)` after every candidate
    pair, where total is the n(n-1)/2 comparisons this sweep will make. A cold
    comparison costs ~64 ms (measured 2026-09-21 on data/png, stitch cache
    cleared: 45 pairs 2.91 s, 78 pairs 5.22 s, 120 pairs 7.47 s), so a batch of
    any size is a wait the caller has to be able to render. Rejected candidates
    are counted too - they are instant, which makes the bar uneven rather than
    wrong, and a bar that skips the cheap pairs would stall instead.

    skipped: pass a list to be told, per candidate pair, why it was never
    tried or why it failed - {"i", "j", "reason"}. Differently sized captures
    used to be dropped by a bare `continue`, so /api/pairs reported "no pair"
    and the user was never told that the two files are simply not the same
    shape. Reporting invents no pair; it only names the reason.

    Image-based only (user ruling 2026-09-02): renaming a file must not change
    the answer. Discovery is by phase-correlation response, which separates
    hard - measured over all ten pairs of the five 10x tiles, the one true
    pair scores 0.232 and every other pair 0.023 or less. Validation is
    stitch_pair's own gate, because response alone cannot catch a pitch-
    aliased shift and overlap NCC alone cannot tell a real pair from grid
    self-similarity (non-pairs reach 0.45 on NCC).

    Each capture joins at most one other (user ruling: pairs, not chains).

    Returns (groups, stitched): stitched maps each winning pair's (i, j) - i
    < j, matching the tuple in groups - to the (image, info) stitch_pair
    already computed for it while scoring the candidate. Every caller used to
    re-run stitch_pair on the winners to get this, paying for detect_grid
    twice more per pair; only the winners are kept here - a losing candidate's
    stitched image is dropped once the winners are chosen. The sweep itself is
    O(n^2) in batch size and cannot avoid holding a candidate's result until
    then.
    """
    n = len(grays)
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    total = len(pairs)
    # One float32 copy and one digest per capture instead of per comparison
    # (2026-09-22: float ~2.2 ms, digest 1.893 -> 0.0007 ms of ~35 ms per pair).
    fl = [g.astype(np.float32) for g in grays]
    dg = [_image_digest(g) for g in grays]

    def one(ij):
        i, j = ij
        if grays[i].shape != grays[j].shape:
            return ("size", None)
        try:
            return ("ok", stitch_pair(grays[i], grays[j], af=fl[i], bf=fl[j], da=dg[i], db=dg[j]))
        except ValueError as e:
            return ("err", str(e))

    # Comparisons are independent; ex.map yields in submission order, so
    # `skipped`, `progress` and `cand` see exactly the serial order and the
    # decision below cannot change (2026-09-22: 34.8 -> 12.9 ms/pair at 8
    # workers, groups/stitches identical).
    workers = workers or min(8, os.cpu_count() or 1)
    cand, results = [], {}
    if progress is not None:
        progress(0, total)
    with ThreadPoolExecutor(workers) as ex:
        for done, ((i, j), (kind, val)) in enumerate(zip(pairs, ex.map(one, pairs)), 1):
            if kind == "size" and skipped is not None:
                hi, wi = grays[i].shape[:2]
                hj, wj = grays[j].shape[:2]
                skipped.append({"i": i, "j": j, "reason": (
                    f"These two captures are different sizes ({wi} x {hi} and "
                    f"{wj} x {hj}), so they cannot be two views of one field.")})
            elif kind == "err" and skipped is not None:
                skipped.append({"i": i, "j": j, "reason": val})
            elif kind == "ok":
                results[(i, j)] = val
                cand.append((val[1]["response"], i, j))
            if progress is not None:
                progress(done, total)
    cand.sort(reverse=True)
    taken, groups = set(), []
    for _, i, j in cand:
        if i not in taken and j not in taken:
            taken.update((i, j))
            groups.append([i, j])
    groups += [[i] for i in range(n) if i not in taken]
    groups.sort(key=lambda g: g[0])
    stitched = {tuple(g): results[tuple(g)] for g in groups if len(g) == 2}
    return groups, stitched
