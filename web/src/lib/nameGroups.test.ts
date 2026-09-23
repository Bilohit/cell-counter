import { describe, expect, it } from "vitest"
import { GROUP_LIMIT, groupByName, hasNamePattern, sweepCost } from "./nameGroups"

/** The two real folders this feature was built against. */
const squares = (pre: string, n = 4) =>
  Array.from({ length: n }, (_, s) => [`${pre} sq${s + 1}.1.tif`, `${pre} sq${s + 1}.2.tif`]).flat()

const keys = (names: string[]) => groupByName(names).map(g => g.key)
const sizes = (names: string[]) => groupByName(names).map(g => g.indices.length)

describe("groupByName", () => {
  it("groups on the first space", () => {
    const names = [...squares("ha1"), ...squares("ha2")]
    expect(keys(names)).toEqual(["ha1", "ha2"])
    expect(sizes(names)).toEqual([8, 8])
  })

  it("re-splits a bucket at the limit on its next space", () => {
    // Every file starts "hemo1", which is 24 > 10, so the shared first token
    // carries no information and the rule has to look one token further.
    const names = ["HNT", "ha1", "ha2"].flatMap(p => squares(`hemo1 ${p}`))
    expect(keys(names)).toEqual(["hemo1 HNT", "hemo1 ha1", "hemo1 ha2"])
    expect(sizes(names)).toEqual([8, 8, 8])
  })

  it("re-splits per bucket, not globally", () => {
    // "10x" is under the limit and must stay one token deep even though its
    // neighbour "hemo1" had to go two.
    const names = [
      "10x tile picture 1; last three rows.png",
      "10x tile picture 2; first three rows.png",
      ...["HNT", "KA1"].flatMap(p => squares(`hemo1 ${p}`)),
    ]
    expect(keys(names)).toEqual(["10x", "hemo1 HNT", "hemo1 KA1"])
  })

  it("preserves input order, and each group's indices ascend", () => {
    const names = ["b x.tif", "a x.tif", "b y.tif", "a y.tif"]
    expect(groupByName(names)).toEqual([
      { key: "b", indices: [0, 2], ungrouped: false },
      { key: "a", indices: [1, 3], ungrouped: false },
    ])
  })

  it("groups case-insensitively but shows the user's own capitalisation", () => {
    expect(groupByName(["HA1 sq1.tif", "ha1 sq2.tif"])).toEqual([
      { key: "HA1", indices: [0, 1], ungrouped: false },
    ])
  })

  it("drops the extension, so a spaceless name is its own group", () => {
    expect(keys(["ha1.tif", "ha2.tif"])).toEqual(["ha1", "ha2"])
  })

  it("marks a bucket ungrouped when it is over the limit with nothing left to split on", () => {
    // Identical first tokens, no second token anywhere: the rule cannot go
    // deeper, so these fall back to being swept in full against each other.
    const names = Array.from({ length: GROUP_LIMIT }, (_, i) => `blob${i}.tif`)
      .map(() => "blob.tif")
    const [g] = groupByName(names)
    expect(g.ungrouped).toBe(true)
    expect(g.key).toBe("")
    expect(g.indices).toHaveLength(GROUP_LIMIT)
  })

  it("never loses or duplicates a capture", () => {
    const names = [
      ...["HNT", "KA1", "KGN"].flatMap(p => squares(`hemo1 ${p}`)),
      "10x a.png", "10x b.png", "lonely.png",
    ]
    const seen = groupByName(names).flatMap(g => g.indices).sort((a, b) => a - b)
    expect(seen).toEqual(names.map((_, i) => i))
  })

  it("trips at the limit, not only past it", () => {
    expect(sizes(squares("p", 4))).toEqual([8])       // 8 files, under -> whole
    expect(groupByName(squares("p", 5))[0].ungrouped).toBe(true)   // 10 -> trips
  })

  it("refuses a deeper split that would orphan a capture", () => {
    // "p sq1.1" ... "p sq5.2" is ten files, so it trips the limit - but the
    // pair suffix lives inside the square token, so splitting on the next space
    // gives ten groups of ONE and sweeps no pairs at all. The bucket has to
    // stay whole and be swept in full.
    const names = squares("p", 5)
    expect(groupByName(names)).toEqual([
      { key: "", indices: names.map((_, i) => i), ungrouped: true },
    ])
  })

  it("takes a deeper split that leaves every capture with company", () => {
    const names = ["HNT", "ha1"].flatMap(p => squares(`hemo1 ${p}`))
    expect(groupByName(names).every(g => !g.ungrouped)).toBe(true)
    expect(sizes(names)).toEqual([8, 8])
  })
})

describe("hasNamePattern", () => {
  it("arms for two or more groups that each hold a pair", () => {
    expect(hasNamePattern(groupByName([...squares("ha1"), ...squares("ha2")]))).toBe(true)
  })

  it("does not arm when every capture is its own group", () => {
    expect(hasNamePattern(groupByName(["a.tif", "b.tif", "c.tif"]))).toBe(false)
  })

  it("does not arm for a single group", () => {
    expect(hasNamePattern(groupByName(squares("ha1")))).toBe(false)
  })

  // One lone capture among a batch that otherwise lines up is not a broken
  // pattern: it is a field captured once, and it has nothing to sweep against
  // whether the switch is on or off.
  it("arms even though one capture stands alone", () => {
    expect(hasNamePattern(groupByName([...squares("ha1"), ...squares("ha2"), "odd.tif"])))
      .toBe(true)
  })

  // The reported case: six "ha1 sq*" files and a single "KGN sq2.1".
  it("arms for a run of one sample plus a lone capture of another", () => {
    const names = ["ha1 sq1.1.tif", "ha1 sq1.2.tif", "KGN sq2.1.tif", "ha1 sq2.1.tif",
      "ha1 sq2.2.tif", "ha1 sq3.1.tif", "ha1 sq3.2.tif"]
    expect(hasNamePattern(groupByName(names))).toBe(true)
  })

  // Half the batch standing alone is not a naming pattern, it is a pile of
  // one-offs with a pair in it - the full sweep is the safe answer there.
  it("does not arm when the lone captures are half the batch or more", () => {
    expect(hasNamePattern(groupByName(["ha1 sq1.1.tif", "ha1 sq1.2.tif", "a.tif", "b.tif"])))
      .toBe(false)
  })
})

describe("sweepCost", () => {
  it("reports the comparisons saved", () => {
    const names = ["HNT", "ha1", "ha2"].flatMap(p => squares(`hemo1 ${p}`))
    // 24 captures: 276 comparisons across the batch, 28 inside each of 3 groups.
    expect(sweepCost(groupByName(names), names.length)).toEqual({ full: 276, grouped: 84 })
  })
})
