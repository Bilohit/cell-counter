import cv2
import numpy as np
import pytest

import pipeline

TIF = "data/tif/"

EXPECTED = {  # measured 2026-09-01, tolerance ±4 px
    # 2026-09-02: tile 1 gains y=10 and tile 2 gains x=1351 - boundary lines
    # clipped by the image border, rescued by the lattice extrapolation in
    # detect_grid (tile 1: 325 - pitch 315 = 10; tile 2: 1037 + 315 = 1352).
    "10x tile picture 1; last three rows.tif": ([75, 390, 705, 1020, 1335], [10, 325, 639, 955]),
    "10x tile picture 3; first three rows.tif": ([73, 388, 703, 1018, 1334], [45, 363, 677, 993]),
    "10x tile picture 2; first three rows.tif": ([91, 408, 721, 1038, 1351], [62, 377, 690, 1005]),
    "10x tile picture 4; first three rows.tif": ([68, 383, 698, 1013, 1330], [43, 360, 674, 990]),
}
# 2026-09-12: tile 2 loses x = 27, the companion line 64 px outside the left boundary -
# off the 315 px lattice, and count_cells was clipping it anyway; the API output is unchanged.


def _close(found, expected, tol=4):
    return len(found) == len(expected) and all(abs(a - b) <= tol for a, b in zip(found, expected))


@pytest.mark.data
@pytest.mark.parametrize("name,exp", EXPECTED.items())
def test_detect_grid(name, exp):
    gray = cv2.imread(TIF + name, cv2.IMREAD_GRAYSCALE)
    mask, xs, ys = pipeline.detect_grid(gray, pipeline.DEFAULTS)
    assert _close(xs, exp[0]), (xs, exp[0])
    assert _close(ys, exp[1]), (ys, exp[1])
    assert mask.dtype == np.uint8 and mask.shape == gray.shape
    # lines only, not whole image. Upper bound raised from 0.08 on 2026-09-02:
    # tophat_size 21 + line_dilate 9 (Task 3 defaults, needed to extract the 24 px
    # wide band at x=1335 and to keep seeds off the lines) measure 0.110-0.124 here.
    assert 0.005 < (mask > 0).mean() < 0.14


@pytest.mark.data
def test_detect_grid_merges_a_split_faint_line():
    """KNT sq1.1: the defocused interior line at y ~ 690 came out as a 1 px
    sliver at 680 and a 3 px one at 698 - 18 px apart, past the 12 px run
    merge - so the field read 5 rows (6 when stitched). One line, on the
    lattice, and exactly four horizontal lines."""
    g = cv2.imread(TIF + "hemo1 KNT sq1.1.tif", cv2.IMREAD_GRAYSCALE)
    _, xs, ys = pipeline.detect_grid(g, pipeline.DEFAULTS)
    assert len(ys) == 4, ys
    assert _close(ys, [58, 372, 689, 1006], tol=6), ys
    assert len(xs) == 5, xs


@pytest.mark.data
def test_detect_grid_fills_a_missed_lattice_line():
    """KGN sq3.1: the interior line at y ~ 686 peaks at coverage 0.24 against
    the 0.25 threshold, so ys read [60, 375, 991] and the row count was 2;
    the seam search in stitch_pair then found no line inside the overlap and
    the pair never stitched. The lattice (pitch 315) says a line belongs at
    375 + 315 = 690; a weaker run is there and must be used."""
    g = cv2.imread(TIF + "hemo1 KGN sq3.1.tif", cv2.IMREAD_GRAYSCALE)
    _, xs, ys = pipeline.detect_grid(g, pipeline.DEFAULTS)
    assert len(ys) == 4, ys
    assert _close(ys, [60, 375, 690, 991], tol=8), ys


def test_lattice_lines_fills_a_3_pitch_gap():
    """The FILL branch's k=3 arm (two missing interior lines between a pair
    of lattice lines 3 pitches apart) is otherwise only reached indirectly,
    through _frame_side's KGN sq4 case - a different code path from
    detect_grid's. No fixture in data/tif exercises k=3 directly through
    _lattice_lines (checked: no tile's detected xs/ys carry a 3-pitch gap),
    so this drives _lattice_lines with a synthetic profile: two strong runs
    at 100 and 1045 (3 x NOMINAL_PITCH apart, kept as on-lattice against each
    other via k=3) and two weak runs (above 0.4 x thr, below thr) at the two
    predicted interior positions 415 and 730, standing in for the real
    defocused lines FILL is meant to recover."""
    n = 1200
    prof = np.zeros(n)

    def bump(c, val, w=2):
        for i in range(c - w, c + w + 1):
            prof[i] = val

    bump(100, 20)
    bump(1045, 20)  # 100 + 3 * NOMINAL_PITCH
    bump(415, 5)    # 100 + 1 * NOMINAL_PITCH, weak
    bump(730, 5)    # 100 + 2 * NOMINAL_PITCH, weak
    out = pipeline._lattice_lines(prof, 10, n, margin=5, gap=12)
    assert out == [100, 415, 730, 1045], out


@pytest.mark.data
def test_pair_stitches_when_the_seam_line_was_faint():
    """KGN sq3.1 + sq3.2 failed with 'No grid line sits at least 33 px inside
    the overlap' because detect_grid had lost the y ~ 686 line of the upper
    capture (see test_detect_grid_fills_a_missed_lattice_line). With the
    lattice fill the seam lands on it and the pair is one 4 x 4 field."""
    a = cv2.imread(TIF + "hemo1 KGN sq3.1.tif", cv2.IMREAD_GRAYSCALE)
    b = cv2.imread(TIF + "hemo1 KGN sq3.2.tif", cv2.IMREAD_GRAYSCALE)
    groups, stitched = pipeline.group_captures([a, b])
    assert groups == [[0, 1]], groups
    img, info = stitched[(0, 1)]
    _, xs, ys = pipeline.detect_grid(img, pipeline.DEFAULTS)
    assert len(xs) == 5 and len(ys) == 5, (xs, ys)
    f = pipeline.triple_frame(img, pipeline.DEFAULTS, xs, ys)
    assert all(f["sides"].values()), f


