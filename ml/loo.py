"""Grouped cross-validation: hold out one GROUP of tiles, train on the rest
(+ every other tile's cluster chunks), score the held-out group's tiles with
score.py's ruler.

python -m ml.loo --channels C --iters 3000 --seeds 0 1 2
python -m ml.loo --folds 4 --seeds 0 1 2        # quick sweep, spread of groups
python -m ml.loo --final --seeds 0 1 2         # + the permanent test groups, once
Appends the tables to ml/runs/loo.md. The classical engine (engine 0) is
scored on the same tiles as the baseline row.

This was leave-one-TILE-out until 2026-09-12, which leaked: the `.1`/`.2`
captures of a pair overlap physically and `picture 3`'s two tiles are halves of
one slide, so a held-out tile had already been trained on through its sibling.
`data.group_of` defines the leakage-safe split; see its docstring.
"""
import argparse
import json
import os
import random
import shutil
import time

import cv2
import numpy as np

import pipeline
import score
from ml import data, infer, peaks, train
from ml.peaks import heat_to_points

RADIUS = 13.2
TIF = "data/tif"
GT = "data/gt"
# Permanent test groups (plan 2026-09-12): annotated last, excluded from every
# sweep, scored exactly once under --final. Threshold picking and every
# iters/sigma decision are made on the other groups, so these stay clean.
TEST_GROUPS = ("hgrc1", "ha2")


def score_tile(name, params, ml_weights=None, ml_tta=None, ml_thr=None):
    """One score.py row for one tile: (gt, det, tp, fp, fn, err%)."""
    gt, pale = score.load_gt(os.path.join(GT, name + ".json"))[1:]
    bgr = cv2.imread(os.path.join(TIF, name + ".tif"), cv2.IMREAD_COLOR)
    r = pipeline.count_cells(bgr, params, ml_weights=ml_weights, ml_tta=ml_tta, ml_thr=ml_thr)
    det = np.array(r["centers"], float).reshape(-1, 2)
    gt = score.inside_frame(gt, r["frame"])
    tp = len(score.match(det, gt, RADIUS))
    fp, fn = len(det) - tp, len(gt) - tp
    return len(gt), len(det), tp, fp, fn, 100.0 * (len(det) - len(gt)) / max(1, len(gt))


def pick_thr(weights, tta, channels, held_group, objective="f1", step=0.05,
              train_tiles=None):
    """Best pooled-F1 threshold for this exact inference mode, swept over the
    TRAINING tiles only. train.pick_threshold cannot do this: it sweeps one
    torch model with no TTA, and averaging heatmaps lowers peak heights, so an
    ensemble or a TTA average scored at a single model's threshold silently
    drops the marginal detections it was supposed to recover.
    """
    idx = data.chan_idx(channels)
    preds = []
    # This loop is the silent half of an eval mode: one full-tile forward per
    # TRAINING tile (~60 of them per fold, x8 again under TTA) before a single
    # score row is printed. Measured 2026-09-15: the 10-group CV went 23 min with
    # no output here, which reads as a stall on the dashboard. The scoring loop
    # below already prints every 10 tiles; this one has to as well.
    todo = train_tiles if train_tiles is not None else [
        n for n in data.TILES
        if data.group_of(n) != held_group and data.group_of(n) not in TEST_GROUPS]
    for i, name in enumerate(todo, 1):
        t = data._cached_tile(name)
        heat = infer.predict_stack(t["channels"][idx], weights, tta)
        preds.append((heat, score.inside_frame(t["points"], t["frame"]), t["frame"]))
        if i % 10 == 0 or i == len(todo):
            print(f"  thr sweep {held_group}{' +TTA' if tta else ''}: "
                  f"{i}/{len(todo)} train tiles", flush=True)

    # objective "f1": pooled F1, what train.pick_threshold uses.
    # objective "err": mean per-tile |count error|, which is the headline metric
    #   the project actually ships on. The two pick different thresholds - F1
    #   is indifferent to a FP and a FN cancelling, a count error is not.
    best_thr, best_score = 0.5, -1e9
    for thr in np.arange(0.10, 0.90 + 1e-9, step):
        tp = fp = fn = 0
        errs = []
        for heat, gt, frame in preds:
            pts = np.array(heat_to_points(heat, float(thr)), float).reshape(-1, 2)
            pts = score.inside_frame(pts, frame)
            n = len(score.match(pts, gt, RADIUS))
            tp += n; fp += len(pts) - n; fn += len(gt) - n
            errs.append(abs(len(pts) - len(gt)) / max(1, len(gt)))
        if objective == "err":
            val = -float(np.mean(errs))
        else:
            val = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 0.0
        if val > best_score:
            best_score, best_thr = val, float(thr)
    return best_thr


