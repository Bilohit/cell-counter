// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Field } from "@/lib/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { GalleryProvider, useGallery } from "@/state/useGallery"
import { GalleryGrid } from "@/components/GalleryGrid"
import { BAR } from "@/lib/styles"

// The counted screen lays its cards out in the bands the SWEEP used, and each
// band hands its own numbers to the calculator. Two bands are two samples: the
// whole point of the band is that their counts are never added together.

vi.mock("@/lib/api", () => ({
  fetchParams: vi.fn(),
  count: vi.fn(),
  fetchPairs: vi.fn(),
  fetchThumbs: vi.fn(() => new Promise(() => {})),
  fetchCountProgress: vi.fn(() => new Promise(() => {})),
}))
import { count, fetchPairs, fetchParams } from "@/lib/api"

const fullField = (names: string[], n: number): Field => ({
  names, count: n, centers: Array.from({ length: n }, (_, i) => [i + 1, i + 1] as [number, number]),
  grid_x: [], grid_y: [], diameter: 22, level: 2, grid_cols: 4, grid_rows: 4, squares: [],
  frame: { x0: 0, y0: 0, x1: 10, y1: 10, sides: { left: true, right: true, top: true, bottom: true } },
  base_image: "b", stages: [], stitch: null, width: 100, height: 100,
})

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(TooltipProvider, null,
    createElement(CounterProvider, null, createElement(GalleryProvider, null, children)))

function Harness({ files }: { files: string[] }) {
  const { stage, confirm, view, items } = useGallery()
  const { version } = useCounter()
  if (!version) return <p>loading</p>
  return (
    <div style={{ position: "relative", height: 600 }}>
      <button onClick={() => stage(files.map(n => new File(["xxxx"], n, { type: "image/png" })))}>
        stage
      </button>
      <button onClick={() => confirm()}>confirm</button>
      <p data-testid="view">{view}</p>
      <p data-testid="ready">{items.filter(i => i.status === "ready").length}</p>
      {/* The gallery carries the calculator in its own bottom bar; a second one
          here would be a second panel reading the same storage. */}
      <GalleryGrid onOpenSettings={() => {}} />
    </div>
  )
}

