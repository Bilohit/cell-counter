/** The three quality rungs, mirroring `pipeline.LEVELS`.
 *
 *  The names are the whole interface. The accuracy behind each rung (F1, worst
 *  tile, seconds) is measured leave-one-tile-out and lives in docs/accuracy-evidence.md and
 *  ml/runs/loo.md; it deliberately never appears on screen, because a number a
 *  user cannot act on is clutter.
 */
/** Every name is five or six characters, and the bars set them in a monospace
 *  face: the rung's name is the ONE thing on those bars that changes as the
 *  slider moves, so a name that is wider than its neighbour shoves the
 *  Reprocess button - and the ring it becomes - sideways under the pointer. */
export const LEVELS = [
  { n: 1, name: "Quick" },
  { n: 2, name: "Normal" },
  { n: 3, name: "Finest" },
] as const

export const MIN_LEVEL = 1
export const MAX_LEVEL = 3
export const DEFAULT_LEVEL = 2

export function levelName(n: number): string {
  return LEVELS.find(l => l.n === n)?.name ?? `Level ${n}`
}

/* The rungs used to carry a second line saying how they are built - "no
 * model", "3 models, 8 views". Removed 2026-09-18: how many networks a rung
 * runs is an implementation detail no bench user can act on, and the estimate
 * beside the button already says what moving the slider costs them, in
 * seconds. */

/** Card chips used to read "L3", which named the rung to nobody. The chip is
 *  narrow, but the names are short enough to fit as words. */
export const levelTag = (n: number) => (n >= MIN_LEVEL && n <= MAX_LEVEL ? levelName(n) : "—")

/** Seconds per image, measured end to end on the dev workstation (README "Three
 *  settings"). Only a seed: the store replaces each with the rate the current
 *  run actually achieves, so a slower lab laptop corrects its own estimate
 *  after the first image instead of promising a workstation's number.
 *  MEASURED 2026-09-23, the cross-build timing run (ml/runs/timing.json):
 *  median of three interleaved repeats, one lone count per image over 32
 *  captures, idle machine. The values before these came from a contaminated
 *  identity_check --time run and were 1.4-2.3x too slow. */
export const SEED_RATE: Record<number, number> = { 1: 0.702, 2: 1.453, 3: 9.483 }

/** A duration a person can read. Seconds up to a minute, then whole minutes —
 *  an estimate accurate to the second would be a lie either way. */
export function humanSecs(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "~0 s"
  if (s < 60) return `~${Math.max(1, Math.round(s))} s`
  return `~${Math.round(s / 60)} min`
}

/** Would a Reprocess at `level` pick this image up? True in either direction:
 *  an image counted higher is recounted lower just the same, and an image with
 *  no count at all carries level 0 and is always included. One predicate, used
 *  by both the store that runs the batch and the cards that mark it. */
export function needsLevel(countedAt: number | undefined, level: number): boolean {
  return (countedAt ?? 0) !== level
}
