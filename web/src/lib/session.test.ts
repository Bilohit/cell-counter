// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { loadSession, orphanedEdits, saveSession, sessionSeeds } from "./session"
import type { SessionStateV1 } from "./session"
import type { FieldEdits } from "./geom"
import { dotsNow, fingerprintOf } from "./geom"
import type { CountedField, GalleryItem, Pt } from "./types"

const mkField = (names: string[]): CountedField => ({
  names, count: 3, centers: [[1, 1]], grid_x: [0, 10], grid_y: [0, 10], diameter: 22, level: 2,
  grid_cols: 1, grid_rows: 1, squares: [], frame: null, base_image: "b",
  stages: [], stitch: null, width: 10, height: 10,
})

const mkFile = (name: string, body = "capture-bytes") =>
  new File([body], name, { type: "image/tiff" })

const edits = (n: number): FieldEdits =>
  ({ edits: { added: [[n, n]], removed: [[n + 1, n + 1]] }, off: [`${n},0`] })

/** A single counted capture, and a merged one built from two files. */
function session() {
  const a = mkFile("a.tif", "aaaa")
  const b = mkFile("b.tif", "bbbb")
  const c = mkFile("c.tif", "cccc")
  const items: GalleryItem[] = [
    { id: "it1", files: [a], name: "a.tif", field: mkField(["a.tif"]), status: "ready" },
    {
      id: "it2", files: [b, c], name: "b.tif + c.tif", field: mkField(["b.tif", "c.tif"]),
      status: "ready", mergedFrom: ["b.tif", "c.tif"],
    },
  ]
  const byField: Record<string, FieldEdits> = {
    [fingerprintOf(items[0].field!)]: edits(1),
    [fingerprintOf(items[1].field!)]: edits(2),
  }
  return { items, byField }
}

async function roundTrip(
  items: GalleryItem[], byField: Record<string, FieldEdits>, engine = "test-engine",
  dock: { cells?: string; squares?: string; dilution?: string } = {},
) {
  const { blob, filename } = await saveSession(
    items, byField, true, engine, undefined, {}, dock)
  const { files, state } = await loadSession(new File([blob], filename))
  return { files, state, filename }
}

/** A zip holding exactly this session.json, however malformed. */
async function zipOf(json: unknown) {
  const zip = new JSZip()
  zip.file("session.json", typeof json === "string" ? json : JSON.stringify(json))
  return new File([await zip.generateAsync({ type: "blob" })], "s.zip")
}

