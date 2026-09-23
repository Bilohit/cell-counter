import { isCountedField, type CountedField, type Dot, type Edits, type Field, type M3, type Pt } from "./types"

// The server reports `transform`: a 3x3 matrix taking ORIGINAL-image px to
// DISPLAYED-image px (identity when nothing is cropped). Hand edits are kept
// in original px, so they survive — and visibly follow — any crop change.
export const IDENT: M3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

export function applyM(M: M3, [x, y]: Pt): Pt {
  const w = M[2][0] * x + M[2][1] * y + M[2][2]
  return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w,
          (M[1][0] * x + M[1][1] * y + M[1][2]) / w]
}

export function invM(M: M3): M3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = M
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e,
        D = f * g - d * i, E = a * i - c * g, F = c * d - a * f,
        G = d * h - e * g, H = b * g - a * h, I = a * e - b * d
  const det = a * A + b * D + c * G
  return [[A / det, B / det, C / det], [D / det, E / det, F / det], [G / det, H / det, I / det]]
}

// These all read CountedField-only members (transform/stitch/diameter/centers
// etc.), so they take one, not the union - a caller holding a possibly-failed
// `Field` narrows with `isCountedField` first (dotsNow/gridLinesOf/countedDots
// below do exactly that).
export const fieldM = (f: CountedField): M3 => f.transform ?? IDENT
export const toDisp = (f: CountedField, p: Pt): Pt => applyM(fieldM(f), p)
export const toOrig = (f: CountedField, p: Pt): Pt => applyM(invM(fieldM(f)), p)

/** Field identity: file names + stitch geometry. Crops deliberately do NOT
 *  change it, because the transform maps stored edits onto whatever is shown. */
export const fingerprintOf = (f: CountedField): string =>
  JSON.stringify([f.names, f.stitch ? [f.stitch.dx, f.stitch.dy, f.stitch.seam_y] : 0])

/** Every dot to draw, in DISPLAYED px, with its kind. */
export function dotsNow(f: Field | undefined, edits: Edits, imgW = Infinity, imgH = Infinity): Dot[] {
  // A per-field error entry (app.py: one bad field in an otherwise-good batch)
  // carries no centers at all - nothing to draw, and f.centers would be undefined.
  if (!isCountedField(f)) return []
  const r = (f.diameter || 22) * 0.5
  const inside = ([x, y]: Pt) => x >= 0 && y >= 0 && x < imgW && y < imgH
  const remD = edits.removed.map(q => toDisp(f, q))
  const gone = (p: Pt) => remD.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= r)
  const out: Dot[] = f.centers.filter(c => !gone(c)).map(c => [c[0], c[1], "auto"])
  // An added point cropped out of view is not on the slide area being shown:
  // it leaves the tally until the crop brings it back.
  //
  // An added point the detector has SINCE FOUND is dropped too, and that is the
  // same proximity test `gone` uses in the other direction. Hand-marking a cell
  // the run missed and then recounting at a higher rung - which is exactly what
  // "Reprocess, keep my hand edits" is for - used to leave two dots on that one
  // cell and a total one too high per cell (flow audit 2026-09-21, row 4). The
  // mirror case was already handled: a removal that no longer matches is shown
  // as a ghost rather than silently counted.
  const found = (p: Pt) => out.some(d => d[2] === "auto" && Math.hypot(d[0] - p[0], d[1] - p[1]) <= r)
  edits.added.map(p => toDisp(f, p)).filter(inside).filter(p => !found(p))
    .forEach(p => out.push([p[0], p[1], "added"]))
  // A removal that no longer matches anything means a slider change moved the
  // detection: show it as a ghost so a resurrected false positive is visible
  // rather than silently back in the total.
  remD.filter(inside).forEach(q => {
    if (!f.centers.some(c => Math.hypot(c[0] - q[0], c[1] - q[1]) <= r))
      out.push([q[0], q[1], "ghost"])
  })
  return out
}

/** Square boundaries the UI can trust: the detected interior grid lines plus
 *  any triple-frame side that was REALLY detected (frame.sides.* true). The
 *  outer row of a 3-row EVOS capture is bounded by the triple line, which
 *  detect_grid never reports — without it the grid panel showed one row too
 *  few. A side that fell back to the image edge (sides false) is not a ruled
 *  line and must not invent a row. Lines within 15 px are the same line. */
const LINE_TOL = 15
// Every caller re-derives the same lines from the same field (DotCanvas draws
// them, squareKeyOf below keys against them, and the gallery's per-square
// tally calls it once per dot) - a new {xs,ys} object each time defeats any
// memoised consumer downstream (React.memo, useMemo deps) purely on
// reference identity. Keyed on the Field object itself: a re-count always
// produces a fresh field, so a stale grid can never survive one, and nothing
// has to be invalidated by hand.
const gridLinesMemo = new WeakMap<Field, { xs: number[]; ys: number[] }>()
export function gridLinesOf(f: Field | undefined): { xs: number[]; ys: number[] } {
  // Same guard as dotsNow, one component over: an error entry (app.py: one
  // bad field in an otherwise-good batch) carries no grid_x/grid_y/frame at
  // all - f.grid_x would be undefined and `[...lines]` throws, which crashed
  // the whole app (not just this reading) the moment an error field became
  // selected. Sidebar's `hasGrid` and CountBadge's `measured` already treat
  // an empty {xs:[],ys:[]} as "not measured", so this is the only fix needed.
  if (!isCountedField(f)) return { xs: [], ys: [] }
  const cached = gridLinesMemo.get(f)
  if (cached) return cached
  const merge = (lines: number[], extra: number[]) => {
    const out = [...lines]
    for (const e of extra) if (!out.some(l => Math.abs(l - e) <= LINE_TOL)) out.push(e)
    return out.sort((a, b) => a - b)
  }
  const fr = f.frame
  const s = fr?.sides
  const result = {
    xs: merge(f.grid_x, [...(s?.left ? [fr!.x0] : []), ...(s?.right ? [fr!.x1] : [])]),
    ys: merge(f.grid_y, [...(s?.top ? [fr!.y0] : []), ...(s?.bottom ? [fr!.y1] : [])]),
  }
  gridLinesMemo.set(f, result)
  return result
}

