"""Sweep the decode stage - peak threshold x NMS radius - without retraining.

The decode is the only thing between a heatmap and a count: on the ML branch
`pipeline.count_cells` does `heat_to_points`, then the edge margin, then the
triple frame, and nothing else. So a heatmap computed once can be re-decoded for
free, and a grid of (threshold, min_dist) that would cost hours as one
`python -m ml.loo --reuse` run per point costs a single inference pass here.

Two facts make it cheap:

* `peak_local_max` is greedy in descending intensity, so the peaks surviving at
  threshold t are exactly the peaks surviving at the lowest threshold that are
  also >= t. One call per (tile, mode, min_dist) covers the whole threshold axis.
* Picking a threshold against mean per-tile |count error| needs only counts, not
  a Hungarian match. Matching runs once per winning config, on held-out tiles.

Reads the weights `ml.loo` leaves in ml/runs/_w<fold><ch>s<seed><tag>/, so run
`python -m ml.loo ... --tag <t>` first (or point --tag at an existing set).

    python tools/sweep_decode.py --tag ref --folds 4 --seeds 0 1 2
"""
import argparse
import os
import pickle
import sys

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pipeline          # noqa: E402
import score             # noqa: E402
from ml import data, infer, peaks    # noqa: E402
from ml.loo import RADIUS, TEST_GROUPS   # noqa: E402
from ml.peaks import peak_local_max      # noqa: E402

EDGE = int(pipeline.DEFAULTS["edge_margin"])
THR_LO = 0.10


def peaks_with_intensity(heat, min_dist):
    """[(x, y, intensity)] of every local maximum above THR_LO, sorted desc."""
    c = peak_local_max(heat, min_distance=min_dist, threshold_abs=THR_LO)
    if not len(c):
        return np.zeros((0, 3), np.float32)
    v = heat[c[:, 0], c[:, 1]]
    out = np.stack([c[:, 1], c[:, 0], v], 1).astype(np.float32)
    return out[np.argsort(-out[:, 2])]


def bg_contrast(gray, frame):
    """5th-95th percentile spread of raw intensity inside the frame - a cheap
    per-image background/contrast statistic computed straight from the tile,
    no model output needed, so it is identical whatever fold or seed asks for
    it."""
    sub = gray[frame["y0"]:frame["y1"], frame["x0"]:frame["x1"]] if frame else gray
    lo, hi = np.percentile(sub, [5, 95])
    return float(hi - lo)


def count_above(q, thr, b, r):
    """Count of peaks in q ([x,y,intensity] rows) that clear thr + b*crowd."""
    if b == 0.0:
        return int((q[:, 2] >= thr).sum())
    ref = q[q[:, 2] >= peaks.CROWD_FLOOR][:, :2]
    if len(ref) < 2:
        nb_n = np.zeros(len(q))
    else:
        nb_n = cKDTree(ref).query_ball_point(q[:, :2], r, return_length=True).astype(float)
        nb_n = nb_n - (q[:, 2] >= peaks.CROWD_FLOOR)
    return int((q[:, 2] >= thr + b * nb_n).sum())


def det_above(q, thr, b, r):
    """Kept [x, y] points that clear thr + b*crowd."""
    if b == 0.0:
        return q[q[:, 2] >= thr][:, :2]
    ref = q[q[:, 2] >= peaks.CROWD_FLOOR][:, :2]
    if len(ref) < 2:
        nb_n = np.zeros(len(q))
    else:
        nb_n = cKDTree(ref).query_ball_point(q[:, :2], r, return_length=True).astype(float)
        nb_n = nb_n - (q[:, 2] >= peaks.CROWD_FLOOR)
    return q[q[:, 2] >= thr + b * nb_n][:, :2]


def optimal_tile_thr(q, n_gt, grid, b, r):
    """The grid threshold minimizing this SINGLE tile's own |count error|."""
    n_gt = max(1, n_gt)
    cnt = np.array([count_above(q, th, b, r) for th in grid], float)
    rel = np.abs(cnt - n_gt) / n_gt
    return float(grid[int(np.argmin(rel))])


