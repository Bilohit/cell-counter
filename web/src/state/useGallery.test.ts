// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { DEFAULT_LEVEL } from "@/lib/levels"
import { REFUSED_STITCH_MSG } from "@/lib/messages"
import type { Field, Pt } from "@/lib/types"
import { CounterProvider, useCounter } from "./useCounter"
import { GalleryProvider, useGallery } from "./useGallery"

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(),
  count: vi.fn(),
  fetchPairs: vi.fn(),
  fetchThumbs: vi.fn(() => new Promise(() => {})),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import { count, fetchPairs, fetchParams } from "@/lib/api"

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
import { toast } from "sonner"

const PARAMS = {
  version: "test-engine",
  groups: ["Cell check"],
  params: [{ key: "diameter", label: "Cell diameter (px)", min: 6, max: 60,
             default: 22, step: 1, group: "Cell check" }],
}

// `names` mirrors the server: the filenames of the group this field came from.
const mkField = (names: string[] | string, count = 3): Field => ({
  names: typeof names === "string" ? [names] : names, count, centers: [[1, 1], [2, 2], [3, 3]],
  grid_x: [0, 10], grid_y: [0, 10], diameter: 22, level: 2, grid_cols: 1, grid_rows: 1,
  squares: [], frame: null, base_image: "b", stages: [], stitch: null,
  width: 10, height: 10,
})

const mkFile = (name: string, body = "xxxx") =>
  new File([body], name, { type: "image/png" })

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(CounterProvider, null, createElement(GalleryProvider, null, children))

/** Mount the hook and wait until the engine params have landed, so every
 *  count() call in a test carries the same parameter payload. */
async function mount() {
  const h = renderHook(() => useGallery(), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  return h
}

beforeEach(() => {
  vi.mocked(fetchParams).mockResolvedValue(PARAMS)
  vi.mocked(count).mockReset()
  vi.mocked(fetchPairs).mockReset()
  vi.mocked(toast.info).mockClear()
  vi.mocked(count).mockImplementation(async req =>
    ({ fields: [mkField(req.files.map(f => f.name))] }))
  vi.mocked(fetchPairs).mockResolvedValue({ pairs: [], count: 0, skipped: [] })
})

it("stage() dedupes by name+size and moves to the confirm screen", async () => {
  const { result } = await mount()

  act(() => result.current.stage([mkFile("a.tif"), mkFile("a.tif"), mkFile("b.tif")]))
  expect(result.current.pending.map(f => f.name)).toEqual(["a.tif", "b.tif"])
  expect(result.current.view).toBe("confirm")

  // A second drop of the same capture must not add it twice…
  act(() => result.current.stage([mkFile("a.tif"), mkFile("c.tif")]))
  expect(result.current.pending.map(f => f.name)).toEqual(["a.tif", "b.tif", "c.tif"])

  // …but the same name at a different size is a different capture.
  act(() => result.current.stage([mkFile("a.tif", "xxxxxxxx")]))
  expect(result.current.pending).toHaveLength(4)

  act(() => result.current.removePending("b.tif", 4))
  expect(result.current.pending.map(f => f.name)).toEqual(["a.tif", "c.tif", "a.tif"])

  // Removal matches the same identity staging dedupes on, so the big "a.tif"
  // goes and the small one — a different capture — stays.
  act(() => result.current.removePending("a.tif", 8))
  expect(result.current.pending.map(f => [f.name, f.size]))
    .toEqual([["a.tif", 4], ["c.tif", 4]])
})

it("stage() also dedupes against captures already in the gallery", async () => {
  const { result } = await mount()

  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })
  expect(result.current.items).toHaveLength(2)
  expect(result.current.view).toBe("gallery")

  // Every dropped file is already counted: nothing stages, and the confirm
  // screen is not shown for an empty batch.
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  expect(result.current.pending).toEqual([])
  expect(result.current.view).toBe("gallery")

  // A mixed drop stages only the capture the gallery has never seen.
  act(() => result.current.stage([mkFile("a.tif"), mkFile("c.tif")]))
  expect(result.current.pending.map(f => f.name)).toEqual(["c.tif"])
  expect(result.current.view).toBe("confirm")
})

it("confirm() counts one capture at a time and lands on the gallery", async () => {
  let inFlight = 0, maxInFlight = 0
  vi.mocked(count).mockImplementation(async req => {
    maxInFlight = Math.max(maxInFlight, ++inFlight)
    await new Promise(r => setTimeout(r, 0))
    inFlight--
    return { fields: [mkField(req.files.map(f => f.name))] }
  })

  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })

  expect(maxInFlight).toBe(1)                    // the pipeline is single-process
  expect(count).toHaveBeenCalledTimes(2)
  expect(vi.mocked(count).mock.calls[0][0].params).toMatchObject({ boundary: 1 })
  expect(result.current.items.map(i => i.status)).toEqual(["ready", "ready"])
  expect(result.current.items.map(i => i.field?.names[0])).toEqual(["a.tif", "b.tif"])
  expect(result.current.view).toBe("gallery")
  expect(fetchPairs).toHaveBeenCalledTimes(1)
})