def fmt(rows, label):
    lines = [f"{label}", f"{'tile':44} {'gt':>4} {'det':>5} {'tp':>4} {'fp':>4} {'fn':>4} {'prec':>6} {'rec':>6} {'err%':>7}"]
    T = np.zeros(3)
    for name, (g, d, tp, fp, fn, err) in rows:
        lines.append(f"{name[:44]:44} {g:4d} {d:5d} {tp:4d} {fp:4d} {fn:4d} "
                     f"{tp / max(1, d):6.3f} {tp / max(1, g):6.3f} {err:7.1f}")
        T += (tp, fp, fn)
    tp, fp, fn = T
    f1 = 2 * tp / max(1, 2 * tp + fp + fn)
    worst = max(abs(e) for _, (*_, e) in rows)

    # per-group rollup: the pooled number hides a group regressing while the
    # rest improve, and "how does it do on a cell line it has never seen" is a
    # per-group question (plan 2026-09-12, Phase 4b.2).
    by = {}
    for name, (g_, d, tp_, fp_, fn_, err) in rows:
        grp = data.group_of(name)
        acc = by.setdefault(grp, [0, 0, 0, 0, 0, 0.0])
        acc[0] += g_; acc[1] += d; acc[2] += tp_; acc[3] += fp_; acc[4] += fn_
        acc[5] = max(acc[5], abs(err))
    if len(by) > 1:
        lines.append(f"{'per group':44} {'gt':>4} {'det':>5} {'tp':>4} {'fp':>4} {'fn':>4} "
                     f"{'F1':>6} {'worst|err|':>11}")
        for grp, (g_, d, tp_, fp_, fn_, w_) in by.items():
            gf1 = 2 * tp_ / max(1, 2 * tp_ + fp_ + fn_)
            lines.append(f"  {grp[:42]:42} {g_:4d} {d:5d} {tp_:4d} {fp_:4d} {fn_:4d} "
                         f"{gf1:6.3f} {w_:10.1f} %")
    # The error ladder. F1 and worst-|err| alone hid the finding that set the
    # 2026-09-14 agenda: the error is a BIAS, not noise - 42 of 53 tiles
    # over-counted, FP/FN 771/319, pooled +3.67 %. Mean per-tile |err| is the
    # headline the project ships on; "signed" is what says whether a change
    # fixed the bias or just traded FPs for FNs.
    errs = sorted(abs(e) for _, (*_, e) in rows)
    signed = [e for _, (*_, e) in rows]
    gt_all = sum(g_ for _, (g_, *_) in rows)
    det_all = sum(d for _, (_, d, *_) in rows)

    # Bundle-stratified reporting (audit-ml.md Tier 0, item 0b, 2026-09-18): the
    # plain "mean |err|" above is pooled over TILES, so an 8-tile hemo bundle
    # outweighs a 1-tile legacy one ~6x - that alone was the 2.20 vs 1.94 gap
    # measured by tools/fold_spread.py. The fold-level mean below weights every
    # BUNDLE equally instead, with its across-fold sd, and is the number a sweep
    # should be read on. ml.data.fold_level_mean_sd is the single definition
    # both this and tools/fold_spread.py use, so they cannot disagree.
    errs_by_fold = {}
    for name, (*_, e) in rows:
        errs_by_fold.setdefault(data.group_of(name), []).append(abs(e))
    fold_mean, fold_sd = data.fold_level_mean_sd(errs_by_fold)

    lines.append(
        f"F1 {f1:.3f}  mean |err| {np.mean(errs):.2f} %  median {np.median(errs):.2f} %  "
        f"p90 {errs[min(len(errs) - 1, int(0.9 * len(errs)))]:.2f} %  worst |err| {worst:.1f} %  "
        f"<=2% {100 * sum(e <= 2 for e in errs) / len(errs):.0f} %  "
        f"signed {np.mean(signed):+.2f} %  pooled {100 * (det_all - gt_all) / max(1, gt_all):+.2f} %")
    lines.append(
        f"[pooled-over-tiles |err| {np.mean(errs):.2f} %]  vs  "
        f"[bundle-fold mean {fold_mean:.2f} % sd {fold_sd:.2f} pp, unweighted over "
        f"{len(errs_by_fold)} fold(s)] <- read sweeps on THIS one")
    return "\n".join(lines), f1, worst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channels", nargs="+", default=["A", "B", "C"])
    ap.add_argument("--iters", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--seeds", type=int, nargs="+",
                    help="train one model per seed and also score their heatmap ensemble")
    ap.add_argument("--tta", action="store_true", help="also score with 8-fold dihedral TTA")
    ap.add_argument("--ensemble-only", action="store_true",
                    help="score only the ensemble mode, skipping the per-seed ones. With "
                         "--tta that is 2 modes instead of 8.")
    ap.add_argument("--skip-classical", action="store_true")
    ap.add_argument("--folds", type=int,
                    help="score only this many groups, spread evenly (quick sweeps)")
    ap.add_argument("--final", action="store_true",
                    help=f"also score the permanent test groups {TEST_GROUPS} - "
                         "run this once, at the end, never inside a sweep")
    ap.add_argument("--split", default="group", choices=["group", "square"],
                    help="group = hold out one bundle (generalisation to an "
                         "unseen bundle); square = random K-fold over capture "
                         "pairs, mixing bundles (accuracy on the material we have)")
    ap.add_argument("--split-seed", type=int, default=0,
                    help="which random square partition; change it to see how "
                         "much of a result is the draw")
    ap.add_argument("--thr-objective", default="f1", choices=["f1", "err"],
                    help="what the per-mode threshold sweep maximises on the training tiles")
    ap.add_argument("--reuse", action="store_true",
                    help="reuse ml/runs/_w<fold><ch>s<seed> weights if present instead of retraining")
    ap.add_argument("--note", default="", help="one-line label for this config, written into loo.md")
    ap.add_argument("--sigma", type=float, help="override ml.data.SIGMA (target blob width)")
    ap.add_argument("--base", type=int, default=16, help="UNet base width")
    ap.add_argument("--levels", type=int, default=3, help="UNet encoder depth")
    ap.add_argument("--amp", action="store_true",
                    help="bf16 autocast + channels_last training (1.6x; scored as a sweep variable)")
    ap.add_argument("--pos-weight", type=float, help="override ml.data.POS_WEIGHT (loss weight on cells)")
    ap.add_argument("--sep-weight", type=float,
                    help="override ml.data.SEP_WEIGHT (loss weight on the ridge between "
                         "centres closer than ml.data.SEP_R px; 0/unset = off)")
    ap.add_argument("--heavy-aug", action="store_true",
                    help="ml.data.HEAVY_AUG: elastic deformation, scale jitter, blur, noise "
                         "and an illumination gradient on top of the flip/rot/gain-bias base "
                         "augmentation. Off by default; scored as a sweep variable.")
    ap.add_argument("--ema", type=float, default=0.0,
                    help="export an EMA of the weights at this decay (e.g. 0.999); 0 = off")
    ap.add_argument("--min-dist", type=int, help="override ml.peaks.MIN_DIST (NMS radius, px)")
    ap.add_argument("--crowd-b", type=float,
                    help="override ml.peaks.CROWD_B: a peak must clear thr + b*(neighbours "
                         "within --crowd-r). 0 is the plain global threshold.")
    ap.add_argument("--crowd-r", type=float, help="override ml.peaks.CROWD_R (crowding radius, px)")
    ap.add_argument("--thr-step", type=float, default=0.05,
                    help="threshold sweep grid; 0.05 is the historical grid, 0.01 is finer")
    ap.add_argument("--tag", default="",
                    help="suffix for ml/runs/_w<fold>... so two runs can train side by side")
    ap.add_argument("--no-chunks", action="store_true",
                    help="drop cluster_gt.json's chunk samples (annotated against the pre-44da00d tile GT)")
    a = ap.parse_args()
    if a.sigma:
        data.SIGMA = a.sigma
    data.USE_CHUNKS = not a.no_chunks
    if a.min_dist:
        peaks.MIN_DIST = a.min_dist
    if a.crowd_b is not None:
        peaks.CROWD_B = a.crowd_b
    if a.crowd_r is not None:
        peaks.CROWD_R = a.crowd_r
    if a.pos_weight is not None:
        data.POS_WEIGHT = a.pos_weight
    if a.sep_weight is not None:
        data.SEP_WEIGHT = a.sep_weight
    if a.heavy_aug:
        data.HEAVY_AUG = True
    seeds = a.seeds or [a.seed]
    os.makedirs("ml/runs", exist_ok=True)

    if a.split == "square":
        # Random K-fold over SQUARES, not tiles and not groups. A square is the
        # overlapping .1/.2 capture pair (data.square_of), so no fold shares
        # pixels with another - leave-one-TILE-out does, and was measured to
        # report better than the truth (2026-09-12). Every fold draws squares
        # from every bundle, so the test set looks like the whole dataset
        # instead of like one bundle; the price is that it no longer measures
        # generalisation to an unseen bundle, which is what the group split is
        # for. Both splits are real, they answer different questions.
        # TEST_GROUPS are NOT excluded here: mixing is the entire point, and
        # hgrc1/ha2 are spent as a held-out set anyway (2026-09-18).
        units = sorted({data.square_of(t) for t in data.TILES})
        random.Random(a.split_seed).shuffle(units)
        k = a.folds or 5
        part = [set(units[i::k]) for i in range(k)]
        folds = [f"rand{i}" for i in range(k)]
        tiles_of = {folds[i]: [t for t in data.TILES if data.square_of(t) in part[i]]
                    for i in range(k)}
        held_of = {g: set(tiles_of[g]) for g in folds}
        train_of = {g: [t for t in data.TILES if t not in held_of[g]] for g in folds}
    else:
        folds = data.groups()
        if not a.final:
            folds = [g for g in folds if g not in TEST_GROUPS]
        if a.folds and a.folds < len(folds):
            step = len(folds) / a.folds        # spread, not the first N: the first
            folds = [folds[int(i * step)] for i in range(a.folds)]   # 4 would be all-old
        tiles_of = {g: [t for t in data.TILES if data.group_of(t) == g] for g in folds}
        held_of = {g: g for g in folds}        # build_samples takes the group name
        train_of = {g: None for g in folds}    # pick_thr keeps its own filter
    print(f"{len(folds)} folds: " + ", ".join(f"{g}({len(tiles_of[g])})" for g in folds), flush=True)
    print(f"config: iters {a.iters}, sigma {data.SIGMA}, base {a.base}x{a.levels}L, "
          f"chunks {'on' if data.USE_CHUNKS else 'off'}, amp {a.amp}, gt {data.GT_DIR}, "
          f"pos_w {data.POS_WEIGHT}, sep_w {data.SEP_WEIGHT}@{data.SEP_R}px/hw{data.RIDGE_HALFWIDTH}, heavy_aug {data.HEAVY_AUG}, ema {a.ema}, min_dist {peaks.MIN_DIST}, crowd {peaks.CROWD_B}@{peaks.CROWD_R}px, thr obj {a.thr_objective} step {a.thr_step}, "
          f"{len(data.TILES)} tiles, seeds {seeds}", flush=True)

    out = []
    if not a.skip_classical:
        base = [(n, score_tile(n, {"engine": 0})) for g in folds for n in tiles_of[g]]
        out.append(fmt(base, "classical (engine 0)")[0])
        print(out[-1], flush=True)

    for ch in a.channels:
        # Train every (fold, seed) once, into its own weights dir, so the eval
        # modes below all read the same models instead of retraining per mode.
        wpaths = {}
        for g in folds:
            for seed in seeds:
                tag = f"{g.replace(' ', '_')}{ch}s{seed}{a.tag}"
                stem = f"ml/runs/f{tag}"
                wdir = f"ml/runs/_w{tag}"
                onnx = os.path.join(wdir, "cellnet.onnx")
                wpaths[(g, seed)] = onnx
                if a.reuse and os.path.exists(onnx):
                    print(f"  fold {g} {ch} seed {seed}: reusing {onnx}")
                    continue
                t0 = time.time()
                res = train.train(held_of[g], ch, a.iters, stem, seed=seed, base=a.base,
                                  pick_thr=False,   # loo re-picks per mode below
                                  amp=a.amp, ema=a.ema, levels=a.levels)
                os.makedirs(wdir, exist_ok=True)
                shutil.copy(stem + ".onnx", onnx)
                shutil.copy(stem + ".json", os.path.join(wdir, "cellnet.json"))
                print(f"  fold {g} {ch} seed {seed}: trained in {time.time() - t0:.0f} s", flush=True)

        modes = [(f"seed {s}", [s]) for s in seeds]
        if len(seeds) > 1:
            modes.append((f"ensemble of seeds {seeds}", list(seeds)))
        if a.ensemble_only and len(seeds) > 1:
            # --tta wraps the whole mode list, so 3 seeds + ensemble becomes 8
            # modes and the TTA half costs 8x the per-tile inference. When the
            # question is only "what does the shipped top rung score", the single
            # seed modes are 6 of those 8 and answer nothing (2026-09-17).
            modes = modes[-1:]
        for tta in ([False, True] if a.tta else [False]):
            for label, use in modes:
                rows = []
                # pick_thr + this loop run silently for 10-20 min per mode (full
                # classical+ML pipeline over every tile at a fine thr grid; the
                # ensemble mode doubles the per-tile inference cost). A print
                # every 10 tiles is the difference between the dashboard showing
                # progress and looking dead for that whole window (2026-09-15).
                done = 0
                total = sum(len(tiles_of[g]) for g in folds)
                for g in folds:
                    w = [wpaths[(g, s)] for s in use]
                    thr = pick_thr(w, tta, ch, g, a.thr_objective, a.thr_step,
                                   train_of[g])
                    for name in tiles_of[g]:
                        rows.append((name, score_tile(name, {"engine": 1},
                                                       ml_weights=w, ml_tta=tta, ml_thr=thr)))
                        done += 1
                        if done % 10 == 0 or done == total:
                            print(f"  {label}: {done}/{total} tiles", flush=True)
                # --reuse never trains, so a.iters was not used and printing it
                # labels the table with a config that did not produce it (a reused
                # 8000-iter arm read "3000 iters" on 2026-09-15). Say so instead.
                iters_txt = "reused weights" if a.reuse else f"{a.iters} iters"
                tag = (f"ML channels {ch}, {len(folds)}-group CV, {iters_txt}, {label}"
                       + (" + TTA" if tta else "")
                       + f", thr obj {a.thr_objective}, min_dist {peaks.MIN_DIST}"
                       + (f", crowd {peaks.CROWD_B}@{peaks.CROWD_R}px"
                          if peaks.CROWD_B else ""))
                out.append(fmt(rows, tag)[0])
                print(out[-1], flush=True)

    with open("ml/runs/loo.md", "a") as f:
        head = f"\n## {time.strftime('%Y-%m-%d %H:%M')}"
        if a.note:
            head += f" - {a.note}"
        # The config belongs in the log, not in whoever remembers the command
        # line: loo.md is the only record that survives the run.
        head += (f"\n`iters {a.iters}, sigma {data.SIGMA}, base {a.base}x{a.levels}L, "
                 f"chunks {'on' if data.USE_CHUNKS else 'off'}, amp {a.amp}, "
                 f"pos_w {data.POS_WEIGHT}, sep_w {data.SEP_WEIGHT}@{data.SEP_R}px/hw{data.RIDGE_HALFWIDTH}, heavy_aug {data.HEAVY_AUG}, ema {a.ema}, min_dist {peaks.MIN_DIST}, crowd {peaks.CROWD_B}@{peaks.CROWD_R}px, thr obj {a.thr_objective} step {a.thr_step}, "
                 f"gt {data.GT_DIR}, {len(folds)} folds, seeds {seeds}`")
        f.write(head + "\n```text\n" + "\n\n".join(out) + "\n```\n")


if __name__ == "__main__":
    main()
