import { describe, expect, it } from "vitest"
import { dotsNow, effectiveTotal, gridLinesOf, squareKeyOf, toOrig } from "./geom"
import type { CountedField } from "./types"

// The self-check that used to run as demo() in the old page, kept runnable.
const field = (over: Partial<CountedField> = {}): CountedField => ({
  names: ["t"], count: 2, centers: [[10, 10], [50, 50]], grid_x: [], grid_y: [],
  diameter: 20, level: 2, grid_cols: 0, grid_rows: 0, squares: [], frame: null,
  base_image: "", stages: [], stitch: null,
  width: 100, height: 100, ...over,
})

describe("dot re-application", () => {
  it("drops a removed detection and keeps an added one", () => {
    const kinds = dotsNow(field(), { added: [[80, 80]], removed: [[10, 10]] })
      .map(d => d[2]).sort().join(",")
    expect(kinds).toBe("added,auto")
  })

  it("shows a removal that matches nothing as a ghost", () => {
    const dots = dotsNow(field(), { added: [], removed: [[300, 300]] })
    expect(dots.filter(d => d[2] === "ghost")).toHaveLength(1)
  })

  it("moves hand edits with a crop, and maps them back", () => {
    const f = field({ names: ["t2"], centers: [], count: 0,
                      transform: [[1, 0, -20], [0, 1, -30], [0, 0, 1]] })
    const moved = dotsNow(f, { added: [[100, 100]], removed: [] }).find(d => d[2] === "added")
    expect(moved?.slice(0, 2)).toEqual([80, 70])
    expect(toOrig(f, [80, 70]).map(Math.round)).toEqual([100, 100])
  })
})

describe("effectiveTotal", () => {
  const gridded = () => field({ grid_x: [0, 40, 80], grid_y: [0, 40, 80] })

  it("is the server count when nothing was corrected", () => {
    expect(effectiveTotal(field())).toBe(2)
    expect(effectiveTotal(undefined)).toBe(0)
  })

  it("adds hand-added cells and drops hand-removed ones", () => {
    expect(effectiveTotal(field(), { edits: { added: [[80, 80]], removed: [[10, 10]] }, off: [] }))
      .toBe(2)
    expect(effectiveTotal(field(), { edits: { added: [], removed: [[50, 50]] }, off: [] }))
      .toBe(1)
  })

  it("does not count a ghost — a removal that no longer matches a detection", () => {
    expect(effectiveTotal(field(), { edits: { added: [], removed: [[300, 300]] }, off: [] }))
      .toBe(2)
  })

  it("drops the cells inside an excluded square", () => {
    // Squares are 40 px wide with no crop, so a key is the square centre in
    // original px divided by 40: [10,10] sits in the square centred on
    // (20, 20) -> "1,1"; [50,50] in the one centred on (60, 60) -> "2,2".
    const k1 = squareKeyOf(gridded(), [10, 10])
    const k2 = squareKeyOf(gridded(), [50, 50])
    expect([k1, k2]).toEqual(["1,1", "2,2"])
    expect(effectiveTotal(gridded(), { edits: { added: [], removed: [] }, off: [k1] })).toBe(1)
    expect(effectiveTotal(gridded(), { edits: { added: [], removed: [] }, off: [k1, k2] }))
      .toBe(0)
  })

  it("counts every dot when no bounds are given, and crops them out when they are", () => {
    const e = { edits: { added: [[200, 200]] as [number, number][], removed: [] }, off: [] }
    expect(effectiveTotal(field(), e)).toBe(3)
    expect(effectiveTotal(field(), e, 100, 100)).toBe(2)
  })

  it("leaves out an added dot that the field's own pixel size cuts off", () => {
    // What a gallery card does: the item's field may have been re-counted from
    // a crop in the edit view, and a dot outside that smaller field is no
    // longer on the slide area being shown. Both views must say 2, not 3.
    const cropped = field({ width: 60, height: 60 })
    const e = { edits: { added: [[80, 80]] as [number, number][], removed: [] }, off: [] }
    expect(effectiveTotal(cropped, e, cropped.width, cropped.height)).toBe(2)
    expect(effectiveTotal(field(), e, 100, 100)).toBe(3)   // uncropped: still on screen
  })
})

