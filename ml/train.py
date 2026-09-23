"""Trainer CLI for the U-Net cell detector.

python -m ml.train --fold 0 --channels C --iters 3000 --out ml/runs/f0C
"""
import argparse
import json
import os
import time

import numpy as np
import torch

from ml import data
from ml.model import UNet, export_onnx
from ml.peaks import heat_to_points
from score import inside_frame, match


def pick_threshold(model, samples, channels):
    """Sweep thr 0.10..0.90 step 0.05, maximise pooled F1 over whole-tile
    samples (those carrying "frame"/"points"), score.match at 13.2 px inside frame."""
    tiles = [s for s in samples if "frame" in s]
    if not tiles:
        return 0.5
    idx = data.chan_idx(channels)
    model.eval()
    preds = []
    with torch.no_grad():
        for s in tiles:
            x = torch.from_numpy(s["x"][idx]).unsqueeze(0).float()
            heat = model(x)[0, 0].numpy()
            gt = inside_frame(s["points"], s["frame"])
            preds.append((heat, s["frame"], gt))

    best_thr, best_f1 = 0.5, -1.0
    for thr in np.arange(0.10, 0.90 + 1e-9, 0.05):
        tp = fp = fn = 0
        for heat, frame, gt in preds:
            pts = np.array(heat_to_points(heat, float(thr)), float).reshape(-1, 2)
            pts = inside_frame(pts, frame)
            pairs = match(pts, gt, 13.2)
            tp += len(pairs)
            fp += len(pts) - len(pairs)
            fn += len(gt) - len(pairs)
        f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 0.0
        if f1 > best_f1:
            best_f1, best_thr = f1, float(thr)
    return best_thr


