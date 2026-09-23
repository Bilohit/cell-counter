# Accuracy evidence and measurement history

Moved out of README.md on 2026-09-18, verbatim, when the README was rewritten for
lab users rather than developers. Nothing here was edited; some measurements
predate later ground-truth revisions and are marked in place or superseded by
`ml/runs/loo.md`, which is the running experiment log.

Read `ml/runs/loo.md` for anything after 2026-09-17. The build-by-build ledger is
local only (`ml/runs/comparison.html`, written by `tools/make_comparison_page.py`,
not published).

---

## Accuracy (EVOS 10x tiles)

The table below is the **classical engine** (`engine` 0). The default engine since
2026-09-04 is the ML detector; its leave-one-tile-out numbers are in the next section.

> **This table is against a superseded ruler.** It was measured on three tiles before the
> two later GT passes (whole-tile review 2026-09-04, clump reconciliation the same day).
> Against the current five-tile GT the classical engine scores **F1 0.872, worst tile
> 19.8 %** - it did not get worse, the ruler gained 80 clump cells it was never finding and
> was previously not charged for. The rows below are kept because the tuning history in this
> section refers to them; for a current classical number use the ML section's table.

Measured 2026-09-02 with `python score.py` against the three hand-annotated tiles in
`data/gt/`. A detection counts as a hit if it lands within 13.2 px of a ground-truth
point — an absolute radius, so tuning `diameter` cannot move the ruler — matched one-to-one with
optimal (Hungarian) assignment. Ground-truth points outside the triple-line frame are not scored,
because the app does not count there either; that drops 11–14 % of each file (46 of 337 points on
tile 1, 57 of 498 on tile 2, 29 of 251 on tile 3), leaving 954 scored cells.

```text
image                                          gt pale   det   tp  ptp   fp   fn   prec    rec    err%
10x tile picture 1; last three rows.tif       289    0   283  254    0   29   35  0.898  0.879    -2.1
10x tile picture 2; first three rows.tif      439    0   436  403    0   33   36  0.924  0.918    -0.7
10x tile picture 3; first three rows.tif      219    0   222  185    0   37   34  0.833  0.845     1.4
TOTAL precision 0.895 recall 0.889 F1 0.892
```

Re-measured 2026-09-03 on the same three tiles; the grid-selection fix that landed on
2026-09-02 moved the scored region slightly, which is why the `gt` column differs from the
2026-09-02 run (0.889 / 0.878, F1 0.884, worst tile 4.5 %). Worst tile is now 2.1 %.

**Per-tile count error is the headline, not F1.** False positives and negatives cancel about
99 % when pooled, so a pooled count error is meaningless. Worst tile: 2.1 %.

Session history, all measured: P 0.839 / R 0.838 at the start, 0.843 / 0.842 after the matcher
was fixed, 0.846 / 0.866 after the grid-line paint fix, 0.886 / 0.856 after the line gate and
focus gate, 0.889 / 0.878 after the triple-line boundary — which is measured on a smaller,
honest region, so it is not directly comparable to the rows before it.

### ML detector (default since 2026-09-04, retrained 2026-09-16)