beforeEach(() => {
  sessionStorage.clear()
  vi.mocked(fetchParams).mockResolvedValue({ version: "test-engine" })
  vi.mocked(count).mockReset()
  vi.mocked(fetchPairs).mockReset()
  vi.mocked(count).mockImplementation(async req =>
    ({ fields: [fullField(req.files.map(f => f.name), 40)] }))
  vi.mocked(fetchPairs).mockResolvedValue({ pairs: [], count: 0, skipped: [] })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  URL.createObjectURL ??= () => "blob:x"
  URL.revokeObjectURL ??= () => {}
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function counted(files: string[]) {
  render(<Harness files={files} />, { wrapper })
  fireEvent.click(await screen.findByText("stage"))
  await waitFor(() => expect(screen.getByTestId("view").textContent).toBe("confirm"))
  fireEvent.click(screen.getByRole("button", { name: "confirm" }))
  await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe(String(files.length)),
    { timeout: 5000 })
}

const TWO = ["ha1 sq1.1.tif", "ha1 sq1.2.tif", "KGN sq2.1.tif", "KGN sq2.2.tif"]

it("heads each band with its own name, tally and calculator button", async () => {
  await counted(TWO)
  expect(screen.getByRole("button", { name: /Send ha1 to the concentration calculator/ })).toBeTruthy()
  expect(screen.getByRole("button", { name: /Send KGN to the concentration calculator/ })).toBeTruthy()
  // 2 fields of 40 cells each, both full squares.
  expect(screen.getAllByText(/fields/).length).toBe(2)
  expect(screen.getAllByText(/80/).length).toBeGreaterThan(0)
})

it("sends that band's numbers, and only that band's, to the calculator", async () => {
  await counted(TWO)
  fireEvent.click(screen.getByRole("button", { name: /Send KGN to the concentration calculator/ }))

  expect((await screen.findByLabelText("cells counted") as HTMLInputElement).value).toBe("80")
  expect(screen.getByTestId("dock-title").textContent).toBe("KGN")
})

// One band is not a grouping, it is a label over everything - so the grid stays
// the flat wall of cards it has always been.
it("draws no headings at all when every capture is in one band", async () => {
  await counted(["ha1 sq1.1.tif", "ha1 sq1.2.tif"])
  expect(screen.queryByRole("button", { name: /to the concentration calculator/ })).toBeNull()
})

// The sweep builds bands from filenames before anything is counted, so a batch
// whose names formed no pattern reaches this screen as one heap - and a heap
// cannot be handed to the calculator one sample at a time.
it("makes a band by hand out of a selection", async () => {
  await counted(["ha1 sq1.1.tif", "ha1 sq1.2.tif"])
  fireEvent.click(screen.getByRole("button", { name: "Select" }))
  fireEvent.click(screen.getByRole("button", { name: "Select ha1 sq1.1.tif" }))
  fireEvent.click(screen.getByRole("button", { name: "Group" }))

  await waitFor(() => expect(
    screen.getByRole("button", { name: /Send Group 1 to the concentration calculator/ })).toBeTruthy())
  // What is left behind is the leftovers, and two bands are a grouping - so
  // both now carry a header where one band carried none.
  expect(screen.getByRole("button", { name: /Send Ungrouped to the concentration calculator/ }))
    .toBeTruthy()
})

// A failed card used to be a dead, disabled button - the user was told the
// count failed and given no way to try again from the card itself.
it("retries a failed card on click instead of leaving it dead", async () => {
  vi.mocked(count).mockImplementation(async req => {
    if (req.files.some(f => f.name.includes("sq1"))) throw new Error("server exploded")
    return { fields: [fullField(req.files.map(f => f.name), 40)] }
  })
  render(<Harness files={["ha1 sq1.1.tif", "KGN sq2.1.tif"]} />, { wrapper })
  fireEvent.click(await screen.findByText("stage"))
  await waitFor(() => expect(screen.getByTestId("view").textContent).toBe("confirm"))
  fireEvent.click(screen.getByRole("button", { name: "confirm" }))
  await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("1"), { timeout: 5000 })

  const retry = await screen.findByRole("button", { name: /^Retry ha1 sq1\.1\.tif —/ })
  expect(retry.hasAttribute("disabled")).toBe(false)

  vi.mocked(count).mockClear()
  vi.mocked(count).mockImplementation(async req =>
    ({ fields: [fullField(req.files.map(f => f.name), 40)] }))
  fireEvent.click(retry)

  await waitFor(() => expect(count).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("2"), { timeout: 5000 })
})

// A working card's only visible mark was its spinner - nothing in the
// accessible name said whether a card was still counting or just sitting
// there ready, so a screen-reader user got no status at all for it. Counting
// runs one item at a time (see useGallery.runCounts), so with two items in
// the batch the first is "counting" while the second waits at "queued".
it("says so in the accessible name while a card is counting or queued", async () => {
  let resolveFirst!: (v: { fields: ReturnType<typeof fullField>[] }) => void
  vi.mocked(count).mockImplementation(req => {
    if (req.files[0].name.includes("sq1")) {
      return new Promise(resolve => { resolveFirst = resolve })
    }
    return Promise.resolve({ fields: [fullField(req.files.map(f => f.name), 40)] })
  })

  render(<Harness files={["ha1 sq1.1.tif", "KGN sq2.1.tif"]} />, { wrapper })
  fireEvent.click(await screen.findByText("stage"))
  await waitFor(() => expect(screen.getByTestId("view").textContent).toBe("confirm"))
  fireEvent.click(screen.getByRole("button", { name: "confirm" }))

  await screen.findByRole(
    "button", { name: /^Open ha1 sq1\.1\.tif — counting…$/ }, { timeout: 5000 })
  expect(screen.getByRole("button", { name: /^Open KGN sq2\.1\.tif — queued$/ })).toBeTruthy()

  resolveFirst({ fields: [fullField(["ha1 sq1.1.tif"], 40)] })
  await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("2"), { timeout: 5000 })
  // At rest, the name goes back to the plain "Open <name>[, N cells]" form.
  expect(screen.getByRole("button", { name: /^Open ha1 sq1\.1\.tif, 40 cells$/ })).toBeTruthy()
})

