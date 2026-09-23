import { effectiveTotal, fingerprintOf } from "./geom"
import type { FieldEdits } from "./geom"
import type { CountedField, GalleryItem } from "./types"

/** A haemocytometer large square is 4 by 4 small squares, and one EVOS 10x
 *  capture covers three of its four rows. So a full square is a MERGED field:
 *  measured on data/tif, a stitched pair reports grid_cols 4, grid_rows
 *  4 with every frame side detected, and a lone capture reports 4 by 3 with
 *  the bottom side missing.
 *
 *  KNOWN LIMITATION. This is a 10x rule. At 4x the whole grid is in frame and
 *  grid_cols is far larger, so no field passes and the divisor comes back 0
 *  for the user to type. That is the safe direction to be wrong in: a wrong
 *  divisor would silently scale the result. */
const FULL_COLS = 4
const FULL_ROWS = 4

export function isFullSquare(f: CountedField | null | undefined): boolean {
  if (!f || f.grid_cols !== FULL_COLS || f.grid_rows !== FULL_ROWS) return false
  const s = f.frame?.sides
  return !!s && s.left && s.right && s.top && s.bottom
}

/** Why a field is not a full square, for the calculator's "left out" line -
 *  the API's grid_cols/grid_rows and frame.sides say exactly which test
 *  failed, and a user looking at a square that plainly IS complete needs to
 *  see which one, not just "partial". */
