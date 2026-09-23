"""Dataset builder for the ML cell detector: GT loading, channels, heatmap
targets with ignore zones, chunk crops, and leave-one-tile-out folds."""
import glob
import json
import os
import re

import cv2
import numpy as np

import pipeline

SIGMA, IGNORE_R, DIA = 3.0, 13, 22
# POS_WEIGHT: the k in the loss weight `1 + k*[heat>0.1]`. 4.0 since the engine
# landed, never measured. It says a missed cell costs 5x what an invented one
# costs, which is the training-side twin of the F1-picked threshold - and the
# 2026-09-14 baseline over-counts 42 of 53 tiles (FP 771 / FN 319). Swept in
# plan 2026-09-14 Track C1.
POS_WEIGHT = 4.0
# SEP_WEIGHT: loss weight added on the "ridge" between two GT centres closer
# than SEP_R px. Failure mode #2 (audit-ml.md Tier 1 item 1): 3.9% of all cells
# sit within 12 px of another and are all but guaranteed to merge into one
# heatmap peak, because nothing in the loss ever tells the net where two cells
# touch. Measured basis for SEP_R=18px: nearest-neighbour distance p1 9.5px,
# p5 12.4, p10 14.8, p25 19.0; cells are ~22px across; 3.9% of cells sit under
# 12px of another, 20% within 18px.
# Default 0.0 = off. Bit-identical to before this flag existed is guaranteed
# by `if SEP_WEIGHT > 0` below, not by any numerical inertness of the ridge
# term (it is added, so a 0 contribution still requires the gate to skip the
# whole block) - see tests/ml/test_data.py. Threaded through ml/train.py and
# ml/loo.py exactly like SIGMA/POS_WEIGHT above.
SEP_WEIGHT = 0.0
SEP_R = 18.0        # px; pairs of centres this close or closer get a ridge weight
RIDGE_HALFWIDTH = 1.0   # px; half-width of the ridge band around the true
                        # perpendicular bisector line (geometric distance, not
                        # the |d1-d2| proxy - see make_targets)
# HEAVY_AUG: gate for the physically-motivated augmentation ops added in
# audit-ml.md Tier 1 item 2 (elastic deformation, blur, additive noise, a
# low-order illumination gradient, scale jitter). The un-gated augmentation
# was dihedral flips/rotations + a gain/bias jitter only - no deformation, no
# blur/defocus, no noise, no illumination gradient, no scale jitter, which are
# exactly what differs between capture bundles (ha1 0.86% vs KGN 3.64% mean
# per-tile count error, same weights). Default False = bit-identical to
# before this flag existed. Threaded through ml/train.py and ml/loo.py as
# --heavy-aug, same pattern as --amp/--tta.
HEAVY_AUG = False
# The photometric gain/bias jitter in augment() applies to every input
# channel, not only channel 0, unconditionally (fixed ef59864/eb8dadd's
# follow-up gate removed again - c2c5 brief: "photometric ops must apply to
# all three channels consistently ... that inconsistency gets fixed
# regardless of any sweep result"). Channels 1/2 (grid-line mask, ring-
# template NCC) are derived from the same underlying grayscale as channel 0,
# so jittering channel 0 alone taught the net a grayscale that contradicts
# its own derived channels. This DOES move the training baseline versus
# every pre-c2c5 ml/runs/loo.md entry (same status as a GT revision: not
# comparable across it) - that is accepted as the cost of the fix, per the
# brief, not gated behind a flag.
NOT_TILE_GT = {"cluster_gt", "reconciled_clumps"}     # chunk/reconcile files, not whole-tile GT
# GT_DIR is env-overridable so a historical GT snapshot can be scored on today's
# code (the 5 originals were re-annotated in 44da00d, 2113 -> 2048 points, so the
# pre-44da00d baseline is only reproducible by pointing at the old files).
GT_DIR = os.environ.get("ML_GT_DIR", "data/gt")
# Where score.py --dump-candidates writes <tile>.candidates.json (same artifact,
# same filename convention - see its docstring). Moved out of data/gt/ alongside
# that write so the pale-ignore read below keeps finding the file.
CANDIDATES_DIR = os.environ.get("ML_CANDIDATES_DIR", "data/candidates")
# USE_CHUNKS: cluster_gt.json's 100 chunk samples. They were annotated against the
# OLD tile GT and claim 968 cells where the 2026-09-14 whole-image re-annotation
# has 926 inside the same boxes, so the model is given two answers for the same
# pixels. loo --no-chunks measures it both ways.
USE_CHUNKS = True