describe("saveSession / loadSession", () => {
  it("round-trips parameters, items and hand corrections", async () => {
    const { items, byField } = session()
    const { state, files } = await roundTrip(items, byField)

    expect(state.version).toBe(2)
    expect(Date.parse(state.savedAt)).not.toBeNaN()
    expect(state.boundary).toBe(true)
    expect(state.editsByFingerprint).toEqual(byField)

    expect(state.items.map(i => i.name)).toEqual(["a.tif", "b.tif + c.tif"])
    expect(state.items[0].fileKeys).toHaveLength(1)
    // A merged item keeps BOTH of its captures, so it recounts as its stitched
    // self rather than falling back to two separate counts.
    expect(state.items[1].fileKeys).toHaveLength(2)
    expect(state.items[1].mergedFrom).toEqual(["b.tif", "c.tif"])

    // Every key the items name is present, and the files come back byte-exact
    // under their ORIGINAL names — the fingerprint is built from those.
    expect([...files.keys()].sort()).toEqual(state.items.flatMap(i => i.fileKeys).sort())
    const seeds = sessionSeeds(state, files)
    expect(seeds.map(s => s.files.map(f => f.name))).toEqual([["a.tif"], ["b.tif", "c.tif"]])
    expect(seeds[1].mergedFrom).toEqual(["b.tif", "c.tif"])
    expect(await seeds[1].files[0].text()).toBe("bbbb")
    expect(await seeds[0].files[0].text()).toBe("aaaa")
  })

  it("round-trips the crop each capture was counted through", async () => {
    const { items, byField } = session()
    const q: Pt[] = [[10, 10], [90, 10], [90, 90], [10, 90]]
    // Only the first item was cropped; the merged one was not.
    const { blob, filename } = await saveSession(
      items, byField, true, "test-engine", new Date(), { it1: q, it2: null })
    const { files, state } = await loadSession(new File([blob], filename))

    expect(state.items[0].crop).toEqual(q)
    expect(state.items[1].crop).toBeUndefined()
    const seeds = sessionSeeds(state, files)
    expect(seeds[0].crop).toEqual(q)
    expect(seeds[1].crop).toBeUndefined()
  })

  it("restores a session written before crops were saved, uncropped", async () => {
    const { items, byField } = session()
    const { state, files } = await roundTrip(items, byField)   // no crops passed

    expect(state.items.every(i => i.crop === undefined)).toBe(true)
    expect(sessionSeeds(state, files).every(s => s.crop === undefined)).toBe(true)
  })

  it("prunes corrections no saved field can reach", async () => {
    const { items, byField } = session()
    const orphan = fingerprintOf(mkField(["gone.tif"]))
    // What a merge leaves behind: the two originals' fields are retired, but
    // their entries stay in byField.
    const { state } = await roundTrip(items, { ...byField, [orphan]: edits(9) })

    expect(Object.keys(state.editsByFingerprint).sort())
      .toEqual(Object.keys(byField).sort())
  })

  it("keeps nothing for an item that never counted", async () => {
    const uncounted: GalleryItem[] = [
      { id: "it1", files: [mkFile("x.tif")], name: "x.tif", field: null, status: "error" },
    ]
    const { state } = await roundTrip(uncounted, { [fingerprintOf(mkField(["x.tif"]))]: edits(1) })

    expect(state.editsByFingerprint).toEqual({})
    expect(state.items[0].fileKeys).toHaveLength(1)   // the capture itself is still saved
  })

  it("gives each file a distinct entry even when two captures share a name", async () => {
    const items: GalleryItem[] = [
      { id: "a", files: [mkFile("f.tif", "one")], name: "f.tif", field: null, status: "ready" },
      { id: "b", files: [mkFile("f.tif", "two")], name: "f.tif", field: null, status: "ready" },
    ]
    const { state, files } = await roundTrip(items, {})

    expect(state.items[0].fileKeys[0]).not.toBe(state.items[1].fileKeys[0])
    expect(files.size).toBe(2)
    const seeds = sessionSeeds(state, files)
    expect(await seeds[0].files[0].text()).toBe("one")
    expect(await seeds[1].files[0].text()).toBe("two")
    expect(seeds.map(s => s.files[0].name)).toEqual(["f.tif", "f.tif"])
  })

  it("preserves the exact original name through a zip-unsafe one", async () => {
    const odd = 'well A1: rep "2".tif'
    const items: GalleryItem[] = [
      { id: "a", files: [mkFile(odd)], name: odd, field: null, status: "ready" },
    ]
    const { state, files } = await roundTrip(items, {})

    expect(state.items[0].fileKeys[0]).not.toContain(":")
    expect(sessionSeeds(state, files)[0].files[0].name).toBe(odd)
  })

  it("refuses an empty session, a non-zip and a zip that is not a session", async () => {
    await expect(saveSession([], {}, true)).rejects.toThrow(/nothing in this session/i)
    await expect(loadSession(new File(["not a zip"], "x.zip"))).rejects.toThrow(/not a zip/i)

    const stray = new JSZip()
    stray.file("readme.txt", "hello")
    const blob = await stray.generateAsync({ type: "blob" })
    await expect(loadSession(new File([blob], "x.zip"))).rejects.toThrow(/session\.json/i)
  })

  // Version 1 is the four-rung era, refused since 2026-09-21: it records a
  // quality level this app no longer has.
  it("rejects a session written by another version", async () => {
    const zip = new JSZip()
    zip.file("session.json", JSON.stringify({ version: 1, items: [] }))
    const blob = await zip.generateAsync({ type: "blob" })
    await expect(loadSession(new File([blob], "x.zip"))).rejects.toThrow(/different version/i)
  })

  it("drops an item whose captures are missing rather than restoring half of it", () => {
    const state: SessionStateV1 = {
      version: 2, savedAt: new Date().toISOString(), boundary: true,
      files: { "files/0_a.tif": "a.tif" },
      items: [
        { id: "1", name: "a.tif", fileKeys: ["files/0_a.tif"] },
        { id: "2", name: "b + c", fileKeys: ["files/0_a.tif", "files/9_gone.tif"] },
      ],
      editsByFingerprint: {},
    }
    const files = new Map([["files/0_a.tif", mkFile("a.tif")]])
    expect(sessionSeeds(state, files).map(s => s.name)).toEqual(["a.tif"])
  })
})