`engine` 1 replaces the seeder, the rim/faint passes, the cluster pass and the line/focus
gates with a U-Net (`ml/`) that regresses a centre heatmap from three channels: the
background-normalised image, the grid-line mask and the classical NCC response. Grid
detection, the triple frame, stitching and the per-square tally are unchanged. It ships as
a **3-model deep ensemble** - three models trained from different random starts, averaged
in heatmap space (`ml/weights/cellnet*.onnx`, 4.2 MB each; `cellnet.json` names them and
carries each quality level's own threshold). It runs on `onnxruntime` on CPU; torch is
needed only to train (`requirements-train.txt`).

**The 2026-09-16 retrain.** Ground truth went from 5 tiles to **69** with the hemo run 1
merge, which changed what the ruler can measure. Multiple tiles now come from the same
capture, so leave-one-*tile*-out leaks: a held-out tile's neighbours, sharing illumination
and cell population, sit in the training set. `ml/loo.py` is now **grouped** cross
validation - it holds out a whole capture group at a time (`data.group_of`), which is the
only honest split for this data.

The shipped model is base 24 (up from 16), 8000 iterations (up from 3000), seeds 0/1/2.

#### The numbers, and which one is the accuracy claim

Two groups, `hgrc1` and `ha2`, were declared a **permanent held-out test set**
(`TEST_GROUPS` in `ml/loo.py`), unreachable without `--final`. They were touched exactly
once, at the end of the session, after the configuration was frozen. That single
measurement is the accuracy claim:

```text
2026-09-17, boundary GT, decode frozen and committed before the test set was seen
                             mean |err|   F1     signed
held out only (16 tiles)        1.91 %   -       +1.58 %   <- the accuracy number
  seed 0 / 1 / 2              2.22 / 1.71 / 2.02 %
all 12 groups (context)         2.38 %   0.969   +1.47 %
```

**Read the first row, not the second.** `--final` does not score only the test groups: it
adds `hgrc1` and `ha2` as two more folds and prints a 12-group CV, which pools the groups
everything was tuned on with the two that were not. The accuracy claim is the 16 held-out
tiles alone - median 1.95 %, worst tile 4.5 %.

The earlier claim on this line was **2.55 %**, and it was the 12-group figure, so the
like-for-like comparison is 2.55 % -> 2.38 %. Both moved for two reasons at once and
neither is a clean A/B: the ground truth was re-annotated on 2026-09-17 (the boundary
pass, +394 points), and the decode was refit on it. The one clean, single-ruler comparison
is grouped CV on the 10 non-test groups: **2.23 % -> 2.00 %**.

The weights did not change. Retraining on the new ground truth was measured and **lost**
(2.17 % against 2.00 %, losing on the ensemble and on every seed), so the whole gain is
the annotation pass plus a refitted decode. `ml/runs/loo.md` carries both runs.

`hgrc1` and `ha2` are now **spent**: they were scored once on the old ground truth and once
here. They cannot referee another round, and further tuning has no clean ruler left.

#### Selection overfitting, measured

An architecture screen over 4 capture groups picked base 24 at **1.94 %**. The same
configuration on the full 10 groups scored **2.23 %**. The 0.3 pp gap is not noise - it is
the cost of having chosen the architecture by looking at held-out scores. Screening
numbers are recorded in `ml/runs/loo.md` as screens, never quoted as accuracy.

For the same reason the shipped model is the **ensemble**, not seed 1, even though seed 1
scored 2.22 % against the ensemble's 2.23 % on the 10-group run. Picking the best seed off
a held-out table is the identical mistake at a smaller scale, and 0.01 pp is nothing
against ~2.6 pp of seed noise.

#### Overtraining: tested, absent

8000 iterations against 3000, base 24, identical decode, full 10-group CV:

```text
iters   seed 0   seed 1   seed 2   ensemble
3000    3.66 %   3.69 %   3.35 %    3.48 %
8000    2.90 %   2.92 %   2.72 %    2.69 %
```

Shorter training loses on every seed and on the ensemble. The long run is learning, not
memorising. 8000 kept.

#### Crowding-adaptive decode

A peak must clear `thr + b x n`, where `n` counts peaks within `crowd_r` px of it
(`ml/peaks.py`). Dense regions demand more confidence; sparse regions are unaffected, and
`b = 0` restores a plain global threshold exactly.

`b` and `r` **must be fitted per fold on training tiles**. Fitting one global `b` on four
easy groups and applying it to all ten produced 2.69 % and a +1.56 % over-count; refitting
per fold on the same models gave 2.23 % and a signed -0.41 %. The failure was the fitting
protocol, not the decode.

Two findings worth keeping:

- **Crowding decode and network capacity are substitutes, not complements.** Each alone
  helps; together they mostly recover the same errors.
- **Ensembling only pays at base 24.** Base-16 seeds make correlated errors, so averaging
  them buys close to nothing.

#### Quality levels

Each rung carries **its own `(thr, crowd_b)` pair** in `ml/weights/cellnet.json`, picked
through that rung's own inference path by `tools/pick_ensemble_thr.py` (`--tta` for level
4). Averaging heatmaps lowers peak heights, so a level's threshold is not transferable -
re-pick every rung whenever the models change.

```text
level                        thr   crowd_b   training-tile |err|   pooled F1   s/tile
1  classical + cluster pass    -      -           (see above)        0.872      0.9
2  one model                 0.59   0.020          1.60 %           0.9733      1.0
3  three models  (default)   0.58   0.020          1.37 %           0.9747      2.6
4  three models + 8-fold TTA 0.57   0.020          1.43 %           0.9764     12.6
```

**Those three percentages are training-tile numbers, not accuracy** - the shipped models
trained on all 69 tiles. They are listed because they are what the picker optimised; the
accuracy figure is 1.91 %.

