import { describe, expect, it } from "vitest"
import {
  PROGRESS_MIN_COMPARISONS, fitScale, placePair, remainingLabel, sweepComparisons,
} from "./overlap"

const SIZE: [number, number] = [1360, 1024]

describe("placePair", () => {
  it("puts b under a for a plain pair", () => {
    // The real sample pair: 10x tile picture 3, first + last three rows.
    const p = placePair(2, 408, false, SIZE, SIZE)
    expect([p.ax, p.ay]).toEqual([0, 0])
    expect([p.bx, p.by]).toEqual([2, 408])
    expect([p.x0, p.y0]).toEqual([0, 0])
    expect([p.uw, p.uh]).toEqual([1362, 1432])
  })

  it("puts a under b when the pair is swapped", () => {
    const p = placePair(2, 408, true, SIZE, SIZE)
    expect([p.ax, p.ay]).toEqual([2, 408])
    expect([p.bx, p.by]).toEqual([0, 0])
    expect([p.x0, p.y0]).toEqual([0, 0])
    expect([p.uw, p.uh]).toEqual([1362, 1432])
  })

  it("moves the union origin left of both captures for a negative dx", () => {
    const p = placePair(-30, 400, false, SIZE, SIZE)
    expect([p.x0, p.y0]).toEqual([-30, 0])
    expect([p.uw, p.uh]).toEqual([1390, 1424])
    // Expressed against the origin, a is inset and b starts at the left edge.
    expect(p.ax - p.x0).toBe(30)
    expect(p.bx - p.x0).toBe(0)
  })

  it("mirrors a negative dx when swapped", () => {
    const p = placePair(-30, 400, true, SIZE, SIZE)
    expect([p.ax, p.ay]).toEqual([-30, 400])
    expect([p.bx, p.by]).toEqual([0, 0])
    expect(p.ax - p.x0).toBe(0)
    expect(p.bx - p.x0).toBe(30)
    expect([p.uw, p.uh]).toEqual([1390, 1424])
  })

  it("stands the loaded size in for the one still loading", () => {
    const a = placePair(2, 408, false, SIZE, null)
    const b = placePair(2, 408, false, null, SIZE)
    expect([a.uw, a.uh]).toEqual([1362, 1432])
    expect([b.uw, b.uh]).toEqual([1362, 1432])
  })

  it("has an empty box before either size is known", () => {
    const p = placePair(2, 408, false, null, null)
    expect(p.uw).toBe(2)      // offsets only; the caller gates on fitScale
    expect(fitScale(p.uw, p.uh, 800, 600)).toBeGreaterThan(0)
    expect(fitScale(0, 0, 800, 600)).toBe(0)
  })
})

describe("fitScale", () => {
  it("letterboxes against whichever side binds", () => {
    expect(fitScale(1000, 500, 500, 500)).toBe(0.5)      // width binds
    expect(fitScale(500, 1000, 500, 500)).toBe(0.5)      // height binds
  })

  it("constrains width only while the box has no height", () => {
    expect(fitScale(1000, 500, 500, 0)).toBe(0.5)
  })

  it("is zero without a measurement", () => {
    expect(fitScale(1000, 500, 0, 500)).toBe(0)
  })
})

describe("sweepComparisons", () => {
  it("counts every capture against every other, inside each band", () => {
    expect(sweepComparisons([13])).toBe(78)          // the measured 5 s sweep
    expect(sweepComparisons([4, 4, 4])).toBe(18)     // 6 per band, not 66
  })

  it("charges nothing for a band that is never sent", () => {
    expect(sweepComparisons([1, 1, 1])).toBe(0)
    expect(sweepComparisons([])).toBe(0)
  })

  it("agrees with the threshold about where five seconds starts", () => {
    // 78 comparisons measured 5.22 s and 4.88 s cold; 66 measured well under.
    // The bar must be on for the first and off for the second.
    expect(sweepComparisons([13])).toBeGreaterThanOrEqual(PROGRESS_MIN_COMPARISONS)
    expect(sweepComparisons([12])).toBeLessThan(PROGRESS_MIN_COMPARISONS)
  })
})

describe("remainingLabel", () => {
  it("says nothing until the estimate is worth trusting", () => {
    expect(remainingLabel(0, 200, 10_000)).toBe("")        // nothing done
    expect(remainingLabel(2, 200, 10_000)).toBe("")        // under a twentieth
    expect(remainingLabel(100, 200, 500)).toBe("")         // no elapsed to divide
    expect(remainingLabel(200, 200, 10_000)).toBe("")      // finished, not "0 left"
  })

  it("says nothing at all while the end is still far off", () => {
    // 50 of 200 in 5 s is 100 ms each, so 150 comparisons are ~15 s away. The
    // seconds-and-minutes line that used to be returned here was removed
    // 2026-09-21: the only claim kept is the one the arithmetic can hold.
    expect(remainingLabel(50, 200, 5_000)).toBe("")
    expect(remainingLabel(100, 2000, 10_000)).toBe("")
    expect(remainingLabel(100, 700, 10_000)).toBe("")
  })

  it("says almost done once under five seconds are left", () => {
    expect(remainingLabel(196, 200, 10_000)).toBe("almost done")
    // Faster machine, same shape of run: still the same words.
    expect(remainingLabel(196, 200, 3_000)).toBe("almost done")
  })
})