describe("engine version and orphaned corrections", () => {
  it("stamps the engine that produced the session", async () => {
    const { items, byField } = session()
    const { state } = await roundTrip(items, byField, "v9-tuned")
    expect(state.engineVersion).toBe("v9-tuned")

    // Not every session names one: an older file simply has no stamp, and that
    // is a missing key, never a load failure.
    const { state: bare } = await roundTrip(items, byField, "")
    expect(bare.engineVersion).toBeUndefined()
  })

  it("counts the correction sets that found no field", async () => {
    const { items, byField } = session()
    const { state } = await roundTrip(items, byField)
    const fields = items.map(i => i.field!)

    expect(orphanedEdits(state, fields)).toBe(0)
    // What a changed stitcher does: the merged field comes back with different
    // stitch geometry, so its fingerprint no longer matches the saved key.
    const moved = { ...fields[1], stitch: { dx: 3, dy: 500, seam_y: 260, ncc: 0.9 } }
    expect(orphanedEdits(state, [fields[0], moved])).toBe(1)
    expect(orphanedEdits(state, [])).toBe(2)
  })
})

describe("loadSession sanitising", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    version: 2, savedAt: "now", boundary: true,
    files: { "files/0_a.tif": "a.tif" },
    items: [{ id: "1", name: "a.tif", fileKeys: ["files/0_a.tif"] }],
    editsByFingerprint: {}, ...over,
  })

  it("coerces a half-written correction set instead of handing it to the app", async () => {
    const { state } = await loadSession(await zipOf(base({
      editsByFingerprint: {
        empty: {},
        partial: { edits: { added: [[1, 2], "nope", [3], [4, 5, 6]] } },
        junk: { edits: 7, off: ["1,1", 3, null] },
        dropped: "not an object",
        alsoDropped: null,
      },
    })))

    expect(Object.keys(state.editsByFingerprint).sort())
      .toEqual(["empty", "junk", "partial"])
    expect(state.editsByFingerprint.empty)
      .toEqual({ edits: { added: [], removed: [] }, off: [] })
    expect(state.editsByFingerprint.partial.edits.added).toEqual([[1, 2]])
    expect(state.editsByFingerprint.junk.off).toEqual(["1,1"])

    // The point of the coercion: what comes out is safe to draw with.
    const f = mkField(["a.tif"])
    for (const e of Object.values(state.editsByFingerprint)) {
      expect(() => dotsNow(f, e.edits, f.width, f.height)).not.toThrow()
    }
  })

  it("ignores an unrecognised top-level key", async () => {
    // A session written by an older build carries a paramVals block that
    // nothing reads any more (the tuning round trip is gone). The key must
    // not fail the load - it is simply absent from the state that comes back.
    const { state } = await loadSession(await zipOf(base({
      paramVals: { level: 0, diameter: 22, ncc_thr: 0.21 },
    })))
    expect(state.items.map(i => i.name)).toEqual(["a.tif"])
    expect("paramVals" in state).toBe(false)
  })

  it("drops a malformed item, and says so when that leaves nothing", async () => {
    const { state } = await loadSession(await zipOf(base({
      items: [
        null,
        { name: "no keys" },
        { name: 5, fileKeys: [] },
        { name: "keys not strings", fileKeys: [1, 2] },
        { id: "1", name: "a.tif", fileKeys: ["files/0_a.tif"], mergedFrom: "b + c" },
      ],
    })))
    expect(state.items.map(i => i.name)).toEqual(["a.tif"])
    expect(state.items[0].mergedFrom).toBeUndefined()   // malformed provenance is not kept

    await expect(loadSession(await zipOf(base({ items: [null] }))))
      .rejects.toThrow(/capture list is damaged/i)
  })

  it("drops a crop that is not four whole points", async () => {
    const { state } = await loadSession(await zipOf(base({
      items: [
        { id: "1", name: "a.tif", fileKeys: ["files/0_a.tif"], crop: [[1, 1], [2, 2]] },
        { id: "2", name: "a.tif", fileKeys: ["files/0_a.tif"], crop: "nope" },
        { id: "3", name: "a.tif", fileKeys: ["files/0_a.tif"],
          crop: [[1, 1], [2, 2], [3, 3], [4, "x"]] },
        { id: "4", name: "a.tif", fileKeys: ["files/0_a.tif"],
          crop: [[1, 1], [2, 2], [3, 3], [4, 4]] },
      ],
    })))
    expect(state.items.map(i => i.crop)).toEqual([
      undefined, undefined, undefined, [[1, 1], [2, 2], [3, 3], [4, 4]]])
  })

  it("keeps only real names among the files", async () => {
    const { state, files } = await loadSession(await zipOf(base({
      files: { "files/0_a.tif": "a.tif", "files/1_b.tif": 5, "files/2_c.tif": "" },
    })))
    expect(Object.keys(state.files)).toEqual(["files/0_a.tif"])
    // The entry is named but absent from the zip, so nothing is rebuilt for it.
    expect(files.size).toBe(0)
  })

  it("treats a missing boundary flag as the app default, and only false as off", async () => {
    expect((await loadSession(await zipOf(base({ boundary: undefined })))).state.boundary).toBe(true)
    expect((await loadSession(await zipOf(base({ boundary: false })))).state.boundary).toBe(false)
  })

  // Painting was removed on 2026-09-04. A session written while it existed
  // still has to restore - minus the painting, which is simply dropped.
  it("drops an unknown key from a correction set, such as a retired feature's data", async () => {
    const { state } = await loadSession(await zipOf(base({
      editsByFingerprint: {
        k: {
          edits: { added: [[1, 2]], removed: [] }, off: ["0,0"],
          regions: [{ kind: "rect", rect: [1, 2, 3, 4] }],
        },
      },
    })))
    expect(state.editsByFingerprint.k.edits.added).toEqual([[1, 2]])
    expect(state.editsByFingerprint.k.off).toEqual(["0,0"])
    expect("regions" in state.editsByFingerprint.k).toBe(false)
  })
})