def fit_thr_line(xs, ys):
    """1-degree fit of per-tile-optimal thr against a statistic. Falls back to
    a constant (the mean) when the training tiles carry no spread in the
    statistic, rather than fitting a slope to noise. Takes plain xs/ys arrays
    only - the caller decides what tiles feed them, so this function has no
    way to know or care whether a tile is held-out."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    if len(np.unique(xs)) < 2:
        return 0.0, float(np.mean(ys))
    b1, b0 = (float(v) for v in np.polyfit(xs, ys, 1))
    return b1, b0


def keep(pk, frame, shape):
    """Everything pipeline.count_cells applies after heat_to_points."""
    h, w = shape
    if not len(pk):
        return pk
    x, y = pk[:, 0], pk[:, 1]
    m = (x >= EDGE) & (x < w - EDGE) & (y >= EDGE) & (y < h - EDGE)
    if frame:
        m &= (x >= frame["x0"]) & (x < frame["x1"]) & (y >= frame["y0"]) & (y < frame["y1"])
    return pk[m]


def ladder(errs):
    e = sorted(abs(v) for v in errs)
    return (float(np.mean(e)), float(np.median(e)),
            e[min(len(e) - 1, int(0.9 * len(e)))], max(e),
            100.0 * sum(v <= 2 for v in e) / len(e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="", help="suffix of the ml/runs/_w... weight dirs")
    ap.add_argument("--channels", default="C")
    ap.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    ap.add_argument("--folds", type=int, default=4)
    ap.add_argument("--min-dist", type=int, nargs="+", default=[4, 5, 6, 7, 8])
    ap.add_argument("--thr-step", type=float, default=0.01)
    ap.add_argument("--cache", help="pickle of peak lists; written if absent, read if present. "
                                    "Peaks are all any decode objective needs, so a cached "
                                    "run re-answers 'which threshold rule' in seconds.")
    ap.add_argument("--crowd-b", type=float, nargs="+", default=[0.0],
                    help="grid for ml.peaks CROWD_B: a peak must clear thr + b*(neighbours "
                         "within crowd_r). [0.0] alone is the plain global threshold.")
    ap.add_argument("--crowd-r", type=float, nargs="+", default=[30.0],
                    help="grid for the crowding radius in px. Fitted per fold on TRAINING "
                         "tiles alongside thr and b - comparing radii on the held-out tiles "
                         "would be selecting a hyper-parameter on the test set.")
    ap.add_argument("--objective", default="err", choices=["err", "median", "pooled"],
                    help="what the per-fold threshold is picked on, over the TRAINING tiles: "
                         "err = mean per-tile |count error| (the headline), "
                         "median = median per-tile |count error| (ignores the tail), "
                         "pooled = |sum(det) - sum(gt)| (zeroes the aggregate bias only)")
    ap.add_argument("--adaptive-thr", choices=["mass", "peak", "bg"],
                    help="predict each tile's decode threshold from a per-image statistic "
                         "instead of using one constant per fold: 'mass' = mean heatmap mass "
                         "inside the frame, 'peak' = median kept-peak height, 'bg' = raw-pixel "
                         "background contrast (5th-95th percentile spread, frame-only, needs "
                         "no model). A 1-degree fit of per-tile-optimal thr vs the statistic "
                         "is done PER FOLD on that fold's TRAINING tiles only, then applied to "
                         "its held-out tiles - see the adaptive-thr block below for why this "
                         "cannot leak.")
    a = ap.parse_args()

    ch, seeds = a.channels, a.seeds
    idx = data.chan_idx(ch)
    grid = np.arange(THR_LO, 0.90 + 1e-9, a.thr_step)

    folds = [g for g in data.groups() if g not in TEST_GROUPS]
    if a.folds and a.folds < len(folds):
        step = len(folds) / a.folds
        folds = [folds[int(i * step)] for i in range(a.folds)]
    tiles = [t for t in data.TILES if data.group_of(t) not in TEST_GROUPS]
    print(f"{len(folds)} folds: {', '.join(folds)}   {len(tiles)} tiles, "
          f"min_dist {a.min_dist}, thr {THR_LO}..0.90 step {a.thr_step}", flush=True)

    modes = [(f"seed {s}", [s]) for s in seeds]
    if len(seeds) > 1:
        modes.append((f"ensemble {seeds}", list(seeds)))

    # pk[(fold, mode, min_dist, tile)] -> kept peaks, gt[tile] -> in-frame GT
    # stat_mass[(fold, mode, tile)] -> mean in-frame heatmap intensity, the
    # 'mass' adaptive-thr statistic (mode-dependent: different seeds/ensembles
    # predict different heatmaps for the same tile).
    pk, gt, mass, stat_mass = {}, {}, {}, {}
    if a.cache and os.path.exists(a.cache):
        with open(a.cache, "rb") as f:
            loaded = pickle.load(f)
        if len(loaded) == 4:
            gt, mass, pk, stat_mass = loaded
        else:
            gt, mass, pk = loaded  # older 3-tuple cache: no stat_mass in it
        print(f"loaded {len(pk)} peak lists from {a.cache}", flush=True)
        _skip_inference = True
    else:
        _skip_inference = False
    for g in [] if _skip_inference else folds:
        w = {s: f"ml/runs/_w{g.replace(' ', '_')}{ch}s{s}{a.tag}/cellnet.onnx" for s in seeds}
        missing = [p for p in w.values() if not os.path.exists(p)]
        if missing:
            raise SystemExit(f"missing weights for fold {g}: {missing[0]}")
        for i, name in enumerate(tiles):
            t = data._cached_tile(name)
            gt[name] = score.inside_frame(t["points"], t["frame"])
            heats = {s: infer.predict_stack(t["channels"][idx], [w[s]], False) for s in seeds}
            for label, use in modes:
                h = heats[use[0]] if len(use) == 1 else np.mean([heats[s] for s in use], 0)
                # The heatmap's mass inside the frame, in units of one cell: each
                # GT point stamps a Gaussian of unit peak, so its integral is
                # 2*pi*sigma^2. That makes sum(heat)/(2 pi sigma^2) a count
                # estimate that never picks a peak - the density-regression
                # reading of the same network, free, for comparison against the
                # detection count (plan 2026-09-14 Track C2).
                f = t["frame"]
                sub = h[f["y0"]:f["y1"], f["x0"]:f["x1"]] if f else h
                mass[(g, label, name)] = float(sub.sum()) / (2 * np.pi * data.SIGMA ** 2)
                stat_mass[(g, label, name)] = float(sub.mean())
                for md in a.min_dist:
                    pk[(g, label, md, name)] = keep(peaks_with_intensity(h, md),
                                                    t["frame"], t["gray"].shape)
            if (i + 1) % 10 == 0:
                print(f"  {g}: {i + 1}/{len(tiles)} tiles", flush=True)

    if a.cache and not _skip_inference:
        # pickle, not npz: savez turns every key into a zip entry NAME, and the
        # composite keys here need a separator that survives that. They do not.
        with open(a.cache, "wb") as f:
            pickle.dump((gt, mass, pk, stat_mass), f, protocol=4)
        print(f"cached {len(pk)} peak lists to {a.cache}", flush=True)

    # Threshold picked on the fold's TRAINING tiles, scored on its held tiles -
    # the same train/held split ml.loo uses, so the numbers are comparable.
    # thr/b/r are the MEAN of the per-fold picks, never a value the grid was
    # asked for - reading them as "the chosen radius" put a wrong note in
    # loo.md on 2026-09-17 ("r 30 -> 28" when 28 was not in that run's grid).
    # The +- columns are the sd across folds: one shipped constant is only as
    # trustworthy as that spread is small.
    print(f"\n{'mode':16} {'md':>3} {'thr':>5} {'+-':>4} {'b':>6} {'+-':>5} {'r':>4} {'+-':>3} "
          f"{'mean':>6} {'med':>6} {'p90':>6} "
          f"{'worst':>6} {'<=2%':>5} {'signed':>7} {'F1':>6}")
    best = None
    for label, _ in modes:
        for md in a.min_dist:
            # Crowding per peak: neighbours within crowd_r among peaks above the
            # floor, built once per (mode, min_dist) so the (thr, b) search below
            # is pure arithmetic. Mirrors ml.peaks.heat_to_points exactly.
            nb = {}
            for g in folds:
                for n in tiles:
                    q = pk[(g, label, md, n)]
                    ref = q[q[:, 2] >= peaks.CROWD_FLOOR][:, :2]
                    for r in a.crowd_r:
                        if len(ref) < 2:
                            nb[(g, n, r)] = np.zeros(len(q))
                        else:
                            c = cKDTree(ref).query_ball_point(q[:, :2], r,
                                                              return_length=True).astype(float)
                            nb[(g, n, r)] = c - (q[:, 2] >= peaks.CROWD_FLOOR)
            thrs, bees, rads, errs_all, rows = [], [], [], [], []
            for g in folds:
                train_t = [n for n in tiles if data.group_of(n) != g]
                held_t = [n for n in tiles if data.group_of(n) == g]
                ngt = np.array([max(1, len(gt[n])) for n in train_t], float)[:, None]
                pick = None
                for r in a.crowd_r:
                    for b in a.crowd_b:
                        if b == 0.0 and r != a.crowd_r[0]:
                            continue       # the radius is meaningless when b is 0
                        cnt = np.array([[(pk[(g, label, md, n)][:, 2]
                                          >= th + b * nb[(g, n, r)]).sum()
                                         for th in grid] for n in train_t], float)
                        rel = np.abs(cnt - ngt) / ngt
                        if a.objective == "median":
                            obj = np.median(rel, 0)
                        elif a.objective == "pooled":
                            obj = np.abs(cnt.sum(0) - ngt.sum()) / ngt.sum()
                        else:
                            obj = np.mean(rel, 0)
                        i = int(np.argmin(obj))
                        if pick is None or obj[i] < pick[0]:
                            pick = (float(obj[i]), float(grid[i]), float(b), float(r))
                _, thr, b, r = pick
                thrs.append(thr); bees.append(b); rads.append(r)
                for n in held_t:
                    q = pk[(g, label, md, n)]
                    det = q[q[:, 2] >= thr + b * nb[(g, n, r)]][:, :2]
                    n_gt = len(gt[n])
                    tp = len(score.match(det, gt[n], RADIUS))
                    errs_all.append(100.0 * (len(det) - n_gt) / max(1, n_gt))
                    rows.append((tp, len(det) - tp, n_gt - tp))
            tp = sum(r[0] for r in rows); fp = sum(r[1] for r in rows); fn = sum(r[2] for r in rows)
            f1 = 2 * tp / max(1, 2 * tp + fp + fn)
            mean, med, p90, worst, pct2 = ladder(errs_all)
            print(f"{label:16} {md:3d} {np.mean(thrs):5.2f} {np.std(thrs):4.2f} "
                  f"{np.mean(bees):6.3f} {np.std(bees):5.3f} "
                  f"{np.mean(rads):4.0f} {np.std(rads):3.0f} {mean:6.2f} "
                  f"{med:6.2f} {p90:6.2f} {worst:6.1f} {pct2:5.0f} "
                  f"{np.mean(errs_all):+7.2f} {f1:6.3f}", flush=True)
            if best is None or mean < best[0]:
                best = (mean, label, md, float(np.mean(thrs)), f1, float(np.mean(bees)), float(np.mean(rads)))
    print(f"\nbest: {best[1]}, min_dist {best[2]}, thr ~{best[3]:.2f} + {best[5]:.3f}*crowd"
          f"(r {best[6]:.0f}) -> mean |err| {best[0]:.2f} %, F1 {best[4]:.3f}")

    # Counting by heatmap mass instead of by peaks. One scale factor per fold,
    # fitted on that fold's TRAINING tiles, applied to its held-out tiles - if
    # this beats the peak count, the detector's localisation is costing accuracy
    # that a density reading of the same network does not pay.
    if mass:
        print(f"\nmass count (sum heat / 2*pi*sigma^2, one fitted scale per fold)")
        print(f"{'mode':16} {'scale':>6} {'mean':>6} {'med':>6} {'p90':>6} {'worst':>6} {'<=2%':>5} {'signed':>7}")
        for label, _ in modes:
            errs = []
            for g in folds:
                tr = [n for n in tiles if data.group_of(n) != g]
                k = (sum(len(gt[n]) for n in tr) /
                     max(1e-9, sum(mass[(g, label, n)] for n in tr)))
                for n in tiles:
                    if data.group_of(n) != g:
                        continue
                    ng = max(1, len(gt[n]))
                    errs.append(100.0 * (k * mass[(g, label, n)] - ng) / ng)
            mean, med, p90, worst, pct2 = ladder(errs)
            print(f"{label:16} {k:6.3f} {mean:6.2f} {med:6.2f} {p90:6.2f} {worst:6.1f} "
                  f"{pct2:5.0f} {np.mean(errs):+7.2f}", flush=True)

    # Adaptive threshold: predict each tile's decode thr from a per-image
    # statistic instead of shipping one constant per fold. crowd_b/r are held
    # at the caller's first grid value throughout - this flag studies the thr
    # axis only, same as the "thrs" column above studies the constant case.
    #
    # LEAKAGE GUARD, made structural rather than a rule to remember: `xs, ys`
    # (the regression inputs) are built ONLY from `train_t` inside the `for n
    # in train_t` loop below, and `b0, b1` are frozen (np.polyfit returns
    # plain floats) before the `for n in held_t` loop that reads them ever
    # runs. A held-out tile's statistic or optimal thr is never appended to
    # xs/ys, never seen by polyfit, and the fitted (b0, b1) cannot change
    # after that point - so held-out data has no path, direct or indirect,
    # into its own fold's fitted rule. tests/tools/test_sweep_decode.py checks this by
    # constructing a fold whose held-out tiles have an extreme statistic and
    # asserting the fitted slope/intercept are unaffected by it.
    if a.adaptive_thr:
        stat_name = a.adaptive_thr
        stat_bg_cache = {}

        def get_stat(g, label, md, n):
            if stat_name == "mass":
                return stat_mass[(g, label, n)]
            if stat_name == "peak":
                q = pk[(g, label, md, n)]
                return float(np.median(q[:, 2])) if len(q) else 0.0
            # "bg": pure raw-pixel statistic, independent of fold/model, so
            # it is computed once per tile name and cached.
            if n not in stat_bg_cache:
                t = data._cached_tile(n)
                stat_bg_cache[n] = bg_contrast(t["gray"], t["frame"])
            return stat_bg_cache[n]

        b_fixed, r_fixed = a.crowd_b[0], a.crowd_r[0]
        print(f"\nadaptive thr on '{stat_name}' (thr = b0 + b1*stat, fit per fold on "
              f"TRAINING tiles only; crowd b={b_fixed} r={r_fixed} fixed)")
        print(f"{'mode':16} {'md':>3} {'b1':>9} {'+-':>7} {'b0':>6} {'+-':>5} "
              f"{'mean':>6} {'med':>6} {'p90':>6} {'worst':>6} {'<=2%':>5} {'signed':>7} {'F1':>6}")
        for label, _ in modes:
            for md in a.min_dist:
                errs_all, rows, slopes, intercepts = [], [], [], []
                for g in folds:
                    train_t = [n for n in tiles if data.group_of(n) != g]
                    held_t = [n for n in tiles if data.group_of(n) == g]

                    # --- fit: TRAINING tiles of this fold only. xs/ys are
                    # built exclusively from train_t; held_t is not in scope
                    # in this loop at all. ---
                    xs, ys = [], []
                    for n in train_t:
                        q = pk[(g, label, md, n)]
                        xs.append(get_stat(g, label, md, n))
                        ys.append(optimal_tile_thr(q, len(gt[n]), grid, b_fixed, r_fixed))
                    b1, b0 = fit_thr_line(xs, ys)
                    slopes.append(b1); intercepts.append(b0)

                    # --- apply: this fold's HELD-OUT tiles only, using the
                    # (b0, b1) already frozen above; nothing here can feed
                    # back into the fit. ---
                    for n in held_t:
                        thr = float(np.clip(b0 + b1 * get_stat(g, label, md, n),
                                            THR_LO, grid[-1]))
                        q = pk[(g, label, md, n)]
                        det = det_above(q, thr, b_fixed, r_fixed)
                        n_gt = len(gt[n])
                        tp = len(score.match(det, gt[n], RADIUS))
                        errs_all.append(100.0 * (len(det) - n_gt) / max(1, n_gt))
                        rows.append((tp, len(det) - tp, n_gt - tp))
                tp = sum(r[0] for r in rows); fp = sum(r[1] for r in rows); fn = sum(r[2] for r in rows)
                f1 = 2 * tp / max(1, 2 * tp + fp + fn)
                mean, med, p90, worst, pct2 = ladder(errs_all)
                print(f"{label:16} {md:3d} {np.mean(slopes):+9.4f} {np.std(slopes):7.4f} "
                      f"{np.mean(intercepts):6.2f} {np.std(intercepts):5.2f} {mean:6.2f} "
                      f"{med:6.2f} {p90:6.2f} {worst:6.1f} {pct2:5.0f} "
                      f"{np.mean(errs_all):+7.2f} {f1:6.3f}", flush=True)


if __name__ == "__main__":
    main()