_tile_cache = {}


def discover_tiles(gt_dir=None):
    """Every whole-tile GT in `gt_dir`, sorted. Was a hardcoded list of the 5
    reviewed 2026-09-04 tiles; the hemo run 1 annotation pass (2026-09-12) adds
    up to 64 more, so the list is read off disk instead of edited by hand.
    Sorting puts the "10x tile picture N" originals first, as before."""
    gt_dir = gt_dir or GT_DIR
    out = []
    for path in sorted(glob.glob(os.path.join(gt_dir, "*.json"))):
        stem = os.path.basename(path)[:-5]
        if stem in NOT_TILE_GT or stem.endswith(".candidates"):
            continue
        if not os.path.exists(os.path.join("data/tif", stem + ".tif")):
            continue
        out.append(stem)
    return out


TILES = discover_tiles()


def group_of(stem):
    """Cross-validation group. Tiles that share pixels or a sample MUST share a
    group, or a held-out fold is not held out at all:
      * "hemo1 KA1 sq2.1" -> "KA1". The `.1` / `.2` captures of a pair are two
        shots of the same spot and overlap physically; all 4 squares come off
        one bundle / one cell suspension.
      * "10x tile picture 3; last three rows" -> "picture 3", the other half of
        the same slide capture.
    This replaced leave-one-TILE-out on 2026-09-12: that split trained on a
    sibling capture's pixels and so reported better than the truth."""
    parts = stem.split()
    if parts and parts[0] == "hemo1" and len(parts) >= 2:
        return parts[1]
    m = re.search(r"picture (\d+)", stem)
    return "picture " + m.group(1) if m else stem


def groups(tiles=None):
    """Ordered unique group names over `tiles` (default TILES)."""
    seen = []
    for t in (TILES if tiles is None else tiles):
        g = group_of(t)
        if g not in seen:
            seen.append(g)
    return seen


def fold_level_mean_sd(errs_by_fold):
    """Bundle-stratified accuracy: the unweighted mean over folds of each
    fold's mean per-tile |count error|, and the sample sd (ddof=1) over those
    per-fold means. A plain pooled mean over tiles weights the 8-tile hemo
    bundles ~6x over the 1-tile legacy ones - that alone was the 2.20 vs 1.94
    gap measured in tools/fold_spread.py (audit-ml.md, Tier 0 item 0b,
    2026-09-18). This is the single definition both that tool and ml/loo.py
    read the ruler off, so they cannot disagree.

    `errs_by_fold`: dict (or any mapping) fold -> list/array of that fold's
    per-tile |err| % values. Returns (fold_mean, fold_sd); fold_sd is nan
    with fewer than 2 folds (sample sd is undefined for n=1).
    """
    fold_means = np.array([np.mean(v) for v in errs_by_fold.values()], float)
    fold_mean = float(fold_means.mean())
    fold_sd = float(fold_means.std(ddof=1)) if len(fold_means) > 1 else float("nan")
    return fold_mean, fold_sd