/** Which grid square a displayed-px point falls in, as a key that means the
 *  same physical square whatever the transform.
 *
 *  It used to be the square's INDEX into the displayed grid lines ("col,row").
 *  That is only stable while the grid is: crop the capture and the first
 *  detected line is a different physical line, so every excluded square
 *  silently re-pointed onto a neighbour, and any key that fell out of range was
 *  dropped without a word - a total that changed for no reason the user could
 *  see (flow audit 2026-09-21, row 5).
 *
 *  The key is now the square's own position in ORIGINAL-image px, measured in
 *  whole squares: `round(centre / square size)` on each axis. Original px are
 *  what the hand edits already use, and quantising by the square's own size
 *  makes it tolerant to half a square of drift - far more than the couple of px
 *  a re-detected grid actually moves - while still naming exactly one square.
 *
 *  A field with no usable grid has no squares to key, and returns "".
 */
export const squareKeyOf = (f: Field, [x, y]: Pt): string => {
  if (!isCountedField(f)) return ""
  const { xs, ys } = gridLinesOf(f)
  const col = xs.filter(g => g <= x).length - 1
  const row = ys.filter(g => g <= y).length - 1
  if (col < 0 || row < 0 || col >= xs.length - 1 || row >= ys.length - 1) {
    // Outside the ruled area: there is no square here, and the old index form
    // ("-1,-1", "4,2" past the edge) named one that does not exist.
    return ""
  }
  // The square's centre, in displayed px, then in original px.
  const [ox, oy] = toOrig(f, [(xs[col] + xs[col + 1]) / 2, (ys[row] + ys[row + 1]) / 2])
  // One square's size in ORIGINAL px, taken through the same transform so a
  // crop's scale cannot change the unit.
  const [x0, y0] = toOrig(f, [xs[col], ys[row]])
  const [x1, y1] = toOrig(f, [xs[col + 1], ys[row + 1]])
  const sw = Math.abs(x1 - x0), sh = Math.abs(y1 - y0)
  if (!(sw > 1) || !(sh > 1)) return ""
  return `${Math.round(ox / sw)},${Math.round(oy / sh)}`
}

/** The same key, for a square named by its position in the DISPLAYED grid.
 *
 *  The two callers that walk the lattice rather than a point - the sidebar's
 *  square panel and the canvas's grey-out - need the key for cell (col, row),
 *  and must get it from the one place that decides what a key is. Before the
 *  keys became transform-independent they could build `${col},${row}` by hand,
 *  and that is exactly how they drifted.
 */
export const squareKeyOfCell = (f: Field, col: number, row: number): string => {
  const { xs, ys } = gridLinesOf(f)
  if (col < 0 || row < 0 || col >= xs.length - 1 || row >= ys.length - 1) return ""
  return squareKeyOf(f, [(xs[col] + xs[col + 1]) / 2, (ys[row] + ys[row + 1]) / 2])
}

/** A field's per-session corrections: hand edits and excluded square keys.
 *  Both are stored in original-image px or in transform-independent keys, so a
 *  crop moves neither of them. */
export interface FieldEdits { edits: Edits; off: string[] }

/** The number a field actually reports: the server's detections after the hand
 *  edits are re-applied and any excluded square is dropped. Ghosts are removals
 *  that no longer match a detection, so they are not cells and never counted.
 *  With no square excluded every dot counts, including ones outside the detected
 *  squares — the rule the server total uses.
 *
 *  `imgW`/`imgH` bound which added dots and ghosts are still on screen. They
 *  are the FIELD's own pixel size (`field.width`/`field.height`, which the edit
 *  view also measures off the image it renders at natural size), not the
 *  viewport's: a crop shrinks the field, and a point the crop left behind is
 *  not on the slide area being shown. Every caller passes them — a field is
 *  always displayed at its own size somewhere — and the Infinity default only
 *  serves callers that have no field size to hand, such as a test. */
export function effectiveTotal(
  f: Field | undefined, s?: FieldEdits, imgW = Infinity, imgH = Infinity,
): number {
  return countedDots(f, s, imgW, imgH).length
}

/** The dots `effectiveTotal` counts, as dots — the same rule, so an export can
 *  draw and list exactly the cells the gallery card and the workbench report
 *  rather than re-deriving the rule and drifting from it. */
export function countedDots(
  f: Field | undefined, s?: FieldEdits, imgW = Infinity, imgH = Infinity,
): Dot[] {
  if (!f) return []
  const solid = dotsNow(f, s?.edits ?? { added: [], removed: [] }, imgW, imgH)
    .filter(d => d[2] !== "ghost")
  const off = s?.off
  if (!off?.length) return solid
  const dead = new Set(off)
  return solid.filter(d => !dead.has(squareKeyOf(f, [d[0], d[1]])))
}
