// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BatchConfirm } from "@/components/BatchConfirm"
import { ScanScreen } from "@/components/ScanScreen"
import type { Field } from "@/lib/types"
import { CounterProvider } from "@/state/useCounter"
import { GalleryProvider, useGallery } from "@/state/useGallery"

// api_pairs has always said WHY a capture got no partner, and nothing ever
// showed it (AUDIT-2026-09-05 #8). "No overlaps" is a half-truth when the real
// answer is "these two are different sizes", and this screen is where the user
// reads the verdict.

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(), count: vi.fn(), fetchPairs: vi.fn(),
  fetchThumbs: vi.fn(() => new Promise(() => {})),
  fetchSweepProgress: vi.fn(async () => ({ done: 0, total: 0 })),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import {
  count, fetchPairs, fetchParams, fetchSweepProgress, fetchThumbs,
} from "@/lib/api"

const mkField = (names: string[]): Field => ({
  names, count: 3, centers: [], grid_x: [], grid_y: [], diameter: 22, level: 2,
  grid_cols: 0, grid_rows: 0, squares: [], frame: null, base_image: "",
  stages: [], stitch: null, width: 10, height: 10,
})

beforeEach(() => {
  vi.mocked(fetchParams).mockResolvedValue({ version: "test-engine" })
  vi.mocked(count).mockReset()
  vi.mocked(count).mockImplementation(async req =>
    ({ fields: [mkField(req.files.map(f => f.name))] }))
  vi.mocked(fetchThumbs).mockReset()
  vi.mocked(fetchThumbs).mockReturnValue(new Promise(() => {}))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  URL.createObjectURL ??= () => "blob:x"
  URL.revokeObjectURL ??= () => {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
  const { stage } = useGallery()
  return (
    <>
      <button type="button" onClick={() => stage(
        [new File(["x"], "a.tif"), new File(["y"], "b.tif")])}>stage</button>
      <BatchConfirm />
      <ScanScreen />
    </>
  )
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(TooltipProvider, null,
    createElement(CounterProvider, null, createElement(GalleryProvider, null, children)))

async function sweep() {
  render(createElement(Harness), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  fireEvent.click(screen.getByText("stage"))
  fireEvent.click(screen.getByRole("button", { name: /Count 2 captures/i }))
  await waitFor(() => expect(fetchPairs).toHaveBeenCalled())
}

it("names the two captures and why they could not pair", async () => {
  const reason = "These two captures are different sizes (10 x 10 and 5 x 5), " +
    "so they cannot be two views of one field."
  vi.mocked(fetchPairs).mockResolvedValue({
    pairs: [], count: 2,
    skipped: [{ i: 0, j: 1, reason, names: ["a.tif", "b.tif"] }],
  })

  await sweep()

  expect(await screen.findByText(`a.tif and b.tif: ${reason}`)).toBeTruthy()
  // The verdict itself still stands; the reason explains it rather than
  // replacing it.
  expect(screen.getByText(/No overlaps/)).toBeTruthy()
})

it("says nothing extra when every capture was compared", async () => {
  vi.mocked(fetchPairs).mockResolvedValue({ pairs: [], count: 2, skipped: [] })

  await sweep()

  expect(await screen.findByText(/No overlaps/)).toBeTruthy()
  expect(screen.queryByText(/different sizes/)).toBeNull()
})

// --- the progress bar -----------------------------------------------------
//
// A sweep of 78 comparisons measured 5.2 s cold (see PROGRESS_MIN_COMPARISONS),
// and until now every one of those seconds looked identical to a hung server.

/** Stage `n` captures and press Count, without waiting for the sweep to answer. */
async function sweepOf(n: number) {
  const files = Array.from({ length: n }, (_, i) => new File(["x"], `c${i}.tif`))
  function Big() {
    const { stage } = useGallery()
    return (
      <>
        <button type="button" onClick={() => stage(files)}>stage</button>
        <BatchConfirm />
        <ScanScreen />
      </>
    )
  }
  render(createElement(Big), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  fireEvent.click(screen.getByText("stage"))
  fireEvent.click(screen.getByRole("button", { name: /Count \d+ captures/i }))
}

it("shows a real bar once the sweep is long enough to need one", async () => {
  // Held open, so the screen stays on the checking state the bar belongs to.
  vi.mocked(fetchPairs).mockReturnValue(new Promise(() => {}))
  // 13 captures is 78 comparisons: the measured five-second sweep.
  await sweepOf(13)

  expect(await screen.findByText("0 of 78 comparisons")).toBeTruthy()
  expect(screen.getByRole("progressbar", { name: /overlap check progress/i })).toBeTruthy()
})

it("moves the bar as the server reports comparisons done", async () => {
  vi.mocked(fetchPairs).mockReturnValue(new Promise(() => {}))
  vi.mocked(fetchSweepProgress).mockResolvedValue({ done: 30, total: 78 })
  await sweepOf(13)

  expect(await screen.findByText("30 of 78 comparisons")).toBeTruthy()
})

it("leaves a short sweep the screen it always had", async () => {
  vi.mocked(fetchPairs).mockReturnValue(new Promise(() => {}))
  // Three captures is three comparisons - under a fifth of a second. A bar
  // that appeared and vanished would be a flicker, not an answer.
  await sweepOf(3)

  expect(await screen.findByText(/Comparing 3 captures/)).toBeTruthy()
  expect(screen.queryByRole("progressbar")).toBeNull()
})