describe("the concentration dock in the session file", () => {
  it("round-trips the typed dilution and overrides", async () => {
    const { items, byField } = session()
    const { state } = await roundTrip(items, byField, "test-engine",
      { dilution: "2.5", cells: "410", squares: "3" })
    expect(state.concentration).toEqual({ cells: "410", squares: "3", dilution: "2.5" })
  })

  it("keeps the raw string, so a half-typed decimal survives", async () => {
    const { items, byField } = session()
    const { state } = await roundTrip(items, byField, "test-engine", { dilution: "1." })
    expect(state.concentration?.dilution).toBe("1.")
  })

  it("saves no block for an untouched dock", async () => {
    const { items, byField } = session()
    const { blob, filename } = await saveSession(items, byField, true, "e")
    const zip = await JSZip.loadAsync(new File([blob], filename))
    const raw = JSON.parse(await zip.file("session.json")!.async("string"))
    expect("concentration" in raw).toBe(false)
  })

  it("loads a session that names no dock at all", async () => {
    const { items, byField } = session()
    const { blob, filename } = await saveSession(items, byField, true, "e")
    const zip = await JSZip.loadAsync(new File([blob], filename))
    const raw = JSON.parse(await zip.file("session.json")!.async("string"))
    delete raw.concentration
    const rebuilt = new JSZip()
    rebuilt.file("session.json", JSON.stringify(raw))
    for (const key of Object.keys(raw.files)) rebuilt.file(key, "bytes")
    const { state } = await loadSession(
      new File([await rebuilt.generateAsync({ type: "blob" })], "old.zip"))
    expect(state.concentration).toEqual({})
    expect(state.items).toHaveLength(2)
  })

  it("drops a damaged dock block rather than restoring junk", async () => {
    const { state } = await loadSession(await zipOf({
      version: 2, items: [], files: {}, paramVals: {}, boundary: true,
      editsByFingerprint: {}, concentration: { dilution: 2.5, cells: null, squares: ["x"] },
    }))
    expect(state.concentration).toEqual({})
  })
})