@pytest.mark.data
def test_detect_grid_drops_the_companion_line():
    """hemo run 1 rules a third line ~63 px outside the double boundary
    (tile 2's x = 27 is the same thing on the reference slide). It is
    0.2 pitch off the lattice and must never become a grid line: with the
    boundary undetected it used to add a fifth column or row."""
    g = cv2.imread(TIF + "hemo1 KA2 sq1.1.tif", cv2.IMREAD_GRAYSCALE)
    _, xs, ys = pipeline.detect_grid(g, pipeline.DEFAULTS)
    assert len(xs) == 5 and len(ys) == 4, (xs, ys)
    for seq in (xs, ys):
        gaps = np.diff(seq)
        assert all(abs(gp - 315) <= 20 for gp in gaps), seq


SQUARE = (395, 325, 705, 639)  # x0, y0, x1, y1


@pytest.mark.data
def test_count_hand_counted_square():
    bgr = cv2.imread(TIF + "10x tile picture 1; last three rows.tif", cv2.IMREAD_COLOR)
    r = pipeline.count_cells(bgr)
    x0, y0, x1, y1 = SQUARE
    n = sum(1 for x, y in r["centers"] if x0 <= x < x1 and y0 <= y < y1)
    # User ruling 2026-09-02: pale out-of-plane cells count too. The GT file
    # gives 18 for this window but skips pale cells; the original hand count
    # of 26 included them. Pipeline with the faint pass reads 25.
    assert 20 <= n <= 30, n            # ~25 +/- 5


@pytest.mark.data
def test_no_spurious_cells_on_grid_lines():
    """No chains of phantom seeds along the grid lines.

    Rewritten 2026-09-02. The old form capped *every* seed within 3 px of a
    line at 3 % of the count, which assumed a seed there is an artefact. It
    is not: real cells lie on and beside the lines, and at the old defaults
    all 5 on-line seeds matched ground truth. That made the test block the
    grid-line recall fix (in-band recall was 0.53 against 0.95 elsewhere)
    while never measuring the thing it was named for. It now counts only
    on-line seeds that match no ground-truth cell - actual phantoms.
    Measured at the shipped defaults: 4 of 344 (1.2 %).
    """
    import json
    name = "10x tile picture 1; last three rows"
    with open("data/gt/" + name + ".json") as f:
        gt = np.array(json.load(f)["points"], float).reshape(-1, 2)
    bgr = cv2.imread(TIF + name + ".tif", cv2.IMREAD_COLOR)
    r = pipeline.count_cells(bgr)
    det = np.array(r["centers"], float).reshape(-1, 2)
    d = np.linalg.norm(det[:, None, :] - gt[None, :, :], axis=2)
    real = (d <= 13.2).any(axis=1)
    spurious = sum(1 for i, (x, y) in enumerate(det)
                   if not real[i]
                   and (any(abs(x - gx) <= 3 for gx in r["grid_x"])
                        or any(abs(y - gy) <= 3 for gy in r["grid_y"])))
    assert spurious <= 0.03 * r["count"], (spurious, r["count"])


@pytest.mark.data
def test_empty_region_is_empty():
    bgr = cv2.imread(TIF + "10x tile picture 1; last three rows.tif", cv2.IMREAD_COLOR)
    r = pipeline.count_cells(bgr)
    # emptiest 180x120 window off the grid lines (measured 2026-09-01: one tiny speck)
    n = sum(1 for x, y in r["centers"] if 180 <= x < 360 and 20 <= y < 140)
    assert n <= 1, n


@pytest.mark.data
def test_stages_and_api_shape():
    bgr = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_COLOR)
    st = {}
    r = pipeline.count_cells(bgr, stages=st)
    assert set(r) >= {"image", "count", "centers", "grid_x", "grid_y", "squares", "params"}
    assert "contours" not in r
    assert all(k.count("|") == 2 for k in st)
    assert len(st) == 8, sorted(st)
    classical = pipeline.count_cells(bgr, {"engine": 0})["count"]
    assert pipeline.count_cells(bgr, {"sensitivity": 40, "engine": 0})["count"] < classical


def test_per_square_L_rule():
    xs, ys = [100, 200, 300], [100, 200, 300]
    pts = [(150, 150), (199, 150), (201, 150), (150, 299), (150, 301)]
    c, _, _ = pipeline.per_square_counts(pts, xs, ys, rule="center")
    assert c == {(0, 0): 2, (1, 0): 1, (0, 1): 1}   # (150,301) is outside
    c, _, _ = pipeline.per_square_counts(pts, xs, ys, rule="L")
    # 199 and 201 sit on the x=200 line -> both belong to the square on the right;
    # 299 and 301 sit on the y=300 line -> belong to the square below, which is
    # outside the detected grid, so neither is counted in any square.
    assert c == {(0, 0): 1, (1, 0): 2}


@pytest.mark.data
def test_stitch_synthetic_exact():
    t = cv2.imread(TIF + "10x tile picture 1; last three rows.tif", cv2.IMREAD_GRAYSCALE)
    a, b = t[:700], t[324:]            # two 700-row views, 376 rows shared
    out, info = pipeline.stitch_pair(a, b)
    assert info["dx"] == 0 and info["dy"] == 324 and not info["swapped"]
    assert 324 < info["seam_y"] < 700
    assert np.array_equal(out, t)      # pixel-exact reconstruction
    out2, info2 = pipeline.stitch_pair(b, a)   # order does not matter
    assert info2["swapped"] and np.array_equal(out2, t)