it("clearPending() goes back to the gallery once the session holds captures", async () => {
  const { result } = await mount()

  // Nothing counted yet: cancelling staging can only go back to the drop zone.
  act(() => result.current.stage([mkFile("a.tif")]))
  act(() => result.current.clearPending())
  expect(result.current.view).toBe("intake")
  expect(result.current.pending).toHaveLength(0)

  await act(async () => { result.current.stage([mkFile("a.tif")]) })
  await act(async () => { await result.current.confirm() })
  expect(result.current.items).toHaveLength(1)

  // Now cancelling "Add captures" must not hide the counted one behind the
  // intake screen, which has no way back to the gallery.
  act(() => result.current.stage([mkFile("b.tif")]))
  act(() => result.current.clearPending())
  expect(result.current.view).toBe("gallery")
  expect(result.current.items).toHaveLength(1)
})

it("confirm() records a failed count as an error item and still pairs the rest", async () => {
  vi.mocked(count).mockImplementation(async req =>
    req.files[0].name === "b.tif"
      ? Promise.reject(new Error("Count failed"))
      : { fields: [mkField(req.files[0].name)] })

  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })

  expect(result.current.items.map(i => i.status)).toEqual(["ready", "error"])
  expect(result.current.items[1].error).toBe("Count failed")
  // Pairing now runs first, on the staged files, so both were offered to it;
  // finding nothing, the batch fell through to counting them individually.
  expect(fetchPairs).toHaveBeenCalledTimes(1)
  expect(result.current.view).toBe("gallery")
})

it("confirm() routes to review when the server finds an overlap", async () => {
  vi.mocked(fetchPairs).mockResolvedValue(
    { pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }], count: 2, skipped: [] })

  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })

  expect(result.current.view).toBe("review")
  expect(result.current.candidates).toHaveLength(1)
  expect(result.current.items.map(i => i.status)).toEqual(["pending", "pending"])
})

const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" })

it("an aborted batch leaves no item stuck at queued/counting", async () => {
  // a.tif never answers, so the batch is still mid-flight when it is aborted.
  vi.mocked(count).mockImplementation(req => new Promise((res, rej) => {
    if (req.files[0].name === "a.tif") req.signal?.addEventListener("abort", () => rej(abortErr()))
    else res({ fields: [mkField(req.files.map(f => f.name))] })
  }))

  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif"), mkFile("c.tif")]))
  let first: Promise<void>
  act(() => { first = result.current.confirm() })
  // The overlap sweep and its verdict beat run before the first count, so the
  // batch reaches "counting" a couple of seconds in, not immediately.
  await waitFor(() => expect(result.current.items[0].status).toBe("counting"),
                { timeout: 4000 })

  // A second batch aborts the first one.
  act(() => result.current.stage([mkFile("d.tif")]))
  await act(async () => { await result.current.confirm() })
  await act(async () => { await first })

  expect(result.current.items.map(i => i.status)).toEqual(["error", "error", "error", "ready"])
  expect(result.current.items.slice(0, 3).map(i => i.error)).toEqual(
    ["cancelled", "cancelled", "cancelled"])
})

/** Stage two captures the server pairs, so merge/split have something to decide. */
async function withCandidate() {
  vi.mocked(fetchPairs).mockResolvedValue(
    { pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }], count: 2, skipped: [] })
  const h = await mount()
  act(() => h.result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await h.result.current.confirm() })
  return h
}

it("merge replaces the two items with one merged item", async () => {
  const { result } = await withCandidate()
  const c = result.current.candidates[0]

  await act(async () => { await result.current.decide(c, "merge") })

  expect(result.current.items).toHaveLength(1)
  const it0 = result.current.items[0]
  expect(it0.name).toBe("a.tif + b.tif")
  expect(it0.mergedFrom).toEqual(["a.tif", "b.tif"])
  expect(it0.files.map(f => f.name)).toEqual(["a.tif", "b.tif"])
  expect(it0.status).toBe("ready")
  expect(it0.field?.names).toEqual(["a.tif", "b.tif"])   // one stitched count, from the server
  expect(result.current.candidates).toHaveLength(0)
  expect(result.current.view).toBe("gallery")
  // The review phase decides seams and counts nothing: the one count is the
  // stitched field, and it was paid for after the queue emptied.
  expect(vi.mocked(count).mock.calls.map(c => c[0].files.map(f => f.name)))
    .toEqual([["a.tif", "b.tif"]])
})

it("the merged capture stays in the batch the processing screen lists", async () => {
  const { result } = await withCandidate()
  const [a, b] = result.current.items
  expect([...result.current.batchIds!].sort()).toEqual([a.id, b.id].sort())

  await act(async () => { await result.current.decide(result.current.candidates[0], "merge") })

  // One id where there were two, and it is the merged item's: the merged
  // capture stands in the batch in place of the pair it was made from.
  const merged = result.current.items[0]
  expect(merged.mergedFrom).toEqual(["a.tif", "b.tif"])
  expect([...result.current.batchIds!]).toEqual([merged.id])
})

it("split counts both captures individually", async () => {
  const { result } = await withCandidate()
  const c = result.current.candidates[0]

  await act(async () => { await result.current.decide(c, "split") })

  expect(result.current.items.map(i => i.status)).toEqual(["ready", "ready"])
  expect(result.current.items.map(i => i.name)).toEqual(["a.tif", "b.tif"])
  // They were held uncounted through the review, so the split is what pays for them.
  expect(result.current.items.map(i => i.field?.names[0])).toEqual(["a.tif", "b.tif"])
  expect(result.current.candidates).toHaveLength(0)
  expect(result.current.view).toBe("gallery")
})

