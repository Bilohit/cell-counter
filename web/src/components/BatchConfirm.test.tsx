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

// The staging screen is the last stop before the FIRST count, so the level
// picked here has to be the level that count actually runs at. Getting it wrong
// is not a cosmetic bug: the user pays for a whole batch at the wrong rung and
// has to reprocess every image to correct it.

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(), count: vi.fn(), fetchPairs: vi.fn(),
  fetchThumbs: vi.fn(() => new Promise(() => {})),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import { count, fetchPairs, fetchParams, fetchThumbs } from "@/lib/api"

const PARAMS = {
  version: "test-engine",
  groups: ["Cell check"],
  params: [{ key: "diameter", label: "Cell diameter (px)", min: 6, max: 60,
             default: 22, step: 1, group: "Cell check" }],
}

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
  vi.mocked(fetchPairs).mockResolvedValue({ pairs: [], count: 0, skipped: [] })
  vi.mocked(fetchThumbs).mockReset()
  vi.mocked(fetchThumbs).mockReturnValue(new Promise(() => {}))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  URL.createObjectURL ??= () => "blob:x"
  URL.revokeObjectURL ??= () => {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Stages one capture, which is what puts the confirm screen on screen. */
function Harness() {
  const { stage } = useGallery()
  return (
    <>
      <button type="button" onClick={() => stage([new File(["x"], "a.tif")])}>stage</button>
      <BatchConfirm />
    </>
  )
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(TooltipProvider, null,
    createElement(CounterProvider, null, createElement(GalleryProvider, null, children)))

async function staged() {
  render(createElement(Harness), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  fireEvent.click(screen.getByText("stage"))
  return screen.getByRole("slider", { name: /Quality level/i })
}

it("counts the first batch at the level chosen on this screen", async () => {
  const slider = await staged()

  // One step down from the default: the run must carry 1, not 2.
  fireEvent.keyDown(slider, { key: "ArrowLeft" })
  expect(screen.getByText("Quick")).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: /Count 1 capture/i }))
  await waitFor(() => expect(count).toHaveBeenCalled())
  expect(vi.mocked(count).mock.calls[0][0].params.level).toBe(1)
})

it("does not count while the level is being chosen", async () => {
  const slider = await staged()
  fireEvent.keyDown(slider, { key: "ArrowRight" })
  await waitFor(() => expect(screen.getByText("Finest")).toBeTruthy())
  // Same rule as every other quality slider: the button is the only thing that
  // counts. A debounce firing here would count the batch at a rung the user was
  // still scrolling past.
  expect(count).not.toHaveBeenCalled()
})

// TIF is this product's normal input and no browser decodes one, so without a
// server-rendered tile the confirm screen is a grid of grey boxes.
it("shows the server's thumbnail for a capture the browser cannot decode", async () => {
  vi.mocked(fetchThumbs).mockResolvedValue(
    { thumbs: [{ name: "a.tif", image: "data:image/jpeg;base64,AAAA" }] })

  await staged()

  const img = await screen.findByRole("presentation")
  expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA")
  // Only the undecodable file is sent, and only once.
  expect(vi.mocked(fetchThumbs).mock.calls[0][0].map(f => f.name)).toEqual(["a.tif"])
})

it("falls back to the file tile when no thumbnail comes back", async () => {
  vi.mocked(fetchThumbs).mockRejectedValue(new Error("nope"))

  await staged()

  await waitFor(() => expect(fetchThumbs).toHaveBeenCalled())
  expect(screen.getByText("TIF")).toBeTruthy()
  expect(screen.queryByRole("presentation")).toBeNull()
})

// ---------------------------------------------------------------------------
// Hand-made groups. A group is a fence for the overlap sweep, never a merge:
// getting this wrong either compares captures that can never match (slow) or
// withholds a real pair (a field counted twice, and a doubled cells/mL).
// ---------------------------------------------------------------------------

const BATCH = ["ha1 sq1.1.tif", "ha1 sq1.2.tif", "KGN sq2.1.tif", "KGN sq2.2.tif"]

function Batch() {
  const { stage } = useGallery()
  return (
    <>
      <button type="button" onClick={() => stage(BATCH.map(nm => new File(["x"], nm)))}>
        stage
      </button>
      <BatchConfirm />
      <ScanScreen />
    </>
  )
}