@pytest.mark.data
def test_stitch_real_pair():
    a = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    b = cv2.imread(TIF + "10x tile picture 3; last three rows.tif", cv2.IMREAD_GRAYSCALE)
    out, info = pipeline.stitch_pair(a, b)
    assert abs(info["dy"] - 408) <= 2 and abs(info["dx"]) <= 3
    assert info["overlap_err"] < 6           # measured 3.0; sensor noise sigma ~4
    assert out.shape == (1024 + info["dy"], 1360 + abs(info["dx"]))
    _, xs, ys = pipeline.detect_grid(out, pipeline.DEFAULTS)
    assert _close(ys, [45, 363, 678, 992, 1306], tol=6), ys       # 4 rows
    assert _close(xs, [71, 386, 701, 1017, 1332], tol=6), xs      # 4 columns


@pytest.mark.data
def test_stitch_rejects_bad_pair():
    t = cv2.imread(TIF + "10x tile picture 1; last three rows.tif", cv2.IMREAD_GRAYSCALE)
    with pytest.raises(ValueError):
        pipeline.stitch_pair(t[:, :1000], t[:, 360:])   # side-by-side, not stacked
    with pytest.raises(ValueError):
        pipeline.stitch_pair(t, t[:900])                # different sizes


@pytest.mark.data
def test_recall_beside_grid_lines():
    """Cells lying beside a grid line must be counted.

    Measured 2026-09-02: with line_dilate 9 used as both the paint mask and
    the seed-reject mask, recall inside the dilated band was 0.34 against
    0.89 outside it, and that band alone held 43 % of all misses.
    """
    import json
    name = "10x tile picture 1; last three rows"
    with open("data/gt/" + name + ".json") as f:
        gt = np.array(json.load(f)["points"], float).reshape(-1, 2)
    bgr = cv2.imread(TIF + name + ".tif", cv2.IMREAD_COLOR)
    r = pipeline.count_cells(bgr)
    # Score only the region the pipeline counts. 13.6 % of this tile's ground
    # truth lies outside the triple frame (measured 2026-09-02); those cells
    # are correctly excluded from the count, so scoring them as misses would
    # report a recall collapse that never happened.
    fr = r["frame"]
    gt = gt[[fr["x0"] <= x < fr["x1"] and fr["y0"] <= y < fr["y1"] for x, y in gt]]
    det = np.array(r["centers"], float).reshape(-1, 2)
    near = np.array([any(abs(x - gx) <= 9 for gx in r["grid_x"])
                     or any(abs(y - gy) <= 9 for gy in r["grid_y"]) for x, y in gt])
    d = np.linalg.norm(det[:, None, :] - gt[None, :, :], axis=2)
    found = (d <= 13.2).any(axis=0)
    assert near.sum() > 20, near.sum()          # the test needs subjects
    assert found[near].mean() >= 0.70, (found[near].mean(), near.sum())


GT_TILES = ["10x tile picture 1; last three rows",
            "10x tile picture 2; first three rows",
            "10x tile picture 3; first three rows"]


def _gt(name):
    import json
    with open("data/gt/" + name + ".json") as f:
        return np.array(json.load(f)["points"], float).reshape(-1, 2)


