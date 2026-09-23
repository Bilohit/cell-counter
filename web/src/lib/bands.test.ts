import { describe, expect, it } from "vitest"
import { UNGROUPED, bandTotals, bandsOf } from "./bands"
import type { CountedField, GalleryItem } from "./types"

// The cells are the CENTERS, not the `count` field: `effectiveTotal` counts the
// dots that survive the hand edits, which is what the card and the workbench
// both report.
const full = (n: number): CountedField => ({
  names: ["x"], count: n,
  centers: Array.from({ length: n }, (_, i) => [i + 1, i + 1] as [number, number]),
  grid_x: [], grid_y: [], diameter: 22, level: 2,
  grid_cols: 4, grid_rows: 4, squares: [],
  frame: { x0: 0, y0: 0, x1: 9, y1: 9, sides: { left: true, right: true, top: true, bottom: true } },
  base_image: "", stages: [], stitch: null, width: 100, height: 100,
})
/** A lone 10x capture: three of the large square's four rows, bottom open. */
const part = (n: number): CountedField => ({
  ...full(n), grid_rows: 3,
  frame: { x0: 0, y0: 0, x1: 9, y1: 9, sides: { left: true, right: true, top: true, bottom: false } },
})

const it_ = (name: string, group?: string, field: CountedField | null = full(10)): GalleryItem =>
  ({ id: name, files: [], name, field, status: "ready", ...(group ? { group } : {}) })

describe("bandsOf", () => {
  it("keeps the order the bands first appear in", () => {
    const out = bandsOf([it_("a", "KGN"), it_("b", "ha1"), it_("c", "KGN")])
    expect(out.map(b => [b.key, b.items.length])).toEqual([["KGN", 2], ["ha1", 1]])
  })

  // The leftovers are not a group anyone made, so they never sit between two
  // that were: whatever order they arrived in, they read last.
  it("puts the captures nobody grouped last", () => {
    const out = bandsOf([it_("loose"), it_("a", "KGN")])
    expect(out.map(b => b.key)).toEqual(["KGN", UNGROUPED])
    expect(out[1].name).toBe("Ungrouped")
  })

  it("gives an ungrouped session one band", () => {
    expect(bandsOf([it_("a"), it_("b")]).map(b => b.key)).toEqual([UNGROUPED])
  })
})

describe("bandTotals", () => {
  const band = bandsOf([it_("a", "KGN", full(40)), it_("b", "KGN", part(30))])[0]

  // The numerator and the divisor have to describe the same volume, so a
  // partial capture contributes to neither - it is only counted in the tally,
  // where it is there to be explained.
  it("leaves partial captures out of both cells and squares", () => {
    expect(bandTotals(band, {})).toEqual({ cells: 40, squares: 1, full: 1, partial: 1, counted: 70 })
  })

  it("counts partials in when asked, at their share of a square", () => {
    expect(bandTotals(band, {}, true))
      .toEqual({ cells: 70, squares: 1.75, full: 1, partial: 1, counted: 70 })
  })

  it("ignores a capture that has no count yet", () => {
    const pending = bandsOf([it_("a", "KGN", full(40)), it_("q", "KGN", null)])[0]
    expect(bandTotals(pending, {})).toEqual({ cells: 40, squares: 1, full: 1, partial: 0, counted: 40 })
  })

  // What the band head says. A session of one lone capture is all partial, so
  // `cells` is 0 by design - `counted` is what stops the head reading as if
  // nothing was found.
  it("still reports the cells of a band that is all partial captures", () => {
    const lone = bandsOf([it_("k", "KGN", part(181))])[0]
    const t = bandTotals(lone, {})
    expect([t.cells, t.counted, t.full, t.partial]).toEqual([0, 181, 0, 1])
  })
})