async function stagedBatch() {
  render(createElement(Batch), { wrapper })
  await waitFor(() => expect(fetchParams).toHaveBeenCalled())
  fireEvent.click(screen.getByText("stage"))
  // Two prefixes, two captures each: the filename rule finds a pattern and arms
  // the switch, which is what puts the board on screen.
  await waitFor(() => expect(screen.getByText("ha1")).toBeTruthy())
}

const tile = (nm: string) => screen.getByRole("button", { name: new RegExp(`Select ${nm}`) })

/** The file lists handed to each /api/pairs call, in call order. */
const sweptNames = () =>
  vi.mocked(fetchPairs).mock.calls.map(c => c[0].map(f => f.name))

it("seeds the board from the filename rule and sweeps inside each band", async () => {
  await stagedBatch()
  expect(screen.getByText("KGN")).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: /Count 4 captures/i }))
  await waitFor(() => expect(fetchPairs).toHaveBeenCalledTimes(2))
  expect(sweptNames()).toEqual([BATCH.slice(0, 2), BATCH.slice(2)])
})

it("groups the captures the user ticked, and sweeps that group instead", async () => {
  await stagedBatch()

  // One capture out of each automatic band - the case the filename rule cannot
  // get right and the whole feature exists for.
  fireEvent.click(tile("ha1 sq1.1.tif"))
  fireEvent.click(tile("KGN sq2.1.tif"))
  expect(screen.getByText("2 selected")).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: /New group from 2 selected/i }))

  // The two they were taken from are left holding one capture each, so neither
  // has anyone to pair with and neither is swept.
  await waitFor(() => expect(screen.getByText("Group 1")).toBeTruthy())
  fireEvent.click(screen.getByRole("button", { name: /Count 4 captures/i }))
  await waitFor(() => expect(fetchPairs).toHaveBeenCalledTimes(1))
  expect(sweptNames()).toEqual([["ha1 sq1.1.tif", "KGN sq2.1.tif"]])
})

it("hands a band back to the tray when it is ungrouped", async () => {
  await stagedBatch()
  fireEvent.click(screen.getAllByRole("button", { name: /^Ungroup$/ })[0])

  await waitFor(() => expect(screen.getByText("Ungrouped")).toBeTruthy())
  expect(screen.queryByText("ha1")).toBeNull()
  // The leftovers are still swept against each other - that is what a capture
  // nobody grouped always got - so the pair that is left is still a band.
  fireEvent.click(screen.getByRole("button", { name: /Count 4 captures/i }))
  await waitFor(() => expect(fetchPairs).toHaveBeenCalledTimes(2))
  expect(sweptNames()).toEqual([BATCH.slice(2), BATCH.slice(0, 2)])
})

it("puts the board back under the filename rule on Reset", async () => {
  await stagedBatch()
  fireEvent.click(tile("ha1 sq1.1.tif"))
  fireEvent.click(screen.getByRole("button", { name: /New group from 1 selected/i }))
  await waitFor(() => expect(screen.getByText("Group 1")).toBeTruthy())

  fireEvent.click(screen.getByRole("button", { name: /Reset to automatic/i }))
  await waitFor(() => expect(screen.queryByText("Group 1")).toBeNull())
  expect(screen.getByText("ha1")).toBeTruthy()
  expect(screen.getByText("KGN")).toBeTruthy()
})

// The one thing a hand-made group owes the user. Putting two captures together
// is a claim; the pixels still decide, but a claim the sweep turns down has to
// be SAID, or a field counted twice looks exactly like a merge that worked.
it("says so when a hand-made pair turns out not to overlap", async () => {
  await stagedBatch()
  fireEvent.click(tile("ha1 sq1.1.tif"))
  fireEvent.click(tile("KGN sq2.1.tif"))
  fireEvent.click(screen.getByRole("button", { name: /New group from 2 selected/i }))
  await waitFor(() => expect(screen.getByText("Group 1")).toBeTruthy())

  fireEvent.click(screen.getByRole("button", { name: /Count 4 captures/i }))
  await waitFor(() => expect(screen.getByTestId("view-scan")).toBeTruthy())
  await screen.findByText(/ha1 sq1\.1\.tif and KGN sq2\.1\.tif: you grouped these two/)
})