Re-picked 2026-09-17 on the boundary ground truth. All three levels landed on the same
crowd_b, 0.020, and `crowd_r` stays 30: the grouped-CV per-fold fit averaged 0.024 @ 29 px
with a tight spread (b sd 0.004, r sd 4 px), so 29 is inside the noise and moving it would
not be evidence-backed. Seconds per tile measured on a 24-core laptop, CPU inference:
level 4 is 4.7x level 3 for ~0.3 pp, which is why the default rung stays 3.

Level 4's advantage is not believed to generalise: on held-out folds TTA *lost*, 2.92 %
with against 2.79 % without, for 8x the compute. It stays wired as the user-chosen slow
rung, unchanged.

**Base 24 costs speed.** Level 3 went 2.0 s -> 6.6 s per tile and level 4 7.4 s -> 32.5 s
(desktop CPU, 1360x1024, end to end) for the wider network. Accuracy beats speed in this
project, but level 4 is now slow enough that a batch of 30 fields is a ~16 minute wait.
#### Where the remaining error is

The error is **systematically positive**: signed +1.65 %, and 20 of the 22 worst tiles are
over-counts. Per-group F1 on the final run:

```text
hgrc1 0.983   ha2 0.977   HNT 0.976   KA1 0.973   KA2 0.960   ha1 0.982
picture 1-4 0.946-0.956   KGN 0.942   KNT 0.941
```

`KNT` and `KGN` carry the error, and density does not explain it - `KNT sq2.1` (293 GT) and
`ha1 sq2.2` (266 GT) are comparably crowded yet differ by 0.04 F1. Count tables cannot
distinguish a model that invents cells from ground truth that under-annotates pale ones,
and `data/gt` is known to under-annotate pale cells. `ml/runs/review_knt_kgn.html`
(`ml.dump_candidates` + `ml.make_review`) renders those tiles for human arbitration. **That
question is open and is not resolvable from the numbers alone.**

Earlier finding, still standing: the cells missed inside clumps are **merged, not faint**.
Two touching cells make one heatmap peak and no threshold splits one peak into two - which
is why `min_dist` 8 -> 6 helped and why lowering the threshold locally does not.

#### Input format: TIF, PNG, and bit depth (2026-09-16)

The plan called for an 8-bit vs 16-bit comparison. **It cannot be run: no 16-bit data
exists.** Every tile in `data/tif` and `data/png` is `uint8` - the EVOS exports 8-bit - and
upcasting adds no information. `tools/depth_compare.py` answers the two questions that can
be answered, at quality level 3 over all 69 tiles:

```text
tif vs png                identical on 69/69 tiles, mean |delta| 0.00 cells, pooled +0.00 %
tif vs 16-bit round-trip  identical on 69/69 tiles, mean |delta| 0.00 cells, pooled +0.00 %
```

Not "close" - **bit-identical counts on every tile**. A user may supply the `.tif` or its
`.png` export and get the same number, and the normalisation path is exact through a
16-bit round-trip. If a real 16-bit capture ever arrives, re-run this tool; the claim above
covers 8-bit sources only.

#### Rules

- The ML ruler is `python -m ml.loo`, never `score.py`. `python score.py` at defaults
  scores weights trained on every tile: a training-set number, never an accuracy claim.
- Worst per-tile |err| from one seed decides nothing (~2.6 pp of pure seed noise). Run
  `--seeds 0 1 2` and require the win on every seed.
- Re-pick every level's `(thr, crowd_b)` with `tools/pick_ensemble_thr.py` whenever the
  shipped models change.
- Append every configuration to `ml/runs/loo.md` with its `--note`, kept or dropped.
- Never reuse the test groups for tuning. They are spent once, at the end.

Channel ablation on the old three-tile GT (seed 0): image only F1 0.934 / worst 3.8 %;
+ line mask 0.931 / 3.2 %; + NCC response 0.935 / 2.1 % (shipped). Of the 26 processing
sliders, 12 provably cannot change the ML result (pushed to their extremes the output is
byte-identical): `open_iter`, `fill_holes`, `ncc_thr`, `ncc_thr2`, `focus_min`, `rim_min`,
`min_area_frac`, `line_gate`, `grid_edge_margin`, `triple_min_w`, `cluster_on`,
`cluster_min`.

### Cluster reprocessing (augment, tuned on hand-annotated clusters)

