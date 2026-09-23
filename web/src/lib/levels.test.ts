import { describe, expect, it } from "vitest"
import { humanSecs, levelTag, needsLevel } from "./levels"

describe("needsLevel", () => {
  it("a level-0 (never counted) item needs any level", () => {
    expect(needsLevel(0, 1)).toBe(true)
    expect(needsLevel(0, 3)).toBe(true)
    expect(needsLevel(undefined, 2)).toBe(true)
  })
  it("an item counted at exactly the target level does not need it", () => {
    expect(needsLevel(3, 3)).toBe(false)
  })
  it("an item counted at a lower level needs a higher one", () => {
    expect(needsLevel(2, 3)).toBe(true)
  })
  it("an item counted at a higher level still needs a lower one - a Reprocess picks it up either direction", () => {
    expect(needsLevel(3, 1)).toBe(true)
  })
})

describe("humanSecs", () => {
  it("rounds sub-minute durations to whole seconds", () => {
    expect(humanSecs(2.02)).toBe("~2 s")
  })
  it("floors a fractional second up to at least 1 s, never ~0 s", () => {
    expect(humanSecs(0.48)).toBe("~1 s")
  })
  it("switches to whole minutes at 60s and above", () => {
    expect(humanSecs(90)).toBe("~2 min")
  })
  it("reads non-finite or non-positive input as ~0 s", () => {
    expect(humanSecs(0)).toBe("~0 s")
    expect(humanSecs(NaN)).toBe("~0 s")
    expect(humanSecs(-5)).toBe("~0 s")
  })
})

describe("levelTag", () => {
  it("names each of the three published rungs", () => {
    expect(levelTag(1)).toBe("Quick")
    expect(levelTag(2)).toBe("Normal")
    expect(levelTag(3)).toBe("Finest")
  })
  it("is an em dash outside the published range", () => {
    expect(levelTag(0)).toBe("—")
    expect(levelTag(4)).toBe("—")
  })
})