@pytest.mark.data
def test_few_false_positives_on_grid_lines():
    """Seeds on the painted line band must be rare and mostly real.

    Measured 2026-09-02: the scalar xs/ys guard misses 15 of 16 line false
    positives on tile 2, because lines are tilted by up to 28 px across the
    frame and the boundary lines are 28 px triple bands, while xs/ys are
    single integers guarded by line_reject=3. Gating on the 2-D painted mask
    instead cut line false positives from 25 to 7 over the 3 tiles.
    """
    total = 0
    for name in GT_TILES:
        gt = _gt(name)
        gray = cv2.imread(TIF + name + ".tif", cv2.IMREAD_GRAYSCALE)
        line_mask, _, _ = pipeline.detect_grid(gray, pipeline.DEFAULTS)
        r = pipeline.count_cells(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
        det = np.array(r["centers"], float).reshape(-1, 2)
        d = np.linalg.norm(det[:, None, :] - gt[None, :, :], axis=2)
        unmatched = ~(d <= 13.2).any(axis=1)
        total += sum(1 for i, (x, y) in enumerate(r["centers"])
                     if unmatched[i] and line_mask[y, x] > 0)
    assert total <= 12, total          # 25 before the gate, 7 after


@pytest.mark.data
def test_focus_gate_rejects_blur_but_keeps_pale():
    """Blur must collapse the focus score while sharp cells keep it high.

    Measured 2026-09-02 over 58 real cells and 8 hand-labelled out-of-plane
    ghosts: variance of the Laplacian separates them with AUC 0.983 (ghost
    median 160 against real median 2489). NCC cannot make this call at any
    threshold - AUC 0.601 the WRONG way, because ghosts score HIGHER NCC
    than the median real cell.
    """
    gray = cv2.imread(TIF + "10x tile picture 1; last three rows.tif",
                      cv2.IMREAD_GRAYSCALE)
    dia = pipeline.DEFAULTS["diameter"]
    fm = pipeline.focus_map(gray, dia)
    fb = pipeline.focus_map(cv2.GaussianBlur(gray, (0, 0), 3.0), dia)
    r = pipeline.count_cells(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
    sharp = np.median([fm[y, x] for x, y in r["centers"]])
    blurred = np.median([fb[y, x] for x, y in r["centers"]])
    # measured 2026-09-02 in THIS function's units (box-filtered Laplacian
    # variance, disc 0.6*dia): median 252 at detections, 2 after a 3 px blur.
    # The AUC quoted above came from a differently scaled Laplacian, so the
    # shipped focus_min (60) was re-derived by sweep here, not transplanted.
    assert sharp > 150, sharp
    assert blurred < 0.1 * sharp, (blurred, sharp)


@pytest.mark.data
def test_rim_admit_recovers_cells():
    """Loosening boundary strictness must add detections; 1.0 admits none.

    Measured 2026-09-02: of 114 analysable misses, 92.1 % already show a rim
    over half the circle while 87.7 % sit below ncc_thr - they are cluster
    members the template does not fire on, not cells without an edge.
    Admitting by rim completeness recovers the same 22 cells as lowering
    ncc_thr, at half the false-positive cost (TP/FP 0.73 against 0.37).
    """
    bgr = cv2.imread(TIF + "10x tile picture 3; first three rows.tif",
                     cv2.IMREAD_COLOR)
    strict = pipeline.count_cells(bgr, {"rim_min": 1.0, "engine": 0})["count"]
    loose = pipeline.count_cells(bgr, {"rim_min": 0.75, "engine": 0})["count"]
    assert loose > strict, (loose, strict)


# ---------------------------------------------------------------- triple frame

# Pinned full-image counts (boundary = 0) under the shipped defaults, so an
# accidental change to any stage or default shows up as an exact-count diff.
# Re-pinned 2026-09-02 after the seed_dist/ncc_thr/line_gate retune (measured
# F1 0.884 -> 0.890, per-tile err -2.7/-2.9/+4.5 -> -2.7/-0.9/+0.5).
# 2026-09-12: tile 2 moves 485 -> 486. detect_grid itself now drops the
# off-lattice companion line at x = 27 (see EXPECTED above and
# test_detect_grid_drops_the_companion_line); with boundary = 0 there is no
# frame-side clip to remove that column after the fact, so this pinned count
# now reflects the same, single sanctioned change - not a new regression.
BASELINE_COUNTS = {
    "10x tile picture 1; last three rows.tif": 323,
    "10x tile picture 2; first three rows.tif": 486,
    "10x tile picture 3; first three rows.tif": 245,
    "10x tile picture 3; last three rows.tif": 271,
    "10x tile picture 4; first three rows.tif": 473,
}


def test_profile_runs_keeps_extent():
    prof = np.zeros(200, np.float32)
    prof[10:14] = 1.0          # a single line, 4 px wide
    prof[100:128] = 1.0        # a triple line, 28 px wide
    runs = pipeline._profile_runs(prof, 0.5)
    assert len(runs) == 2
    assert runs[0][0] == 10 and runs[0][-1] == 13
    assert runs[1][0] == 100 and runs[1][-1] == 127


@pytest.mark.data
def test_edge_clipped_boundary_line_is_rescued():
    """A boundary line clipped by the image border must survive the edge
    margin when it sits on the grid lattice, and off-lattice edge runs must
    stay dropped.

    Measured 2026-09-02 on tile 1 (last three rows): the top triple is
    clipped to a run at y = 1..20 (peak 10); kept ys [325, 639, 955] give
    pitch 315, extrapolated 325 - 315 = 10 (off by 0.0 px, tol 9.45), so it
    is rescued and the UI shows 3 rows instead of 2. Its below-frame smear
    at y = 1016 is 254 px from the extrapolated 955 + 315 = 1270 and stays
    rejected (same class as tile 4's x = 0..11 artifact, 253.5 px off)."""
    g = cv2.imread(TIF + "10x tile picture 1; last three rows.tif",
                   cv2.IMREAD_GRAYSCALE)
    _, _, ys = pipeline.detect_grid(g, pipeline.DEFAULTS)
    assert _close(ys, [10, 325, 639, 955]), ys
    # synthetic negative: an off-lattice edge run must stay dropped
    img = np.full((1024, 600), 30, np.uint8)
    for y in (10, 325, 639, 955):
        img[max(0, y - 2):y + 3, :] = 90
    img[1015:1020, :] = 90     # edge run, 253 px off the lattice point 1270
    _, _, ys = pipeline.detect_grid(img, pipeline.DEFAULTS)
    assert ys == [10, 325, 639, 955], ys


# Measured 2026-09-02 on data/tif. Each capture shows 3 of the 4 grid
# rows, so exactly one horizontal triple is visible per tile and the other
# horizontal boundary is the image edge. Tile 2's right triple is clipped by
# the image border, so that side is the edge too.
# 2026-09-02: these pin triple_frame WITHOUT xs/ys - the pure triple-detection
# path. count_cells now passes the lattice, which clamps undetected sides to
# the outermost grid line (full-boxes-only ruling); see the clamp test below.
EXPECTED_FRAMES = {
    "10x tile picture 1; last three rows.tif": (75, 1336, 0, 955),
    "10x tile picture 2; first three rows.tif": (91, 1360, 61, 1024),
    "10x tile picture 3; first three rows.tif": (73, 1333, 49, 1024),
    "10x tile picture 3; last three rows.tif": (67, 1327, 0, 900),
    "10x tile picture 4; first three rows.tif": (67, 1329, 47, 1024),
}


@pytest.mark.data
@pytest.mark.parametrize("name", sorted(EXPECTED_FRAMES))
def test_triple_frame_on_all_tiles(name):
    g = cv2.imread(TIF + name, cv2.IMREAD_GRAYSCALE)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS)
    got = (f["x0"], f["x1"], f["y0"], f["y1"])
    for a, b in zip(got, EXPECTED_FRAMES[name]):
        assert abs(a - b) <= 2, (name, got, EXPECTED_FRAMES[name])


@pytest.mark.data
def test_undetected_side_clamps_to_outermost_grid_line():
    """Only FULL grid boxes count (user ruling 2026-09-02, overrules the old
    "image edge, looser and never tighter" fallback): tile 4's bottom triple
    is out of view, so y1 fell back to 1024 and 9 cells in the y = 990..1024
    partial row-4 sliver were wrongly counted. With the lattice passed in
    (grid_y [47, 360, 674, 990]) the undetected bottom clamps to the
    outermost grid line, 990; `sides` still reports detection truthfully and
    the detected top/left/right stay where the triples put them."""
    g = cv2.imread(TIF + "10x tile picture 4; first three rows.tif",
                   cv2.IMREAD_GRAYSCALE)
    _, xs, ys = pipeline.detect_grid(g, pipeline.DEFAULTS)
    plain = pipeline.triple_frame(g, pipeline.DEFAULTS)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS, xs, ys)
    assert f["y1"] == max(ys) == 990, f
    assert f["sides"]["bottom"] is False
    assert (f["x0"], f["x1"], f["y0"]) == (plain["x0"], plain["x1"], plain["y0"])