it("no count is ordered while a pair is still undecided", async () => {
  const { result } = await withCandidate()

  // The sweep ran, the review screen is up, and nothing has been counted: the
  // overlap phase is strictly about seams.
  expect(result.current.view).toBe("review")
  expect(result.current.items.map(i => i.status)).toEqual(["pending", "pending"])
  expect(count).not.toHaveBeenCalled()
})

it("a merged pair the server will not stitch lands as an error card", async () => {
  const { result } = await withCandidate()
  // Two fields back means the server refused the seam and counted each capture
  // on its own — storing one of them under both names would be a wrong count.
  vi.mocked(count).mockResolvedValueOnce(
    { fields: [mkField("a.tif"), mkField("b.tif")] })

  await act(async () => { await result.current.decide(result.current.candidates[0], "merge") })

  expect(result.current.items).toHaveLength(1)
  expect(result.current.items[0].status).toBe("error")
  expect(result.current.items[0].error).toBe(REFUSED_STITCH_MSG)
  expect(result.current.view).toBe("gallery")
})

it("opening a card shows its own count and orders no new one", async () => {
  const { result } = await mount()
  // Same filename, two different captures: the microscope resets its filenames
  // per session, so a name cannot identify which item a count belongs to.
  act(() => result.current.stage([mkFile("f.tif", "xxxx"), mkFile("f.tif", "xxxxxxxx")]))
  await act(async () => { await result.current.confirm() })
  const [a, b] = result.current.items
  const aField = a.field, bField = b.field
  expect(a.files[0].name).toBe(b.files[0].name)
  const paid = vi.mocked(count).mock.calls.length

  // The gallery already counted this capture. Opening it is a look at that
  // result: the field on the card is the field the workbench gets, and the
  // pipeline is not asked to reproduce it.
  act(() => result.current.openItem(a.id))
  await new Promise(r => setTimeout(r, 400))     // past the counting debounce
  expect(vi.mocked(count)).toHaveBeenCalledTimes(paid)
  expect(result.current.items[0].field).toBe(aField)

  // Switching cards is just as free, and neither card's field lands on the other.
  act(() => result.current.openItem(b.id))
  await new Promise(r => setTimeout(r, 400))
  expect(vi.mocked(count)).toHaveBeenCalledTimes(paid)
  expect(result.current.items[0].field).toBe(aField)
  expect(result.current.items[1].field).toBe(bField)
})

it("a merged item's card keeps sending pair: true on every later recount", async () => {
  // Opening a seeded card sends no new count (see the test above), so the
  // wiring is pinned the way a real re-count happens: crop the open card and
  // check what the next count() call actually carried.
  vi.mocked(fetchPairs).mockResolvedValue(
    { pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }], count: 2, skipped: [] })
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await r.current.g.confirm() })
  await act(async () => { await r.current.g.decide(r.current.g.candidates[0], "merge") })
  const merged = r.current.g.items[0]
  expect(merged.files).toHaveLength(2)   // a confirmed pair - see GalleryItem.files

  act(() => r.current.g.openItem(merged.id))
  const q: Pt[] = [[10, 10], [90, 10], [90, 90], [10, 90]]
  act(() => r.current.c.setQuad(q))
  await waitFor(() => expect(lastCall().quad).toEqual(q))
  expect(lastCall().pair).toBe(true)
})

it("a single capture's card keeps sending pair: false on every later recount", async () => {
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif")]))
  await act(async () => { await r.current.g.confirm() })
  const single = r.current.g.items[0]
  expect(single.files).toHaveLength(1)

  act(() => r.current.g.openItem(single.id))
  const q: Pt[] = [[10, 10], [90, 10], [90, 90], [10, 90]]
  act(() => r.current.c.setQuad(q))
  await waitFor(() => expect(lastCall().quad).toEqual(q))
  expect(lastCall().pair).toBe(false)
})

it("a confirmed pair's card refuses to show a two-field response silently", async () => {
  // Mirrors runCounts' own guard (useGallery.tsx) but on the workbench side
  // (useCounter.tsx): a confirmed pair that comes back split is a hard
  // failure there too, never a silent field switcher. The card's own
  // `pairRef.current && data.fields.length !== 1` throw (useCounter.tsx) was
  // otherwise exercised by no test.
  vi.mocked(fetchPairs).mockResolvedValue(
    { pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }], count: 2, skipped: [] })
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await r.current.g.confirm() })
  await act(async () => { await r.current.g.decide(r.current.g.candidates[0], "merge") })
  const merged = r.current.g.items[0]

  act(() => r.current.g.openItem(merged.id))
  vi.mocked(count).mockResolvedValueOnce(
    { fields: [mkField("a.tif"), mkField("b.tif")] })
  const q: Pt[] = [[10, 10], [90, 10], [90, 90], [10, 90]]
  act(() => r.current.c.setQuad(q))
  await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(REFUSED_STITCH_MSG))
})

