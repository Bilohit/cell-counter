// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { OverlapBoard } from "@/components/OverlapBoard"
import type { Field } from "@/lib/types"
import { CounterProvider } from "@/state/useCounter"
import { GalleryProvider, useGallery } from "@/state/useGallery"

// The board answers EVERY pair in one press, which is the whole reason it
// exists. The thing these tests guard is that the press acts on what the switches
// say — a board that merged a pair the user had set to "Keep both" would count
// one field where the user asked for two, and nothing downstream would say so.

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(), count: vi.fn(), fetchPairs: vi.fn(),
  fetchThumbs: vi.fn(() => new Promise(() => {})),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import { count, fetchPairs, fetchParams } from "@/lib/api"

const PARAMS = { version: "test-engine", groups: [], params: [] }

const mkField = (names: string[]): Field => ({
  names, count: 3, centers: [], grid_x: [], grid_y: [], diameter: 22, level: 2,
  grid_cols: 0, grid_rows: 0, squares: [], frame: null, base_image: "",
  stages: [], stitch: null, width: 10, height: 10,
})

beforeEach(() => {
  vi.mocked(fetchParams).mockResolvedValue(PARAMS)
  vi.mocked(count).mockReset()
  vi.mocked(fetchPairs).mockReset()
  vi.mocked(count).mockImplementation(async req =>
    ({ fields: [mkField(req.files.map(f => f.name))] }))
  // Four captures, two independent pairs: enough for "all" to mean something
  // and for one pair to disagree with the other.
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [
      { i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 },
      { i: 2, j: 3, dx: 2, dy: 480, seam_y: 290, ncc: 0.88 },
    ],
    count: 4, skipped: [],
  })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  URL.createObjectURL ??= () => "blob:x"
  URL.revokeObjectURL ??= () => {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
  const { stage, confirm, pending } = useGallery()
  return (
    <>
      <button type="button" onClick={() => stage(
        ["a.tif", "b.tif", "c.tif", "d.tif"].map(n => new File(["x"], n)))}>
        stage
      </button>
      <button type="button" onClick={() => void confirm()} disabled={!pending.length}>
        run
      </button>
      <OverlapBoard />
    </>
  )
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(CounterProvider, null,
    createElement(GalleryProvider, null,
      createElement(TooltipProvider, null, children)))

/** Get to the board: stage four captures, sweep them, land on the review. */
async function board() {
  render(createElement(Harness), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  fireEvent.click(screen.getByText("stage"))
  fireEvent.click(screen.getByText("run"))
  await screen.findByText("2 pairs of captures overlap", {}, { timeout: 5000 })
}

/** The switches, in card order. The board-wide one is excluded by its wording:
 *  it says "all" precisely so it cannot be mistaken for a pair's own. */
const cardSwitches = () => screen.getAllByRole("button", { name: "Keep both" })

const countedGroups = () =>
  vi.mocked(count).mock.calls.map(c => c[0].files.map(f => f.name))

it("shows one card per pair and primes them all to merge", async () => {
  await board()
  expect(cardSwitches()).toHaveLength(2)
  // Merge is the default because it is what the sweep is claiming: these two
  // are one field, and counting them apart counts the overlap twice.
  expect(screen.getByRole("button", { name: "Merge all" })
    .getAttribute("aria-pressed")).toBe("true")
  expect(screen.getByText(/4 captures · 2 to merge · 2 fields to count/)).toBeTruthy()
})

it("the subline tracks each switch, and nothing is counted until Overlap", async () => {
  await board()
  fireEvent.click(cardSwitches()[0])

  expect(screen.getByText(/4 captures · 1 to merge · 3 fields to count/)).toBeTruthy()
  // Priming is not deciding. The run is still the only thing that counts.
  expect(count).not.toHaveBeenCalled()
})

it("the board-wide switch reads `mixed` when the pairs disagree", async () => {
  await board()
  const all = screen.getByRole("button", { name: "Merge all" })
  expect(all.getAttribute("aria-pressed")).toBe("true")

  fireEvent.click(cardSwitches()[0])

  // Neither end is claimed: rounding a split board to one setting would tell
  // the user something untrue about their own board.
  expect(all.getAttribute("aria-pressed")).toBe("false")
  expect(screen.getByRole("button", { name: "Keep all" })
    .getAttribute("aria-pressed")).toBe("false")
})

it("Keep all then Merge all sets every pair, both ways", async () => {
  await board()
  fireEvent.click(screen.getByRole("button", { name: "Keep all" }))
  expect(screen.getByText(/0 to merge · 4 fields to count/)).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: "Merge all" }))
  expect(screen.getByText(/2 to merge · 2 fields to count/)).toBeTruthy()
})

it("Overlap merges every primed pair in one press", async () => {
  await board()
  fireEvent.click(screen.getByRole("button", { name: /Overlap/ }))

  await waitFor(() => expect(count).toHaveBeenCalledTimes(2), { timeout: 5000 })
  expect(countedGroups()).toEqual([["a.tif", "b.tif"], ["c.tif", "d.tif"]])
})

it("Overlap honours a pair set to Keep both", async () => {
  await board()
  fireEvent.click(cardSwitches()[1])          // the second pair stays apart
  fireEvent.click(screen.getByRole("button", { name: /Overlap/ }))

  await waitFor(() => expect(count).toHaveBeenCalledTimes(3), { timeout: 5000 })
  // One stitched field and two captures counted on their own — exactly what
  // the two switches said, not what the bulk control defaulted to.
  expect(countedGroups()).toEqual([["a.tif", "b.tif"], ["c.tif"], ["d.tif"]])
})

it("a capture that could not be paired is named on the board", async () => {
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [{ i: 0, j: 1, dx: 4, dy: 500, seam_y: 300, ncc: 0.9 }],
    count: 4,
    skipped: [{ i: 2, j: 3, names: ["c.tif", "d.tif"], reason: "they overlap by only 180 px." }],
  })
  render(createElement(Harness), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  fireEvent.click(screen.getByText("stage"))
  fireEvent.click(screen.getByText("run"))
  await screen.findByText("1 pair of captures overlap", {}, { timeout: 5000 })

  // The scan screen shows this for 3.2 s and then loses it. Two captures of one
  // field counted separately is a doubled cells/mL, so the reason has to
  // survive to the screen where the user is deciding about pairing.
  expect(screen.getByText(/could not be lined up/)).toBeTruthy()
  expect(screen.getByText(/c\.tif \+ d\.tif/)).toBeTruthy()
})
