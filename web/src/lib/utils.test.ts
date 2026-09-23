import { expect, it } from "vitest"
import { midTruncate } from "./utils"

it("leaves a short name untouched", () => {
  expect(midTruncate("a.tif", 28)).toBe("a.tif")
  expect(midTruncate("exactly-twenty-eight-chars.x", 28)).toBe("exactly-twenty-eight-chars.x")
})

it("keeps the tail, which is what a head-truncate throws away", () => {
  // The shared EVOS prefix is long; the distinguishing part sits at the end.
  const a = midTruncate("10x tile picture 3; first three rows.tif", 24)
  const b = midTruncate("10x tile picture 3; first three rows 2.tif", 24)

  expect(a).toHaveLength(24)
  expect(a).toContain("…")
  expect(a.startsWith("10x")).toBe(true)
  expect(a.endsWith("rows.tif")).toBe(true)
  expect(b.endsWith("rows 2.tif")).toBe(true)
  // The whole point: two names sharing a long prefix no longer render alike.
  expect(a).not.toBe(b)
})

it("keeps the differing word of the real EVOS first/last pair at the default width", () => {
  const first = midTruncate("10x tile picture 3; first three rows.tif")
  const last = midTruncate("10x tile picture 3; last three rows.tif")
  expect(first).toContain("first")
  expect(last).toContain("last")
})

it("keeps the picture digit at the tile budget, so a 4-file batch stays 4 distinct strings", () => {
  const names = [
    "10x tile picture 1; last three rows.tif",
    "10x tile picture 2; first three rows.tif",
    "10x tile picture 3; first three rows.tif",
    "10x tile picture 3; last three rows.tif",
  ]
  const shown = names.map(n => midTruncate(n, 34))
  expect(new Set(shown).size).toBe(4)
})

it("degenerate limits do not throw", () => {
  expect(midTruncate("abcdef", 1)).toBe("abcdef")
  expect(midTruncate("abcdef", 0)).toBe("abcdef")
  expect(midTruncate("", 10)).toBe("")
})
