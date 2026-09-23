/** Filename-prefix grouping for the overlap sweep.
 *
 *  The sweep runs `stitch_pair` on every i<j combination of a batch, so it is
 *  O(n^2): 64 captures is 2016 stitches. Researchers name their captures by
 *  sample - "hemo1 KGN sq2.1.tif" - and two captures of one field always share
 *  that prefix, so comparing across prefixes is work that can only ever answer
 *  "no". Grouping the batch by prefix and sweeping inside each group took the
 *  real data/png folder from 2346 comparisons to 234.
 *
 *  This can only REMOVE candidate pairs, never invent one, which is what keeps
 *  `pipeline.group_captures`'s standing ruling intact - "image-based only:
 *  renaming a file must not change the answer" still holds for every pair that
 *  is actually tested. The filter lives here, on the client, so the endpoint
 *  and the pipeline never learn what a filename is.
 */

/** A group of captures that will be swept against each other. */
export interface NameGroup {
  /** The shared prefix, as it appears in the filenames. "" when ungrouped. A
   *  hand-made group carries the name the user gave the band instead. */
  key: string
  /** Set only for a hand-made group (see `manualGroups.ts`), where the band has
   *  an identity of its own that survives a rename. The filename rule derives
   *  its groups fresh on every change, so they have nothing to identify. */
  id?: string
  /** Indices into the array passed to `groupByName`, in their original order. */
  indices: number[]
  /** True when the prefix rule gave up on these: a bucket at or over the limit
   *  with no further space to split on. They are still swept in full against
   *  each other - the old behaviour, confined to them - so nothing is silently
   *  skipped. They carry no colour and no prefix in the UI. */
  ungrouped: boolean
}

/** A bucket at or over this many files re-splits on its next space. Chosen by
 *  the user: the natural group is 8 (four squares, two captures each), so 10
 *  leaves headroom for a stray capture without letting a whole session's worth
 *  of one prefix through as a single bucket. */
export const GROUP_LIMIT = 10

/** `"hemo1 KGN sq2.1.tif"` -> `["hemo1", "KGN", "sq2.1"]`. The extension is
 *  dropped first so a single-token name groups as "ha1", not "ha1.tif". */
function tokens(name: string): string[] {
  return name.replace(/\.[^.\s]+$/, "").split(" ").filter(Boolean)
}

/** Split `names` into the groups the sweep will run inside.
 *
 *  Depth 1 is the filename up to the first space. A bucket holding GROUP_LIMIT
 *  files or more re-splits on its next space - per bucket, so `10x` can stay
 *  one token deep while `hemo1` goes two. A bucket that is over the limit and
 *  has no deeper token left is returned `ungrouped`.
 *
 *  Order is preserved: groups come out in the order their first file appears,
 *  and each group's indices are ascending.
 */
export function groupByName(names: string[], limit = GROUP_LIMIT): NameGroup[] {
  const all = names.map((n, i) => ({ i, t: tokens(n) }))
  const out: NameGroup[] = []

  const split = (rows: typeof all, depth: number) => {
    const by = new Map<string, typeof all>()
    for (const r of rows) {
      const k = r.t.slice(0, depth).join(" ").toLowerCase()
      const bucket = by.get(k)
      if (bucket) bucket.push(r)
      else by.set(k, [r])
    }
    return [...by.values()]
  }

  const walk = (rows: typeof all, depth: number) => {
    for (const bucket of split(rows, depth)) {
      if (bucket.length < limit) {
        out.push({
          // The key is read off a real filename, so it keeps the user's own
          // capitalisation - grouping is case-insensitive, display is not.
          key: bucket[0].t.slice(0, depth).join(" "),
          indices: bucket.map(r => r.i),
          ungrouped: false,
        })
        continue
      }

      // At or over the limit: try the next space. The deeper split is only
      // taken if it leaves every capture with company.
      //
      // MEASURED: ten captures named "ha1 sq1.1" ... "ha1 sq5.2" trip the limit
      // at depth 1, and splitting them at depth 2 gives ten groups of ONE -
      // because the pair suffix (.1/.2) lives inside the same token as the
      // square. That sweeps zero pairs and silently reports no overlaps, which
      // double-counts every field. A split that orphans a capture is worse than
      // no split, so the bucket stays whole and is swept in full instead: slow,
      // and right. The real 69-file data/png folder splits cleanly under this
      // guard (hemo1 -> eight groups of 8, no singletons).
      const kids = split(bucket, depth + 1)
      const usable = kids.length > 1 && kids.every(k => k.length >= 2)
      if (usable) { for (const k of kids) walk(k, depth + 1); continue }

      out.push({ key: "", indices: bucket.map(r => r.i), ungrouped: true })
    }
  }
  walk(all, 1)
  return out
}

