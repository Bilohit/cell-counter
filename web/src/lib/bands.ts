/** How the counted gallery lays itself out.
 *
 *  A band is the group a capture was swept in, carried onto the card by
 *  `runBatch` (see `GalleryItem.group`). Bands exist only to be looked at and
 *  to scope the concentration calculator — nothing here reaches a count.
 *
 *  The leftovers get a band of their own, keyed `""`. It is a real band for the
 *  calculator's purposes: captures nobody grouped are still a set of fields the
 *  user may want a number for. It is never named after anything, so it sorts
 *  last and is called what it is.
 */

import { effectiveTotal, fingerprintOf } from "./geom"
import type { FieldEdits } from "./geom"
import { isFullSquare, partialFraction } from "./concentration"
import type { GalleryItem } from "./types"

/** The key of the band holding everything nobody grouped. */
export const UNGROUPED = ""
export const UNGROUPED_NAME = "Ungrouped"

export interface Band {
  key: string
  name: string
  items: GalleryItem[]
}

/** The bands, in the order their first capture appears in the gallery, with the
 *  ungrouped leftovers last. One band means the session is not really grouped,
 *  and the caller draws a plain grid — that is the caller's decision, not this
 *  function's, so a single band still comes back named. */
export function bandsOf(items: GalleryItem[]): Band[] {
  const by = new Map<string, Band>()
  for (const it of items) {
    const key = it.group ?? UNGROUPED
    const band = by.get(key)
    if (band) band.items.push(it)
    else by.set(key, { key, name: key || UNGROUPED_NAME, items: [it] })
  }
  const out = [...by.values()]
  // Insertion order is first-appearance order already; only the leftovers move,
  // and they move to the end.
  const loose = out.findIndex(b => b.key === UNGROUPED)
  if (loose >= 0 && loose < out.length - 1) out.push(...out.splice(loose, 1))
  return out
}

/** What one band contributes to a concentration: the same rule
 *  `countedDefaults` applies to a whole session, over this band's captures
 *  alone. Partial captures are excluded here too unless asked for — the
 *  numerator and the divisor have to describe the same volume. */
export function bandTotals(
  band: Band, byField: Record<string, FieldEdits>, includePartial = false,
): { cells: number; squares: number; full: number; partial: number; counted: number } {
  let cells = 0, squares = 0, full = 0, partial = 0, counted = 0
  for (const it of band.items) {
    const f = it.field
    if (!f) continue
    if (isFullSquare(f)) full += 1
    else partial += 1
    // Every field's cells, full square or not. The band head says this one:
    // a band of one partial capture reporting "0 cells" beside a card badge
    // reading 181 says the count failed, which it did not.
    counted += effectiveTotal(f, byField[fingerprintOf(f)], f.width, f.height)
    const frac = isFullSquare(f) ? 1 : includePartial ? partialFraction(f) : 0
    if (!frac) continue
    cells += effectiveTotal(f, byField[fingerprintOf(f)], f.width, f.height)
    squares += frac
  }
  return { cells, squares, full, partial, counted }
}