`cluster_on` turns on a second pass over fused clumps. After the whole-image seeds are found,
every connected component holding at least `cluster_min` seeds (default 2, no UI slider) - plus
any region the user paints by hand - gets an extra look. The second pass **augments, never
replaces**: every first-pass seed survives, and the pass only adds ring-template NCC peaks that
clear a lowered threshold (`CLUSTER_AUG_NCC` = 0.60 × `ncc_thr`), sit inside the region's cell
mask, and land at least `CLUSTER_AUG_KEEP` = 0.7 × diameter from every existing seed.

That design came from `cluster_gt.json` - 100 cluster chunks (948 cells) hand-annotated in
`tools/annotate_clusters.html` (built by `tools/make_cluster_chunks.py`), scored by
`tools/tune_clusters.py` with score.py's Hungarian matcher. Measured 2026-09-04 on that GT:

```text
strategy (inside clusters only)          prec    rec     F1   bias cells/chunk
first pass untouched                    0.881  0.799  0.838        -0.89
budget-matched NCC sweep (old recut)    0.575  0.730  0.643        (replace)
best fixed NCC combo, no budget         0.682  0.624  0.652        (replace)
Otsu + distance watershed               0.501  0.229  0.314        (replace)
augment (shipped)                       0.850  0.819  0.834        -0.35
```

Every replace-the-seeds strategy lost to the untouched first pass - the whole-image mask and
seeder are already the best splitter on real clumps - but the first pass undercounts inside
them by ~0.9 cells per chunk. Augmenting recovers most of that without giving up F1.

On the three whole-tile GTs, `python score.py --params '{"cluster_on": 1}'` now reads per-tile
err +0.3 / −0.5 / +9.6 %, F1 0.890 (baseline off: −2.1 / −0.7 / +1.4, F1 0.892). The old
replace-based recut scored F1 0.768 with err −8.7 / −10.0 / −10.5 on the same run. Tile 3's
+9.6 % is where the standing caveat bites: the whole-tile GT under-annotates clumps, so added
pale seeds score as false positives there. Tune the cluster pass against `cluster_gt.json`
(re-annotate with `tools/annotate_clusters.html` as needed), never against the whole-tile GTs.

Hand-painted regions rebuild the mask from the crop's own Otsu split (the whole-image threshold
found nothing there, which is why the user painted), and all seeds inside a painted region are
exempt from the line and focus gates: painting is the user's assertion that cells are there, and
those gates are what rejected them on the first pass. The edge margin and the triple frame still
apply. (`cluster_quick` was removed 2026-09-03; the budget sweep and the watershed split were
removed 2026-09-04 after losing on `cluster_gt.json` as above - do not bring either back.)

The master switch still ships off (`cluster_on` 0): turning it on is the user's call for
clump-heavy fields.

### What was fixed, and what the evidence was

**Grid lines were deleting cells.** The fat `line_mask` was painted flat to background in both
`texture_map` and `seed_response`, erasing any cell overlapping the band before later stages saw
it — recall inside the band was 0.53 against 0.95 outside, and that band held 43 % of all misses.
`paint_lines()` is now the single place a line is removed and it interpolates across the band
(`cv2.INPAINT_TELEA`) instead of flat-filling. Flat-filling forces an unwinnable trade: wide
erases cells, narrow leaves a bright ridge that seeds phantom chains.

**Grid lines were also creating cells.** Line positions are stored as single integers, but the
lines are tilted (the ridge drifts 15–28 px across the frame) and the boundary lines are 28-px
triple bands — so 15 of tile 2's 16 line false positives sat 6–13 px away from the scalar
position, on the same physical line, outside the guard. A seed on the painted band now has to
clear a higher NCC (`line_gate`). Line false positives over the three tiles: 25 → 7.

**Out-of-focus bodies.** Variance of the Laplacian (`focus_min`) separates a blurry out-of-plane
ghost from a pale but sharp cell with AUC 0.983 — ghost median 160 against 2489 for real cells.
NCC cannot do this at any threshold: its AUC for the same split is 0.601 *the wrong way*, because
ghosts score higher NCC than the median real cell. Tuning this gate against the ground truth
would have selected exactly the wrong feature.

**Thin boundaries.** 92 % of missed cells already show a rim over half the circle while 88 % sit
below `ncc_thr` — they are cluster members the template does not fire on, not cells without an
edge. `rim_min` admits them by rim completeness, which recovers the same cells as lowering
`ncc_thr` at half the false-positive cost. It ships **off** (1.00): loosening it to 0.938 gains
0.037 recall but blows tile 3's count error out to +21 %. The slider is there to loosen per image.

### Grid lattice and triple frame (2026-09-12, hemo run 1)

