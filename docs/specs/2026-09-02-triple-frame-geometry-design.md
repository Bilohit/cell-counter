# Spec A — Triple-line boundary, auto-crop, skew crop

**Date:** 2026-09-02
**Status:** approved (user, 2026-09-02)
**Covers:** user request items 2, 3, 6. Item 1 is evidence folded into
`docs/plans/2026-09-02-counting-accuracy.md`, not part of this spec.
**Sibling spec:** `2026-09-02-multi-capture-and-manual-edit-design.md` (items 4, 5).

## Problem

Three separate requests share one root: the app has no model of the hemocytometer's
**outer triple-line frame**.

1. **Item 2.** The grid has single lines and triple lines. Only cells inside the triple-line
   boundary may be counted; cells outside it must be excluded entirely. Today `count_cells`
   counts every seed in the frame, including cells beyond the ruled area.
2. **Item 3.** Auto-crop should select the region inside the triple frame. Today
   `auto_crop_viewport` looks for a bright monitor screen inside a dark bezel — built for
   photographs of a monitor, useless on an EVOS capture, and off by default.
3. **Item 6.** Manual crop is an axis-aligned box. A skewed or rotated capture needs a
   four-corner perspective warp, the interaction PDF-scanner apps use.

## User rulings (2026-09-02, binding)

- **RA1 — outer frame only.** "Inside" means inside the outermost triple line on each axis.
  Single inner dividers keep today's behaviour. Per-square triple-line exclusion is out of scope.
- **RA2 — correctness over aggressiveness for auto-crop.** Never cut off anything that could
  contain a valid reading. When the two goals conflict, crop looser.
- **RA3 — auto-crop, manual crop and skew crop are three independent options, all acting on
  the original image.** None replaces another; Reset restores the original.

## Measured evidence (2026-09-02, all five 10x tiles in `samples-new_tif/`)

Grid lines were extracted with the existing `detect_grid` morphology and grouped into runs by
the existing `_profile_peaks` rule (`gap = 12`). Run **width** separates the two line kinds:

| line kind | run widths observed |
| --- | --- |
| triple | 25, 26, 26, 26, 27, 27, 30, 31, 31, 32 |
| single | 11, 12, 12, 13, 13, 13, 13, 14, 17, 18, 18, 18, 19 |

The gap between 19 and 25 is clean on every tile, so a fixed threshold works. Two
complications appeared and both are handled:

- **Off-lattice artefacts.** `10x tile picture 4` has a spurious run at `x = 0..11`, 62 px from
  the real triple at `x = 55..80`. The line pitch is 315 px on every tile (V) and 314-316 (H),
  so a run whose distance to its nearest neighbour is not within 10 % of the pitch is not a
  grid line and is dropped. This removes the artefact and keeps every real line on all 5 tiles.
- **Edge-clipped runs.** `10x tile picture 2` has its right triple clipped to width 17 at
  `x = 1343..1359`; `10x tile picture 1` has a clipped *single* at `y = 1..20` of width 20.
  Width is unreliable for any run touching the image border, and the two cases are not
  separable by width. Clipped runs are therefore **never** classified as triple; that side of
  the frame falls back to the image edge. Cost: tile 2's right boundary sits 9 px outside the
  true triple centre — looser, never tighter, which is the direction RA2 requires.

Resulting frame on each tile (x0, x1, y0, y1 as run centre lines, image edge where absent):

| tile | x | y |
| --- | --- | --- |
| 1; last three rows | 75 .. 1336 | 0 .. 955 |
| 2; first three rows | 92 .. 1360 | 62 .. 1024 |
| 3; first three rows | 73 .. 1334 | 50 .. 1024 |
| 3; last three rows | 68 .. 1328 | 0 .. 900 |
| 4; first three rows | 68 .. 1330 | 47 .. 1024 |

Each capture shows one horizontal triple only, because the microscope shows 3 of the 4 rows —
so a one-sided horizontal frame is the normal case, not an error.

## Design

### A1. Triple-frame detection (`pipeline.py`)

`_profile_peaks` currently returns run *centres* and discards run extent. Split it:

- `_profile_runs(prof, thr, gap=12) -> [(start, end), ...]` — the existing grouping, extent kept.
- `_profile_peaks(prof, thr, gap=12)` becomes a one-line wrapper returning run centres, so
  `detect_grid` and `stitch_pair` are unchanged.

New: `triple_frame(gray, p) -> {"x0","x1","y0","y1","sides"}`.

For each axis, from that axis's runs:

1. Drop runs off the line lattice (nearest-neighbour distance not within `tol = 0.10` of the
   median run spacing).