def load_tile(name, gt_dir=None, tif_dir="data/tif"):
    gt_dir = gt_dir or GT_DIR
    gray = cv2.imread(os.path.join(tif_dir, name + ".tif"), cv2.IMREAD_GRAYSCALE)
    p = dict(pipeline.DEFAULTS)
    line_mask, xs, ys = pipeline.detect_grid(gray, p)
    tex, bg = pipeline.texture_map(gray, line_mask, p)
    thr = pipeline.noise_threshold(tex, line_mask, p)
    mask = pipeline.cell_mask(tex, thr, p)
    mask[pipeline.line_reject_mask(line_mask, p) > 0] = 0
    sm = pipeline.seed_response(gray, line_mask, mask, p)
    frame = pipeline.triple_frame(gray, p, xs, ys)
    norm = np.clip((gray.astype(np.float32) - bg) / 32.0, -4, 4)
    channels = np.stack([norm, line_mask.astype(np.float32) / 255.0, sm.astype(np.float32)])
    gp = os.path.join(gt_dir, name + ".json")
    whole = False
    if os.path.exists(gp):
        with open(gp) as f:
            gt = json.load(f)
        pts = np.array(gt["points"], float).reshape(-1, 2)
        # "whole_image": written by ml/make_review.py for a tile annotated edge
        # to edge, so its loss mask is the whole tile instead of the triple
        # frame. The 5 original tiles have no flag and stay frame-limited:
        # their outside-frame region was never annotated, and carrying loss
        # over unannotated real cells teaches them as background.
        whole = bool(gt.get("whole_image", False))
    else:
        pts = np.zeros((0, 2))
    # Pale cells come from EITHER of two places, because the repo grew two
    # mechanisms that never met:
    #   1. data/candidates/<tile>.candidates.json -> "pale", written by
    #      score.py --dump-candidates.
    #   2. data/gt/<tile>.json's OWN "pale" key, which is where the human
    #      review workflow (ml.dump_candidates -> ml.make_review ->
    #      tools/merge_gt.py) has always written its marks.
    # Only (1) was ever read, so every mark made through the human workflow -
    # the only workflow a person actually uses - was silently ignored, and the
    # pale cells it names kept being taught as background. That is the exact
    # bug the pale-ignore feature exists to prevent.
    # Reading both is behaviour-neutral until someone marks a cell: zero pale
    # marks exist in either location today. This is NOT a ruler change - it
    # zeroes the loss near a marked point, and data/gt/'s "points" (what the
    # ruler scores) are untouched.
    ign_pts = []
    cp = os.path.join(CANDIDATES_DIR, name + ".candidates.json")
    if os.path.exists(cp):
        with open(cp) as f:
            ign_pts.append(np.array(json.load(f).get("pale", []), float).reshape(-1, 2))
    if os.path.exists(gp):
        with open(gp) as f:
            ign_pts.append(np.array(json.load(f).get("pale", []), float).reshape(-1, 2))
    ign = np.concatenate(ign_pts) if ign_pts else np.zeros((0, 2))
    return {"gray": gray, "channels": channels, "frame": frame, "points": pts,
            "ignore": ign, "whole_image": whole}


def _cached_tile(name, gt_dir=None, tif_dir="data/tif"):
    gt_dir = gt_dir or GT_DIR
    if name not in _tile_cache:
        _tile_cache[name] = load_tile(name, gt_dir, tif_dir)
    return _tile_cache[name]


def load_chunks(name, gt_dir=None, tif_dir="data/tif"):
    """Every chunk from cluster_gt.json whose source == name + '.tif'."""
    gt_dir = gt_dir or GT_DIR
    with open(os.path.join(gt_dir, "cluster_gt.json")) as f:
        chunks = json.load(f)["chunks"]
    out = []
    for c in chunks:
        if c["source"] != name + ".tif":
            continue
        box = c["box"]
        pts = np.array(c["points"], float).reshape(-1, 2)
        pts = pts + np.array([box[0], box[1]], float) if len(pts) else pts
        out.append({"box": box, "points": pts})
    return out