@pytest.mark.data
def test_triple_frame_rejects_off_lattice_run():
    """Tile 4 has a spurious line-bright run at x = 0..11, 62 px from the real
    left triple at x = 55..80. The grid pitch is 315 px, so it is not a grid
    line and must not become the left boundary."""
    g = cv2.imread(TIF + "10x tile picture 4; first three rows.tif",
                   cv2.IMREAD_GRAYSCALE)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS)
    assert f["x0"] > 40, f
    assert f["sides"]["left"] is True


@pytest.mark.data
def test_triple_frame_falls_back_to_the_image_edge():
    g = cv2.imread(TIF + "10x tile picture 1; last three rows.tif",
                   cv2.IMREAD_GRAYSCALE)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS)
    assert f["y0"] == 0 and f["sides"]["top"] is False   # top triple is off-frame
    assert f["sides"]["bottom"] is True


@pytest.mark.data
def test_frame_side_keeps_a_boundary_two_pitches_from_its_raw_neighbour():
    """hemo1 KGN sq3, stitched: the bottom triple (mass 17.56, well over
    triple_min_mass=14) sat ~3 pitches (940.8 px) from its nearest RAW
    candidate, and _frame_side's own single-pitch, unmerged pitch estimate
    (median 318.7, skewed by an edge-artefact gap of 51 px) rejected it as
    off-lattice - the same two defects _lattice_lines had, living a second
    place. Before the 2026-09-12 fix this fell back to the image edge
    (y1 = 1414, sides.bottom = False); it must now be detected."""
    fs = [TIF + "hemo1 KGN sq3.1.tif", TIF + "hemo1 KGN sq3.2.tif"]
    grays = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in fs]
    groups, stitched = pipeline.group_captures(grays)
    assert groups == [[0, 1]], groups
    img = stitched[(0, 1)][0]
    f = pipeline.triple_frame(img, pipeline.DEFAULTS)
    assert f["sides"]["bottom"] is True, f


@pytest.mark.data
def test_frame_side_accepts_a_border_clipped_run_over_threshold():
    """hemo1 KGN sq1, stitched: the bottom triple (mass 17.93, over
    triple_min_mass=14, on-lattice) touches the stitched image's border
    (its run spans y = 1305..1344, n = 1347) and used to be rejected purely
    for that contact, regardless of mass. Narrowed 2026-09-12 (pass 5):
    clipping can only remove mass, never add it, so a clipped run already
    over threshold is accepted. Before the narrowing this fell back to the
    image edge (y1 = 1347, sides.bottom = False); it must now be detected at
    the run's own position (y1 = 1324, the outermost grid line - the run's
    own centre sits at 1324.5), not the edge."""
    fs = [TIF + "hemo1 KGN sq1.1.tif", TIF + "hemo1 KGN sq1.2.tif"]
    grays = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in fs]
    groups, stitched = pipeline.group_captures(grays)
    assert groups == [[0, 1]], groups
    img = stitched[(0, 1)][0]
    f = pipeline.triple_frame(img, pipeline.DEFAULTS)
    assert f["sides"]["bottom"] is True, f
    assert abs(f["y1"] - 1324) <= 4, f


def _corner_clipped_grid():
    """A 10x-geometry grid whose right AND bottom triples are cut by the
    border, the way a stitched canvas's bg-filled margin cuts them: the band
    stops 2 px short of the edge, so the run lands inside the guard's
    `hi >= n - 3` test without being flush (a band flush to the edge is
    erased by the top-hat, whose erosion replicates the border column)."""
    h, w = 1024, 1360
    g = np.full((h, w), 40, np.uint8)
    for x in (415, 730, 1045):          # interior verticals, thin -> low mass
        g[:, x:x + 4] = 200
    g[:, 90:110] = 200                  # left triple, fully in view
    g[:, 1340:1358] = 200               # right triple, cut by the border
    for y in (385, 700):                # interior horizontals, thin
        g[y:y + 4, :] = 200
    g[60:80, :] = 200                   # top triple, fully in view
    g[1004:1022, :] = 200               # bottom triple, cut by the border
    return g


@pytest.mark.data
def test_stitch_padding_does_not_starve_a_boundary():
    """hemo1 HNT sq2, stitched: the two captures overlap at dx = 102, so the
    canvas is 1462 px wide and 6.8 % of it is the constant grey `stitch_pair`
    fills what neither capture covers. The right triple lies in that strip, and
    scoring its coverage against the FULL height charged it for rows that hold
    no picture: mass 9.16 against triple_min_mass = 14, so the field was
    reported partial and dropped from the calculator's divisor. Measured over
    the rows that are actually imaged it reads 18.70, inside the 16.8-21.4 band
    every other boundary in data/tif sits in (2026-09-18)."""
    fs = [TIF + "hemo1 HNT sq2.1.tif", TIF + "hemo1 HNT sq2.2.tif"]
    grays = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in fs]
    groups, stitched = pipeline.group_captures(grays)
    assert groups == [[0, 1]], groups
    img = stitched[(0, 1)][0]
    # the premise: a real padded strip, and the right triple standing in it
    pad = 1.0 - float(pipeline._imaged(img).mean())
    assert pad > 0.05, pad

    prof_v, _, _, _ = pipeline._line_profiles(img, pipeline.DEFAULTS)
    runs = pipeline._profile_runs(prof_v, pipeline.DEFAULTS["line_min_frac"])
    right = pipeline._merged_runs(prof_v, runs)[-1]
    assert right[1] > pipeline.DEFAULTS["triple_min_mass"], right

    f = pipeline.triple_frame(img, pipeline.DEFAULTS)
    assert f["sides"]["right"] is True, f
    assert abs(f["x1"] - 1432) <= 4, f