def train(fold, channels, iters, out, batch=8, lr=1e-3, seed=0, base=16,
          pick_thr=True, amp=False, ema=0.0, levels=3):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    os.cpu_count() and torch.set_num_threads(os.cpu_count())

    samples = data.build_samples(fold, channels)
    # Draw whole tiles and chunk crops 50/50. Uniform draws gave the 2 whole
    # tiles ~2.5 % of crops against ~80 chunks, starving the background
    # negatives where the classical engine's false positives live.
    whole = [s for s in samples if "frame" in s]
    chunks = [s for s in samples if "frame" not in s]
    whole, chunks = whole or chunks, chunks or whole
    idx = data.chan_idx(channels)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    net = UNet(len(idx), base, levels).to(dev)
    # amp: bf16 autocast + NHWC + cudnn autotune. Measured 2026-09-14 on the
    # 4070 after the laptop power profile was raised: 0.038 -> 0.023 s/iter
    # sustained. Only the convolutions run in bf16; `pred - h` promotes back to
    # fp32 (h and w are fp32), so the weighted-MSE reduction keeps full
    # precision. Off by default - it is scored as a sweep variable like any
    # other, never adopted on a speed argument alone.
    amp = amp and dev == "cuda"
    if amp:
        torch.backends.cudnn.benchmark = True
        net = net.to(memory_format=torch.channels_last)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=iters)

    # Measured 2026-09-14 on the 69-tile set (RTX 4070): CUDA is async, so the
    # ~28 ms of numpy crop/augment for batch i+1 already overlaps the ~40 ms GPU
    # step of batch i - inline 0.043 s/iter against 0.040 with no prep at all.
    # A prefetch thread was tried and is a pessimisation (0.064 s/iter): the main
    # thread's kernel launches and the producer's numpy fight over the GIL.
    # pin_memory + non_blocking H2D is what keeps the copy off the critical path.

    # ema: an exponential moving average of the weights, exported instead of the
    # last iterate. Cosine LR already anneals, but the last step still lands
    # wherever its batch pushed it; the average of the tail is the cheap,
    # standard way to stop paying for that draw. Off by default, swept like any
    # other variable (plan 2026-09-14 Track C3).
    shadow = {k: v.detach().clone().float() for k, v in net.state_dict().items()} if ema else None

    t0 = time.time()
    net.train()
    for it in range(iters):
        xs, hs, ws = [], [], []
        for _ in range(batch):
            pool = whole if rng.random() < 0.5 else chunks
            s = pool[rng.integers(len(pool))]
            xc, hc, wc = data.random_crop(s, 256, rng)
            xc, hc, wc = data.augment(xc, hc, wc, rng)
            xs.append(xc[idx]); hs.append(hc); ws.append(wc)
        x = torch.from_numpy(np.stack(xs)).pin_memory().to(dev, non_blocking=True)
        if amp:
            x = x.to(memory_format=torch.channels_last)
        h = torch.from_numpy(np.stack(hs)).unsqueeze(1).pin_memory().to(dev, non_blocking=True)
        w = torch.from_numpy(np.stack(ws)).unsqueeze(1).pin_memory().to(dev, non_blocking=True)

        with torch.autocast("cuda", torch.bfloat16, enabled=amp):
            pred = net(x)
        loss = ((pred.float() - h) ** 2 * w).sum() / w.sum()

        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()

        if shadow is not None:
            # Warm up the decay so the first iterations are not dominated by the
            # random init they start from.
            d = min(ema, (1 + it) / (10 + it))
            with torch.no_grad():
                for k, v in net.state_dict().items():
                    shadow[k].mul_(d).add_(v.detach().float(), alpha=1 - d)

        if it % 500 == 0:
            print(f"iter {it} loss {float(loss):.5f}", flush=True)

    print(f"trained {iters} iters in {time.time() - t0:.1f}s on {dev}", flush=True)

    if shadow is not None:
        net.load_state_dict({k: v.to(p.dtype) for (k, v), p
                             in zip(shadow.items(), net.state_dict().values())})

    net = net.to(memory_format=torch.contiguous_format).cpu()
    # ml/loo.py re-picks the threshold per inference mode with its own pick_thr
    # (ensemble/TTA averaging lowers peak heights), and throws this one away -
    # 62 CPU full-tile forwards x 17 thresholds per training, for nothing.
    thr = pick_threshold(net, samples, channels) if pick_thr else 0.5

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    torch.save(net.state_dict(), out + ".pt")
    export_onnx(net, len(idx), out + ".onnx")
    result = {"thr": thr, "channels": channels, "fold": fold, "iters": iters,
              "sigma": data.SIGMA, "base": base, "chunks": data.USE_CHUNKS, "amp": amp,
              "pos_weight": data.POS_WEIGHT, "sep_weight": data.SEP_WEIGHT, "sep_r": data.SEP_R,
              "ridge_halfwidth": data.RIDGE_HALFWIDTH, "heavy_aug": data.HEAVY_AUG,
              "ema": ema, "levels": levels}
    with open(out + ".json", "w") as f:
        json.dump(result, f)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fold", required=True)
    ap.add_argument("--channels", default="C")
    ap.add_argument("--iters", type=int, default=3000)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--sigma", type=float, help="override ml.data.SIGMA (target blob width)")
    ap.add_argument("--base", type=int, default=16, help="UNet base width")
    ap.add_argument("--pos-weight", type=float, help="override ml.data.POS_WEIGHT (loss weight on cells)")
    ap.add_argument("--sep-weight", type=float,
                    help="override ml.data.SEP_WEIGHT (loss weight on the ridge between "
                         "centres closer than ml.data.SEP_R px; 0/unset = off)")
    ap.add_argument("--no-chunks", action="store_true",
                    help="drop cluster_gt.json's chunk samples (they contradict the re-annotated tile GT)")
    ap.add_argument("--amp", action="store_true", help="bf16 autocast + channels_last (1.6x, different numerics)")
    ap.add_argument("--levels", type=int, default=3, help="UNet encoder depth")
    ap.add_argument("--ema", type=float, default=0.0, help="export an EMA of the weights at this decay (e.g. 0.999); 0 = off")
    ap.add_argument("--heavy-aug", action="store_true",
                    help="ml.data.HEAVY_AUG: elastic deformation, scale jitter, blur, noise "
                         "and an illumination gradient on top of the flip/rot/gain-bias base "
                         "augmentation. Off by default; scored as a sweep variable.")
    a = ap.parse_args()
    if a.sigma:
        data.SIGMA = a.sigma
    data.USE_CHUNKS = not a.no_chunks
    if a.pos_weight is not None:
        data.POS_WEIGHT = a.pos_weight
    if a.sep_weight is not None:
        data.SEP_WEIGHT = a.sep_weight
    if a.heavy_aug:
        data.HEAVY_AUG = True
    fold = int(a.fold) if a.fold.isdigit() else a.fold   # 0-4, "all", or a tile stem
    train(fold, a.channels, a.iters, a.out, a.batch, a.lr, a.seed, base=a.base,
          amp=a.amp, ema=a.ema, levels=a.levels)


if __name__ == "__main__":
    main()