export function partialReason(f: CountedField | null | undefined): string | null {
  if (!f) return null
  if (isFullSquare(f)) return null
  // Either axis missing is enough to call it "no grid" - a field with cols but
  // no rows (or vice versa) has nothing sensible to say about, so this does
  // not wait for both to be absent.
  if (!(f.grid_cols > 0) || !(f.grid_rows > 0)) return "no grid"
  const parts: string[] = []
  if (f.grid_rows !== FULL_ROWS) parts.push(`${f.grid_rows} of ${FULL_ROWS} rows`)
  if (f.grid_cols !== FULL_COLS) parts.push(`${f.grid_cols} columns`)
  const s = f.frame?.sides
  const missing = (["left", "right", "top", "bottom"] as const).filter(k => !s?.[k])
  if (missing.length) {
    const list = missing.length === 1 ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`
    parts.push(`${list} boundar${missing.length === 1 ? "y" : "ies"} not found`)
  }
  return parts.join("; ")
}

/** cells/mL for standard haemocytometer large squares, each holding 0.1 uL.
 *  The only implementation - the server has none - because the gallery
 *  computes it without a round trip. */
export function concentrationOf(cells: number, squares: number, dilution: number): number {
  if (!(squares > 0) || !Number.isFinite(cells) || !Number.isFinite(dilution)) return 0
  return (cells / squares) * dilution * 1e4
}

/** What the calculator opens with: cells and squares taken from the full
 *  squares alone, so the numerator and the divisor describe the same volume.
 *  A partial capture contributes to neither. Cell counts come through
 *  effectiveTotal, the rule the gallery cards and the workbench already share,
 *  so the calculator can never disagree with the badge above it. */
export function countedDefaults(
  items: GalleryItem[], byField: Record<string, FieldEdits>,
  includePartial = false,
  /** One band's captures only, when the calculator has been handed a band.
   *  `""` is the band of captures nobody grouped. Undefined means the whole
   *  session, which is what a session with one band or no bands at all is. */
  group?: string,
): { cells: number; squares: number } {
  let cells = 0, squares = 0
  for (const it of items) {
    if (group !== undefined && (it.group ?? "") !== group) continue
    const f = it.field
    const frac = isFullSquare(f) ? 1 : includePartial ? partialFraction(f) : 0
    if (!frac) continue
    cells += effectiveTotal(f!, byField[fingerprintOf(f!)], f!.width, f!.height)
    squares += frac
  }
  return { cells, squares }
}

/** How much of a large square a partial capture covers, as rows in frame over
 *  the four a full square has — a lone 10x capture is 4 by 3, so 0.75. Same 10x
 *  rule as isFullSquare, and anything outside it (a 4x capture, a field with no
 *  grid) contributes nothing rather than a wrong divisor. */
export function partialFraction(f: CountedField | null | undefined): number {
  if (!f || f.grid_cols !== FULL_COLS) return 0
  if (!(f.grid_rows > 0) || f.grid_rows > FULL_ROWS) return 0
  return f.grid_rows / FULL_ROWS
}

/** A number split for display as mantissa times ten to the exponent. */
export function formatSci(v: number): { mantissa: string; exponent: number } | null {
  if (!Number.isFinite(v) || v <= 0) return null
  const exponent = Math.floor(Math.log10(v))
  return { mantissa: (v / Math.pow(10, exponent)).toFixed(2), exponent }
}

/** The dilution field keeps the RAW STRING the user typed, because a number is
 *  lossy while typing: "1." parses to 1, re-renders as "1", and the decimal
 *  point the user just typed disappears — "1.5" was unreachable. Parsing
 *  happens here, on use, and an unfinished or empty entry reads as 1 (no
 *  dilution) rather than 0, which would zero the whole result. */
export function parseDilution(raw: string): number {
  const v = parseFloat(raw)
  return Number.isFinite(v) && v > 0 ? v : 1
}

/** Same rule for the two integer slots: an unfinished entry must not silently
 *  become a counted value again, so the string is what is stored and 0 is what
 *  an unparsable entry contributes. */
export function parseCount(raw: string): number {
  const v = parseFloat(raw)
  return Number.isFinite(v) && v >= 0 ? v : 0
}

// ----------------------------------------------------- surviving a view change

/** The dock is unmounted on every trip to the workbench, so a typed dilution or
 *  an overridden cell count would be gone on the way back. sessionStorage keeps
 *  it for the life of the tab — the same lifetime as the counts it describes —
 *  and every access is guarded: a private window can throw on read AND write. */
export interface DockState {
  cells?: string
  squares?: string
  dilution?: string
  /** "1" when partial captures are counted too. A string like the rest, so the
   *  stored shape stays one map of strings. */
  partial?: string
  /** The band the calculator is working on, or absent for the whole session.
   *  `""` is a real value here: the band of captures nobody grouped. */
  group?: string
}

const DOCK_KEY = "cellcounter.concentration"

export function readDock(store?: Storage): DockState {
  try {
    const s = store ?? sessionStorage
    const raw = s.getItem(DOCK_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== "object" || Array.isArray(o)) return {}
    const pick = (k: keyof DockState) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {})
    return { ...pick("cells"), ...pick("squares"), ...pick("dilution"), ...pick("partial"),
      ...pick("group") }
  } catch {
    return {}
  }
}

/** Forget every typed override.
 *
 *  The dock lives in sessionStorage, which survives a reload; the counts it
 *  describes do not. A typed cells-per-square from before a reload therefore
 *  came back attached to an empty gallery and produced a confident cells/mL for
 *  captures that no longer exist (flow audit 2026-09-21, row 9). The app's rule
 *  is that a reload wipes the work, and these numbers are work. */
export function clearDock(store?: Storage): void {
  try {
    (store ?? sessionStorage).removeItem(DOCK_KEY)
  } catch { /* storage unavailable: there was nothing to forget */ }
}

export function writeDock(v: DockState, store?: Storage): void {
  try {
    const s = store ?? sessionStorage
    // `undefined`, never falsy: "" is a slot the user deliberately CLEARED to
    // type their own number, and treating it as absent snapped the counted
    // value straight back in — the box could not be emptied.
    if (v.cells === undefined && v.squares === undefined && v.dilution === undefined
      && v.partial === undefined && v.group === undefined) s.removeItem(DOCK_KEY)
    else s.setItem(DOCK_KEY, JSON.stringify(v))
  } catch { /* storage unavailable: the dock still works, it just forgets */ }
  listeners.forEach(f => f())
}

/** Hand the calculator a band and open it, from anywhere on the gallery screen.
 *
 *  Sending a band REPLACES what the calculator holds - it is one band's number,
 *  never a running total of several - so any typed override of the two counted
 *  slots goes with it. The dilution the user typed stays: it describes the
 *  sample they are measuring, not which captures they measured it from.
 */
export function openDockWith(group: string, store?: Storage): void {
  const cur = readDock(store)
  opens += 1
  writeDock({ dilution: cur.dilution, partial: cur.partial, group }, store)
}

/** Bumped by every `openDockWith`. The dock re-reads it on each notification and
 *  opens itself when it has moved - a plain "open" flag could not tell a second
 *  send from the first. */
let opens = 0
export function dockOpens(): number { return opens }

/** Restoring a session writes the dock while the dock itself is on screen, and
 *  a mounted component never re-reads storage on its own — the typed dilution
 *  would sit in sessionStorage and show nowhere. Anyone holding the dock's
 *  values subscribes here and re-reads when they change. */
const listeners = new Set<() => void>()

export function subscribeDock(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
