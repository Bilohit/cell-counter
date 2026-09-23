import pytest
import numpy as np, pytest
from ml import data

def test_make_targets_peak_and_ignore():
    heat, w = data.make_targets((64, 64), np.array([[20., 20.]]), np.array([[50., 50.]]), np.ones((64, 64), np.float32))
    # one sigma from the centre is exp(-0.5), whatever SIGMA is tuned to
    assert heat[20, 20] == pytest.approx(1.0)
    assert heat[20, 20 + int(data.SIGMA)] == pytest.approx(np.exp(-0.5), abs=1e-3)
    assert w[20, 20] == 5.0 and w[5, 5] == 1.0 and w[50, 50] == 0.0 and w[50, 63] == 0.0 and w[50, 30] == 1.0

def test_make_targets_sep_weight_off_by_default_is_bit_identical():
    # points are (px, py) i.e. (x, y); arrays are indexed [y, x]. Both points
    # share py=32, px=10/26, so their midpoint is array index [32, 18].
    pts = np.array([[10., 32.], [26., 32.]])
    valid = np.ones((64, 64), np.float32)
    heat_off, w_off = data.make_targets((64, 64), pts, np.zeros((0, 2)), valid)
    # midpoint sits off-blob (heat < 0.1) but with SEP_WEIGHT at its default
    # (0.0, off) it must fall back to the plain valid*(1+POS_WEIGHT*[heat>0.1])
    # rule - i.e. weight 1, exactly like before this feature existed.
    assert data.SEP_WEIGHT == 0.0
    assert heat_off[32, 18] < 0.1
    assert w_off[32, 18] == 1.0

def test_make_targets_sep_weight_on_ridge_midpoint(monkeypatch):
    pts = np.array([[10., 32.], [26., 32.]])   # 16 px apart, < SEP_R (18)
    valid = np.ones((64, 64), np.float32)
    monkeypatch.setattr(data, "SEP_WEIGHT", 10.0)
    heat, w = data.make_targets((64, 64), pts, np.zeros((0, 2)), valid)
    assert heat[32, 18] < 0.1                 # off-blob, so this pins the ridge weight
    assert w[32, 18] == 11.0                  # midpoint: additive, 1 (off-blob) + SEP_WEIGHT
    assert w[5, 5] == 1.0                     # off-blob, far from the pair: untouched
    assert w[40, 16] == 1.0                   # in the lens, off-blob, but 2px off the bisector

def test_make_targets_sep_weight_extends_off_the_centre_line(monkeypatch):
    # Regression pin for the bbox bug: the old crop was the bare rectangle
    # spanning c1/c2, which for a horizontal (or vertical) pair has zero
    # extent off the centre line and so clipped the ridge to ~1 row. The true
    # ridge is the perpendicular bisector inside the lens {d1<=dist,d2<=dist},
    # which for this 16px pair extends to y = 32 +/- 13.86 (sqrt(3)/2*dist).
    pts = np.array([[10., 32.], [26., 32.]])
    valid = np.ones((64, 64), np.float32)
    monkeypatch.setattr(data, "SEP_WEIGHT", 10.0)
    heat, w = data.make_targets((64, 64), pts, np.zeros((0, 2)), valid)
    assert heat[42, 18] < 0.1                 # off-blob (d=12.8 from each centre)
    assert w[42, 18] == 11.0                  # on the bisector, 10px off the centre line

def test_make_targets_sep_weight_diagonal_pair_extent(monkeypatch):
    # Pins the lens+bisector geometry for a non-axis-aligned pair: a point on
    # the true bisector, offset from the midpoint, still gets the ridge weight
    # as long as it stays inside the lens.
    pts = np.array([[10., 10.], [22., 22.]])   # ~16.97 px apart, diagonal
    valid = np.ones((64, 64), np.float32)
    monkeypatch.setattr(data, "SEP_WEIGHT", 10.0)
    heat, w = data.make_targets((64, 64), pts, np.zeros((0, 2)), valid)
    assert heat[12, 20] < 0.1
    assert w[12, 20] == 11.0                  # on the bisector (10.2px from each centre), in the lens