describe("gridLinesOf", () => {
  const base = (over: Partial<CountedField>): CountedField => ({
    names: ["a.tif"], count: 0, width: 1360, height: 1024, centers: [],
    grid_x: [200, 430, 660], grid_y: [300, 530, 760], diameter: 22, level: 2,
    grid_cols: 2, grid_rows: 2, squares: [], frame: null,
    base_image: "", stages: [], stitch: null,
    ...over,
  })

  it("returns interior lines untouched when there is no frame", () => {
    expect(gridLinesOf(base({}))).toEqual({ xs: [200, 430, 660], ys: [300, 530, 760] })
  })

  it("adds a frame side that was really detected, sorted in", () => {
    const f = base({ frame: { x0: 40, y0: 70, x1: 1350, y1: 1020,
      sides: { left: true, right: false, top: true, bottom: false } } })
    expect(gridLinesOf(f)).toEqual({ xs: [40, 200, 430, 660], ys: [70, 300, 530, 760] })
  })

  it("ignores a frame side that fell back to the image edge", () => {
    const f = base({ frame: { x0: 0, y0: 0, x1: 1360, y1: 1024,
      sides: { left: false, right: false, top: false, bottom: false } } })
    expect(gridLinesOf(f)).toEqual({ xs: [200, 430, 660], ys: [300, 530, 760] })
  })

  it("dedupes a frame line that coincides with a detected grid line", () => {
    const f = base({ frame: { x0: 205, y0: 296, x1: 1350, y1: 1020,
      sides: { left: true, right: false, top: true, bottom: false } } })
    expect(gridLinesOf(f)).toEqual({ xs: [200, 430, 660], ys: [300, 530, 760] })
  })

  it("tolerates a frame object without sides (older server)", () => {
    const f = base({ frame: { x0: 40, y0: 70, x1: 1350, y1: 1020 } })
    expect(gridLinesOf(f)).toEqual({ xs: [200, 430, 660], ys: [300, 530, 760] })
  })

  it("memoises its return object per field (WeakMap identity)", () => {
    const f = base({})
    expect(Object.is(gridLinesOf(f), gridLinesOf(f))).toBe(true)
  })

  it("squareKeyOf keys against the merged lines", () => {
    const f = base({ frame: { x0: 40, y0: 70, x1: 1350, y1: 1020,
      sides: { left: true, right: false, top: true, bottom: false } } })
    // Two different squares get two different keys, and the same point always
    // gets the same one. The exact string is the square's original-px position
    // in square units, which nothing outside geom.ts should care about.
    const a = squareKeyOf(f, [100, 100])       // frame line 40/70 .. first interior 200/300
    const b = squareKeyOf(f, [250, 350])       // one square in on each axis
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
    expect(squareKeyOf(f, [110, 110])).toBe(a)   // same square, same key
    // (10, 10) sits before every line: there is no square there at all, and the
    // old index form named one ("-1,-1") that does not exist.
    expect(squareKeyOf(f, [10, 10])).toBe("")
  })

  // Flow audit 2026-09-21, row 5. The key used to be the square's INDEX into
  // the displayed grid lines, so cropping the capture - which drops the lines
  // outside the crop and renumbers the rest - silently moved every excluded
  // square onto a neighbour, and any key that fell out of range was dropped
  // without a word. The same physical square must keep its key.
  it("names the same physical square before and after a crop", () => {
    const whole = base({ frame: null })
    // A crop that removes the first interior line on each axis and shifts the
    // origin by 200/300 px: the same physical square is now index (0,0).
    const cropped = base({
      grid_x: [230, 460], grid_y: [230, 460],
      transform: [[1, 0, -200], [0, 1, -300], [0, 0, 1]],
    })
    // The square between the second and third interior lines, in each frame.
    const before = squareKeyOf(whole, [545, 645])
    const after = squareKeyOf(cropped, [345, 345])
    expect(before).toBeTruthy()
    expect(after).toBe(before)
  })
})

// Flow audit 2026-09-21, row 4. "Reprocess, keep my hand edits" exists so a
// cell the run missed stays marked. When the higher rung then FINDS that cell,
// the hand dot and the detection are the same cell, and keeping both counted it
// twice. The mirror case (a removal that no longer matches) was already ghosted
// rather than counted; this is the other half of the same rule.
it("drops a hand-added dot the recount has since found", () => {
  const f = field({ diameter: 22, centers: [[100, 100]] })
  const edits = { added: [[104, 103]] as [number, number][], removed: [] }

  const dots = dotsNow(f, edits, 500, 500)
  expect(dots).toHaveLength(1)
  expect(dots[0][2]).toBe("auto")
})

it("keeps a hand-added dot that is still its own cell", () => {
  const f = field({ diameter: 22, centers: [[100, 100]] })
  // 40 px away is nearly two cell diameters: a different cell.
  const edits = { added: [[140, 100]] as [number, number][], removed: [] }

  const dots = dotsNow(f, edits, 500, 500)
  expect(dots).toHaveLength(2)
  expect(dots.filter(d => d[2] === "added")).toHaveLength(1)
})