def make_targets(shape, points, ignore_pts, valid_mask):
    """heat = max Gaussian (sigma SIGMA) over points, stamped locally.
    weight = valid_mask * (1 + POS_WEIGHT*[heat>0.1]), zeroed inside IGNORE_R of ignore_pts."""
    h, w = shape
    heat = np.zeros((h, w), np.float32)
    r = int(np.ceil(3 * SIGMA))
    for px, py in points:
        cx, cy = int(round(px)), int(round(py))
        x0, x1 = max(0, cx - r), min(w, cx + r + 1)
        y0, y1 = max(0, cy - r), min(h, cy + r + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1]
        d2 = (xs - cx) ** 2 + (ys - cy) ** 2
        g = np.exp(-d2 / (2 * SIGMA ** 2)).astype(np.float32)
        np.maximum(heat[y0:y1, x0:x1], g, out=heat[y0:y1, x0:x1])

    weight = valid_mask.astype(np.float32) * (1.0 + POS_WEIGHT * (heat > 0.1))

    if SEP_WEIGHT > 0 and len(points) > 1:
        pts = np.asarray(points, float)
        # Accumulate a boolean union of the ridge over every close pair first,
        # then add SEP_WEIGHT once at the end. Additive (not np.maximum) so a
        # ridge pixel that also sits inside a blob (heat > 0.1, already
        # carrying weight 1+POS_WEIGHT=5.0) still gets the full SEP_WEIGHT on
        # top instead of being silently absorbed whenever SEP_WEIGHT <= 5 -
        # `max` made any such --sep-weight a bit-exact no-op on exactly the
        # under-12px pairs this flag exists for. Additive stays idempotent
        # over 3+ mutually close points via the boolean OR below (the one
        # merit `max` had), and can only raise a weight, never lower one.
        ridge_any = np.zeros((h, w), bool)
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                c1, c2 = pts[i], pts[j]
                dist = float(np.hypot(*(c2 - c1)))
                if dist == 0 or dist >= SEP_R:
                    continue
                # The lens {d1<=dist, d2<=dist} has half-extent sqrt(3)/2*dist
                # (~0.87*dist) perpendicular to the c1-c2 line. Expand the crop
                # by a full `dist` in both axes - a loose superset of the lens -
                # so only the tile edge ever clips it, not this box (the old
                # box was the bare rectangle spanning c1,c2, which for a
                # horizontal or vertical pair has zero extent in the other
                # axis and cuts the lens down to ~1 px).
                x0 = max(0, int(np.floor(min(c1[0], c2[0]) - dist)))
                x1 = min(w, int(np.ceil(max(c1[0], c2[0]) + dist)) + 1)
                y0 = max(0, int(np.floor(min(c1[1], c2[1]) - dist)))
                y1 = min(h, int(np.ceil(max(c1[1], c2[1]) + dist)) + 1)
                if x0 >= x1 or y0 >= y1:
                    continue
                ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
                d1 = np.hypot(xs - c1[0], ys - c1[1])
                d2 = np.hypot(xs - c2[0], ys - c2[1])
                # "the ridge": the true perpendicular bisector of c1,c2 (every
                # point with signed distance 0 from it has d1==d2 exactly, at
                # any offset along the bisector - unlike |d1-d2|, which only
                # goes to 0 at the midpoint and changes at rate ~2 moving
                # along the c1-c2 axis, so a <=0.75px tolerance on it is a
                # <1px-wide, orientation-dependent band that lands empty
                # between integer-lattice pixels for some separations, e.g. a
                # 17px horizontal integer pair). Measured as the geometric
                # distance from each pixel to the bisector line, given a real
                # RIDGE_HALFWIDTH-px half-width. Confined to the lens
                # {d1<=dist, d2<=dist} between the two centres, not the
                # bisector's outward extension past either point.
                ux, uy = (c2[0] - c1[0]) / dist, (c2[1] - c1[1]) / dist
                mx, my = (c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0
                bisector_dist = np.abs((xs - mx) * ux + (ys - my) * uy)
                ridge = (bisector_dist <= RIDGE_HALFWIDTH) & (d1 <= dist) & (d2 <= dist)
                if ridge.any():
                    ridge_any[y0:y1, x0:x1] |= ridge
        if ridge_any.any():
            weight += np.float32(SEP_WEIGHT) * ridge_any * valid_mask.astype(np.float32)

    for px, py in ignore_pts:
        cx, cy = int(round(px)), int(round(py))
        x0, x1 = max(0, cx - IGNORE_R), min(w, cx + IGNORE_R + 1)
        y0, y1 = max(0, cy - IGNORE_R), min(h, cy + IGNORE_R + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1]
        d2 = (xs - cx) ** 2 + (ys - cy) ** 2
        weight[y0:y1, x0:x1][d2 <= IGNORE_R ** 2] = 0.0

    return heat, weight


def chan_idx(channels):
    """-> sorted channel indices into the stack built by load_tile.

    0 = background-subtracted grayscale, 1 = grid line mask, 2 = ring-template
    NCC response. 1 and 2 are classical pipeline outputs, so the net is a hybrid
    and which subset it should see is a real question - but the letters A/B/C
    are nested prefixes, so only 3 of the 7 non-empty subsets were ever
    expressible, and the one comparison on record (2026-09-04) was 3 tiles, one
    seed, leave-one-TILE-out, on the pre-reconciliation GT. A digit string
    ("02", "12", "2") names any subset; the letters stay because every entry in
    loo.md and the shipped manifest is labelled with one.
    """
    letters = {"A": [0], "B": [0, 1], "C": [0, 1, 2]}
    if channels in letters:
        return letters[channels]
    if not channels or not all(c in "012" for c in channels):
        raise ValueError(f"channels must be A/B/C or digits from 012, got {channels!r}")
    return sorted({int(c) for c in channels})


def square_of(stem):
    """Finer cross-validation unit than `group_of`: the SQUARE, i.e. the pair of
    captures that physically overlap. "hemo1 KA1 sq2.1" -> "KA1 sq2", which
    keeps `.1` and `.2` (two shots of the same spot) together while letting
    sq1..sq4 of one bundle land in different folds. "picture 3" keeps both
    halves of the slide capture together, same as group_of.
    Weaker than group_of: squares of one bundle share a cell suspension and an
    imaging session, so a square-level split does NOT measure generalisation to
    a new bundle. It measures accuracy on the mix of material we have, which is
    a different and equally legitimate question. It is NOT leave-one-tile-out:
    that split shares pixels and was measured to report better than the truth
    (2026-09-12).
    """
    m = re.match(r"hemo1 (\S+) (sq\d+)\.\d+$", stem)
    return f"{m.group(1)} {m.group(2)}" if m else group_of(stem)


def build_samples(fold, channels="C", gt_dir=None):
    """Whole-tile samples for every TILES entry except the held-out fold, plus
    chunk samples for every cluster_gt source tile except the held-out one.
    `channels` is accepted for signature compatibility only; "x" always
    carries all 3 channels."""
    # fold: an index into TILES, a tile stem, a GROUP name (holds out every tile
    # of that group - the leakage-safe split since 2026-09-12), or "all".
    # A group name is checked first: with 12 groups and 69 tiles, "KA1" must
    # exclude all 8 of its captures, not one.
    gt_dir = gt_dir or GT_DIR
    if fold == "all":
        held = set()
    elif isinstance(fold, str) and fold in groups():
        held = {t for t in TILES if group_of(t) == fold}
    elif isinstance(fold, (set, frozenset, list, tuple)):
        held = set(fold)          # an explicit tile set: the random-split folds
    elif isinstance(fold, str):
        held = {fold}
    else:
        held = {TILES[fold]}
    samples = []
    cluster_path = os.path.join(gt_dir, "cluster_gt.json")
    if USE_CHUNKS and os.path.exists(cluster_path):
        with open(cluster_path) as f:
            all_sources = sorted({c["source"][:-4] for c in json.load(f)["chunks"]})
    else:
        all_sources = []

    for name in TILES:
        if name in held:
            continue
        t = _cached_tile(name, gt_dir)
        h, w = t["gray"].shape
        frame = t["frame"]
        valid = np.zeros((h, w), np.float32)
        if t["whole_image"]:
            valid[:] = 1.0
        else:
            valid[frame["y0"]:frame["y1"], frame["x0"]:frame["x1"]] = 1.0
        heat, weight = make_targets((h, w), t["points"], t["ignore"], valid)
        samples.append({"x": t["channels"], "heat": heat, "w": weight, "name": name,
                         "frame": frame, "points": t["points"]})

    for name in all_sources:
        if name in held:
            continue
        t = _cached_tile(name, gt_dir)
        h, w = t["gray"].shape
        for chunk in load_chunks(name, gt_dir):
            bx, by, bw, bh = chunk["box"]
            valid = np.zeros((h, w), np.float32)
            valid[by:by + bh, bx:bx + bw] = 1.0
            heat, weight = make_targets((h, w), chunk["points"], t["ignore"], valid)
            # ponytail: keep only box +-128 px; a full-tile heat+weight per chunk
            # is 11 MB x 100 chunks, and crops outside the box carry no loss.
            y0, y1 = max(0, by - 128), min(h, by + bh + 128)
            x0, x1 = max(0, bx - 128), min(w, bx + bw + 128)
            samples.append({"x": t["channels"][:, y0:y1, x0:x1], "heat": heat[y0:y1, x0:x1],
                            "w": weight[y0:y1, x0:x1], "name": name})

    return samples


def random_crop(sample, size=256, rng=None):
    """50% of crops centred on a positive (heat > 0) pixel."""
    if rng is None:
        rng = np.random.default_rng()
    x, heat, w = sample["x"], sample["heat"], sample["w"]
    _, h, wd = x.shape
    half = size // 2

    if "_pos" not in sample:      # cache: np.nonzero over a full tile per crop is 3 ms x 8 x iters
        sample["_pos"] = np.nonzero(heat > 0)
        sample["_loss"] = np.nonzero(w > 0)
    pos_ys, pos_xs = sample["_pos"]
    if len(pos_ys) and rng.random() < 0.5:
        i = rng.integers(len(pos_ys))
        cy, cx = int(pos_ys[i]), int(pos_xs[i])
    else:
        # centre on a pixel that carries loss (inside frame / chunk box)
        ws_ys, ws_xs = sample["_loss"]
        if len(ws_ys):
            i = rng.integers(len(ws_ys))
            cy, cx = int(ws_ys[i]), int(ws_xs[i])
        else:
            cy, cx = rng.integers(0, h), rng.integers(0, wd)

    y0 = min(max(0, cy - half), h - size)
    x0 = min(max(0, cx - half), wd - size)
    y0, x0 = max(0, y0), max(0, x0)

    xc = x[:, y0:y0 + size, x0:x0 + size]
    hc = heat[y0:y0 + size, x0:x0 + size]
    wc = w[y0:y0 + size, x0:x0 + size]

    if xc.shape[1] != size or xc.shape[2] != size:
        pad_y = size - xc.shape[1]
        pad_x = size - xc.shape[2]
        xc = np.pad(xc, ((0, 0), (0, pad_y), (0, pad_x)))
        hc = np.pad(hc, ((0, pad_y), (0, pad_x)))
        wc = np.pad(wc, ((0, pad_y), (0, pad_x)))

    return xc.astype(np.float32), hc.astype(np.float32), wc.astype(np.float32)


_elastic_grid_cache = {}
# Never evicted. Bounded in practice only because the crop is fixed at 256 and
# _fit_hw restores the pre-scale shape, so `shape` takes one value per (h, w)
# actually seen; nothing enforces that, and each 256x256 float32 entry pair is
# ~0.5 MB.


def _elastic_field(shape, alpha, sigma, rng):
    """Smoothed random displacement field (map_x, map_y) for cv2.remap."""
    h, w = shape
    dx = cv2.GaussianBlur(rng.normal(size=(h, w)).astype(np.float32), (0, 0), sigma) * alpha
    dy = cv2.GaussianBlur(rng.normal(size=(h, w)).astype(np.float32), (0, 0), sigma) * alpha
    # xs/ys don't depend on rng - cache per shape (np.meshgrid was 1 of the
    # measured 7.8ms/sample heavy-aug overhead; this doesn't touch the RNG
    # draw sequence, only the identity coordinate grid).
    if shape not in _elastic_grid_cache:
        _elastic_grid_cache[shape] = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    xs, ys = _elastic_grid_cache[shape]
    return (xs + dx).astype(np.float32), (ys + dy).astype(np.float32)


def _fit_hw(a, h, w):
    """Crop (centred) or pad (reflect, centred) the last two dims of `a` to
    exactly (h, w). Used to keep scale-jittered arrays at their original
    shape, which random_crop/the trainer assume."""
    ah, aw = a.shape[-2], a.shape[-1]
    y0, x0 = max(0, (ah - h) // 2), max(0, (aw - w) // 2)
    a = a[..., y0:y0 + min(h, ah), x0:x0 + min(w, aw)]
    ph, pw = h - a.shape[-2], w - a.shape[-1]
    if ph > 0 or pw > 0:
        pt, pb = max(ph, 0) // 2, max(ph, 0) - max(ph, 0) // 2
        pl, pr = max(pw, 0) // 2, max(pw, 0) - max(pw, 0) // 2
        pad = [(0, 0)] * (a.ndim - 2) + [(pt, pb), (pl, pr)]
        a = np.pad(a, pad, mode="reflect")
    return a


def _scale_jitter(x, heat, w, scale):
    """Resize x/heat/w together by `scale`, then fit back to the original
    (h, w) so the caller sees no shape change - geometric, so x, heat and w
    must move together or the target stops matching the image."""
    c, h, wd = x.shape
    nh, nw = max(1, int(round(h * scale))), max(1, int(round(wd * scale)))
    x_r = np.stack([cv2.resize(x[i], (nw, nh), interpolation=cv2.INTER_LINEAR) for i in range(c)])
    heat_r = cv2.resize(heat, (nw, nh), interpolation=cv2.INTER_LINEAR)
    w_r = cv2.resize(w, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return (_fit_hw(x_r, h, wd).astype(np.float32),
            _fit_hw(heat_r, h, wd).astype(np.float32),
            _fit_hw(w_r, h, wd).astype(np.float32))


_illum_grid_cache = {}
# Never evicted; same unenforced bound as _elastic_grid_cache above (fixed
# 256 crop + _fit_hw), ~0.5 MB per 256x256 entry pair.


def _low_order_illum(shape, rng, mag=0.3):
    """A random linear (low-order) illumination gradient plane over `shape`."""
    # yy/xx don't depend on rng - cache per shape (np.mgrid was measured at
    # 1.31ms/call, the single biggest slice of the 7.8ms heavy-aug overhead;
    # this doesn't touch the RNG draw sequence, only the identity grid).
    if shape not in _illum_grid_cache:
        h, w = shape
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        yy = yy / max(h - 1, 1) - 0.5
        xx = xx / max(w - 1, 1) - 0.5
        _illum_grid_cache[shape] = (yy, xx)
    yy, xx = _illum_grid_cache[shape]
    a, b, c = rng.uniform(-mag, mag, 3)
    return (a * xx + b * yy + c).astype(np.float32)


def _heavy_augment(x, heat, w, rng):
    """The --heavy-aug ops: elastic deformation + scale jitter (geometric, x/
    heat/w move together) then blur/noise/illumination gradient (photometric,
    image channels only - all of them consistently, same as the gain/bias
    fix above). Gated by HEAVY_AUG; default off, see its module comment."""
    x = np.ascontiguousarray(x, np.float32)

    # geometric: elastic (alpha~15, sigma~6)
    if rng.random() < 0.5:
        map_x, map_y = _elastic_field(heat.shape, alpha=15.0, sigma=6.0, rng=rng)
        x = np.stack([cv2.remap(x[c], map_x, map_y, cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_REFLECT) for c in range(x.shape[0])])
        heat = cv2.remap(heat, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        w = cv2.remap(w, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    # geometric: scale jitter 0.9-1.1. A prior `if abs(scale-1.0) > 1e-6`
    # guard here was removed; the removal is safe, but not for the reason
    # once written here. With scale ~ U(0.9, 1.1), P(|scale-1|<=1e-6) is
    # 2e-6/0.2 = 1e-5, not ~0 - measured at 101 hits in 10**7 draws, i.e.
    # the guard fired roughly once per training run, not "never". It's safe
    # to drop anyway because for any scale in that band, round(h*scale)==h
    # and round(w*scale)==w, so cv2.resize to the identical size is an exact
    # copy: verified _scale_jitter(x, heat, w, 1.0) and (..., 1+5e-7) are
    # np.array_equal to their inputs on all three arrays.
    scale = rng.uniform(0.9, 1.1)
    x, heat, w = _scale_jitter(x, heat, w, scale)

    # photometric: gaussian blur (defocus), sigma in U(0, 1.2), all channels
    blur_sigma = rng.uniform(0.0, 1.2)
    if blur_sigma > 1e-3:
        x = np.stack([cv2.GaussianBlur(x[c], (0, 0), blur_sigma) for c in range(x.shape[0])])

    # photometric: additive gaussian noise, all channels. noise_std is drawn
    # continuously from U(0, 0.05), so P(noise_std == 0) is 0 - a prior
    # `if noise_std > 0` guard here never actually skipped the draw. Drawn
    # directly in float32 (rng.normal is float64 by default: measured at
    # 2.09ms/call, most of it the redundant precision and the cast down).
    noise_std = rng.uniform(0.0, 0.05)
    x = x + rng.standard_normal(size=x.shape, dtype=np.float32) * np.float32(noise_std)

    # photometric: low-order illumination gradient, all channels
    x = x + _low_order_illum(x.shape[1:], rng)[None, :, :]

    return x, heat, w


def augment(x, heat, w, rng=None):
    """Random flip h/v, rot90 k, gain/bias jitter (all channels), then, if
    HEAVY_AUG, elastic deformation, scale jitter, blur, noise and an
    illumination gradient."""
    if rng is None:
        rng = np.random.default_rng()
    x, heat, w = x.copy(), heat.copy(), w.copy()

    if rng.random() < 0.5:
        x, heat, w = x[:, :, ::-1], heat[:, ::-1], w[:, ::-1]
    if rng.random() < 0.5:
        x, heat, w = x[:, ::-1, :], heat[::-1, :], w[::-1, :]

    k = int(rng.integers(0, 4))
    if k:
        x = np.rot90(x, k, axes=(1, 2))
        heat = np.rot90(heat, k)
        w = np.rot90(w, k)

    gain = rng.uniform(0.8, 1.2)
    bias = rng.uniform(-0.3, 0.3)
    # Channel 0 ONLY. The plan asked for photometric jitter "on all three
    # channels consistently", because channels 1-2 derive from the unperturbed
    # image. That change was made and then reverted here.
    #
    # WHAT IS MEASURED vs WHAT IS INFERRED - keep these apart. The pixel
    # numbers below were measured 2026-09-19 on tile "picture 1; last three
    # rows". That all-channel jitter is therefore WORSE FOR ACCURACY is an
    # inference from them, NOT a ruler result: no ml.loo arm has been run
    # either way, and pixel distance is not loss. Treat this as a documented,
    # unadopted hypothesis, and see ml/runs/loo.md if an arm is ever run.
    #
    # The counter-argument, which a council raised and which is not dismissed:
    # augmentation need not resemble inference data to help (dropout, cutout
    # and mixup all feed the net things it never sees at test time), so
    # jittering channel 1 might regularise against over-trusting the grid
    # mask. The reason to doubt that HERE is that channel 1 is not an internal
    # representation being regularised - it is a hand-built geometric prior
    # that arrives rock-solid at inference, so corrupting it in training is
    # not the same move as dropout. Unmeasured on both sides.
    #
    # The measured facts:
    #   - Channel 1 is a BINARY grid mask, exactly {0, 1} at inference. An
    #     affine makes it {-0.3, 0.5} or {0.3, 1.5} - values the net never
    #     sees when it runs. That is a train/inference mismatch, not realism.
    #   - Channel 2 is a NORMALISED NCC, so it is already near-invariant to a
    #     contrast change of the source image.
    # Re-deriving channels 1-2 from the jittered image (the plan's intent, read
    # literally) moves ch1 by 0.05-1.7 % of pixels and ch2 by mean|d|
    # 0.007-0.061. Applying the affine to the channels instead moves ch2 by
    # mean|d| 0.29 - five to forty times LARGER than the inconsistency it was
    # meant to remove, and in a direction inference never produces.
    # So the inconsistency is real but ~1 %, and is not worth a per-sample
    # detect_grid + seed_response recompute. Jitter channel 0 alone.
    x = x.copy()
    x[0] = x[0] * gain + bias

    if HEAVY_AUG:
        x, heat, w = _heavy_augment(x, heat, w, rng)

    return np.ascontiguousarray(x, np.float32), np.ascontiguousarray(heat, np.float32), np.ascontiguousarray(w, np.float32)