it("checks for overlaps before counting, and says so when there are none", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  let run: Promise<void>
  act(() => { run = result.current.confirm() })

  // The sweep gets its own screen. Counting has not started: a merged pair is
  // counted once, so counting first is work a merge would throw away.
  expect(result.current.view).toBe("scan")
  expect(result.current.scan).toEqual({ n: 2, found: null })
  expect(count).not.toHaveBeenCalled()

  // The verdict is stated, then the run goes on to the counts by itself.
  await waitFor(() => expect(result.current.scan?.found).toBe(0))
  await act(async () => { await run })
  expect(result.current.view).toBe("gallery")
  expect(vi.mocked(count).mock.calls.map(c => c[0].files.map(f => f.name)))
    .toEqual([["a.tif"], ["b.tif"]])
})

it("a lone capture skips the overlap sweep entirely", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif")]))
  let run: Promise<void>
  act(() => { run = result.current.confirm() })
  expect(result.current.view).toBe("processing")
  expect(result.current.scan).toBeNull()
  await act(async () => { await run })
  expect(result.current.view).toBe("gallery")
})

it("addManualPair refuses two captures the server does not pair", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })
  const [a, b] = result.current.items

  await expect(result.current.addManualPair(a.id, b.id))
    .rejects.toThrow(/do not overlap/i)
  expect(result.current.candidates).toHaveLength(0)

  vi.mocked(fetchPairs).mockResolvedValue(
    { pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }], count: 2, skipped: [] })
  await act(async () => { await result.current.addManualPair(a.id, b.id) })

  expect(result.current.candidates).toHaveLength(1)
  expect(result.current.view).toBe("review")
  expect(result.current.items.map(i => i.status)).toEqual(["pending", "pending"])
})

it("addManualPair is cancelled by the shared abort controller, stranding nothing", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })
  const [a, b] = result.current.items
  expect(result.current.items.map(i => i.status)).toEqual(["ready", "ready"])

  // a/b's own fetchPairs call is held open (and rejects if the signal it was
  // given fires, exactly like a real aborted fetch would); any other call
  // (the next batch's own sweep) resolves straight away.
  let resolveHeld: (() => void) | null = null
  vi.mocked(fetchPairs).mockImplementation((files, signal) => {
    if (!files.some(f => f.name === "a.tif")) {
      return Promise.resolve({ pairs: [], count: 0, skipped: [] })
    }
    return new Promise((res, rej) => {
      signal?.addEventListener("abort", () => rej(abortErr()))
      resolveHeld = () => res(
        { pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }], count: 2, skipped: [] })
    })
  })

  let pairCall: Promise<void>
  act(() => { pairCall = result.current.addManualPair(a.id, b.id) })

  // A second, unrelated action reassigns/aborts the shared controller — the
  // same thing loadSession/clear/reprocess all do. A lone capture skips the
  // sweep entirely, so this does not touch the held fetchPairs call itself.
  act(() => result.current.stage([mkFile("c.tif")]))
  await act(async () => { await result.current.confirm() })

  // The held request finally answers, long after the operation that started
  // it was cancelled.
  act(() => resolveHeld?.())
  await act(async () => { await pairCall.catch(() => {}) })

  // The unfixed code has no signal to cancel on, so it barges ahead here and
  // marks a/b "pending" with nothing left that will ever decide them.
  expect(result.current.items.filter(i => i.status === "pending")).toHaveLength(0)
})

it("importSession replaces the session and recounts every item, never re-pairing", async () => {
  const { result } = await withCandidate()
  expect(result.current.items).toHaveLength(2)
  vi.mocked(count).mockClear()
  vi.mocked(fetchPairs).mockClear()

  const seeds = [
    { files: [mkFile("a.tif"), mkFile("b.tif")], name: "a.tif + b.tif",
      mergedFrom: ["a.tif", "b.tif"] as [string, string] },
    { files: [mkFile("c.tif")], name: "c.tif" },
  ]
  await act(async () => {
    await result.current.importSession(seeds, { params: { diameter: 30, boundary: 0 } })
  })

  // The restored items replace what was open, candidates and all.
  expect(result.current.items.map(i => i.name)).toEqual(["a.tif + b.tif", "c.tif"])
  expect(result.current.candidates).toHaveLength(0)
  expect(result.current.items.map(i => i.status)).toEqual(["ready", "ready"])
  expect(result.current.view).toBe("gallery")

  // A merged item recounts as its two-file self, and the decision is not
  // re-litigated: the pairer is never called on a restore.
  expect(count).toHaveBeenCalledTimes(2)
  expect(vi.mocked(count).mock.calls[0][0].files.map(f => f.name)).toEqual(["a.tif", "b.tif"])
  expect(result.current.items[0].field?.names).toEqual(["a.tif", "b.tif"])
  expect(result.current.items[0].mergedFrom).toEqual(["a.tif", "b.tif"])
  expect(fetchPairs).not.toHaveBeenCalled()
  // The parameters come from the file, not from the live counter state - with
  // one exception. The quality level is the gallery's: a session saved before
  // levels existed carries level 0, and honouring that would bring every card
  // back marked stale against a level it was never counted at.
  expect(vi.mocked(count).mock.calls[0][0].params)
    .toEqual({ diameter: 30, boundary: 0, level: 2 })
})

it("importSession mints ids the store will never hand out again", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif")]))
  await act(async () => { await result.current.confirm() })
  const before = result.current.items[0].id

  // A session file carries ids minted by a different run of the app; reusing
  // them would collide with the ids this session goes on to mint.
  await act(async () => {
    await result.current.importSession([
      { files: [mkFile("x.tif")], name: "x.tif" },
      { files: [mkFile("y.tif")], name: "y.tif" },
    ])
  })
  const ids = result.current.items.map(i => i.id)
  expect(new Set(ids).size).toBe(2)
  expect(ids).not.toContain(before)

  act(() => result.current.stage([mkFile("z.tif")]))
  await act(async () => { await result.current.confirm() })
  const all = result.current.items.map(i => i.id)
  expect(new Set(all).size).toBe(all.length)
})

