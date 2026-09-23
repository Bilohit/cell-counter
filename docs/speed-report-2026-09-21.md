# Speed report — 64-image batch (2026-09-21)

> **Status, 2026-09-22 — read this first.** This is the evidence file for
> `docs/superpowers/plans/2026-09-22-batch-speed.md`; the plan is what gets
> built, this says why. Four rounds, in order: round 1 (candidates #1-#4),
> round 2 (#5, #6, #3b), round 3 (final measurements, dead code, models side by
> side), **round 4 (six more items, at the end of this file)**. Each round ends
> with a council verdict and the owner's decision; a later round overrides an
> earlier one where they differ (#6 was "defer" in round 2 and is GO in round 3).
> Nothing has been built yet. Whoever builds appends results under `# Build log`
> at the very end, task by task.
>
> | Plan task | Item(s) here | Owner decision |
> |---|---|---|
> | 1 | identity ruler (round 3 guard rail) | GO |
> | 2, 3 | D dead code, #7 contours | GO |
> | 4 | #5 spin off | GO, release-gated on one low-core/Mac machine |
> | 5 | #1 parallel sweep, #3 float once, #3b window once | GO |
> | 6, 7 | #2 two counts at once | GO with guard rails |
> | 8 | B models side by side | GO, Finest or single count only |
> | 9 | #6 heatmap cache | GO with key-miss test |
> | 10 | N2 fill holes by flood fill | GO with conditions |
> | 11 | S4/N4 exact uint8 median | GO |
> | 12 | S3 one `detect_grid` per stitch | GO |
> | 13 | S1 cache key from per-image digests | GO with condition |
> | 14 | S5 parallel decode | GO with condition |
> | 15 | O2 Finest pass order | **measurement gate — may end in "not shipped"** |
> | 16 | re-measure, document, release gate | GO |

**What changed in the app: nothing.** Every number below comes from throwaway
prototype scripts run against the current code. This report lists candidates
for a go/no-go decision; nothing is built yet.

## Non-negotiables this report was held to

1. **Output bit-identical.** Every cell position, count, per-square tally and
   stitched image must match today's output exactly — not "within noise".
2. The flow may change (cards finishing out of order, progress bar, time
   estimate, cancel, pairing speed) only where it is sensible, and every UI/UX
   consequence must be planned.
3. Must work on lab laptops and MacBooks with no graphics card; memory unknown,
   so anything that uses more must size itself to the machine.
4. Sessions / session storage: out of scope for this pass.

## Where a 64-image batch spends its time today

Measured on the dev laptop (Intel i7-14650HX, 16 cores / 24 threads).
Quality **Normal**, 64 single captures, name grouping **off** (the default —
`useGallery.tsx:146`).

| Stage | Cost | For 64 images |
|---|---|---|
| Pairing check (runs automatically before counting) | 35–43 ms per comparison, n(n-1)/2 comparisons | 2016 comparisons ≈ **70–87 s** |
| Counting | 2.50 s per image (detector is 85 % of it) | ≈ **160 s** |
| Thumbnails | 0.5 s total | ≈ 0.5 s |
| Server overhead (upload, JPEG, HTTP) | ≈ 0 over the direct call | ≈ 0 |
| **Total** | | **≈ 3 min 50 s – 4 min 7 s** |

The pairing check is almost as expensive as the counting and is invisible in
any per-image number. With name grouping ON it collapses to a handful of
comparisons — but switching it on changes which pairs *can* form, so it is a
user choice, not an optimisation (see Excluded).

## Candidates (all verified bit-identical unless marked)

### 1. Pairing check in parallel — BIGGEST WIN

- **What:** compare the candidate pairs on several cores at once. Every
  comparison is independent; the "who pairs with whom" decision still runs
  once, afterwards, in the same order, so the answer cannot change.
- **Measured:** 24 images / 276 pairs, serial 34.8 ms/pair → 4 workers
  15.0 ms (2.3x), 8 workers 12.9 ms (**2.7x**). Groups, stitched images and
  stitch info **identical**.
- **Time saved (64 images, names off):** ≈ 45–55 s, on every quality level.
- **Pros:** largest single saving; output provably unchanged (the decision
  step is untouched); the stitch cache is already lock-protected
  (`pipeline._StitchCache._lock`).
- **Cons / risks:** the "why no partner" list and the progress callback are
  written from worker threads — must be kept in the original order. Memory:
  each worker holds one comparison's working set (small next to a count).
  Cancel must still stop the sweep promptly.
- **UI/UX:** none needed — the sweep progress bar just moves faster.

### 2. Count 2 images at once — SECOND WIN

- **What:** the server allows 2 counts at a time instead of 1; the gallery
  keeps 2 requests in flight. The detector is memory-bandwidth-bound, so two
  counts overlap one image's non-detector steps with the other's detector.
- **Measured over all 69 tiles, every output field compared exactly:**

  | Level | One at a time | 2 at once | Speedup | Mismatches |
  |---|---|---|---|---|
  | Quick | 0.87 s | 0.61 s | 1.42x | 0 / 69 |
  | Normal | 2.50 s | 1.77 s | 1.41x | 0 / 69 |
  | Finest | 13.07 s | 11.32 s | 1.16x | 0 / 69 |

- **3 at once measured no better than 2** (Normal 1.77 s), so 2 is the ceiling.
- **Time saved (64 images):** Quick ≈ 17 s, Normal ≈ 47 s, Finest ≈ 1 min 52 s.
- **Pros:** same counts; works on any machine; falls back to 1 automatically.
- **Cons / risks:**
  - Memory: two counts ≈ double the detector's peak memory. Peak RSS was **not
    measured** (the measuring call broke) — must be measured before build,
    and the in-flight count sized from free RAM (1 on small machines).
  - Only measured on a 16-core machine. A 4-core laptop or MacBook may gain
    less or nothing — must be measured on one before shipping; if it does not
    help, the auto-sizing picks 1 there.
  - `_COUNT_LOCK` exists because concurrent counts thrashed; the lock becomes a
    2-slot limit, not removed. The sweep still runs alone.
- **UI/UX changes to plan:**
  - Two cards show "counting" at once; they can finish out of order (the user
    allowed this).
  - The progress bus assumes one card in flight (`useGallery.tsx` comment:
    "the bus always describes the card that is actually being counted") —
    each card needs its own progress.
  - Time estimate must use batch throughput, not per-image time, or it
    over-estimates by ~40 %.
  - The "waiting" position shown for queued cards changes meaning.
  - Cancel aborts both in-flight requests; the rest are marked "cancelled" as
    today.

### 3. Convert each image to float once in the pairing check — SMALL

- **What:** the sweep converts both images to float32 on every comparison
  (`pipeline.py:1407`, `:1433`); do it once per image.
- **Measured:** all `astype` calls in a 66-pair sweep cost 0.18 s ≈ 2.7 ms of
  ~43 ms per comparison (≈ 6 %, an upper bound — not all of it is this
  conversion). Identity is by
  construction (same conversion, same data) but **not yet tested** — needs the
  same identity check before merge.
- **Time saved:** ≈ 5 s on 2016 comparisons; less once #1 runs.
- **Cons:** touches `stitch_pair`'s signature or adds a pre-converted path; small
  but not free code.

### 4. Warm start — TRIVIAL

- **What:** load the detector when the app starts instead of on the first count.
- **Measured:** first count 2.84 s vs 2.53 s after → **0.3 s once per launch.**
- **Verdict:** real but negligible. Include only if it is free.

## Measured and rejected

| Idea | Result | Why rejected |
|---|---|---|
| Memory arena on | detector-only 12 % faster; full count 2.43 → 2.38 s (2 %) | noise-level gain, known 4 GB memory cost |
| Arena on + shrink after each run | 4 % detector-only | noise |
| Detector thread tuning | default (all cores) already fastest; output identical at every thread count | nothing to gain |
| 2 images in one detector pass (batch) | 1.19 s vs 1.00 s for two singles | slower |
| 3 counts at once | no better than 2 | no gain |
| Skip duplicate uploads | thumbnails for 64 images 0.5 s total; HTTP ≈ 0 | nothing to gain |
| Shave non-detector steps (grid, contours, NCC) | ~0.35 s per image, overlapped by #2 anyway | risk to output for ~0 gain |

## Excluded by the non-negotiables (would change output)

- Graphics card (CUDA/DirectML) or Apple GPU (CoreML) — different arithmetic.
- Lighter number formats (fp16, int8) or a smaller/fewer-model detector.
- Re-implementing the pairing FFT to reuse each image's transform — faster, but
  not guaranteed bit-identical to OpenCV's `phaseCorrelate`.
- Name grouping on by default — changes which captures may pair.
- Anything touching sessions (out of scope).

## Projected totals — 64 images, names off, this machine

| Level | Today | With #1 + #2 | Speedup |
|---|---|---|---|
| Quick | ≈ 70–87 s + 56 s ≈ 2.1–2.4 min | ≈ 26–32 s + 39 s ≈ 1.1–1.2 min | ≈ 1.9–2.0x |
| Normal | ≈ 70–87 s + 160 s ≈ 3.8–4.1 min | ≈ 26–32 s + 113 s ≈ 2.3–2.4 min | ≈ 1.7x |
| Finest | ≈ 70–87 s + 836 s ≈ 15.1–15.4 min | ≈ 26–32 s + 724 s ≈ 12.5–12.6 min | ≈ 1.2x |

Caveats: captures that pair up are counted as one larger stitched field, so a
batch of 32 pairs has a different counting cost; lab laptops and MacBooks are
unmeasured.

## Verification

- Script: prototypes in the session scratchpad (`verify.py`); nothing in the
  repo was modified.
- Count identity: deep exact comparison of every field `count_cells` returns
  (arrays bitwise, floats exact), all 69 tiles in `data/tif`, levels 1–3,
  sequential vs 2-at-once — 0 mismatches.
- Pairing identity: `group_captures` vs a parallel prototype with the same
  decision rule, stitch cache cleared before each run, groups + stitched
  images + stitch info compared — identical at 4 and 8 workers.
- Arena identity: all 69 tiles at Normal, 0 mismatches (rejected on speed).

## Open items before any build

1. Measure peak memory of 1 vs 2 concurrent counts at each level.
2. Measure #1 and #2 on a low-core laptop and a MacBook.
3. Unexplained: the very first HTTP timing run was ~2x slow (2.33 s Quick,
   5.70 s Normal); a rerun matched the direct numbers. Suspects: cold start,
   antivirus scan, or a browser tab the test server opened. Re-check at
   baseline.

## Council verdict (Sonnet Skeptic / Pragmatist / Critic + Architect)

| # | Architect | Skeptic | Pragmatist | Critic | Verdict |
|---|---|---|---|---|---|
| 1 Parallel pairing | go | go (check on 4-core) | go, effort S, ship alone first | go (single-writer progress + skip list) | **GO** |
| 2 Count 2 at once | conditional | conditional | conditional, effort M-L | conditional | **CONDITIONAL** |
| 3 Float once in pairing | fold into #1 | conditional (run identity check) | only if free | conditional (run identity check) | **CONDITIONAL, low value** |
| 4 Warm start | skip | go, free | go if free | go | **GO if free** |

Conditions for #2, agreed by all four: peak memory measured for 1 vs 2 counts;
measured on a low-core laptop / MacBook; auto-sizing to 1 slot proven to trigger,
not assumed. Shipped as its own change after #1, never bundled.

Points the council raised that the report missed:

- **Stale-comment contradiction (Skeptic).** `app.py:29-31` (commit `1a0e39c`,
  2026-09-05) says two concurrent counts "do not finish sooner". It cites no
  measurement; the 69-tile run above measured 1.41x on this machine. It may still
  hold on low-core machines — which is the #2 condition. Whoever builds #2 must
  rewrite that comment with the new measurement.
- **Lock-ordering invariant (Critic).** `ml/infer.py:88-96` documents
  `_COUNT_LOCK`-then-`_sessions_lock` ordering; a 2-slot limit changes what
  "holding `_COUNT_LOCK`" means, and two threads cold-loading a session must be
  re-audited. A bug here is a deadlock (a hang for the user), not a wrong count.
- **Queued-card semantics (Pragmatist).** `_PROGRESS.queued()` and the `_WAITING`
  counter (`app.py` ~964-1001) assume exactly one running count; with two, the
  "waiting" position and every `_PROGRESS.running` call site inside the lock need
  their own line item, not just "per-card progress".
- **Arena + 2 slots compounding (Critic).** Arena stays rejected; if it is ever
  revisited, slot sizing must account for it.
- **Value vs risk (Critic).** #1 is the safe item; #2 carries ~half the saving.
  Gate #2 on its conditions anyway rather than rushing them.

---

# Round 2 — wider search (2026-09-22)

User decisions after round 1: **#1, #2, #3 GO**; #4 dropped; #2's memory check
runs once on first launch and is remembered. Ruling: **no speculative
pre-processing** — work runs only on the user's decision.

## 5. Turn off onnxruntime thread spinning — BIGGEST NEW WIN

- **What:** one session option,
  `session.intra_op.allow_spinning = "0"`, in `ml/infer.py::_session_options`.
  By default each onnxruntime session's worker threads keep spinning after a
  run, waiting for more work. Normal/Finest hold **three** sessions (one per
  model), each with its own ~16-thread pool, so the idle pools spin and steal
  cores from the active one. Web sources report the same effect on concurrent
  CPU inference ([onnxruntime threading docs](https://onnxruntime.ai/docs/performance/tune-performance/threading.html),
  [Manticore](https://manticoresearch.com/blog/onnx-embeddings-speedup/)).
- **Root-cause check:** the theory predicts Quick (one session) gains least —
  it does (1.18x vs Normal 1.50x).
- **Measured, all 69 tiles, every output field compared exactly; baseline
  re-run afterwards to rule out run-order/thermal effects:**

  | Level | Today | Spin off | Spin off + 2 at once | Mismatches | Baseline re-run |
  |---|---|---|---|---|---|
  | Quick | 0.86 s | 0.73 s (1.18x) | 0.53 s (1.62x) | 0 / 69 | 0.83 s |
  | Normal | 2.43 s | 1.62 s (1.50x) | 1.29 s (1.87x) | 0 / 69 | 2.38 s |
  | Finest | 13.41 s | 11.97 s (1.12x) | 9.66 s (1.39x) | 0 / 69 | 12.67 s |

  Finest's baseline drifted 6 % between runs, so spin-off *alone* at Finest is
  near noise; the combined figure is well clear of it.
- **Pros:** one line; no UI change; output identical; helps single-image
  Reprocess too, not just batches; also makes #2 better (1.41x → 1.87x Normal).
- **Cons / risks:** measured on one 16-core Intel hybrid CPU only. Spinning
  exists to cut latency between operators; on a 4-core laptop or Apple Silicon
  the trade may differ — measure there before shipping. Pure scheduling
  setting; arithmetic unchanged (thread count was already shown not to change
  output).

## 6. Heatmap cache for identical detector input — RECOUNT WIN

- **What:** the detector's input (`gray`, `line_mask`, `sm`, `bg`) is fixed
  before step 7 of `count_cells`; the **boundary** switch and the "Show
  pipeline" Reprocess do not change it, yet each re-runs the full detector.
  Cache the averaged heatmap keyed by an exact hash of the input stack +
  weights + TTA flag; a hit returns the same array bytes. Identical by
  construction (same values, nothing recomputed).
- **Benefit (estimated from the profile, not prototyped):** those recounts drop
  from 2.5 s → ≈ 0.4 s at Normal and ≈ 13 s → ≈ 0.5 s at Finest. **Zero effect
  on a fresh 64-image batch** — it only helps repeat counts of the same input.
- **Pros:** big for the recount cases it covers; complies with the
  no-pre-processing rule (reuses a count the user already asked for).
- **Cons / risks:** memory, ≈ 5.6 MB per 1360×1024 heatmap (more for stitched
  fields) → must be byte-bounded like the existing caches and cleared by
  `/api/reset`; hashing the stack costs a few ms per count. Cross-level reuse
  (Finest contains Normal's passes) is possible but skipped: per-pass caching
  multiplies memory for a rare case.

## 3b. Build the Hanning window once — fold into #3

`stitch_pair` calls `cv2.createHanningWindow` per comparison (0.086 s over 66
pairs ≈ 1.3 ms, ~3 %). Same function, same arguments, built once per image
size. Identity by construction; verify with #3.

## Round 2 rejected

| Idea | Why |
|---|---|
| Pairing check early, while the user is on the confirm screen | **User ruling:** no speculative pre-processing |
| Reuse each image's FFT across its comparisons | `cv::phaseCorrelate`'s `magSpectrums` and `weightedCentroid` are not exposed to Python; a numpy copy can differ in the last bits, and `response` ranks pairs — not guaranteeable bit-identical without a compiled extension |
| Hash each image once for the stitch-cache key (~1.3 ms/pair) | identity by object is fragile; saving small after #1 |
| Upgrade onnxruntime for faster kernels | not investigated: new kernels can change float results; would need the full 69-tile check for a gain nobody has measured |
| Skip likely non-pairs with a cheap pre-filter | a filter that ever drops a real pair changes output |

## Projected totals with #1 + #2 + #3 + #5 — 64 images, names off, this machine

| Level | Today | After | Speedup |
|---|---|---|---|
| Quick | ≈ 2.1–2.4 min | ≈ 26–32 s + 34 s ≈ 1.0–1.1 min | ≈ 2.1x |
| Normal | ≈ 3.8–4.1 min | ≈ 26–32 s + 83 s ≈ 1.8–1.9 min | ≈ 2.1x |
| Finest | ≈ 15.1–15.4 min | ≈ 26–32 s + 618 s ≈ 10.7–10.8 min | ≈ 1.4x |

Same caveats as round 1: one machine; lab laptops and MacBooks unmeasured.

## Round 2 council verdict

| # | Architect | Skeptic | Pragmatist | Critic | Verdict |
|---|---|---|---|---|---|
| 5 Spin off | go (laptop check) | go (laptop smoke test) | go, effort S | go, gated on a non-Intel-hybrid machine | **GO, confirmed on one low-core/Mac machine before release** |
| 6 Heatmap cache | conditional | conditional, separate ticket | conditional, effort M, defer | no-go as specified | **DEFER** — not the batch pain point |
| 3b Window once | go, fold into #3 | go | go, same PR as #3 | go | **GO, inside #3** |

Council points to carry into any build:

- **#5 on low-end hardware (Skeptic, Critic).** Same class of risk as the arena
  scar in `ml/infer.py:134-141` — one machine's result assumed to generalise.
  A smoke test on a 4-core laptop or MacBook is the release gate, not a formality.
- **#5 is load-bearing config (Pragmatist).** The setting needs a comment in
  `_session_options` naming the measurement, or it reads as dead config.
- **#5 touches the ruler (Critic).** `ml/loo.py` and `score.py` share
  `_session_options`; a scheduling flag cannot change arithmetic, but the
  69-tile check must cover them in-process too.
- **#6 if ever built (Critic).** Cache the raw averaged heatmap, never
  thresholded points; key on the exact bytes of the built input stack (which
  is derived from all of `gray`, `line_mask`, `sm`, `bg`) plus weights + TTA;
  `thr`/`crowd_b`/`crowd_r` stay applied after the cache on every hit; byte
  bound + clear in `/api/reset`; no new lock taken inside `_sessions_lock`.

Ship order (Pragmatist, adopted): #1 + #3/#3b → #5 → #2 → measure a real batch
on a lab laptop → #6 only if recount pain is reported.

---

# Round 3 — final measurements and council (2026-09-22)

User decisions after round 2: **#5, #3b, #6 GO** (#6 on the owner's call, against
the round-2 "defer"). Owner priority for the final council: **small gains
count, because they scale across repeated batches.** Dead / functionally
removed code is removed completely.

## New measurements (spin off applied unless noted; mm = exact-equality mismatches)

| Test | Normal | Finest | mm |
|---|---|---|---|
| today (16 tiles) | 2.58 s | 13.72 s | — |
| spin off | 1.72 | 11.34 | 0 |
| spin off + `dynamic_block_base=4` | 1.73 | 11.38 | 0 → **no gain, rejected** |
| spin off + models side by side (B), one at a time | 1.55 | 9.31 | 0 |
| spin off, 2 at once | 1.42 | 9.59 | 0 |
| spin off + dbb4, 2 at once | 1.37 | 9.62 | 0 → within noise, rejected |
| spin off + B, 2 at once | 1.48 (worse) | 8.71 | 0 |

| Item | Measured | mm |
|---|---|---|
| #7 contours removed (69 tiles) | Quick 0.776 → 0.751 s, Normal 1.753 → 1.722 s (−25 to −31 ms/img) | 0 in every other field |
| #3b window once (24 imgs, 276 pairs) | 35.1 → 33.1 ms/pair | identical |
| #3 float once | `astype` 1.1 ms × 2 per pair ≈ 2.2 ms/pair | by construction |

**B rule from the data:** models side by side only at Finest, or when a single
count is running. At Normal with two counts in flight it is slower.

## Dead / functionally-removed code found

- `tools/tune_clusters.py` → calls deleted `pipeline.reprocess_region`; crashes.
- `tools/make_cluster_chunks.py` → calls deleted `pipeline.cluster_boxes`; crashes.
- `tools/annotate_clusters.html` — 830 KB generated output of that dead tool.
- `pipeline._profile_peaks` — called by one test only. `app._to_bgr8` — no caller.
- `pipeline.blob_contours`, the `contours` result key, stage `07|Filter|Kept blobs`.
- Stale comments: `app.py:54`, `app.py:483-485`, `pipeline.py:1020`,
  `tests/api/test_count.py:64,123,227`, `web/src/components/Viewer.tsx:394,498`,
  `web/src/components/StageStrip.tsx:43`; `web/src/components/Sidebar.test.tsx:23`
  fixture uses deleted param `cluster_on`.
- **Kept (council unanimous, owner to confirm):** `tools/make_reconcile.py`,
  `tools/merge_reconciled.py` (ground-truth provenance), `ml/score_chunks.py`
  (research ruler), classical-engine functions (live at level 0 via `score.py`
  and `ml/loo.py`). Historical mentions in `docs/` stay — `docs/` is design
  history.

## Final council verdict

| # | Architect | Skeptic | Pragmatist | Critic | Final |
|---|---|---|---|---|---|
| 1 Parallel pairing | go | go | go, S | go | **GO** |
| 3 Float once | go | go, verify in same commit | go, S | go | **GO** |
| 3b Window once | go | go | go, S | go | **GO** |
| 5 Spin off | go | go | go, S | go | **GO** |
| 7 Remove contours | go | go, flag UI change | go, S | go + fix tests | **GO** |
| D Dead code | go | go | go, S | go, grep refs first | **GO** |
| 2 Two at once | go | conditional (hard fallback) | go, M | conditional (shared slot cap) | **GO with guard rails** |
| B Models side by side | Finest/single only | Finest only | Finest only, M | Finest only, shared cap | **GO, Finest or single count only** |
| 6 Heatmap cache | go | no-go (unprototyped) | defer, L | conditional (key test) | **GO (owner) with prototype + key-miss test gate** |
| Judgement-call files | owner's call | keep | keep | keep | **KEEP, flagged to owner** |

**Strongest dissent (Skeptic):** the #2 memory check should be live on every
run, not remembered — RAM free at first launch may not be RAM free later. The
owner specified first-run-only, remembered; the plan keeps that and bases the
decision on *total* installed RAM (which does not change between runs), not on
free RAM.

**Guard rails adopted into the plan:**
- One process-wide slot budget for counts; the pairing sweep takes every slot.
- B only when level is Finest or exactly one count is in flight.
- Every change passes the baseline fingerprint check on all 69 tiles, levels 1-3,
  **in the same commit** (not after).
- #6: raw heatmap only, keyed on exact input-stack bytes + weights + TTA,
  thresholds applied after, byte-bounded, cleared on `/api/reset`, plus a test
  that changing any input misses the cache.
- #7: fix every test and comment that names contours or stage 07.
- #5: a comment in `_session_options` with the measurement, so it is never read
  as dead config; release gated on a smoke test on one low-core laptop or Mac.

## Final projected totals — 64 images, names off, this machine

| Level | Today | After all items | Speedup |
|---|---|---|---|
| Quick | ≈ 2.1–2.4 min | ≈ 0.9–1.0 min | ≈ 2.1–2.6x |
| Normal | ≈ 3.8–4.1 min | ≈ 1.7–1.8 min | ≈ 2.1–2.4x |
| Finest | ≈ 15.1–15.4 min | ≈ 9.7 min | ≈ 1.6x |

---

# Round 4 — what is left after the plan (2026-09-22)

Owner brief: find more, keep output bit-identical, **any measured saving counts**
— but a number inside its own run-to-run spread is not a measurement. Nothing
already measured was re-tested; every baseline below already includes the
approved plan (spin off, 8-worker sweep, float and window once), so these are
gains *on top of* it.

## How it was measured, and what went wrong

Twelve ideas in three batches (pairing sweep S, onnxruntime O, classical
stages N), one Sonnet agent per batch, prototypes monkeypatched from a
scratchpad — no repo file touched. Timing runs were serialised on a lock
directory so the batches would not share the CPU. **One agent deleted the lock
believing it stale, so some timings ran contended.** Consequences, item by item:
O1's solo thread scan is unusable (its "default" read 1.16 s against a clean
0.73 s); S1's full-sweep figure and S3's repeats are contended; N2 and O2 were
re-run afterwards on an idle machine, 3 repeats, and are marked CLEAN. Identity
checks are unaffected by contention. Lesson carried into the plan's protocol:
nothing else runs during a timing run.

## Approved (owner: go for everything the council approved, with its conditions)

| # | What | Measured | Identical | Condition → plan task |
|---|---|---|---|---|
| N2 | `cell_mask`: `ndimage.binary_fill_holes` → pad 1 px + 4-connected `cv2.floodFill` from the corner | CLEAN whole count, 16 tiles: 846.6 → 819.0 ms/img (844.9/846.6/851.5 vs 818.3/819.0/820.3) = **−27.6 ms**, ≈ 1.8 s per 64 images at every level. (The contended isolated figure, 50.5 → 4.2 ms, over-states it; the profile put the old call at 32 ms.) | mask exact 69/69; full-count fingerprint 0/69 at level 1 | Runs on the level-0 ruler path too: fingerprint level 0, diff `score.py --params '{"engine":0}'` before/after, test a border-touching hole, an all-0 and an all-255 mask → **Task 10** |
| S4/N4 | exact `uint8` median from a 256-bin histogram instead of `np.median` | `paint_lines` 4.95 → 3.55 ms/img; in a stitch 9.58 → 6.37 ms/call (true pairs only) | exact float equality 69/69 + odd-sized crops | uint8 only; never on `noise_threshold`'s float medians → **Task 11** |
| S3 | `detect_grid(a)` once per stitch instead of twice (`_grid_pitch` + seam) | 176.9 → 125.3 ms per true pair (−51.6 ms); contended, repeats 1.56/1.25/0.83 s — direction only | `(out, info)` exact, 10 pairs | inside one call, not a cross-call `id()` cache; re-measure clean → **Task 12** |
| S1 | stitch-cache key from one sha256 per image instead of both images' bytes per comparison | 1.893 → 0.0007 ms per pair (micro, 3 reps); ≤ 3.8 s per 2016-pair sweep serial, less wall-clock under 8 workers | groups / stitches / skipped equal | key built in ONE place so the sweep and `/api/count`'s confirmed-pair stitch agree → **Task 13** |
| S5 | `/api/pairs` + `/api/thumbs`: decode uploads in an 8-thread pool | 69 files 0.509 → 0.129 s; 24 files 0.174 → 0.052 s (3 reps each) | arrays equal | first-error-in-upload-order kept, with a test; `_DECODE_CACHE` locking verified → **Task 14** |
| O2 | Finest: run each model's same-shape TTA views together, sum in the original order | CLEAN, 4 tiles, 3 reps: −24 / −80 / −161 ms of ≈ 11.4 s | 0/4 | **spread exceeds effect**; measured on the serial path, but Task 8 makes Finest parallel; holds ≈ 135 MB of heatmaps → **Task 15, a measurement gate with a fixed ship rule** |

Risk check, not a speedup — **S6:** `_stitch_pair_uncached` is deterministic
across threads and call history (10 true pairs: fresh = after 20 other pairs =
8 threads at once). This clears the main identity risk of the parallel sweep.
Gap: nobody checked that any of the 10 took the ORB/RANSAC rotation branch —
Task 5 now carries a test that forces it.

## Round 4 rejected

| Idea | Result | Why |
|---|---|---|
| S2 sweep workers 4/12/16/24; `cv2.setNumThreads(1)` | 12.6 / 10.8 / 11.3 / 12.7 ms/pair vs **10.7 at 8**; single-threaded OpenCV 16.0 (8 w), 13.1 (16 w); all identical | the plan's `min(8, cpus)` is already the optimum |
| O1 `intra_op_num_threads` with spin off, solo and two at once | solo run contaminated — but threads=16 reproduced the clean default (0.733 vs 0.734 s), and ORT's default is the 16 physical cores. Two at once: default 0.81 / 1.88 s (Quick / Normal) beat 8 (0.97 / 2.33) and 12 (0.86 / 1.98) | default stays; same verdict as round 1, now also with spin off and two slots |
| O3 `astype(copy=False)` on the already-float32 stack and output | micro −3.8 / −5.6 / −24.5 ms per count (Q/N/F); whole count +4.5 ms = noise | invisible where it matters |
| O4 cache the manifest / sidecar JSON reads | 0.2 ms per count in total (4 reads, all of `cellnet.json`) | not worth a cache-invalidation bug |
| O5 `session.set_denormal_as_zero` | +8 / −14 ms = noise; 0/69 mismatches at Quick and Normal | no speed effect, and it is arithmetic-adjacent |
| N3 unlabelled `peak_local_max` then filter | **not identical** — 138/138 calls differ (per-region vs global suppression) — and 4.7× slower | dead |
| N5 hoist the 3×3 structuring element | 3 µs per count | noise |

## Where the classical time goes now (profile N1, Quick, ms per image)

`seed_response` 154 (`matchTemplate` 72 over 3 calls, `peak_local_max` 69 over 2)
· `paint_lines` 68 (`inpaint` 58) · `blob_contours` 41 (deleted by Task 3) ·
`cell_mask` 36 (`binary_fill_holes` 32 → Task 10) · `noise_threshold` 21 ·
`_line_profiles` 15 · `texture_map` 9 · `detect_grid` 4. After Tasks 3 and 10
what remains is `matchTemplate`, `peak_local_max` and `inpaint` — float or
algorithmic, with no bit-identical replacement. **The classical path is now
mined out under this constraint.** Note that none of these stages can be
skipped on the ML path: `mask` feeds `seed_response` through `labels`, and its
output `sm` is a detector input channel.

## Round 4 council verdict

| # | Verdict | Note |
|---|---|---|
| S3 | **GO** | ranked first: real, cheap, low risk |
| N2 | **CONDITIONAL** | largest win; sign-off weighted like a threshold refit because a bug would silently move `score.py` / `ml/loo.py` |
| S4/N4 | **GO** | small, exact |
| S1 | **CONDITIONAL** | see the correction below |
| S5 | **CONDITIONAL** | error order + test; cache locking confirmed at `app.py` `_BytesLRU` |
| S6 | GO (informational) | rotation branch untested → added to Task 5 |
| O2 | **CONDITIONAL** | one more clean repeat set; the report's author recommended no-go |
| S2, O1, O3, O4, O5, N3, N5 | NO-GO | as the rejects table |

Council points carried into the plan:

- Only CLEAN numbers and micro-timings may move a decision; the contended ones
  are direction-only and are re-measured by their tasks.
- No end-to-end run of the whole stack combined exists. Task 16 Step 5 is that
  run, and now also covers a pairs-heavy batch and name groups on.
- **Correction to the council (S1).** Its Skeptic held that the stitch cache
  never carries from the sweep to the count, because `/api/pairs` decodes with
  `share=False` and `/api/count` with `share=True`. That is true for 16-bit
  input only. `_decode_all`'s own docstring: "uint8 input has no stretch to
  share either way, so it is untouched" — for the 8-bit TIFs this app normally
  sees the pixels are equal and the cache hits today. Hence S1's condition: one
  key builder, same key at every call site.

# Build log

Baseline (`ml/runs/speed_baseline.json`, saved before any task): L0 0.318, L1 0.834,
L2 2.464, L3 12.649 s/img, sweep 34.52 ms/pair (69 tiles, 1 rep, idle machine).
Classical ruler baseline: `ml/runs/score_engine0_before.txt`, F1 0.699.

- **Task 1** (identity ruler): baseline saved, sharded `--jobs 8` check confirmed
  it matches the serial run. Tool extended with `--jobs N` for untimed parallel
  verification (not in the original plan text; speeds routine checks ~3x without
  affecting any timed measurement, which always runs serial).
- **Task 2** (dead code delete): 128 tests passed, IDENTICAL.
- **Task 3** (drop contours): 128 tests passed, IDENTICAL. Also fixed a stale
  `contours` mention in `count_cells`'s docstring (Task 3 agent's own leftover).
- **Task 4** (spin off): L0 0.298, L1 0.745, L2 1.684, L3 11.821 s/img, sweep
  34.54 ms/pair — IDENTICAL. Normal 2.46 -> 1.68 s/img, close to the plan's
  measured 2.43 -> 1.62.
- **Task 5** (parallel sweep): 102 tests passed (incl. rotation-determinism),
  IDENTICAL. L0 0.297, L1 0.708, L2 1.579, L3 11.062 s/img, sweep 34.5 -> 10.96
  ms/pair (plan target <=14). Note: this task's commit (35d281f) was made
  before verification completed, due to an `rtk git add` auto-finalizing the
  cherry-pick's conflict resolution; verification ran immediately after and
  passed cleanly, so the commit stands unmodified. Tightened protocol for all
  later tasks: verify strictly before commit.
- **Task 6** (count slots): memory measured L1 x1 0.98GB x2 1.75GB, L2 x1
  1.01GB x2 1.84GB, L3 x1 1.16GB x2 2.19GB -> TWO_SLOT_MIN_RAM_GB=7. Fixed a
  genuine ctypes `argtypes` bug in `measure_memory.py` (the plan's own template
  overflowed on 64-bit Windows: `GetProcessMemoryInfo` needs explicit argtypes
  for the pseudo -1 process handle, or ctypes truncates it). 98 tests passed,
  IDENTICAL.
- **Task 7** (client parallel slots): 38 files / 360 tests passed, oxlint
  clean, build clean. Fixed a mock-identity artifact in progressBus.test.ts's
  new "keeps two cards apart" test (`mockResolvedValue` shares one object
  reference across every call; `mockImplementation` gives each call a fresh
  object -- the real thing the test checks, key isolation, was never broken).
  Confirmed `BatchConfirm.tsx:232`'s uncaught TypeError (`useServedThumbs`,
  undefined `got[i]`) is pre-existing (reproduced on e5345d6, before this
  task's cherry-pick too) -- out of scope for this plan, untouched. Note:
  `rtk`'s wrapped `npm test` silently drops unhandled-error detail from its
  summary (showed "PASS(5) FAIL(0)" with 2 real unhandled errors present) --
  use `./node_modules/.bin/vitest.cmd run` directly in `web/` for real signal.
- **Task 8** (models parallel): 18 tests passed, IDENTICAL (both `--jobs 8` and
  full serial `--time` runs). Serial L3 11.97 s/img, `ml_parallel=True` L3
  9.54 s/img (8-tile direct measurement -- `identity_check.py`'s `--time` flag
  doesn't pass `ml_parallel`, so its own L3 number reflects the unchanged
  serial default, not this feature; noted as a tool gap, not fixed, since
  changing it would change every other task's timing baseline meaning). Plan's
  own reference: 11.34 -> 9.31 s.
- **Task 9** (heatmap cache): found and fixed a pre-existing test-isolation
  bug -- `test_ml_infer.py`'s `importlib.reload(infer)` calls replaced
  `ml.infer.WeightsMissing`'s class identity for the rest of the pytest
  session (module reload always mints new class objects), silently breaking
  `app.py`'s deferred-import except-clause matching whenever
  `test_api_count.py`'s weights-missing tests ran afterward. Latent before
  this task -- no prior scoped test list combined those two files. The
  reload itself was unnecessary: `_manifest()` re-reads its file fresh every
  call. Removed the three reload calls (and the now-dead `importlib`/
  `pipeline` local imports). All tests passed after the fix (3-file combo 75
  passed, `test_ml_infer.py` alone 10 passed, `test_api_count.py` alone 55
  passed), IDENTICAL.
- **Task 10** (flood-fill holes): 84 tests passed, IDENTICAL. `score.py
  --params engine:0` output byte-identical before/after (classical-ruler
  gate PASSED). Default `score.py` TOTAL precision 0.974 recall 0.983
  F1 0.978.
- **Task 11** (exact median): 85 tests passed, IDENTICAL.
- **Task 14** (parallel decode): 94 tests passed, IDENTICAL.
- **Task 12** (one `detect_grid` per stitch): 112 tests passed, IDENTICAL
  (`--jobs 8`). Re-measured clean on an idle machine, 10 named true pairs
  (hemo1 HNT sq1-4, KA1 sq1-4, KA2 sq1-2), 3 reps each, interleaved
  before/after per pair to cancel thermal/ordering drift (a naive
  before-then-after run showed a false regression from run-order bias alone):
  mean 126.6 -> 114.8 ms/pair (-11.8 ms, ~9%). Smaller than the plan's
  contended estimate (176.9 -> 125.3 ms) as expected -- that number was
  itself flagged contended/direction-only.
- **Task 13** (stitch-cache key from per-image digests): 95 tests passed.
  Identity check MISMATCH-free but needed two attempts -- first `--jobs 8`
  run hit an onnxruntime `bad allocation` (8-way ML memory pressure,
  unrelated to this task's diff, which touches only stitch-cache keying);
  retried at `--jobs 4`, IDENTICAL. Committed d2ffb79. Serial `--time` run
  (post laptop-restart): L0 0.279, L1 0.710, L2 1.664, sweep 34.5 -> 15.2
  ms/pair -- consistent with a real, small further drop. **L3 21.426 s/img
  is CONTENDED, not a regression**: `webwallpaper64.exe` (a live-wallpaper
  app, auto-launched on the post-restart login) was found burning 395+208
  CPU-s during the run -- L0-L2 barely moved (contention hits the heaviest
  multi-threaded stage hardest, same pattern as round 4's O1). Not re-run
  clean; Task 16's final re-measure supersedes this number anyway.
- **Task 15** (GATE, O2 Finest TTA passes grouped by shape): prototyped in
  `ml/infer.py::predict_stack` (order jobs by (model, k%2), sum in original
  order unchanged). `identity_check.py --compare` (full serial, all
  levels): IDENTICAL. Gate measurement, level 3, first 8 tiles, interleaved
  A/B/A/B/A/B, 3 reps -- two attempts:
  - Serial path: baseline [24705.9, 22253.5, 22965.9], grouped [22124.3,
    24296.8, 23559.2] ms/img -- sets overlap, no win.
  - Parallel path (`ml_parallel=True`, what Finest actually ships since
    Task 8): baseline [22484.0, 22266.7, 22308.8], grouped [21762.2,
    22026.7, 18423.5] ms/img. Literal gate condition (slowest grouped <
    fastest baseline, gain >= 100 ms) technically passes at +240 ms -- but
    the grouped set's OWN spread (18423.5 to 22026.7, 3603 ms) dwarfs that
    240 ms margin, which the plan's Global Constraint 6 names directly:
    "a saving smaller than the spread of its own repeats is not a
    measurement". Root cause: `webwallpaper64.exe`, a live-wallpaper app
    auto-launched on the post-restart login, was found still burning
    1700+900 CPU-s during this run -- the same contamination flagged in
    Task 13's log, never cleared. **Not shipped**: reverted
    (`git checkout -- ml/infer.py`) rather than ship on a noisy win. A
    clean re-measurement (idle machine, webwallpaper64 closed) is the
    correct next step if this is revisited; not attempted here since it
    was not authorized to close another running app without asking, and
    Task 16 does not depend on Task 15's outcome either way.
- **Task 16 Step 1** (final clean re-measure): `webwallpaper64.exe` fully
  killed first (all 9 respawned instances, confirmed zero remaining), then a
  lone serial `identity_check.py --compare ml/runs/speed_baseline.json
  --time` run, nothing else CPU-heavy in flight. IDENTICAL. L0 0.339, L1
  1.341, L2 2.851, L3 21.692 s/img, sweep 14.593 ms/pair.
  **CONTAMINATED, REPLACED 2026-09-23.** These were recorded as "the numbers
  of record for the round" and are not: a clean re-run of the same code and
  method put L3 at 15.676 s/img, and the cross-build timing run of
  2026-09-23 (`ml/runs/timing.json`: three interleaved repeats per build,
  one timing at a time, idle machine, spread under 1 %) measures this build
  at **Quick 0.702, Normal 1.453, Finest 9.483 s/img** over 32 captures.
  Whatever was still on the CPU here was never identified -- the run was
  believed clean when it was taken, which is why every timing since is
  interleaved and reports its own repeat spread. `web/src/lib/levels.ts`'s
  SEED_RATE was seeded from the contaminated numbers and has been re-seeded
  from the clean ones.
- **Task 16 Step 5** (real 64-image batch, end to end): full suites (Step 4)
  passed first (287 pytest, 360 vitest, oxlint clean, build clean), so this
  ran alone. Per the plan's own "Not in this plan" table this is API-level,
  not a screenshot of the UI: a script drives `POST /api/pairs` then
  `POST /api/count` per field with `COUNT_SLOTS` (2, this machine) concurrent
  in flight on a second server (`CELL_COUNTER_PORT=8478`), the same calls
  `BatchConfirm.tsx` makes, timed from dispatch to the last response. Three
  batches, all real captures from `data/tif` (no duplicated content): **default**
  (first 64 files, 30 real pairs + 4 singles, names off), **pairs-heavy** (32
  of the 33 true pairs the dataset actually contains, all 64 images paired),
  **names-on** (the same default 64, but the pairing sweep split into
  filename-prefix groups the way the client does with name grouping on).
  Single runs, not interleaved/repeated -- this is the one whole-stack number
  the round lacked, not a micro-timing subject to Global Constraint 6's
  repeat-spread rule.

  **SUPERSEDED 2026-09-23.** Single runs on a machine that had already been
  caught contaminated twice are not evidence, whatever they are called. The
  cross-build run of 2026-09-23 (`ml/runs/timing.json`, rendered in
  `ml/runs/comparison.html`) replaces them: 32 captures (whole name groups
  HNT, KNT, KA2, KA1 -- 16 pairs, one field each), every build interleaved
  A-E and repeated three times, one timing at a time, fresh server per rung.
  This build measures **13.4 s Quick, 33.7 s Normal, 237.0 s Finest** for the
  32-capture batch, against Sept 21's 21.4 / 55.4 / 302.1 s -- and those gaps
  are real by the report's own rule, since no two builds' repeat ranges
  overlap. The table below is left as recorded, over 64 captures, and must
  not be compared against the 32-capture numbers.

  | Batch | Level | Fields | Time | s/img | Plan's "Today" | Plan's "After all items" |
  |---|---|---|---|---|---|---|
  | default | Quick (1) | 34 (30 pair + 4 single) | 53.0 s (0.88 min) | 0.83 | 2.1-2.4 min | 0.9-1.0 min |
  | default | Normal (2) | 34 | 138.7 s (2.31 min) | 2.17 | 3.8-4.1 min | 1.7-1.8 min |
  | default | Finest (3) | 34 | 915.7 s (15.26 min) | 14.31 | 15.1-15.4 min | 9.7 min |
  | pairs-heavy | Quick (1) | 32 (all pair) | 49.7 s (0.83 min) | 0.78 | -- | -- |
  | pairs-heavy | Normal (2) | 32 | 121.9 s (2.03 min) | 1.90 | -- | -- |
  | pairs-heavy | Finest (3) | 32 | 920.7 s (15.35 min) | 14.39 | -- | -- |
  | names-on | Quick (1) | 34 | 49.4 s (0.82 min) | 0.77 | -- | -- |
  | names-on | Normal (2) | 34 | 126.6 s (2.11 min) | 1.98 | -- | -- |
  | names-on | Finest (3) | 34 | 773.2 s (12.89 min) | 12.08 | -- | -- |

  Quick lands on the plan's "After all items" projection (0.88 min vs
  0.9-1.0). Normal and Finest do not: Normal measures 2.3-2.4 min against a
  1.7-1.8 min projection, Finest 12.9-15.4 min against 9.7 min. **Recorded as
  measured, not adjusted to fit the projection** -- the "After all items"
  table was itself built from earlier rounds' per-item deltas stacked
  arithmetically on a projected "Today", never validated end to end until
  this step, which is exactly the gap the round-4 council flagged. Pairs-heavy
  shows no meaningful separation from default at any level (Task 12/13's
  per-pair savings are real but small next to the detector's own per-field
  cost, especially at Finest where the detector is 94.8% of the time per
  Step 2's fresh profile). Names-on's lower Finest number (12.89 vs 15.26 min
  for the same 34 fields) is a single, non-interleaved run each -- most likely
  ordinary machine variance between two sequential ~13-15 min runs, not a
  causal effect of name grouping (name grouping only changes the pairing
  sweep's own cost, a fraction of a second next to ~900s of counting); it is
  reported as measured and not claimed as a finding.
