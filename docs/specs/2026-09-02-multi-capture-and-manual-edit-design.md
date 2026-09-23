# Spec B — Multi-capture auto-merge and the manual dot editor

**Date:** 2026-09-02
**Status:** approved (user, 2026-09-02)
**Covers:** user request items 4, 5.
**Sibling spec:** `2026-09-02-triple-frame-geometry-design.md` (items 2, 3, 6).

## Problem

**Item 4.** The microscope shows only 3 of the 4 grid rows at a time, so the user captures one
subsection in parts. Today the app takes at most two files and assumes `files[0]` and
`files[1]` are the matching pair — the user must supply exactly the right two, in no particular
order but with nothing else alongside. The user wants to drop several captures at once and have
the app work out **which ones overlap** and merge those.

**Item 5.** After a run, detected cells are drawn as orange dots baked into a server-rendered
JPEG. The user cannot correct them. They want to click a dot to remove a false positive
(debris the pipeline picked up) and click empty space to add a cell it missed.

## User rulings (2026-09-02, binding)

- **RB1 — overlap discovery is image-based only.** Phase correlation between captures. No
  filename or metadata hints; renaming a file must not change the result.
- **RB2 — pairs, not chains.** Two overlapping captures per field. N-image chains were offered
  and not chosen.
- **RB3 — edits are session-scoped, update the count live, and are exportable as JSON.**

## Council verdict (2026-09-02, four voices, recorded because it changed the design)

The question put to the council: how to guarantee no double-counted and no lost cells when
merging partial captures and then hand-editing dots.

- **Consensus, 4/4: merge-then-count.** Count-then-merge-with-dedup is unfixable — live cells
  drift between captures, so no association radius separates "the same cell moved" from "two
  cells", and any radius introduces a density-dependent bias. The hard-cut merge has no such
  knob: every output pixel comes from exactly one source frame.
- **Seam stays on a detected grid line.** Grid lines are already masked and inpainted before
  detection, so a seam there adds no new error mode. The invariant to hold is that the four
  grid rows are disjoint and exhaustive, not that pixels are unique.
- **Position changed by the council:** the Architect wanted the seam scored by "row crossing
  the fewest cells". Dropped — a grid-line seam is already detection-blind, so the scoring
  buys nothing.
- **Strongest dissent, adopted:** the Critic argued phase correlation on a *periodic* grid
  aliases by exactly one grid pitch, at high response, and that `overlap_err` cannot detect it
  because focus differences and cell motion dominate that metric. **Reproduced — see below.**
- **Also adopted:** report auto / added / removed as three numbers, never one total (the
  Skeptic's point that users add missed cells far more eagerly than they delete false ones, so
  sticky edits ratchet the count upward); and key edits to a stitch fingerprint rather than to
  detection indices, which renumber on every re-run.
- **Scope bound, from the Skeptic:** the merge is a ~1-cell problem next to a ~30-cell detector
  problem. Merge work is limited to the aliasing gate, the seam clearance rule and one
  round-trip test. No proof framework.

## Measured evidence (2026-09-02)

### The aliasing failure is real and ships today

`10x tile picture 3; first three rows` was split into two overlapping captures at known
offsets and re-stitched with the current `stitch_pair`:

| true dy | overlap px | estimated dy | response | count | error |
| --- | --- | --- | --- | --- | --- |
| 200 | 624 | 200 | 0.706 | 255 | 0 |
| 260 | 504 | 260 | 0.575 | 255 | 0 |
| 320 | 384 | 320 | 0.410 | 255 | 0 |
| 380 | 264 | **268 (−112 wrong)** | 0.222 | 268 | **+13** |
| 440 | 144 | **160 (−280 wrong)** | 0.052 | 222 | **−33** |

Both wrong registrations pass the current `response >= 0.05` check and are returned with no
error. Registration is reliable only when the overlap exceeds one grid pitch (~315 px).

### The gate that rejects them

Normalised cross-correlation of the region the two frames actually share, at the estimated
shift, compared against the same shift plus and minus one grid pitch:

| case | ncc@dy | ncc@dy−315 | ncc@dy+315 | gate |
| --- | --- | --- | --- | --- |
| dy 200 / 260 / 320 (correct) | 1.000 | −1.000 / −1.000 / +0.443 | +0.450 / +0.494 / +0.600 | pass |
| dy 380 (wrong) | +0.479 | −1.000 | +0.418 | reject |
| dy 440 (wrong) | +0.280 | −1.000 | +0.724 | reject |
| real pair, T3 first + T3 last | +0.846 | +0.460 | +0.438 | pass |

Gate: `ncc@dy >= 0.6` **and** `ncc@dy >= max(ncc@dy±pitch) + 0.10`. Passes all four correct
stitches, rejects both wrong ones.

### Discovery separates cleanly on response

All ten pairs of the five 10x tiles were phase-correlated. The one true pair scores
**0.232**; every non-pair scores **≤ 0.023**, a 10x margin. Overlap NCC alone would not do
this — non-pairs reach 0.28–0.45 purely from grid self-similarity — so both signals are needed:
response for discovery, the pitch gate for validation.

### Merge-then-count is exact