it("an aborted restore leaves no item stuck at queued/counting", async () => {
  vi.mocked(count).mockImplementation(req => new Promise((res, rej) => {
    if (req.files[0].name === "x.tif") req.signal?.addEventListener("abort", () => rej(abortErr()))
    else res({ fields: [mkField(req.files.map(f => f.name))] })
  }))

  const { result } = await mount()
  let first: Promise<unknown>
  act(() => {
    first = result.current.importSession([
      { files: [mkFile("x.tif")], name: "x.tif" },
      { files: [mkFile("w.tif")], name: "w.tif" },
    ])
  })
  await waitFor(() => expect(result.current.items[0].status).toBe("counting"))

  // A second restore aborts the first one.
  await act(async () => {
    await result.current.importSession([{ files: [mkFile("q.tif")], name: "q.tif" }])
  })
  await act(async () => { await first })

  expect(result.current.items.map(i => i.name)).toEqual(["q.tif"])
  expect(result.current.items[0].status).toBe("ready")
})

it("openFiles resets autocrop so one item's crop cannot leak into the next", async () => {
  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())

  act(() => result.current.setAutocrop("frame"))
  expect(result.current.autocrop).toBe("frame")

  const fs = [mkFile("b.tif")]
  act(() => result.current.openFiles(fs))

  expect(result.current.autocrop).toBe("")
  expect(result.current.files).toBe(fs)
})

it("removeItems drops the items, their candidates and their selection", async () => {
  const { result } = await withCandidate()
  const [a] = result.current.items

  act(() => result.current.toggleSelected(a.id))
  expect(result.current.selected.has(a.id)).toBe(true)

  act(() => result.current.removeItems([a.id]))
  expect(result.current.items).toHaveLength(1)
  expect(result.current.candidates).toHaveLength(0)
  expect(result.current.selected.size).toBe(0)
})

it("renameItem retitles one capture and refuses a blank name", async () => {
  const { result } = await withCandidate()
  const [a, b] = result.current.items
  const before = b.name

  act(() => result.current.renameItem(a.id, "  well A3 pass 2  "))
  expect(result.current.items.find(i => i.id === a.id)?.name).toBe("well A3 pass 2")
  expect(result.current.items.find(i => i.id === b.id)?.name).toBe(before)

  // A capture with no name could not be told apart in the gallery or found in
  // an export, so a blank rename is dropped rather than applied.
  act(() => result.current.renameItem(a.id, "   "))
  expect(result.current.items.find(i => i.id === a.id)?.name).toBe("well A3 pass 2")
})

/** Both stores at once: a crop is made in the counter and has to survive a
 *  round trip through the gallery. */
async function mountBoth() {
  const h = renderHook(() => ({ g: useGallery(), c: useCounter() }), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  return h
}
const lastCall = () => vi.mocked(count).mock.calls.at(-1)![0]

it("a cropped card reopens in its crop, so Reset still has something to undo", async () => {
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await r.current.g.confirm() })
  const [a, b] = r.current.g.items

  act(() => r.current.g.openItem(a.id))
  const q: Pt[] = [[10, 10], [90, 10], [90, 90], [10, 90]]
  act(() => r.current.c.setQuad(q))
  // The crop is counted, and that cropped field is what the card now holds.
  await waitFor(() => expect(lastCall().quad).toEqual(q))
  await waitFor(() => expect(r.current.c.quad).toEqual(q))

  // Away and back. The card was cropped, so the workbench comes back cropped —
  // not showing a cropped picture with no crop recorded, where Reset was dead
  // and the next crop was measured against pixels that are not on screen.
  act(() => r.current.g.openItem(b.id))
  expect(r.current.c.quad).toBe(null)
  act(() => r.current.g.openItem(a.id))
  expect(r.current.c.quad).toEqual(q)
  await waitFor(() => expect(lastCall().quad).toEqual(q))

  // And Reset now really does bring the whole capture back.
  act(() => r.current.c.reset())
  expect(r.current.c.quad).toBe(null)
  await waitFor(() => expect(lastCall().quad).toBe(null))
})

it("a restored session reopens a saved crop, and a crop-less seed uncropped", async () => {
  const { result: r } = await mountBoth()
  const q: Pt[] = [[10, 10], [90, 10], [90, 90], [10, 90]]
  await act(async () => {
    await r.current.g.importSession([
      { files: [mkFile("a.tif")], name: "a.tif", crop: q },
      { files: [mkFile("b.tif")], name: "b.tif" },
    ])
  })
  const [a, b] = r.current.g.items

  act(() => r.current.g.openItem(a.id))
  expect(r.current.c.quad).toEqual(q)
  await waitFor(() => expect(lastCall().quad).toEqual(q))

  act(() => r.current.g.openItem(b.id))
  expect(r.current.c.quad).toBe(null)
})