def test_make_targets_sep_weight_no_empty_band_on_integer_lattice(monkeypatch):
    # A 17px integer-aligned horizontal pair: the old |d1-d2|<=0.75 proxy
    # changes at rate ~2 along the axis, so its <1px-wide band lands empty
    # between integer pixel columns for this exact separation. The bisector
    # sits at x=18.5; column 18 is within RIDGE_HALFWIDTH (1.0px) of it.
    pts = np.array([[10., 32.], [27., 32.]])
    valid = np.ones((64, 64), np.float32)
    monkeypatch.setattr(data, "SEP_WEIGHT", 10.0)
    heat, w = data.make_targets((64, 64), pts, np.zeros((0, 2)), valid)
    assert heat[32, 18] < 0.1
    assert w[32, 18] == 11.0

def test_make_targets_sep_weight_additive_inside_blob(monkeypatch):
    # The instrument's whole point: a tight (<12px) pair whose ridge falls
    # inside the heat>0.1 zone (which already carries 1+POS_WEIGHT=5.0). With
    # the old np.maximum combinator, any --sep-weight <= 5 was a bit-exact
    # no-op here - exactly the failure mode this test pins.
    pts = np.array([[20., 32.], [30., 32.]])   # 10 px apart
    valid = np.ones((64, 64), np.float32)
    monkeypatch.setattr(data, "SEP_WEIGHT", 5.0)
    heat, w = data.make_targets((64, 64), pts, np.zeros((0, 2)), valid)
    assert heat[32, 25] > 0.1                          # midpoint sits inside a blob
    assert w[32, 25] == pytest.approx(1.0 + data.POS_WEIGHT + 5.0)   # additive, not max(5, 5)

def test_make_targets_sep_weight_gated_by_distance(monkeypatch):
    # two points 60 px apart: far outside the 18 px gate, so no ridge weight
    # anywhere along their midline. This is what proves the distance gate works.
    pts = np.array([[10., 32.], [70., 32.]])
    valid = np.ones((80, 100), np.float32)
    monkeypatch.setattr(data, "SEP_WEIGHT", 10.0)
    heat, w = data.make_targets((80, 100), pts, np.zeros((0, 2)), valid)
    assert heat[32, 40] < 0.1
    assert w[32, 40] == 1.0

def test_targets_respect_valid_mask():
    valid = np.zeros((32, 32), np.float32); valid[:, :16] = 1
    _, w = data.make_targets((32, 32), np.zeros((0, 2)), np.zeros((0, 2)), valid)
    assert w[0, 0] == 1 and w[0, 20] == 0

def test_random_crop_and_augment_shapes():
    rng = np.random.default_rng(0)
    s = {"x": np.zeros((3, 300, 400), np.float32), "heat": np.zeros((300, 400), np.float32), "w": np.ones((300, 400), np.float32)}
    s["heat"][100, 100] = 1
    x, h, w = data.random_crop(s, 256, rng)
    assert x.shape == (3, 256, 256) and h.shape == (256, 256) and w.shape == (256, 256)
    x2, h2, w2 = data.augment(x, h, w, rng)
    assert x2.shape == x.shape and h2.sum() == pytest.approx(h.sum())

def test_augment_deterministic_given_seed(monkeypatch):
    monkeypatch.setattr(data, "HEAVY_AUG", False)
    x = np.random.default_rng(1).normal(size=(3, 64, 64)).astype(np.float32)
    heat = np.zeros((64, 64), np.float32); heat[32, 32] = 1.0
    w = np.ones((64, 64), np.float32)
    x1, h1, w1 = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(7))
    x2, h2, w2 = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(7))
    assert np.array_equal(x1, x2) and np.array_equal(h1, h2) and np.array_equal(w1, w2)
    assert x1.shape == x.shape and h1.shape == heat.shape and w1.shape == w.shape

def test_augment_deterministic_given_seed_heavy_aug(monkeypatch):
    monkeypatch.setattr(data, "HEAVY_AUG", True)
    x = np.random.default_rng(2).normal(size=(3, 64, 64)).astype(np.float32)
    heat = np.zeros((64, 64), np.float32); heat[32, 32] = 1.0
    w = np.ones((64, 64), np.float32)
    x1, h1, w1 = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(11))
    x2, h2, w2 = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(11))
    assert np.array_equal(x1, x2) and np.array_equal(h1, h2) and np.array_equal(w1, w2)
    assert x1.shape == x.shape and h1.shape == heat.shape and w1.shape == w.shape
    # heavy-aug output should differ from the non-heavy path given the same seed
    x3, h3, w3 = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(11))
    monkeypatch.setattr(data, "HEAVY_AUG", False)
    x4, h4, w4 = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(11))
    assert not np.array_equal(x3, x4)

