import { describe, expect, it } from "vitest"
import { groupByName } from "./nameGroups"
import {
  assignTo, claimedPairs, groupFrom, nextGroupName, projectGroups, pruneGroups,
  seedFromAuto, ungroupedKeys,
} from "./manualGroups"
import type { ManualGroup } from "./manualGroups"

const g = (name: string, keys: string[]): ManualGroup => ({ id: `id-${name}`, name, keys })

describe("nextGroupName", () => {
  it("counts up from one", () => {
    expect(nextGroupName([])).toBe("Group 1")
    expect(nextGroupName([g("Group 1", [])])).toBe("Group 2")
  })

  // A user who makes three groups, drops the middle one and makes another
  // expects "Group 2" back. Counting off the LENGTH would hand them "Group 3"
  // and leave two bands with the same name.
  it("reuses a number a removed group gave back", () => {
    expect(nextGroupName([g("Group 1", []), g("Group 3", [])])).toBe("Group 2")
  })

  it("ignores names the user typed", () => {
    expect(nextGroupName([g("KGN passage 4", [])])).toBe("Group 1")
  })
})

describe("seedFromAuto", () => {
  const names = ["ha1 sq1.1.tif", "ha1 sq1.2.tif", "KGN sq2.1.tif", "KGN sq2.2.tif"]
  const keys = names.map(n => `${n} 100`)

  it("keeps the filename rule's partition, with its prefixes as names", () => {
    const out = seedFromAuto(keys, groupByName(names))
    expect(out.map(x => x.name)).toEqual(["ha1", "KGN"])
    expect(out.map(x => x.keys)).toEqual([keys.slice(0, 2), keys.slice(2)])
  })

  it("gives every band its own identity", () => {
    const out = seedFromAuto(keys, groupByName(names))
    expect(new Set(out.map(x => x.id)).size).toBe(out.length)
  })

  // A bucket the prefix rule gave up on was already swept as one bucket, so it
  // becomes an ordinary numbered band: nothing about the run changes, and the
  // user gets something they can rename and edit like any other.
  it("numbers a band the prefix rule could not name", () => {
    const flat = ["a.tif", "b.tif"]
    const out = seedFromAuto(flat.map(n => `${n} 1`),
      [{ key: "", indices: [0, 1], ungrouped: true }])
    expect(out).toEqual([{ id: expect.any(String), name: "Group 1", keys: ["a.tif 1", "b.tif 1"] }])
  })
})

describe("pruneGroups", () => {
  it("drops keys for captures that are no longer staged", () => {
    const out = pruneGroups([g("A", ["x", "y"])], ["x"])
    expect(out).toEqual([{ id: "id-A", name: "A", keys: ["x"] }])
  })

  it("drops a group the removal emptied", () => {
    expect(pruneGroups([g("A", ["x"]), g("B", ["y"])], ["y"]))
      .toEqual([{ id: "id-B", name: "B", keys: ["y"] }])
  })

  // This runs on every staged-file change. A fresh array each time would
  // re-render the whole board for a drop that changed nothing about it.
  it("returns the same array when nothing changed", () => {
    const board = [g("A", ["x", "y"])]
    expect(pruneGroups(board, ["x", "y", "z"])).toBe(board)
  })
})

describe("assignTo", () => {
  const board = [g("A", ["x", "y"]), g("B", ["z"])]

  it("moves a capture out of one group and into another", () => {
    const out = assignTo(board, ["x"], "id-B")
    expect(out.map(x => x.keys)).toEqual([["y"], ["z", "x"]])
  })

  it("moves to the ungrouped tray when the target is null", () => {
    expect(assignTo(board, ["x", "y"], null).map(x => x.name)).toEqual(["B"])
  })

  it("removes a group the move emptied", () => {
    expect(assignTo(board, ["z"], "id-A").map(x => x.name)).toEqual(["A"])
  })

  // Dropping a capture back onto the band it is already in must not duplicate
  // it, and must not reshuffle the band's other members.
  it("is a no-op on the group a capture is already in", () => {
    expect(assignTo(board, ["y"], "id-A")[0].keys).toEqual(["x", "y"])
  })
})

describe("groupFrom", () => {
  it("makes a numbered group and takes the captures out of their old ones", () => {
    const out = groupFrom([g("Group 1", ["x", "y"])], ["y"])
    expect(out.map(x => [x.name, x.keys])).toEqual([["Group 1", ["x"]], ["Group 2", ["y"]]])
  })

  it("does nothing with nothing selected", () => {
    const board = [g("A", ["x"])]
    expect(groupFrom(board, [])).toBe(board)
  })
})

describe("projectGroups", () => {
  const keys = ["a", "b", "c", "d"]

  it("gives ascending indices into the staged order, whatever order the band holds", () => {
    const out = projectGroups(keys, [g("A", ["c", "a"])])
    expect(out[0].indices).toEqual([0, 2])
  })

  it("puts everything nobody grouped in one trailing ungrouped bucket", () => {
    const out = projectGroups(keys, [g("A", ["a", "b"])])
    expect(out.map(x => [x.key, x.indices, x.ungrouped]))
      .toEqual([["A", [0, 1], false], ["", [2, 3], true]])
  })

  it("carries the band's identity through", () => {
    expect(projectGroups(keys, [g("A", ["a"])])[0].id).toBe("id-A")
  })

  it("has no ungrouped bucket when every capture is placed", () => {
    expect(projectGroups(["a"], [g("A", ["a"])]).length).toBe(1)
  })
})

describe("ungroupedKeys", () => {
  it("keeps the staged order", () => {
    expect(ungroupedKeys(["a", "b", "c"], [g("A", ["b"])])).toEqual(["a", "c"])
  })
})

// A hand-made pair is a claim: "these two are one field". The sweep still
// decides from the pixels, but the run owes the user an answer either way, and
// these are the pairs it owes one for.
describe("claimedPairs", () => {
  it("names every group of exactly two", () => {
    expect(claimedPairs(["a", "b", "c", "d"], [g("A", ["a", "b"]), g("B", ["c", "d"])]))
      .toEqual([[0, 1], [2, 3]])
  })

  it("claims nothing for a group of one, three or more", () => {
    expect(claimedPairs(["a", "b", "c", "d"], [g("A", ["a"]), g("B", ["b", "c", "d"])]))
      .toEqual([])
  })

  // The tray is not a claim. Its captures are together because nobody placed
  // them, not because anyone said they belong together.
  it("does not claim the ungrouped leftovers", () => {
    expect(claimedPairs(["a", "b"], [])).toEqual([])
  })
})
