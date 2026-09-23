/** Hand-made capture groups for the confirm screen.
 *
 *  A group means exactly what a name group means (see `nameGroups.ts`): a fence
 *  for the overlap sweep. It never merges anything by itself — the server still
 *  decides from pixels whether two captures are halves of one field, so
 *  `pipeline.group_captures`'s standing ruling holds: renaming or regrouping a
 *  file cannot change the answer for any pair that is actually tested.
 *
 *  What a hand-made group DOES add is a promise to report back. A pair the user
 *  put together themselves is a claim, and `runBatch` answers it either with the
 *  merge offer or with a line on the scan screen saying the two do not overlap.
 *  Without that, hand-grouping two captures that turn out not to match would
 *  look identical to hand-grouping two that do.
 *
 *  Groups hold FILE KEYS (`"name size"`, the identity `useGallery` dedupes by),
 *  never indices: the staged list is edited while the groups stand, and an index
 *  captured before a removal points at the wrong capture afterwards.
 */

import type { NameGroup } from "./nameGroups"

export interface ManualGroup {
  id: string
  /** What the band is headed by. Defaults to "Group 1", "Group 2", …; the user
   *  can type anything, and nothing downstream reads it. */
  name: string
  /** File keys, in the order the user put them in. */
  keys: string[]
}

let seq = 0
/** Identity for a band, so renaming or reordering never confuses two of them.
 *  Not derived from the name: two groups may legitimately share one. */
export function newGroupId(): string {
  seq += 1
  return `mg${seq}`
}

/** The lowest unused "Group n". A group deleted from the middle gives its
 *  number back, so a user who makes three, removes the second and makes another
 *  gets "Group 2" rather than "Group 4". */
export function nextGroupName(groups: ManualGroup[]): string {
  const taken = new Set(groups.map(g => g.name))
  for (let n = 1; ; n += 1) {
    const name = `Group ${n}`
    if (!taken.has(name)) return name
  }
}

/** Turn what the filename rule worked out into groups the user can edit.
 *
 *  Customising starts from the automatic answer rather than from a blank page:
 *  on a real EVOS batch the prefixes are already right, so the usual edit is
 *  moving one stray capture, not building thirty-two bands by hand. A band the
 *  prefix rule gave up on (`ungrouped`) becomes an ordinary numbered group —
 *  it was already being swept as one bucket, so nothing about the run changes.
 */
export function seedFromAuto(keys: string[], auto: NameGroup[]): ManualGroup[] {
  const out: ManualGroup[] = []
  for (const g of auto) {
    out.push({
      id: newGroupId(),
      name: g.ungrouped || !g.key ? nextGroupName(out) : g.key,
      keys: g.indices.map(i => keys[i]).filter(Boolean),
    })
  }
  return out.filter(g => g.keys.length > 0)
}

/** Drop keys for captures that are no longer staged, and drop any group that
 *  leaves empty. Removing a capture must not leave a band naming a file that is
 *  not on the screen. */
export function pruneGroups(groups: ManualGroup[], keys: string[]): ManualGroup[] {
  const live = new Set(keys)
  const out = groups
    .map(g => ({ ...g, keys: g.keys.filter(k => live.has(k)) }))
    .filter(g => g.keys.length > 0)
  // Referential identity matters: this runs from a `useMemo`/setState path on
  // every staged-file change, and a fresh array every time would re-render the
  // whole board for a drop that changed nothing.
  const same = out.length === groups.length
    && out.every((g, i) => g.keys.length === groups[i].keys.length)
  return same ? groups : out
}

/** Move `move` into `target` (a group id, or null for the ungrouped tray),
 *  taking them out of wherever they were. A group emptied by the move is
 *  removed: an empty band is a thing the user has to tidy up by hand for no
 *  reason. */
export function assignTo(
  groups: ManualGroup[], move: string[], target: string | null,
): ManualGroup[] {
  const moving = new Set(move)
  const out = groups
    .map(g => (g.id === target
      // Keep the target's own members in place and append the arrivals, so a
      // drop lands at the end rather than reshuffling what was already there.
      ? { ...g, keys: [...g.keys.filter(k => !moving.has(k)), ...move] }
      : { ...g, keys: g.keys.filter(k => !moving.has(k)) }))
    .filter(g => g.keys.length > 0)
  return out
}

/** A new group holding `keys`, appended. */
export function groupFrom(groups: ManualGroup[], keys: string[]): ManualGroup[] {
  if (!keys.length) return groups
  const id = newGroupId()
  const made: ManualGroup = { id, name: nextGroupName(groups), keys: [] }
  return assignTo([...groups, made], keys, id)
}

/** The staged keys that belong to no group, in staged order. */
export function ungroupedKeys(keys: string[], groups: ManualGroup[]): string[] {
  const used = new Set(groups.flatMap(g => g.keys))
  return keys.filter(k => !used.has(k))
}

/** Project the groups onto the staged order, as the sweep wants them.
 *
 *  Indices are into `keys`, ascending, exactly as `groupByName` returns them —
 *  the sweep maps the server's local indices back through this list. The
 *  leftovers come last as one `ungrouped` bucket: they are still swept against
 *  each other, which is the behaviour a capture nobody grouped had anyway.
 */
export function projectGroups(keys: string[], groups: ManualGroup[]): NameGroup[] {
  const at = new Map(keys.map((k, i) => [k, i]))
  const out: NameGroup[] = []
  for (const g of groups) {
    const indices = g.keys
      .map(k => at.get(k))
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b)
    if (indices.length) out.push({ id: g.id, key: g.name, indices, ungrouped: false })
  }
  const left = ungroupedKeys(keys, groups)
    .map(k => at.get(k))
    .filter((i): i is number => i !== undefined)
  if (left.length) out.push({ key: "", indices: left, ungrouped: true })
  return out
}

/** The hand-made pairs this grouping claims: every group of exactly two, as
 *  index pairs into `keys`. These are the ones the run owes an answer for. */
export function claimedPairs(keys: string[], groups: ManualGroup[]): [number, number][] {
  return projectGroups(keys, groups)
    .filter(g => !g.ungrouped && g.indices.length === 2)
    .map(g => [g.indices[0], g.indices[1]] as [number, number])
}