def test_augment_photometric_touches_channel_0_only(monkeypatch):
    # Channel 1 is a BINARY grid mask and channel 2 a NORMALISED NCC. Both are
    # recomputed from the image at inference, where ch1 is exactly {0, 1}. An
    # affine on them produces values inference never generates - measured
    # 2026-09-19: it shifts ch2 by mean|d| 0.29, where re-deriving the channels
    # from the jittered image (the honest version of "consistently") shifts it
    # by 0.007-0.061. The fix was larger than the flaw, so only ch0 is jittered.
    # See the comment on augment() in ml/data.py.
    monkeypatch.setattr(data, "HEAVY_AUG", False)
    x = np.stack([np.zeros((32, 32), np.float32),
                  np.full((32, 32), 0.5, np.float32),
                  np.full((32, 32), -0.5, np.float32)])
    heat = np.zeros((32, 32), np.float32)
    w = np.ones((32, 32), np.float32)
    x2, _, _ = data.augment(x.copy(), heat.copy(), w.copy(), np.random.default_rng(3))
    assert not np.allclose(x2[0], x[0]), "channel 0 must still be jittered"
    # Geometric ops (flip/rot90) may move ch1/ch2 around, but their VALUE SET
    # must be untouched by the photometric draw.
    assert np.allclose(np.unique(x2[1]), np.unique(x[1]))
    assert np.allclose(np.unique(x2[2]), np.unique(x[2]))

def test_augment_keeps_the_grid_mask_channel_binary(monkeypatch):
    # The consequence that actually matters: whatever augment does, channel 1
    # must still look like what infer.py feeds the net - strictly {0, 1}.
    monkeypatch.setattr(data, "HEAVY_AUG", False)
    rng = np.random.default_rng(0)
    x = np.stack([rng.normal(size=(32, 32)).astype(np.float32),
                  (rng.random((32, 32)) > 0.5).astype(np.float32),
                  rng.normal(size=(32, 32)).astype(np.float32)])
    for seed in range(8):
        x2, _, _ = data.augment(x.copy(), np.zeros((32, 32), np.float32),
                                np.ones((32, 32), np.float32),
                                np.random.default_rng(seed))
        assert set(np.unique(x2[1]).tolist()) <= {0.0, 1.0}

def test_augment_keeps_x_heat_w_aligned_light():
    # Decision 2: pin the x/heat/w alignment invariant under the light
    # (default) path - a distinctive region planted in all three arrays must
    # still coincide after augment (flip/rot are geometric on all three).
    x = np.zeros((3, 64, 64), np.float32)
    heat = np.zeros((64, 64), np.float32)
    w = np.zeros((64, 64), np.float32)
    x[:, 10:14, 20:26] = 9.0
    heat[10:14, 20:26] = 1.0
    w[10:14, 20:26] = 5.0
    x2, h2, w2 = data.augment(x, heat, w, np.random.default_rng(42))
    # Every channel now gets the same gain/bias jitter (gain in [0.8,1.2],
    # bias in [-0.3,0.3]), so an exact-value check would also catch that
    # perturbation, unrelated to the alignment invariant under test. A
    # threshold well clear of both the perturbed background (|bias|<=0.3)
    # and the perturbed region floor (9*0.8-0.3=6.9) isolates the geometric
    # (flip/rot) move alone.
    region_x = (x2[1] > 4.5)
    region_h = (h2 == 1.0)
    region_w = (w2 == 5.0)
    assert region_x.any() and region_h.any() and region_w.any()
    assert np.array_equal(region_x, region_h)
    assert np.array_equal(region_x, region_w)

