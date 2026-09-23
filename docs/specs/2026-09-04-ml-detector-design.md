# ML cell detector — design (2026-09-04)

## Goal
A learned point detector for 10x EVOS hemocytometer tiles, trained on the existing
hand annotations, measured with the same ruler as the classical engine (`score.py`,
Hungarian, 13.2 px, inside triple frame). It replaces the classical engine only if
leave-one-tile-out (LOO) numbers beat it: per-tile |err| worst < 2.1 %, F1 > 0.892.
Otherwise it ships opt-in (`engine=ml`) or not at all. No accuracy claim without
`python score.py` output.

## What stays classical (deterministic geometry, already correct)
`detect_grid`, `triple_frame`, stitching, `per_square_counts`, autocrop, hand-painted
regions. The ML model answers one question: where are the cell centres.

## What the model replaces
`seed_response → seed_points → rim_points/faint_points → apply_clusters → line gate →
focus gate`. Edge margin and triple-frame filter still apply after it.

## Input representation (the "which stage" question)
The painted-line image (`paint_lines`) loses information; grid detection itself is
better expressed as a *channel*, not a preprocessing step. Channels, ablated by LOO:
- A: gray (bg-normalised: `(gray - bg) / 32`, clipped)
- B: A + `line_mask` (0/1)
- C: B + classical NCC `seed_response` (already a strong matched-filter prior)
Ship the best by LOO worst-tile error; ties break toward fewer channels.

## Model
U-Net, 3 levels, 16/32/64 channels (~0.3 M params), fully convolutional. Target =
Gaussian heatmap σ = 4 px at every GT point (dia 22). Loss = MSE, pixel-weighted:
positive discs ×5, ignore zones ×0. Train on random 256² crops with flips / 90°
rotations / mild intensity jitter. Peak-pick: `peak_local_max` min_distance 8 px,
threshold tuned on the training folds only.

## Ground truth handling
- `samples-new_gt/<tile>.json`: solid points, all scored. Only 3 tiles.
- `<tile>.candidates.json` `pale` lists: UNREVIEWED pipeline detections. Never
  positives. Loss ignore-disc (r 13 px) around each, so the net is not taught that
  an unannotated real cell is background (38 % of classical FPs were exactly that).
- `cluster_gt.json`: 100 chunks, 948 points, 5 tiles. Points are box-relative.
  Loss only inside the box; outside is ignored.
- Outside the triple frame: ignored (GT stops there).

## Splits
LOO over the 3 annotated tiles. A held-out tile's chunks are excluded from training
too (chunks from picture 3 first rows leak into fold 3 otherwise). Chunks from the 2
un-annotated tiles are always training data. Final shipped weights train on all.

## Deployment
Train: torch (CPU is fine at this size; GPU if present). Export ONNX; runtime
`onnxruntime` added to `requirements.txt` (~15 MB, no torch in the release zip).
Weights at `ml/weights/cellnet.onnx`, checked in. `count_cells(..., params={"engine": 1})`
runs the ML seeds; stages panel shows the heatmap. Full-image inference on CPU
must stay under ~3 s.

## Files
```
ml/data.py     GT loading, channel builder, crop sampler, ignore masks
ml/model.py    U-Net + heatmap → points
ml/train.py    --fold {1,2,3,all} --channels {A,B,C}; writes ml/runs/<name>.pt + onnx
ml/infer.py    onnxruntime wrapper used by pipeline.py
tests/test_ml.py  shape / peak-pick / ignore-mask self-checks (no training)
score.py       skip GTs without "points" (cluster_gt.json crashes it today);
               --params '{"engine":1}' scores the ML path
```

## Accountability
- The GT is the ceiling. The ML cannot be shown better than the annotator. Step one
  after training: run the model on the 2 un-annotated tiles and the 3 candidates
  lists, dump JSON for `tools/annotate.html`, and the user reviews them. More
  reviewed tiles beat any architecture change.
- Every number in the report is LOO. Numbers from training-set tiles are not reported.