@pytest.mark.data
def test_lattice_recovers_a_boundary_under_the_mass_floor():
    """hemo1 KNT sq2.1, lone: the right triple is tilted about 0.6 degrees and
    rides the frame edge, so its per-column coverage never reaches 1.00 and it
    reads mass 13.42 - under triple_min_mass = 14, over triple_relax_mass = 12.
    `_frame_side` alone therefore refuses it. It sits four lattice pitches from
    the detected left triple, which is where a haemocytometer's counting square
    says a boundary must be, so `_lattice_boundary` accepts it there.

    The mass window is the point of the test: if this run ever moves out of
    [relax, min_mass) the test stops exercising the lattice path and starts
    passing for the wrong reason."""
    g = cv2.imread(TIF + "hemo1 KNT sq2.1.tif", cv2.IMREAD_GRAYSCALE)
    profiles = pipeline._line_profiles(g, pipeline.DEFAULTS)
    _, xs, ys = pipeline.detect_grid(g, pipeline.DEFAULTS, profiles=profiles)

    runs = pipeline._profile_runs(profiles[0], pipeline.DEFAULTS["line_min_frac"])
    right = pipeline._merged_runs(profiles[0], runs)[-1]
    assert pipeline.DEFAULTS["triple_relax_mass"] <= right[1] < pipeline.DEFAULTS["triple_min_mass"], right

    f = pipeline.triple_frame(g, pipeline.DEFAULTS, xs, ys, profiles=profiles)
    assert f["sides"]["right"] is True, f
    assert abs(f["x1"] - 1348) <= 4, f


@pytest.mark.parametrize("name", [
    "hemo1 KNT sq2.1.tif",      # the one the lattice recovery fires on
    "hemo1 ha1 sq1.1.tif",
    "hemo1 hgrc1 sq4.2.tif",
    "10x tile picture 1; last three rows.tif",
])
@pytest.mark.data
def test_lone_capture_is_never_a_full_square(name):
    """A 10x capture of this haemocytometer shows three of the large square's
    four rows, so one horizontal triple is genuinely out of frame and the field
    is a PARTIAL one. `isFullSquare` (web/src/lib/concentration.ts) drops it
    from the divisor for exactly that reason.

    `_lattice_boundary` predicts a missing boundary four pitches from the
    detected one, and four pitches from the top triple of a 1024-tall capture
    lands around y = 1330 - outside the frame, so it is refused. If this test
    ever fails, every concentration computed from lone captures is silently
    halved, and it looks like a correct answer."""
    g = cv2.imread(TIF + name, cv2.IMREAD_GRAYSCALE)
    profiles = pipeline._line_profiles(g, pipeline.DEFAULTS)
    _, xs, ys = pipeline.detect_grid(g, pipeline.DEFAULTS, profiles=profiles)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS, xs, ys, profiles=profiles)
    s = f["sides"]
    full = len(xs) - 1 == 4 and len(ys) - 1 == 4 and all(s.values())
    assert not full, (name, len(xs) - 1, len(ys) - 1, s)


def test_frame_side_accepts_a_corner_clipped_boundary_on_both_axes():
    """_frame_side runs once per axis, so a boundary clipped at a CORNER is
    decided by two independent calls with nothing joining them. That case is
    real - `4x tile picture 1` has one - but no hemo run 1 field exercises
    it, so it went untested when the border-clip guard was narrowed
    (2026-09-12 pass 5). Pin it: both clipped runs clear triple_min_mass, so
    both sides must be detected at the runs' own centres, NOT fall back to
    the image edge. See _frame_side's pass-6 note for why the axes stay
    uncoupled."""
    g = _corner_clipped_grid()
    h, w = g.shape
    prof_v, prof_h, _, _ = pipeline._line_profiles(g, pipeline.DEFAULTS)
    thr = pipeline.DEFAULTS["line_min_frac"]
    # the premise: the outermost run on each axis really is border-clipped
    assert pipeline._profile_runs(prof_v, thr)[-1][-1] >= w - 3
    assert pipeline._profile_runs(prof_h, thr)[-1][-1] >= h - 3

    f = pipeline.triple_frame(g, pipeline.DEFAULTS)
    assert f["sides"] == {"left": True, "right": True, "top": True, "bottom": True}, f
    assert (f["x1"], f["y1"]) == (1348, 1012), f     # run centres, not (1360, 1024)
    assert (f["x0"], f["y0"]) == (99, 69), f
    # A clipped run's centre is the centre of its VISIBLE part, so the frame
    # errs INWARD (1348 < the 1348.5 band midpoint, and the uncut line would
    # sit further out still) - a corner accept can only undercount.
    assert f["x1"] < w and f["y1"] < h, f


@pytest.mark.data
@pytest.mark.parametrize("name", sorted(EXPECTED_FRAMES))
def test_boundary_excludes_outside_cells(name):
    bgr = cv2.imread(TIF + name, cv2.IMREAD_COLOR)
    on = pipeline.count_cells(bgr, {"boundary": 1})
    off = pipeline.count_cells(bgr, {"boundary": 0})
    f = on["frame"]
    assert f is not None and off["frame"] is None
    for x, y in on["centers"]:
        assert f["x0"] <= x < f["x1"] and f["y0"] <= y < f["y1"], (name, x, y)
    assert on["count"] <= off["count"]