@pytest.mark.parametrize("seed", [0, 1, 2, 3, 4])
def test_augment_keeps_x_heat_w_aligned_heavy(monkeypatch, seed):
    # Same invariant with --heavy-aug on: elastic deformation and scale
    # jitter are real geometric warps, not just flips/rot90, so this is the
    # case that actually exercises whether x/heat/w can drift apart. Uses a
    # centroid check (not exact equality) since remap/resize interpolate the
    # region's edges.
    #
    # Tolerance and seed loop measured directly (reviewer, 2026-09-19):
    #   correct code: 0.026 px at seed 5; over 60 seeds, mean 0.057, p95
    #     0.261, max 0.293 px.
    #   an injected 1 px x-vs-heat/w misalignment: 0.961 px, which PASSED on
    #     0 of 30 seeds at the old `< 2.0` tolerance - the old test was blind
    #     to exactly the off-by-one-pixel class it exists to catch.
    #   an injected 2 px misalignment failed on only 18 of 30 seeds at the
    #     old tolerance, so a single pinned seed was itself part of the
    #     weakness.
    # `< 0.5` gives ~1.7x headroom over the measured worst correct case
    # (0.293 px) while catching the 1 px injection on every seed; looping
    # over several seeds (rather than one pinned seed) is required for that
    # guarantee to hold in practice, not just on average.
    monkeypatch.setattr(data, "HEAVY_AUG", True)
    x = np.zeros((3, 96, 96), np.float32)
    heat = np.zeros((96, 96), np.float32)
    w = np.zeros((96, 96), np.float32)
    x[:, 40:56, 40:56] = 9.0
    heat[40:56, 40:56] = 1.0
    w[40:56, 40:56] = 5.0
    x2, h2, w2 = data.augment(x, heat, w, np.random.default_rng(seed))

    def centroid(mask_arr, thr):
        ys, xs = np.nonzero(mask_arr > thr)
        assert len(ys), "region vanished under augmentation"
        return np.array([xs.mean(), ys.mean()])

    cx = centroid(x2[0], 4.5)
    ch = centroid(h2, 0.5)
    cw = centroid(w2, 2.5)
    assert np.hypot(*(cx - ch)) < 0.5
    assert np.hypot(*(cx - cw)) < 0.5

@pytest.mark.data
def test_build_samples_excludes_held_out_chunks():
    s = data.build_samples(2, "C")   # tile 3 first rows held out
    srcs = {e["name"] for e in s}
    assert "10x tile picture 3; first three rows" not in srcs and len(s) > 3

def test_group_of_keeps_overlapping_captures_together():
    # the .1/.2 captures of a pair are two shots of one spot; picture 3's two
    # tiles are halves of one slide. Either split across folds leaks pixels.
    assert data.group_of("hemo1 KA1 sq2.1") == data.group_of("hemo1 KA1 sq2.2") == "KA1"
    assert (data.group_of("10x tile picture 3; first three rows")
            == data.group_of("10x tile picture 3; last three rows") == "picture 3")
    assert data.group_of("hemo1 hgrc1 sq4.2") == "hgrc1"

@pytest.mark.data
def test_discover_tiles_finds_the_five_originals():
    tiles = data.discover_tiles()
    assert "10x tile picture 1; last three rows" in tiles
    assert "cluster_gt" not in tiles and "reconciled_clumps" not in tiles
    # sorted order still puts the "10x ..." originals ahead of any "hemo1 ..."
    assert tiles == sorted(tiles)

@pytest.mark.data
def test_build_samples_holds_out_a_whole_group():
    s = data.build_samples("picture 3", "C")
    srcs = {e["name"] for e in s}
    assert not [n for n in srcs if data.group_of(n) == "picture 3"]
    assert len(s) > 3

@pytest.mark.data
def test_every_tile_is_whole_image_after_the_2026_09_14_reannotation():
    # the 5 original tiles were re-annotated whole-image on 2026-09-14, so every
    # GT file now carries "whole_image" and loss covers the full frame. A tile
    # without the flag would silently teach the outer band as background.
    # cluster chunks are crops that deliberately carry loss only inside their box,
    # so only the full 1360x1024 tiles are checked here
    whole = [t for t in data.build_samples("all", "C") if t["x"].shape[-2:] == (1024, 1360)]
    assert len(whole) == len(data.discover_tiles())
    for t in whole:
        assert t["w"].min() > 0, f"{t['name']} is still frame-limited"
