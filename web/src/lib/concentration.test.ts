import { describe, expect, it } from "vitest"
import {
  concentrationOf, countedDefaults, formatSci, isFullSquare,
  parseCount, parseDilution, partialReason, readDock, writeDock,
} from "./concentration"
import type { CountedField, GalleryItem } from "./types"

/** A memory Storage, so the tab's own sessionStorage is never involved. */
function store(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: k => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size },
  } as Storage
}

const field = (rows: number, bottom: boolean): CountedField => ({
  grid_cols: 4, grid_rows: rows, width: 100, height: 100, total: 10,
  centers: Array.from({ length: 10 }, (_, i) => [i + 1, i + 1]),
  frame: { sides: { left: true, right: true, top: true, bottom } },
} as unknown as CountedField)

const item = (id: string, f: CountedField): GalleryItem =>
  ({ id, name: id, files: [], field: f } as unknown as GalleryItem)

describe("dock storage", () => {
  it("keeps a slot the user cleared, so it does not snap back to the count", () => {
    const s = store()
    writeDock({ cells: "" }, s)
    expect(readDock(s).cells).toBe("")
  })

  it("forgets the dock only when every slot is untouched", () => {
    const s = store()
    writeDock({ cells: "5" }, s)
    writeDock({}, s)
    expect(readDock(s)).toEqual({})
  })
})

describe("countedDefaults", () => {
  const items = [item("a", field(4, true)), item("b", field(3, false))]

  it("leaves partial captures out by default", () => {
    expect(countedDefaults(items, {})).toEqual({ cells: 10, squares: 1 })
  })

  it("counts a partial as the rows it has in frame", () => {
    expect(countedDefaults(items, {}, true)).toEqual({ cells: 20, squares: 1.75 })
  })
})

describe("isFullSquare", () => {
  it("is true for 4 by 4 with every side detected", () => {
    expect(isFullSquare(field(4, true))).toBe(true)
  })
  it("is false when the bottom side is missing", () => {
    expect(isFullSquare(field(4, false))).toBe(false)
  })
  it("is false when rows are short of 4", () => {
    expect(isFullSquare(field(3, true))).toBe(false)
  })
  it("is false for null or undefined", () => {
    expect(isFullSquare(null)).toBe(false)
    expect(isFullSquare(undefined)).toBe(false)
  })
})

describe("concentrationOf", () => {
  it("applies the standard haemocytometer arithmetic", () => {
    expect(concentrationOf(10, 1, 1)).toBe(100000)
  })
  it("scales with dilution", () => {
    expect(concentrationOf(10, 1, 2)).toBe(200000)
  })
  it("is 0 when there are no squares to divide by", () => {
    expect(concentrationOf(10, 0, 1)).toBe(0)
  })
  it("is 0 for a non-finite input", () => {
    expect(concentrationOf(NaN, 1, 1)).toBe(0)
  })
})

describe("formatSci", () => {
  it("splits a value into mantissa and exponent", () => {
    expect(formatSci(1.5e6)).toEqual({ mantissa: "1.50", exponent: 6 })
  })
  it("is null for 0", () => {
    expect(formatSci(0)).toBeNull()
  })
  it("is null for a negative value", () => {
    expect(formatSci(-5)).toBeNull()
  })
})

describe("parseCount", () => {
  it("parses a plain integer string", () => {
    expect(parseCount("12")).toBe(12)
  })
  it("is 0 for an unfinished or empty entry", () => {
    expect(parseCount("")).toBe(0)
  })
  it("is 0 for a negative number", () => {
    expect(parseCount("-3")).toBe(0)
  })
})

describe("parseDilution", () => {
  it("parses a plain number string", () => {
    expect(parseDilution("2.5")).toBe(2.5)
  })
  it("falls back to 1 (no dilution) for an unfinished or empty entry", () => {
    expect(parseDilution("")).toBe(1)
  })
  it("falls back to 1 for a non-positive value", () => {
    expect(parseDilution("0")).toBe(1)
  })
})

describe("partialReason", () => {
  it("is null for a full square", () => {
    expect(partialReason(field(4, true))).toBeNull()
  })
  it("names the missing rows", () => {
    expect(partialReason(field(3, false))).toBe("3 of 4 rows; bottom boundary not found")
  })
  it("names the missing boundaries when the grid is complete", () => {
    const f = { ...field(4, true), frame: { sides: { left: false, right: false, top: true, bottom: true } } } as CountedField
    expect(partialReason(f)).toBe("left and right boundaries not found")
  })
  it("names three missing boundaries", () => {
    const f = { ...field(4, true), frame: { sides: { left: false, right: false, top: false, bottom: true } } } as CountedField
    expect(partialReason(f)).toBe("left, right and top boundaries not found")
  })
  it("names all four missing boundaries", () => {
    const f = { ...field(4, true), frame: { sides: { left: false, right: false, top: false, bottom: false } } } as CountedField
    expect(partialReason(f)).toBe("left, right, top and bottom boundaries not found")
  })
  it("names too many columns", () => {
    const f = { ...field(4, true), grid_cols: 5 } as CountedField
    expect(partialReason(f)).toBe("5 columns")
  })
  it("says so when there is no grid", () => {
    expect(partialReason({ ...field(0, false), grid_cols: 0 } as CountedField)).toBe("no grid")
  })
})
