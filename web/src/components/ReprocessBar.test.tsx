// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { GalleryProvider } from "@/state/useGallery"
import { ImageToolbar } from "@/components/ImageToolbar"
import { BAR } from "@/lib/styles"
import { isCountedField, type CountedField } from "@/lib/types"

// The rule this file exists for: moving the quality slider recounts NOTHING.
// It arms the button, and only the button commits. Everything else about the
// level - the mapping to a detector configuration, the thresholds - is measured
// in Python; this is the one piece of it that lives in the browser.

const PARAMS = {
  version: "test-engine",
  groups: ["Cell check"],
  params: [{ key: "diameter", label: "Cell diameter (px)", min: 6, max: 60,
             default: 22, step: 1, group: "Cell check" }],
}

const field = (level: number): CountedField => ({
  names: ["a.tif"], count: 3, width: 100, height: 100, centers: [],
  grid_x: [], grid_y: [], diameter: 22, level, grid_cols: 0, grid_rows: 0,
  squares: [], frame: null, base_image: "", stages: [], stitch: null,
})

let counts = 0

beforeEach(() => {
  counts = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    // The progress poll (GET /api/progress/<token>) runs beside every count and
    // must not be mistaken for one - this counter is what the "only Reprocess
    // counts" assertions read.
    if (url.includes("progress")) return new Response("{}", { status: 404 })
    if (!url.includes("params")) counts++
    return new Response(
      JSON.stringify(url.includes("params") ? PARAMS : { fields: [field(2)] }),
      { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Opens one capture, so the bar has a counted field to act on. */
function Harness() {
  const { openFiles, field: f } = useCounter()
  return (
    <>
      <button type="button" onClick={() => openFiles([new File(["x"], "a.tif")], 2)}>open</button>
      <span data-testid="level">{isCountedField(f) ? f.level : "none"}</span>
      <ImageToolbar />
    </>
  )
}

async function open() {
  render(
    <TooltipProvider><CounterProvider><GalleryProvider>
      <Harness />
    </GalleryProvider></CounterProvider></TooltipProvider>)
  fireEvent.click(await screen.findByText("open"))
  await waitFor(() => expect(screen.getByTestId("level").textContent).toBe("2"))
}

it("arms the button on a level change without counting", async () => {
  await open()
  const before = counts
  // At rest there is no button at all. A control whose whole job is to say it
  // would do nothing is one more thing to read on every screen that is already
  // finished, and the lit button is what says the level has moved.
  expect(screen.queryByRole("button", { name: /Reprocess/i })).toBeNull()

  // Right arrow on the slider thumb is a level change, the same one a drag makes.
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Reprocess this image/i })).toBeTruthy())
  expect(screen.getByText("Finest")).toBeTruthy()
  // The whole point: the armed button has not counted anything yet. The 250 ms
  // debounce would have fired inside the waitFor above had `level` been a
  // counting input.
  expect(counts).toBe(before)
})

it("counts once the run is confirmed", async () => {
  await open()
  const before = counts
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowLeft" })
  fireEvent.click(await screen.findByRole("button", { name: /Reprocess this image/i }))

  // Confirming is a second, deliberate press: the dialog is the last point at
  // which a lower level can be refused.
  fireEvent.click(await screen.findByRole("button", { name: /^Reprocess$/ }))
  await waitFor(() => expect(counts).toBe(before + 1))
})

it("warns before a run that lowers a level, and not otherwise", async () => {
  await open()
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowLeft" })
  fireEvent.click(await screen.findByRole("button", { name: /Reprocess this image/i }))
  expect(await screen.findByText(/recounted lower/i)).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: /Cancel/i }))
  await waitFor(() => expect(screen.queryByText(/recounted lower/i)).toBeNull())

  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  fireEvent.click(await screen.findByRole("button", { name: /Reprocess this image/i }))
  // The dialog is open (the slider label matches too, hence the role query),
  // and this time it carries no downgrade line.
  expect(await screen.findByRole("heading", { name: /Reprocess this image/i })).toBeTruthy()
  expect(screen.queryByText(/recounted lower/i)).toBeNull()
})

it("says the count is replaced even when nothing is lowered", async () => {
  await open()
  // Upward: the case that used to say nothing at all, so a user could read a
  // recount as a second result added beside the first.
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  fireEvent.click(await screen.findByRole("button", { name: /Reprocess this image/i }))

  expect(await screen.findByText(/replaces the current count/i)).toBeTruthy()
  expect(screen.queryByText(/recounted lower/i)).toBeNull()
})

// The workbench bar and the gallery bar are one control the user learns once;
// `BAR` (lib/styles.ts) is now the only place that string is written, so
// there is nothing left for the two to drift apart on.
it("uses the one shared BAR class string", async () => {
  await open()
  expect(screen.getByLabelText("Image controls").className).toBe(BAR)
})

it("retries a failed count at the same level", async () => {
  await open()
  const before = counts

  // Arm the top rung, then make the server fail that count. The field on
  // screen is still the default-rung one, so the button stays armed - and pressing it again
  // has to send a request. It did not before: countLevel already equalled the
  // armed level, so committing it changed no state and fetched nothing.
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes("progress")) return new Response("{}", { status: 404 })
    if (!url.includes("params")) { counts++; return new Response("{}", { status: 500 }) }
    return new Response(JSON.stringify(PARAMS),
                        { status: 200, headers: { "Content-Type": "application/json" } })
  })

  for (const n of [1, 2]) {
    fireEvent.click(await screen.findByRole("button", { name: /Reprocess this image/i }))
    fireEvent.click(await screen.findByRole("button", { name: /^Reprocess$/ }))
    // An exact count, not "more than before": the 250 ms debounce means a
    // loose assertion would pass on the PREVIOUS press and never wait for this
    // one - which is the bug this test exists to catch.
    await waitFor(() => expect(counts).toBe(before + n))
  }
})
