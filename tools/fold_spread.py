import os, pickle, numpy as np, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scipy.spatial import cKDTree
from ml import data, peaks

gt, _, pk = pickle.load(open("ml/runs/b_decode_newgt_b24.pkl", "rb"))
tiles = sorted(gt)
folds = sorted({data.group_of(t) for t in tiles})
label, md = "ensemble [0, 1, 2]", 6
GRID = np.arange(0.10, 0.90 + 1e-9, 0.01)
CB, CR = [0.0, 0.018, 0.020, 0.023, 0.026], [28.0, 30.0, 32.0]

nb = {}
for g in folds:
    for n in tiles:
        q = pk[(g, label, md, n)]
        ref = q[q[:, 2] >= peaks.CROWD_FLOOR][:, :2]
        for r in CR:
            nb[(g, n, r)] = (np.zeros(len(q)) if len(ref) < 2 else
                cKDTree(ref).query_ball_point(q[:, :2], r, return_length=True).astype(float)
                - (q[:, 2] >= peaks.CROWD_FLOOR))

per_fold = {}
for g in folds:
    train_t = [n for n in tiles if data.group_of(n) != g]
    held_t = [n for n in tiles if data.group_of(n) == g]
    ngt = np.array([max(1, len(gt[n])) for n in train_t], float)[:, None]
    pick = None
    for r in CR:
        for b in CB:
            if b == 0.0 and r != CR[0]:
                continue
            cnt = np.array([[(pk[(g, label, md, n)][:, 2] >= th + b * nb[(g, n, r)]).sum()
                             for th in GRID] for n in train_t], float)
            obj = np.mean(np.abs(cnt - ngt) / ngt, 0)
            i = int(np.argmin(obj))
            if pick is None or obj[i] < pick[0]:
                pick = (float(obj[i]), float(GRID[i]), float(b), float(r))
    _, thr, b, r = pick
    errs = []
    for n in held_t:
        q = pk[(g, label, md, n)]
        det = int((q[:, 2] >= thr + b * nb[(g, n, r)]).sum())
        errs.append(100.0 * abs(det - len(gt[n])) / max(1, len(gt[n])))
    per_fold[g] = (float(np.mean(errs)), len(held_t), thr, b, r)

print(f"{'fold':12} {'n':>3} {'mean|err|':>10}   thr     b    r")
for g in folds:
    m, n, thr, b, r = per_fold[g]
    print(f"{g:12} {n:>3} {m:>9.2f} %  {thr:.2f} {b:.3f} {r:.0f}")
ms = np.array([per_fold[g][0] for g in folds])
ns = np.array([per_fold[g][1] for g in folds])
print(f"\npooled per-tile mean  {float(np.average(ms, weights=ns)):.2f} %")
# ml.data.fold_level_mean_sd is the single definition of "fold-level mean, sd"
# shared with ml/loo.py's fmt() (task C5, 2026-09-19), so the two tools cannot
# disagree on this number. Each fold here already collapsed to one mean per
# fold (per_fold[g][0]), so feed each fold as a length-1 list.
fold_mean, sd = data.fold_level_mean_sd({g: [per_fold[g][0]] for g in folds})
se = sd / np.sqrt(len(ms))
print(f"fold-level mean       {fold_mean:.2f} %  sd {sd:.2f}  se {se:.2f}")
print(f"95% CI (fold mean)    {ms.mean()-1.96*se:.2f} .. {ms.mean()+1.96*se:.2f} %")
hemo = [g for g in folds if not g.startswith("picture")]
hm = np.array([per_fold[g][0] for g in hemo])
print(f"hemo bundles only     {hm.mean():.2f} %  sd {hm.std(ddof=1):.2f}  (n={len(hemo)})")