@pytest.mark.data
@pytest.mark.parametrize("name", sorted(BASELINE_COUNTS))
def test_boundary_off_is_accuracy_neutral(name):
    bgr = cv2.imread(TIF + name, cv2.IMREAD_COLOR)
    assert pipeline.count_cells(bgr, {"boundary": 0, "engine": 0})["count"] == BASELINE_COUNTS[name]


@pytest.mark.data
@pytest.mark.parametrize("name", sorted(EXPECTED_FRAMES))
def test_auto_crop_frame_never_loses_a_cell(name):
    """Correctness beats aggressiveness (user ruling 2026-09-02): every cell
    found in the full image must still be inside the cropped one."""
    bgr = cv2.imread(TIF + name, cv2.IMREAD_COLOR)
    full = pipeline.count_cells(bgr, {"boundary": 1})
    crop, (ox, oy) = pipeline.auto_crop_frame(bgr, pipeline.DEFAULTS)
    f = pipeline.triple_frame(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), pipeline.DEFAULTS)
    m = int(pipeline.DEFAULTS["diameter"])
    assert (ox, oy) == (max(0, f["x0"] - m), max(0, f["y0"] - m))
    ch, cw = crop.shape[:2]
    for x, y in full["centers"]:
        assert 0 <= x - ox < cw and 0 <= y - oy < ch, (name, x, y)
    assert crop.shape[0] <= bgr.shape[0] and crop.shape[1] <= bgr.shape[1]


def test_auto_crop_frame_declines_when_no_triple_is_found():
    flat = np.full((400, 400, 3), 128, np.uint8)      # no grid at all
    out, off = pipeline.auto_crop_frame(flat, pipeline.DEFAULTS)
    assert out.shape == flat.shape and off == (0, 0)


def test_warp_quad_deskews_a_known_rotation():
    # A white rectangle on black, rotated 12 degrees. Warping its four corners
    # back must produce an upright rectangle that is white nearly everywhere.
    img = np.zeros((400, 400, 3), np.uint8)
    box = np.array([[100, 80], [300, 80], [300, 320], [100, 320]], np.float32)
    M = cv2.getRotationMatrix2D((200, 200), 12, 1.0)
    rot = cv2.transform(box.reshape(1, -1, 2), M).reshape(-1, 2)
    cv2.fillPoly(img, [rot.astype(np.int32)], (255, 255, 255))
    out = pipeline.warp_quad(img, rot.tolist())
    assert abs(out.shape[1] - 200) <= 3 and abs(out.shape[0] - 240) <= 3
    inner = out[10:-10, 10:-10]
    assert (inner > 200).mean() > 0.99


def test_warp_quad_accepts_corners_in_any_order():
    img = np.zeros((200, 200, 3), np.uint8)
    q = [[20, 20], [180, 25], [175, 170], [25, 165]]
    a = pipeline.warp_quad(img, q)
    b = pipeline.warp_quad(img, [q[2], q[3], q[0], q[1]])
    assert a.shape == b.shape


def test_warp_quad_rejects_bad_input():
    img = np.zeros((200, 200, 3), np.uint8)
    with pytest.raises(ValueError):
        pipeline.warp_quad(img, [[0, 0], [10, 0], [10, 10]])          # three corners
    with pytest.raises(ValueError):
        pipeline.warp_quad(img, [[0, 0], [4, 0], [4, 4], [0, 4]])     # degenerate


# ---------------------------------------------------------------- merge

def _split(gray, dy):
    """Two overlapping captures of one field, offset by dy, same size."""
    H = gray.shape[0] - dy
    return gray[:H].copy(), gray[dy:dy + H].copy()


@pytest.mark.data
@pytest.mark.parametrize("dy", [200, 260, 320])
def test_stitch_round_trip_is_exact(dy):
    """Merge-then-count, proved: stitching two halves back together must give
    the same cells as the whole image, with none duplicated and none lost."""
    g = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    whole = pipeline.count_cells(cv2.cvtColor(g, cv2.COLOR_GRAY2BGR), {"boundary": 0})
    a, b = _split(g, dy)
    out, info = pipeline.stitch_pair(a, b)
    got = pipeline.count_cells(cv2.cvtColor(out, cv2.COLOR_GRAY2BGR), {"boundary": 0})
    assert info["dy"] == dy
    assert got["count"] == whole["count"]
    s = np.array(got["centers"], float).reshape(-1, 2)
    used, matched = set(), 0
    for qx, qy in whole["centers"]:
        d = np.hypot(s[:, 0] - qx, s[:, 1] - qy)
        for i in np.argsort(d)[:3]:
            if d[i] <= 3 and int(i) not in used:
                used.add(int(i))
                matched += 1
                break
    assert matched == len(whole["centers"])           # nothing lost
    assert len(s) - matched == 0                      # nothing duplicated


@pytest.mark.data
@pytest.mark.parametrize("dy", [380, 440])
def test_stitch_rejects_aliased_registration(dy):
    """The grid is periodic at ~315 px, so phase correlation aliases once the
    overlap drops below one pitch. Measured 2026-09-02: dy 380 registered
    112 px wrong at response 0.222 and produced a +13 count error, dy 440 was
    280 px wrong at 0.052 and produced -33. Both passed the old check."""
    g = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    a, b = _split(g, dy)
    with pytest.raises(ValueError):
        pipeline.stitch_pair(a, b)


@pytest.mark.data
def test_stitch_reports_ncc_and_pitch():
    g = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    a, b = _split(g, 200)
    _, info = pipeline.stitch_pair(a, b)
    assert info["ncc"] > 0.9
    assert 250 < info["pitch"] < 400


import glob as _glob

TILES_10X = sorted(_glob.glob(TIF + "10x*.tif"))


