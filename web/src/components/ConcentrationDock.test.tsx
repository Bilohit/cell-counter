// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Field } from "@/lib/types"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { GalleryProvider, useGallery } from "@/state/useGallery"
import { ConcentrationDock } from "@/components/ConcentrationDock"
import { openDockWith } from "@/lib/concentration"

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(),
  count: vi.fn(),
  fetchPairs: vi.fn(),
  fetchThumbs: vi.fn(() => new Promise(() => {})),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import { count, fetchPairs, fetchParams } from "@/lib/api"

const PARAMS = { version: "test-engine" }

// A full square: 4 by 4 grid, every frame side closed (see concentration.ts).
const fullField = (names: string[], n: number): Field => ({
  names, count: n, centers: Array.from({ length: n }, (_, i) => [i, i] as [number, number]),
  grid_x: [], grid_y: [], diameter: 22, level: 2, grid_cols: 4, grid_rows: 4, squares: [],
  frame: { x0: 0, y0: 0, x1: 10, y1: 10, sides: { left: true, right: true, top: true, bottom: true } },
  base_image: "b", stages: [], stitch: null, width: 100, height: 100,
})

const mkFile = (name: string, body = "xxxx") =>
  new File([body], name, { type: "image/png" })

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(CounterProvider, null, createElement(GalleryProvider, null, children))

/** Stages one capture and waits for it to land as a ready, full-square field,
 *  so the dock's counted defaults have something real to sum. */
function Harness({ files = ["a.tif"] }: { files?: string[] }) {
  const { stage, confirm, view, items } = useGallery()
  const { version } = useCounter()
  if (!version) return <p>loading</p>
  return (
    <div style={{ position: "relative", height: 400 }}>
      <button onClick={() => stage(files.map(n => mkFile(n)))}>stage</button>
      <button onClick={() => confirm()}>confirm</button>
      <p data-testid="view">{view}</p>
      <p data-testid="count">{items.filter(i => i.status === "ready").length}</p>
      <ConcentrationDock />
    </div>
  )
}

beforeEach(() => {
  // The dock lives in sessionStorage, which one test would otherwise hand the
  // next - a band left loaded by one case would blank the next one's defaults.
  sessionStorage.clear()
  vi.mocked(fetchParams).mockResolvedValue(PARAMS)
  vi.mocked(count).mockReset()
  vi.mocked(fetchPairs).mockReset()
  vi.mocked(count).mockImplementation(async req =>
    ({ fields: [fullField(req.files.map(f => f.name), 40)] }))
  vi.mocked(fetchPairs).mockResolvedValue({ pairs: [], count: 0, skipped: [] })

  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function stageOne() {
  render(<Harness />, { wrapper })
  fireEvent.click(await screen.findByText("stage"))
  await waitFor(() => expect(screen.getByTestId("view").textContent).toBe("confirm"))
  fireEvent.click(screen.getByRole("button", { name: "confirm" }))
  await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"))
}

const val = (el: HTMLElement) => (el as HTMLInputElement).value

it("shows a closed tab that opens the calculator panel", async () => {
  render(<Harness />, { wrapper })
  const tab = await screen.findByRole("button", { name: "Open the concentration calculator" })
  expect(screen.queryByText("Concentration")).toBeTruthy()

  fireEvent.click(tab)
  expect(await screen.findByLabelText("Close the calculator")).toBeTruthy()
})

it("opens with cells and squares summed from full-square fields only", async () => {
  await stageOne()
  fireEvent.click(screen.getByRole("button", { name: "Open the concentration calculator" }))

  expect(val(await screen.findByLabelText("cells counted"))).toBe("40")
  expect(val(screen.getByLabelText("full squares"))).toBe("1")
  expect(val(screen.getByLabelText("dilution"))).toBe("1")
})

it("typing a slot marks it edited, amber-dashed, and reveals the reset button", async () => {
  await stageOne()
  fireEvent.click(screen.getByRole("button", { name: "Open the concentration calculator" }))

  const dilution = await screen.findByLabelText("dilution")
  expect(screen.queryByText("Reset to counted values")).toBeNull()

  fireEvent.change(dilution, { target: { value: "2" } })
  expect(val(dilution)).toBe("2")
  expect(await screen.findByText("Reset to counted values")).toBeTruthy()

  fireEvent.click(screen.getByText("Reset to counted values"))
  await waitFor(() => expect(val(screen.getByLabelText("dilution"))).toBe("1"))
  expect(screen.queryByText("Reset to counted values")).toBeNull()
})

/** Four captures whose names split into two bands by the filename rule, so the
 *  session reaches the gallery genuinely grouped - the same path a real batch
 *  takes, rather than a group posted straight into the store. */
async function stageTwoBands() {
  render(<Harness files={["ha1 sq1.1.tif", "ha1 sq1.2.tif", "KGN sq2.1.tif", "KGN sq2.2.tif"]} />,
    { wrapper })
  fireEvent.click(await screen.findByText("stage"))
  await waitFor(() => expect(screen.getByTestId("view").textContent).toBe("confirm"))
  fireEvent.click(screen.getByRole("button", { name: "confirm" }))
  await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("4"), { timeout: 5000 })
}

// Two bands are two samples. One cells/mL summed over both describes neither,
// and it looks exactly like a right answer - so the panel refuses to guess.
it("opens blank when the session holds more than one band", async () => {
  await stageTwoBands()
  fireEvent.click(screen.getByRole("button", { name: "Open the concentration calculator" }))

  expect(val(await screen.findByLabelText("cells counted"))).toBe("")
  expect(val(screen.getByLabelText("full squares"))).toBe("")
  expect(screen.getByText("—")).toBeTruthy()
})

it("takes one band, names itself after it, and hands itself back", async () => {
  await stageTwoBands()
  openDockWith("KGN")

  // It opens itself: the band was sent from a header, not from in here.
  expect(val(await screen.findByLabelText("cells counted"))).toBe("80")
  expect(val(screen.getByLabelText("full squares"))).toBe("2")
  // One title bar, and the band is the title.
  expect(screen.getByTestId("dock-title").textContent).toBe("KGN")

  fireEvent.click(screen.getByLabelText("Back to the whole session"))
  await waitFor(() => expect(val(screen.getByLabelText("cells counted"))).toBe(""))
  expect(screen.getByTestId("dock-title").textContent).toBe("Concentration")
})

it("says nothing about full squares - the divisor field already is that number", async () => {
  await stageOne()
  fireEvent.click(screen.getByRole("button", { name: "Open the concentration calculator" }))
  // The divisor is shown once, in the field the user can edit.
  expect(val(await screen.findByLabelText("full squares"))).toBe("1")
  // ...and never restated as a tally. (The field's own caption still reads
  // "full squares", so this matches a COUNT of them, not the label.)
  expect(screen.queryByText(/\d+ full square/)).toBeNull()
  // Nothing partial in this fixture, so there is nothing to explain and no
  // disclosure to open.
  expect(screen.queryByRole("button", { name: /partial/ })).toBeNull()
})