/** Whether a batch's names form a pattern worth arming the switch for: two or
 *  more groups, at least one of them a real group of two or more, and the lone
 *  captures a MINORITY of the batch. A drop of unrelated one-off names is all
 *  singletons and fails this, which is the point - the switch stays off and the
 *  user keeps the full sweep.
 *
 *  It used to demand that EVERY group hold a pair, which one lone capture was
 *  enough to break: six "ha1 sq*" files and a single "KGN sq2.1" left the
 *  switch off and the whole batch swept in full, when the names plainly line
 *  up. A singleton is not a broken pattern - a field can be captured once, and
 *  it has nothing to be swept against either way. */
export function hasNamePattern(groups: NameGroup[]): boolean {
  if (groups.length < 2) return false
  const lone = groups.filter(g => g.indices.length < 2)
  if (lone.length === groups.length) return false
  const total = groups.reduce((a, g) => a + g.indices.length, 0)
  return lone.length * 2 < total
}

/** The hue ring the bands are coloured from, as `[hue, chroma x, lightness +]`.
 *
 *  Ordered so consecutive groups land far apart, and trimmed per hue: oklch is
 *  uniform in lightness but NOT in how much chroma a hue can carry there, so
 *  the yellows sit a step darker and the blues take more. A flat `i * 40deg`
 *  step put two near-identical greens beside each other and landed one of them
 *  on the app's own accent.
 */
const HUES: readonly (readonly [number, number, number])[] = [
  [255, 1.15, 0], [34, 1.0, 0], [163, 0.92, 0], [318, 1.06, 0], [88, 0.8, -0.05],
  [203, 1.1, 0], [356, 1.02, 0], [131, 0.88, 0], [285, 1.12, 0], [58, 0.84, -0.04],
]

/** The colour for the i-th group, as a CSS value. Lightness and chroma come
 *  from `--gc-l` / `--gc-c`, which every theme sets, so the ring needs no
 *  per-theme table. Past ten groups it repeats one step darker, so the 11th
 *  never reads as the 1st on a screen showing both. */
export function groupColor(i: number): string {
  const [h, c, l] = HUES[i % HUES.length]
  const tier = Math.floor(i / HUES.length) * -0.07
  return `oklch(calc(var(--gc-l) + ${(l + tier).toFixed(3)}) calc(var(--gc-c) * ${c}) ${h})`
}

/** Columns a band of `n` captures lays out in: eight across for the usual group
 *  (four squares, two captures each), and for any other size the closest count
 *  that still fills whole rows - ten goes 5 and 5, never 8 and a ragged 2. */
export function bandColumns(n: number): number {
  return n <= 8 ? n : Math.ceil(n / Math.ceil(n / 8))
}

/** Comparisons the sweep will run for these groups, against the n*(n-1)/2 it
 *  would run without them. Used for the one number the flyout shows. */
export function sweepCost(groups: NameGroup[], total: number) {
  const pairs = (n: number) => (n * (n - 1)) / 2
  return {
    full: pairs(total),
    grouped: groups.reduce((a, g) => a + pairs(g.indices.length), 0),
  }
}