A second run of 64 captures (8 bundles x 4 squares x upper/lower) with different
optics exposed three grid-stage failures; `tools/grid_audit.py` measures a whole
folder and is the ruler for this stage.

- Boundary recognition is by run **mass** (sum of the coverage profile over the
  run), threshold 14. Measured: boundary mass 16.9-23.5, interior <= 10.3 over 69
  captures. Width (the old 22 px floor) read 20-24 px on boundaries and 16-29 px
  on defocused interior lines in the same run, so it failed both ways.
- `detect_grid` keeps only lines on the ~315 px lattice, merges split peaks to
  their mass-weighted centre, and fills a lattice position a threshold missed.
  Lowering the threshold instead was measured and rejected: 0.18 gains 3 lines
  and admits 14 junk peaks.
- Three corrections the lattice rule needed, all shipped: lattice membership
  accepts a neighbour at an integer multiple k of the pitch (k in 1, 2, 3), not
  only exactly one pitch — an outer boundary whose neighbouring interior lines
  are the missing ones would otherwise be dropped before the fill step that
  needs it; split peaks merge to the pair's mass-weighted centre, not the
  heavier peak's own centroid (which landed 9 px off); a pitch measured from
  fewer than 2 in-band diffs is not trusted and falls back to the nominal
  315 px — one noisy diff gave 307.5 and collapsed a whole field to a single
  row. `_frame_side` ran its own raw, unmerged, single-pitch-only lattice test
  and so independently rejected real in-view boundaries of mass 17.6-17.9 —
  well over threshold — because their nearest raw neighbour was 2 or 3 pitches
  away, or because a split run skewed its pitch estimate to 305.4 / 318.7; it
  now shares the same lattice rules as `detect_grid`.
- Result: hemo run 1 fields FULL 11 of 35 -> 30 of 32 (three pairs that
  previously failed to stitch now stitch, turning six single captures into
  three paired fields, which is why the field total drops from 35 to 32).
  `score.py` is byte-identical on both engines before and after, throughout.
- The border-clip guard was narrowed the same day (pass 5): a run touching the
  image border used to be refused outright, whatever its mass. Clipping can
  only REMOVE mass from a run, never add it, so a clipped run that already
  clears `triple_min_mass` is a lower bound on the true mass, not a false
  positive — it is now refused only when its mass falls under the threshold.
  This recovered `KGN sq1`'s bottom boundary (mass 17.93) and `KGN sq4`'s right
  boundary (mass 17.43), both on-lattice and previously refused purely for
  touching the edge. Verified directly, not just by the FULL count: for both
  fields the frame's numeric position and the reported cell count are
  byte-identical before and after the guard change — `triple_frame`'s
  outermost-grid-line clamp for an undetected side already sat at the same
  place the newly-recognised run sits, so nothing moved outward past the
  square; only the `sides` flag changed from a clamped fallback to a genuinely
  detected boundary.
- Remaining honest residuals: `HNT sq2` and `KNT sq2` (a boundary genuinely out
  of view or clipped by the framing).

### Known limitations

- **The ground truth under-annotates.** A visual check of 20 random "false positives" found ~14
  were real cells the annotator had not marked, and pale cells are skipped entirely. Measured
  precision is therefore a pessimistic bound, and any further threshold tuning against these three
  files will systematically over-penalise pale cells. Annotating the `"pale"` list that `score.py`
  already supports is worth more than more feature engineering.
- **Clumps remain the largest unfixed error.** One seed for a doublet accounts for 33 % of misses,
  and a second seed on one cell for 59 % of false positives — the same root cause, a matched filter
  with no notion of object extent.
- **Cellpose was measured and rejected** (2026-09-02): 60–85 min per tile against 0.30 s, *and*
  less accurate (best-tuned F1 0.789 against 0.878 on the same crop), and it merges clump members
  rather than splitting them. It is not the answer to clumps.
- 4x tiles are not in use and are neither tuned nor measured.
- **Cluster reprocessing is off and measured harmful** on the automatic path; see the section
  above for the numbers. The hand-painted path is unmeasured because the ground truth cannot
  express it.
- **The concentration calculator is a 10x rule.** A field counts as one full haemocytometer
  square only when the grid reads 4 by 4 with all four frame sides detected, which is what a
  stitched EVOS 10x pair reports. At 4x the whole grid is in frame, `grid_cols` is far larger
  than 4, no field qualifies, and the divisor opens at 0 for the user to type. That is the safe
  direction to be wrong in: a wrong divisor scales the answer silently, an empty one does not.