it("cropsById reports the crop each card is holding, for a session save", async () => {
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await r.current.g.confirm() })
  const [a] = r.current.g.items

  expect(r.current.g.cropsById()).toEqual({})
  act(() => r.current.g.openItem(a.id))
  const q: Pt[] = [[1, 1], [9, 1], [9, 9], [1, 9]]
  act(() => r.current.c.setQuad(q))
  await waitFor(() => expect(r.current.g.cropsById()[a.id]).toEqual(q))
})

it("opening a card the gallery is still counting does not seed the old field", async () => {
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif")]))
  await act(async () => { await r.current.g.confirm() })
  const [a] = r.current.g.items
  const stale = a.field

  // A Reprocess that never finishes: the card sits at "counting" holding the
  // PREVIOUS count.
  let release: () => void = () => {}
  vi.mocked(count).mockImplementationOnce(() => new Promise(res => {
    release = () => res({ fields: [mkField(["a.tif"], 9)] })
  }))
  act(() => r.current.g.setGalleryLevel(3))
  act(() => { void r.current.g.reprocess([a.id]) })
  await waitFor(() => expect(r.current.g.items[0].status).toBe("counting"))

  const paid = vi.mocked(count).mock.calls.length
  act(() => r.current.g.openItem(a.id))
  // Nothing stale is put on the workbench, and the workbench orders its own
  // count instead of recording the old one as already satisfied.
  expect(r.current.c.fields).not.toContain(stale)
  await waitFor(() => expect(vi.mocked(count).mock.calls.length).toBe(paid + 1))
  release()
})

it("the gallery level can be lowered below the last opened capture's rung", async () => {
  const { result: r } = await mountBoth()
  act(() => r.current.g.stage([mkFile("a.tif")]))
  await act(async () => { await r.current.g.confirm() })
  act(() => r.current.g.openItem(r.current.g.items[0].id))   // counted at level 2
  await waitFor(() => expect(r.current.g.galleryLevel).toBe(2))
  act(() => r.current.g.setGalleryLevel(1))
  await act(async () => {})
  expect(r.current.g.galleryLevel).toBe(1)
})

it("leaving the overlap review cancels the holds instead of stranding them", async () => {
  const { result } = await mount()
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [{ i: 0, j: 1, dx: 0, dy: 400, seam_y: 300, ncc: 0.9 }], count: 1, skipped: [],
  })
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })
  expect(result.current.view).toBe("review")
  expect(result.current.items.map(i => i.status)).toEqual(["pending", "pending"])

  // Walking away is a decision: no merges. Nothing may be left holding a
  // spinner the review screen is no longer there to lift.
  await act(async () => { result.current.setView("gallery") })
  await waitFor(() => expect(result.current.view).toBe("gallery"))
  expect(result.current.candidates).toEqual([])
  expect(result.current.items.map(i => i.status)).toEqual(["ready", "ready"])
  expect(result.current.items.every(i => i.field)).toBe(true)
})

it("says where the duplicate already is, for the screen the user is on", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif")]))
  expect(result.current.view).toBe("confirm")
  act(() => result.current.stage([mkFile("a.tif")]))
  expect(vi.mocked(toast.info).mock.calls.at(-1)![0]).toBe("Already staged.")

  await act(async () => { await result.current.confirm() })
  act(() => result.current.stage([mkFile("a.tif")]))
  expect(vi.mocked(toast.info).mock.calls.at(-1)![0]).toBe("Already in the gallery.")
})

// ---------- the lone-capture fast path ----------

it("intake() of one capture skips confirm and lands on the workbench", async () => {
  const { result } = await mount()

  await act(async () => { result.current.intake([mkFile("a.tif")]) })
  await waitFor(() => expect(result.current.view).toBe("edit"))

  // No confirm screen, no overlap sweep: one capture cannot overlap anything
  // and has nothing to decide.
  expect(result.current.pending).toEqual([])
  expect(fetchPairs).not.toHaveBeenCalled()
  // Counted once, at the default level, and the workbench was seeded with that
  // very result rather than ordering a second count of the same picture.
  expect(count).toHaveBeenCalledTimes(1)
  expect(vi.mocked(count).mock.calls[0][0].params).toMatchObject({ level: DEFAULT_LEVEL })

  // The gallery holds the card exactly as the batch path would have left it.
  expect(result.current.items).toHaveLength(1)
  expect(result.current.items[0]).toMatchObject({ name: "a.tif", status: "ready" })
  expect(result.current.items[0].field?.names).toEqual(["a.tif"])
  expect(result.current.activeId).toBe(result.current.items[0].id)

  // Back from the workbench is the gallery, with the card still there.
  act(() => result.current.setView("gallery"))
  expect(result.current.view).toBe("gallery")
  expect(result.current.items).toHaveLength(1)
})

it("intake() keeps the confirm path for anything but a lone new capture", async () => {
  const { result } = await mount()

  // Two captures may overlap: they keep the confirm screen.
  act(() => result.current.intake([mkFile("a.tif"), mkFile("b.tif")]))
  expect(result.current.view).toBe("confirm")
  expect(result.current.pending.map(f => f.name)).toEqual(["a.tif", "b.tif"])

  // A single capture dropped onto a batch already staged joins it.
  act(() => result.current.intake([mkFile("c.tif")]))
  expect(result.current.view).toBe("confirm")
  expect(result.current.pending.map(f => f.name)).toEqual(["a.tif", "b.tif", "c.tif"])
  expect(count).not.toHaveBeenCalled()

  await act(async () => { await result.current.confirm() })
  expect(result.current.view).toBe("gallery")

  // A duplicate is still refused with a reason, never counted a second time.
  act(() => result.current.intake([mkFile("a.tif")]))
  expect(vi.mocked(toast.info).mock.calls.at(-1)![0]).toBe("Already in the gallery.")
  expect(result.current.items).toHaveLength(3)
  expect(result.current.view).toBe("gallery")
})

