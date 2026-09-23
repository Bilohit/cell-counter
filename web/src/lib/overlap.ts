/** Comparisons an overlap sweep will make: inside each band, every capture
 *  against every other. A band of one compares with nobody and is never sent.
 *
 *  This is what the wait is made of, so it is what the progress bar counts -
 *  captures alone would say a 12-capture drop and a 12-capture drop split into
 *  six bands are the same wait, when one is 66 comparisons and the other 6. */
export function sweepComparisons(bandSizes: number[]): number {
  return bandSizes.reduce((n, k) => n + (k > 1 ? (k * (k - 1)) / 2 : 0), 0)
}

/** Below this many comparisons the sweep is over before a progress bar has
 *  said anything, and a bar that flashes is worse than no bar.
 *
 *  MEASURED 2026-09-21, cold (`pipeline._STITCH_CACHE` cleared per run, 1360 x
 *  1024 captures from data/png): 45 comparisons 2.91 s, 78 comparisons 5.22 s
 *  and 4.88 s, 91 comparisons 5.71 s, 120 comparisons 7.47 s - a flat ~64 ms
 *  per cold comparison. 78 is the smallest count that crosses five seconds;
 *  75 is that, rounded down, and upload and decode sit on top of it. A warm
 *  sweep runs at 2.8 ms per comparison off the stitch cache, but that is a
 *  re-count of captures already seen, never the first sweep of a fresh drop -
 *  which is the wait this exists for. */
export const PROGRESS_MIN_COMPARISONS = 75

/** "almost done", once the sweep's last twentieth is in sight, and "" before
 *  that.
 *
 *  It used to say how much longer the run had, in seconds or minutes, computed
 *  from this run's own rate. Removed 2026-09-21 (user ruling): a live countdown
 *  is the most-read text on the screen and the least dependable thing on it -
 *  the rate is drawn from comparisons already made, and a band the size check
 *  rejects outright costs a fraction of one that survives it, so the figure
 *  moved whenever the work changed shape. The one claim that survives is the
 *  one the arithmetic can keep: the end is near.
 *
 *  Same gates as before, and for the same reasons. Nothing is said until a
 *  twentieth of the work is done, because an estimate drawn from two
 *  comparisons swings by minutes; nothing is said at `done >= total`, because
 *  that is finished, not almost.
 */
export function remainingLabel(done: number, total: number, elapsedMs: number): string {
  if (done < 1 || done < total / 20 || done >= total || elapsedMs < 1200) return ""
  const left = ((total - done) * elapsedMs) / done / 1000
  return left < 5 ? "almost done" : ""
}


/** Where the two captures of an overlapping pair sit relative to each other. */
export interface Placement {
  ax: number; ay: number; aw: number; ah: number
  bx: number; by: number; bw: number; bh: number
  /** Union bounding box: origin (may be negative in either capture's frame). */
  x0: number; y0: number; uw: number; uh: number
}

/** Lay a pair out in one frame.
 *
 *  `stitch_pair` reports dx/dy as the LOWER capture's origin in the UPPER
 *  one's frame, and it swaps its two inputs when the second capture is the
 *  upper one — so `swapped` means a sits at (dx, dy) under b, not the reverse.
 *  A pair is same-size by definition (stitch_pair refuses mismatched shapes),
 *  so whichever size has loaded stands in for the one that has not; before
 *  either is known the union box is empty and the caller draws nothing.
 *
 *  dx is a sideways drift and is routinely negative, which puts the union
 *  origin left of both captures; every position is returned in that origin's
 *  frame so a caller can express it as a percentage of the box.
 */
export function placePair(
  dx: number, dy: number, swapped: boolean,
  aSize: [number, number] | null, bSize: [number, number] | null,
): Placement {
  const [ax, ay] = swapped ? [dx, dy] : [0, 0]
  const [bx, by] = swapped ? [0, 0] : [dx, dy]

  const size = aSize ?? bSize
  const [aw, ah] = aSize ?? size ?? [0, 0]
  const [bw, bh] = bSize ?? size ?? [0, 0]

  const x0 = Math.min(ax, bx), y0 = Math.min(ay, by)
  return {
    ax, ay, aw, ah, bx, by, bw, bh, x0, y0,
    uw: Math.max(ax + aw, bx + bw) - x0,
    uh: Math.max(ay + ah, by + bh) - y0,
  }
}

/** The scale that fits `uw × uh` inside a measured box, letterboxed. A box
 *  with no height yet (a not-yet-laid-out parent) constrains width only. */
export function fitScale(uw: number, uh: number, boxW: number, boxH: number): number {
  if (uw <= 0 || uh <= 0 || boxW <= 0) return 0
  return Math.min(boxW / uw, boxH > 0 ? boxH / uh : Infinity)
}