At the three correct offsets the stitched image yields 255 cells against 255 in the original,
with 0 duplicated and 0 lost centres at a 3 px match radius.

## Design

### B1. `stitch_pair` gains a validity gate (`pipeline.py`)

This is a bug fix and lands first, independent of multi-file upload.

- New `_overlap_ncc(a, b, ox, oy) -> float`.
- Require the overlap to exceed `1.2 x` the median horizontal grid pitch (from `detect_grid`'s
  `ys`), falling back to 380 px when fewer than two lines are found.
- Require `ncc >= 0.6` and `ncc >= max(ncc at dy ± pitch) + 0.10`.
- Require the seam row to sit at least `1.5 x diameter` (33 px at 10x) inside the overlap on
  both sides; if no grid line qualifies, raise rather than warn.
- Failures raise `ValueError` with the numbers in the message, as the existing failure does.
- `info` gains `ncc` and `pitch` so the UI can show why a stitch was refused.

`overlap_err` stays in `info` but stops being treated as a quality signal anywhere — the
council showed it cannot discriminate.

### B2. Multi-file intake and pair discovery (`pipeline.py`, `app.py`, `static/index.html`)

New `group_captures(grays) -> [[i], [j, k], ...]`:

1. Phase-correlate all pairs (n is small; 5 files is 10 correlations).
2. Keep candidates with `response >= 0.05` that pass the B1 gate.
3. Sort surviving candidates by response descending and greedily match, each file to at most
   one partner (RB2).
4. Unmatched files are returned as singleton groups.

`app.py` takes `images: list[UploadFile]` in place of `image` / `image2`. Each group becomes a
**field**: a stitched pair or a lone capture, each counted independently. The response returns
a list of fields; the UI shows a selector strip when there is more than one and behaves exactly
as today when there is one.

The old two-file path is removed rather than kept alongside — the UI is the only caller.
`README.md` step 4 documents the current "drop both files at once" behaviour and the
CHECK OVERLAP tag; it is rewritten in the same task, since the pairing is no longer the user's
job and the refusal is now an error rather than a warning.

### B3. Dots move to the client (`app.py`, `static/index.html`)

`/api/count` already returns `count` and a baked overlay JPEG. It gains `centers`, `grid_x` and
`grid_y`, and the server overlay **stops drawing dots** — contours, grid lines, the triple
frame and the stitch seam stay server-drawn. The client draws dots on a `<canvas>` sized to the
base image.

This is the enabling change for item 5: dots must be addressable objects on the client, not
pixels in a JPEG.

### B4. The edit overlay (`static/index.html`)

State: `{added: [[x, y], ...], removed: [[x, y], ...]}` in base-image pixel coordinates, plus a
`fingerprint`.

- **Fingerprint** = file names and sizes, plus `dx`, `dy`, `seam_y` when stitched, plus the
  active crop. If it changes, edits are **discarded**, not remapped — the Critic's point that
  edits keyed to anything looser silently land on different cells.
- **Click behaviour.** A click within `0.5 x diameter` of a drawn dot removes it (the point is
  appended to `removed`); a click on empty space appends to `added`. Clicking an added dot
  removes it from `added` rather than adding it to `removed`.
- **Re-applying after a re-count.** Auto centres within `0.5 x diameter` of a `removed` point
  are suppressed; `added` points are appended. A `removed` point that matches nothing after a
  slider change is drawn as a hollow grey ghost ring, so a resurrected false positive is
  visible instead of silently miscounted.
- **Reporting.** The headline number stays the total. Beneath it, `auto N · +a · −r` is always
  shown, so a hand-inflated count can never be mistaken for a machine count (RB3, Skeptic).
- **Per-square tallies** recompute on the client from `centers`, `grid_x` and `grid_y` using
  the same `rule="L"` convention as `per_square_counts`, so the square panel stays live during
  editing.
- **Export.** A button downloads `{"image": <name>, "points": [[x, y], ...]}` — the
  `samples-new_gt` format — so a corrected field can become ground truth. Pale-cell marking is
  the annotator tool's job and is not duplicated here.

## Testing

Added to `tests/pipeline/test_pipeline.py`:

1. `test_stitch_round_trip_is_exact` — split a real tile at dy 200, 260 and 320, re-stitch,
   assert the count equals the whole-image count and that every centre matches within 3 px
   with no duplicate and no loss. This is the merge-then-count proof.
2. `test_stitch_rejects_aliased_registration` — dy 380 and dy 440 must raise `ValueError`.
   Locks the bug found on 2026-09-02.
3. `test_stitch_requires_seam_clearance` — a synthetic pair whose only grid line sits at the
   very edge of the overlap is refused.
4. `test_group_captures_finds_the_only_real_pair` — over all five 10x tiles, exactly one group
   of two is returned and it is the tile 3 pair; the other three are singletons.
5. `test_group_captures_is_filename_independent` — the same result after shuffling the input
   order (RB1).

The edit overlay is browser-side; its logic is exercised by a small `demo()` self-check in the
page script asserting the three re-apply cases (suppressed, re-added, ghost).

## Out of scope

- N-image chains (RB2).
- Server-side or on-disk persistence of edits (RB3 — session-scoped).
- Any change to the detector itself.