it("a lone capture whose count fails lands on the gallery, not a blank bench", async () => {
  vi.mocked(count).mockRejectedValue(new Error("Count failed"))
  const { result } = await mount()

  await act(async () => { result.current.intake([mkFile("a.tif")]) })
  await waitFor(() => expect(result.current.items[0]?.status).toBe("error"))
  expect(result.current.view).toBe("gallery")
  expect(result.current.items[0].error).toBe("Count failed")
})

// ---------------------------------------------------------------------------
// Name-group sweep
// ---------------------------------------------------------------------------

/** Four captures in two obvious name groups. */
const TWO_GROUPS = ["ha1 sq1.1.tif", "ha1 sq1.2.tif", "ha2 sq1.1.tif", "ha2 sq1.2.tif"]

it("arms the switch when the staged names form a pattern, and disarms when they stop", async () => {
  const { result } = await mount()

  act(() => result.current.stage(TWO_GROUPS.map(n => mkFile(n))))
  await waitFor(() => expect(result.current.namePattern).toBe(true))
  expect(result.current.nameGroups).toBe(true)
  expect(result.current.groups.map(g => g.key)).toEqual(["ha1", "ha2"])

  // Removing one capture leaves "ha2" a singleton - still a pattern: one lone
  // capture beside a pair is a field captured once, not broken naming.
  act(() => result.current.removePending("ha2 sq1.2.tif"))
  await waitFor(() => expect(result.current.pending).toHaveLength(3))
  expect(result.current.namePattern).toBe(true)

  // Taking the pair apart leaves nothing but singletons, and the full sweep is
  // the only safe answer.
  act(() => result.current.removePending("ha1 sq1.2.tif"))
  await waitFor(() => expect(result.current.namePattern).toBe(false))
  expect(result.current.nameGroups).toBe(false)
})

it("leaves the switch alone once the user has worked it", async () => {
  const { result } = await mount()
  act(() => result.current.stage(TWO_GROUPS.map(n => mkFile(n))))
  await waitFor(() => expect(result.current.nameGroups).toBe(true))

  act(() => result.current.toggleNameGroups(false))
  // Staging another capture re-runs the auto-arm, which must not override them.
  act(() => result.current.stage([mkFile("ha1 sq2.1.tif")]))
  await waitFor(() => expect(result.current.pending).toHaveLength(5))
  expect(result.current.nameGroups).toBe(false)
})

it("sweeps once per name group instead of once over the batch", async () => {
  const { result } = await mount()
  act(() => result.current.stage(TWO_GROUPS.map(n => mkFile(n))))
  await waitFor(() => expect(result.current.nameGroups).toBe(true))
  await act(async () => { await result.current.confirm() })

  expect(fetchPairs).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fetchPairs).mock.calls.map(c => c[0].map(f => f.name))).toEqual([
    ["ha1 sq1.1.tif", "ha1 sq1.2.tif"],
    ["ha2 sq1.1.tif", "ha2 sq1.2.tif"],
  ])
})

it("sweeps the whole batch in one call when the switch is off", async () => {
  const { result } = await mount()
  act(() => result.current.stage(TWO_GROUPS.map(n => mkFile(n))))
  await waitFor(() => expect(result.current.nameGroups).toBe(true))
  act(() => result.current.toggleNameGroups(false))
  await act(async () => { await result.current.confirm() })

  expect(fetchPairs).toHaveBeenCalledTimes(1)
  expect(vi.mocked(fetchPairs).mock.calls[0][0]).toHaveLength(4)
})

it("maps a group's local pair indices back onto the right captures", async () => {
  // THE failure this feature can produce silently: every sweep after the first
  // reports indices local to its own upload, so a pair found in the SECOND
  // group comes back as (0, 1) and would attach to the first group's captures
  // if the client mapped it by arithmetic.
  vi.mocked(fetchPairs).mockImplementation(async files =>
    files[0].name.startsWith("ha2")
      ? { count: 2, skipped: [], pairs: [{
          i: 0, j: 1, dx: 0, dy: 0, seam_y: 0, ncc: 1, swapped: false,
          rotation_deg: 0, a_image: "a", b_image: "b",
        }] }
      : { pairs: [], count: 2, skipped: [] })

  const { result } = await mount()
  act(() => result.current.stage(TWO_GROUPS.map(n => mkFile(n))))
  await waitFor(() => expect(result.current.nameGroups).toBe(true))
  await act(async () => { await result.current.confirm() })
  await waitFor(() => expect(result.current.view).toBe("review"))

  const [c] = result.current.candidates
  const named = (id: string) => result.current.items.find(i => i.id === id)?.name
  expect([named(c.aId), named(c.bId)]).toEqual(["ha2 sq1.1.tif", "ha2 sq1.2.tif"])
})

/** Four captures the server pairs into two independent fields, so the board has
 *  more than one decision to make in a single press. */