// Done already cleared the selection; Remove did not, so a leftover selection
// from before a Remove kept naming a scope ("N selected") for cards that no
// longer existed. The clear now lives once, in useGallery, keyed on
// `selecting` itself - it fires no matter which button turned select mode off.
it("leaving select mode via Remove, not just Done, clears the selection", async () => {
  await counted(["ha1 sq1.1.tif", "ha1 sq1.2.tif"])
  fireEvent.click(screen.getByRole("button", { name: "Select" }))
  fireEvent.click(screen.getByRole("button", { name: "Select ha1 sq1.1.tif" }))
  expect(screen.getByText(/1 of 2 selected/)).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: /Remove/ }))
  fireEvent.click(screen.getByRole("button", { name: "Remove" }))

  await waitFor(() => expect(screen.getByText(/1 capture in this session/)).toBeTruthy())
  expect(screen.queryByText(/selected/)).toBeNull()
})

// While a selection stands, the reprocess bar names it - so a wall of thirty
// cards with a scoped run in flight says so at rest, not only in a tooltip.
it("shows the standing selection as a chip on the reprocess bar", async () => {
  await counted(["ha1 sq1.1.tif", "ha1 sq1.2.tif"])
  fireEvent.click(screen.getByRole("button", { name: "Select" }))
  expect(screen.queryByText(/selection:/)).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "Select ha1 sq1.1.tif" }))
  fireEvent.click(screen.getByRole("button", { name: "Select ha1 sq1.2.tif" }))
  expect(screen.getByText("selection: 2")).toBeTruthy()
})

// The gallery's reprocess bar and the workbench's own bar are meant to be one
// control; `BAR` (lib/styles.ts) is the single place that class string lives,
// so testing this bar against it also proves the two cannot drift apart.
it("uses the one shared BAR class string on the gallery's reprocess bar", async () => {
  await counted(["ha1 sq1.1.tif"])
  const slider = screen.getByRole("slider", { name: /Quality level/i })
  const bar = [...document.querySelectorAll("div")].find(d => d.className === BAR)
  expect(bar).toBeTruthy()
  expect(bar?.contains(slider)).toBe(true)
})

// The bottom-right corner has to mean one thing in both views: the gallery
// header used to carry its own gear (and no Info at all), a second corner for
// the same control the workbench bar already ends on.
it("puts Info and Settings at the right end of the gallery's own bottom bar, not the header", async () => {
  await counted(["ha1 sq1.1.tif"])
  const header = screen.getByText(/in this session/).closest("header")
  expect(header?.querySelector("[aria-label='Settings']")).toBeNull()

  const info = screen.getByRole("button", { name: "Info" })
  const settings = screen.getByRole("button", { name: "Settings" })
  expect(info.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it("breaks a band up on Ungroup, and the headings go with it", async () => {
  await counted(TWO)
  fireEvent.click(screen.getByRole("button", { name: /Ungroup KGN/ }))

  // One named band and the leftovers are still two bands, so the headings stay -
  // but KGN is not one of them any more.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Ungroup KGN/ })).toBeNull())
  expect(screen.getByRole("button", { name: /Send Ungrouped to the concentration calculator/ }))
    .toBeTruthy()
  // The leftovers are nobody's group: there is nothing there to rename or break.
  expect(screen.queryByRole("button", { name: /Ungroup Ungrouped/ })).toBeNull()
})
