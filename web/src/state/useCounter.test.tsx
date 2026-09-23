// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { CounterProvider, useCounter } from "./useCounter"

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(),
  count: vi.fn(),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import { count, fetchParams } from "@/lib/api"

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(CounterProvider, null, children)

const mkFile = (name: string) => new File(["xxxx"], name, { type: "image/png" })

beforeEach(() => {
  vi.mocked(fetchParams).mockReset()
  vi.mocked(count).mockReset()
  vi.mocked(count).mockResolvedValue({
    fields: [{
      names: ["a.tif"], count: 1, centers: [], grid_x: [], grid_y: [], diameter: 22,
      level: 3, grid_cols: 1, grid_rows: 1, squares: [], frame: null, base_image: "b", stages: [], stitch: null, width: 10, height: 10,
    }],
  })
})

it("recovers from transient /api/params failures and becomes ready", async () => {
  vi.mocked(fetchParams)
    .mockRejectedValueOnce(new Error("boom"))
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })

  await waitFor(() => expect(result.current.version).toBe("v"), { timeout: 5000 })
  expect(result.current.serverDown).toBe(false)

  act(() => { result.current.openFiles([mkFile("a.tif")]) })
  await waitFor(() => expect(count).toHaveBeenCalled(), { timeout: 2000 })
}, 10000)

it("sets serverDown and exposes a working retryServer after repeated failures", async () => {
  vi.mocked(fetchParams).mockRejectedValue(new Error("boom"))

  const { result } = renderHook(() => useCounter(), { wrapper })

  await waitFor(() => expect(result.current.serverDown).toBe(true), { timeout: 5000 })
  expect(result.current.version).toBe("")
  const callsBefore = vi.mocked(fetchParams).mock.calls.length
  expect(callsBefore).toBe(3)

  vi.mocked(fetchParams).mockResolvedValueOnce({ version: "v2" })
  act(() => { result.current.retryServer() })

  await waitFor(() => expect(result.current.version).toBe("v2"))
  expect(result.current.serverDown).toBe(false)
}, 10000)

it("reset() clears auto-crop as well as the hand-drawn quad", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.setAutocrop("frame") })
  expect(result.current.autocrop).toBe("frame")

  act(() => { result.current.reset() })

  expect(result.current.autocrop).toBe("")
  expect(result.current.quad).toBeNull()
})

const seedField = {
  names: ["a.tif"], count: 5, centers: [], grid_x: [], grid_y: [], diameter: 22,
  level: 3, grid_cols: 4, grid_rows: 4, squares: [], frame: null, base_image: "seed-b", stages: [], stitch: null, width: 10, height: 10,
}

it("openFiles with a seed field shows it without calling /api/count", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.openFiles([mkFile("seed.tif")], 3, seedField) })

  // The seed lands on screen immediately - no debounce to wait past.
  expect(result.current.field).toEqual(seedField)
  expect(result.current.status).toBe("done")

  // Give the 250ms debounce a chance to fire if the seed path were broken.
  await new Promise(r => setTimeout(r, 400))
  expect(count).not.toHaveBeenCalled()
})

it("openFiles clears both quad and autocrop", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.setAutocrop("frame") })
  act(() => { result.current.setQuad([[0, 0], [1, 0], [1, 1], [0, 1]]) })
  expect(result.current.autocrop).toBe("frame")
  expect(result.current.quad).not.toBeNull()

  act(() => { result.current.openFiles([mkFile("b.tif")]) })

  expect(result.current.autocrop).toBe("")
  expect(result.current.quad).toBeNull()
})

it("a boundary change recounts, and so does a quad change", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.openFiles([mkFile("c.tif")]) })
  await waitFor(() => expect(count).toHaveBeenCalledTimes(1))

  act(() => { result.current.setBoundary(false) })
  await waitFor(() => expect(count).toHaveBeenCalledTimes(2))

  act(() => { result.current.setQuad([[0, 0], [1, 0], [1, 1], [0, 1]]) })
  await waitFor(() => expect(count).toHaveBeenCalledTimes(3))
})

it("clearEdits drops added/removed corrections but leaves excluded squares alone", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.openFiles([mkFile("d.tif")]) })
  await waitFor(() => expect(result.current.field).toBeTruthy())

  act(() => { result.current.clickAt(5, 5) }) // adds a hand-drawn dot
  act(() => { result.current.toggleSquare("0-0") })
  expect(result.current.edits.added.length).toBe(1)
  expect(result.current.off.has("0-0")).toBe(true)

  act(() => { result.current.clearEdits() })

  expect(result.current.edits.added.length).toBe(0)
  expect(result.current.edits.removed.length).toBe(0)
  expect(result.current.off.has("0-0")).toBe(true)
})

// Two rules, one bug. Until 2026-09-21 the seed was installed only when "Show
// pipeline steps" was OFF, because the gallery counts with stages off and a
// stages-on view wanted stage images. With the switch on, that meant nothing
// was installed at all: `fields` stayed empty and the workbench rendered its
// first-run drop zone over an image that was already counted, while a silent
// full recount ran behind it.
it("installs the gallery's seed even with the stage strip showing", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.setShowStages(true) })
  act(() => { result.current.openFiles([mkFile("seed.tif")], 3, seedField) })

  expect(result.current.field).toEqual(seedField)
  expect(result.current.status).toBe("done")

  // And no count follows: the seed satisfied the view, stage strip or not.
  await new Promise(r => setTimeout(r, 400))
  expect(count).not.toHaveBeenCalled()
})

// `showStages` is a DISPLAY setting. It used to sit in the count key and in
// this effect's deps, so flipping it fired a full recount - up to ~7 s, behind
// the settings dialog, with no confirmation, writing its result back over the
// card. Only Reprocess counts.
it("does not count when Show pipeline steps is toggled", async () => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "v" })

  const { result } = renderHook(() => useCounter(), { wrapper })
  await waitFor(() => expect(result.current.version).toBe("v"))

  act(() => { result.current.openFiles([mkFile("seed.tif")], 3, seedField) })
  await new Promise(r => setTimeout(r, 400))
  expect(count).not.toHaveBeenCalled()

  act(() => { result.current.setShowStages(true) })
  await new Promise(r => setTimeout(r, 400))
  expect(count).not.toHaveBeenCalled()

  act(() => { result.current.setShowStages(false) })
  await new Promise(r => setTimeout(r, 400))
  expect(count).not.toHaveBeenCalled()
})