@pytest.mark.data
def test_group_captures_finds_the_only_real_pair():
    """Of the five 10x tiles exactly one true pair exists - tile 3's first and
    last three rows. Every other pair scores response <= 0.023 against the
    pair's 0.232 (measured 2026-09-02)."""
    grays = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in TILES_10X]
    groups, stitched = pipeline.group_captures(grays)
    pairs = [g for g in groups if len(g) == 2]
    assert len(pairs) == 1, groups
    names = sorted(TILES_10X[i] for i in pairs[0])
    assert all("picture 3" in n for n in names), names
    assert sum(len(g) for g in groups) == len(grays)     # nothing dropped
    assert set(stitched) == {tuple(pairs[0])}


@pytest.mark.data
def test_group_captures_is_filename_independent():
    """Discovery is image-based, so input order must not matter."""
    grays = [cv2.imread(f, cv2.IMREAD_GRAYSCALE) for f in TILES_10X]
    order = [3, 0, 4, 1, 2]
    shuffled, _ = pipeline.group_captures([grays[i] for i in order])
    back = sorted(sorted(order[i] for i in g) for g in shuffled)
    groups, _ = pipeline.group_captures(grays)
    assert back == sorted(sorted(g) for g in groups)


@pytest.mark.data
def test_group_captures_single_file():
    g = cv2.imread(TILES_10X[0], cv2.IMREAD_GRAYSCALE)
    groups, stitched = pipeline.group_captures([g])
    assert groups == [[0]] and stitched == {}

@pytest.mark.data
def test_grid_lines_are_clipped_to_the_counting_frame():
    """A grid line outside the triple frame bounds no countable square.

    "picture 2; first three rows" carries the OUTER line of its left triple at
    x = 27, outside frame x0 = 91, so the grid panel reported 5 x 3 with a
    column of 0/0/0 that no cell could ever fall in. Measured 2026-09-05: the
    clip drops that one line, the tally becomes 4 x 3, and the count is
    unchanged because every centre was already frame-filtered.
    """
    g = cv2.imread(TIF + "10x tile picture 2; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    r = pipeline.count_cells(cv2.cvtColor(g, cv2.COLOR_GRAY2BGR), {"level": 3})
    f = r["frame"]
    assert f["sides"]["left"] and f["x0"] > 27
    assert all(x >= f["x0"] for x in r["grid_x"]), r["grid_x"]
    assert len(r["grid_x"]) - 1 == 4 and len(r["grid_y"]) - 1 == 3
    # Every square index the tally reports exists in the clipped lattice.
    assert max(c for c, _ in r["squares"]) == 3


@pytest.mark.data
def test_stitch_rejects_the_same_capture_twice():
    """A user who drops one file twice must get two singles, not a "pair".

    Identical frames phase-correlate at response 1.0 with shift (0, 0), which
    cleared every gate: the pair was reported to the review screen as a perfect
    match (ncc 1.0, dy 0) and stitching it produced one image counted once,
    silently halving a two-capture batch. A real stage scroll moves the field by
    hundreds of pixels; nothing under the seam margin is a second view.
    """
    g = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    with pytest.raises(ValueError):
        pipeline.stitch_pair(g, g.copy())
    groups, stitched = pipeline.group_captures([g, g.copy()])
    assert groups == [[0], [1]] and stitched == {}


@pytest.mark.data
def test_level_is_clamped_to_the_levels_that_exist():
    """Level 9 used to be accepted, run as raw engine params, and echoed back as
    9 - so the card said a quality the app has no such rung for, and "the level
    it was counted at" stopped meaning anything. Clamp to the declared range."""
    g = cv2.imread(TIF + "10x tile picture 3; first three rows.tif", cv2.IMREAD_GRAYSCALE)
    img = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
    top = max(pipeline.LEVELS)
    hi = pipeline.count_cells(img, {"level": 9})
    ref = pipeline.count_cells(img, {"level": top})
    assert hi["params"]["level"] == top
    assert hi["count"] == ref["count"]
    lo = pipeline.count_cells(img, {"level": -3, "engine": 0})
    assert lo["params"]["level"] == 0 and lo["params"]["engine"] == 0


# ---------------------------------------------------------------- hemo run 1 (2026-09-12)
# Four captures from a later run with different optics (mean gray 129 vs 82,
# double-line boundaries 20-24 px wide, KGN/KNT slightly defocused so interior
# lines run 16-29 px). Measured 2026-09-12 over all 64 captures of that run:
# boundary run MASS (sum of the coverage profile over the run) is 16.9-23.5,
# interior 0.3-10.3; width no longer separates them. The audit over the whole
# run is tools/grid_audit.py; these four are the smallest set that fails each
# mechanism the run exposed.

@pytest.mark.data
def test_frame_boundary_is_found_by_mass_not_width():
    """KA2 sq1.1: both vertical boundaries are 21 px runs (mass 19.5 / 20.6),
    under the old 22 px width floor, so the field read L0R0 and the calculator
    called every KA2 square partial. Interior runs here are 11-13 px, mass
    7.7-9.6."""
    g = cv2.imread(TIF + "hemo1 KA2 sq1.1.tif", cv2.IMREAD_GRAYSCALE)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS)
    assert f["sides"]["left"] and f["sides"]["right"], f
    assert f["sides"]["top"] and not f["sides"]["bottom"], f
    assert abs(f["x0"] - 54) <= 3 and abs(f["x1"] - 1315) <= 3, f


@pytest.mark.data
def test_wide_interior_line_is_not_a_boundary():
    """KNT sq1.1: the interior line at y ~ 372 is a 27 px run (defocus) but has
    mass 2.8 - a boundary must not be declared there. The real top boundary at
    y ~ 58 is a 41 px run with mass 18.8. Old rule: bottom reported detected at
    an interior line and the frame lost rows."""
    g = cv2.imread(TIF + "hemo1 KNT sq1.1.tif", cv2.IMREAD_GRAYSCALE)
    f = pipeline.triple_frame(g, pipeline.DEFAULTS)
    assert f["sides"]["top"] and abs(f["y0"] - 58) <= 4, f
    assert not f["sides"]["bottom"], f