async function withTwoCandidates() {
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [
      { i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 },
      { i: 2, j: 3, dx: 2, dy: 480, seam_y: 290, ncc: 0.88 },
    ],
    count: 4, skipped: [],
  })
  const h = await mount()
  act(() => h.result.current.stage(
    [mkFile("a.tif"), mkFile("b.tif"), mkFile("c.tif"), mkFile("d.tif")]))
  await act(async () => { await h.result.current.confirm() })
  return h
}

it("decideAll merges every primed pair and orders ONE count run", async () => {
  const { result } = await withTwoCandidates()
  const [p, q] = result.current.candidates
  expect(result.current.view).toBe("review")

  await act(async () => {
    await result.current.decideAll([
      { c: p, action: "merge" },
      { c: q, action: "merge" },
    ])
  })

  // Four captures in, two stitched fields out.
  expect(result.current.items.map(i => i.name))
    .toEqual(["a.tif + b.tif", "c.tif + d.tif"])
  expect(result.current.items.every(i => i.status === "ready")).toBe(true)
  expect(result.current.candidates).toHaveLength(0)
  expect(result.current.view).toBe("gallery")
  // Two counts, both for stitched pairs. The board settles ONCE, so no count
  // was ordered against a half-applied item list.
  expect(vi.mocked(count).mock.calls.map(c => c[0].files.map(f => f.name)))
    .toEqual([["a.tif", "b.tif"], ["c.tif", "d.tif"]])
})

it("decideAll mixes merge and keep-both in one press", async () => {
  const { result } = await withTwoCandidates()
  const [p, q] = result.current.candidates

  await act(async () => {
    await result.current.decideAll([
      { c: p, action: "merge" },
      { c: q, action: "split" },
    ])
  })

  expect(result.current.items.map(i => i.name))
    .toEqual(["a.tif + b.tif", "c.tif", "d.tif"])
  // The split pair came off hold in the same pass: a capture left "pending"
  // after the board has been answered is one nothing will ever count.
  expect(result.current.items.map(i => i.status)).toEqual(["ready", "ready", "ready"])
  expect(result.current.view).toBe("gallery")
})

it("decideAll keeps every merged capture in the batch the run lists", async () => {
  const { result } = await withTwoCandidates()
  const [p, q] = result.current.candidates
  expect(result.current.batchIds!.size).toBe(4)

  await act(async () => {
    await result.current.decideAll([
      { c: p, action: "merge" },
      { c: q, action: "merge" },
    ])
  })

  // Two ids where there were four, and both are the merged items': every
  // staged capture is still accounted for by the batch.
  expect([...result.current.batchIds!].sort())
    .toEqual(result.current.items.map(i => i.id).sort())
})

it("a merge voids a second pair naming one of its captures", async () => {
  // b appears in both pairs. Merging a+b consumes b, so b+c has nothing left
  // to act on and must not produce a phantom item or a second count.
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [
      { i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 },
      { i: 1, j: 2, dx: 3, dy: 490, seam_y: 295, ncc: 0.7 },
    ],
    count: 3, skipped: [],
  })
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif"), mkFile("c.tif")]))
  await act(async () => { await result.current.confirm() })
  const [p, q] = result.current.candidates

  await act(async () => {
    await result.current.decideAll([
      { c: p, action: "merge" },
      { c: q, action: "merge" },
    ])
  })

  expect(result.current.items.map(i => i.name)).toEqual(["a.tif + b.tif", "c.tif"])
  expect(result.current.candidates).toHaveLength(0)
  expect(result.current.view).toBe("gallery")
  expect(vi.mocked(count).mock.calls.map(c => c[0].files.map(f => f.name)))
    .toEqual([["a.tif", "b.tif"], ["c.tif"]])
})

it("the board keeps the reasons captures could not be paired", async () => {
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }],
    count: 4,
    skipped: [{ i: 2, j: 3, names: ["c.tif", "d.tif"], reason: "they overlap by only 180 px." }],
  })
  const { result } = await mount()
  act(() => result.current.stage(
    [mkFile("a.tif"), mkFile("b.tif"), mkFile("c.tif"), mkFile("d.tif")]))
  await act(async () => { await result.current.confirm() })

  // The scan screen flashes this for a beat; the board is where it has to
  // survive, because that is where the user is deciding about pairing.
  expect(result.current.view).toBe("review")
  expect(result.current.unpaired.map(s => s.names)).toEqual([["c.tif", "d.tif"]])

  await act(async () => {
    await result.current.decideAll(
      result.current.candidates.map(c => ({ c, action: "merge" as const })))
  })

  // This run's gaps must not be reported against the next run's captures.
  expect(result.current.unpaired).toEqual([])
})

it("selectAll reads the live items, not a stale closure", async () => {
  const { result } = await mount()
  act(() => result.current.stage([mkFile("a.tif"), mkFile("b.tif")]))
  await act(async () => { await result.current.confirm() })
  const [a, b] = result.current.items
  const firstSelectAll = result.current.selectAll

  // Removing an item changes `items` but must not change selectAll's own
  // identity - it is read by GalleryGrid and must not force every consumer
  // to re-render on every items change.
  act(() => result.current.removeItems([a.id]))
  expect(result.current.selectAll).toBe(firstSelectAll)

  act(() => result.current.selectAll())
  // A stale closure over the pre-removal `items` would still offer a's id.
  expect([...result.current.selected]).toEqual([b.id])
})