2. Drop runs touching the image border (`start <= 2` or `end >= n - 3`).
3. Keep runs of width `>= triple_min_w`.
4. Boundary = centre line of the outermost kept run on each side; a side with no kept run
   uses the image edge. `sides` records which of the four came from a detected triple, so the
   UI and tests can tell a detected boundary from a fallback.

New params: `("triple_min_w", "Triple-line width (px)", 12, 40, 22, 1, "Grid")` and
`("boundary", "Count inside triple frame only (0/1)", 0, 1, 1, 1, "Grid")`.

Both live in the `Grid` group, which the UI does not render (the page shows only `Cell check`).
`boundary` still needs to be reachable, so the page exposes it as a **switch** beside the
existing auto-crop switch and posts it inside the normal `params` object — a switch, not a
slider, because it is binary. `triple_min_w` stays hidden at its tuned default like every other
`Grid` parameter.

### A2. Boundary enforcement (`count_cells`)

After the existing edge-margin filter and before `blob_contours`, when `boundary` is on, drop
every centre outside the frame. The test uses the same half-open convention as
`per_square_counts(rule="L")` — a cell on the top or left boundary counts, one on the bottom
or right does not — so the two rules cannot disagree. `count_cells` returns a new `frame` key
(the dict, or `None` when `boundary` is off). `app.py` draws the frame on the overlay.

`PARAMS`, `DEFAULTS`, `GROUPS` and the eight existing result keys are unchanged; `frame` is
additive, so the frozen public API in the accuracy plan's Global Constraints still holds.

### A3. Auto-crop to the frame (`pipeline.py`, `app.py`)

New `auto_crop_frame(bgr, p) -> bgr`: detect the frame, crop to it **plus one cell diameter of
margin on every side**, clamped to the image. If no side was detected from a real triple,
return the image untouched — no guessing (RA2).

`auto_crop_viewport` is untouched and keeps its own toggle; the two are different jobs. The UI
gains a third crop option rather than changing the meaning of the existing one (RA3).

### A4. Skew crop (`app.py`, `static/index.html`)

- **UI.** A "Skew crop" button puts four draggable corner handles on the image, initialised to
  the image corners, joined by an SVG quad outline. Confirm applies, Escape cancels.
- **Transport.** The four corners POST as a `quad` form field, `[[x,y] x 4]` in original-image
  pixel coordinates, clockwise from top-left.
- **Server.** `pipeline.warp_quad(bgr, quad) -> bgr` orders the corners, sizes the output from
  the mean of opposite edge lengths, and applies `cv2.getPerspectiveTransform` +
  `cv2.warpPerspective`. This runs first in the request handler, so the rest of the pipeline
  sees an ordinary rectangular image and needs no other change.

Warping is server-side because OpenCV is already there and canvas 2D has no perspective
transform; doing it in the browser would mean hand-rolling the warp.

## Testing

Added to `tests/pipeline/test_pipeline.py`:

1. `test_triple_frame_on_all_tiles` — for each of the 5 10x tiles, the detected frame equals
   the table above within 2 px. This is the regression lock on the width threshold, the
   lattice rule and the clipped-run rule together.
2. `test_triple_frame_rejects_off_lattice_run` — tile 4's `x = 0..11` artefact is not the left
   boundary.
3. `test_boundary_excludes_outside_cells` — with `boundary` on, no returned centre lies outside
   the frame; with it off, the count is `>=` the bounded count on every tile.
4. `test_auto_crop_frame_never_loses_a_cell` — cross-checks RA2 directly: every centre found
   in the uncropped image maps into the cropped image's bounds.
5. `test_warp_quad_round_trip` — warping a synthetic image through a known quad and back
   reproduces it within a small tolerance; a degenerate quad raises `ValueError`.

### A5. The ruler must measure the same region (`score.py`)

Measured 2026-09-02: **11-14 % of every ground-truth file lies outside the triple frame** — 46 of
337 points on tile 1, 57 of 498 on tile 2, 29 of 251 on tile 3. `boundary` defaults to on, so
without a matching change those points become false negatives that are in fact correct
exclusions, and `score.py` would report a recall collapse that never happened.

`score.py` therefore filters the ground truth through the same frame, with the same half-open
convention, before matching, and prints how many points it dropped per tile. Both the old and
the new baseline are recorded in
`docs/plans/2026-09-02-counting-accuracy.md`, because that plan's accept/reject
decisions are made against this scoreboard and would otherwise be compared to a stale number.

## Out of scope

- Per-square or per-large-square triple boundaries (RA1).
- Any change to detection accuracy — that is the counting-accuracy plan's job. This spec must
  be **accuracy-neutral off the boundary**: with `boundary = 0` the count must be identical to
  today's on all 5 tiles, and a test asserts it.
- Replacing `auto_crop_viewport`.
