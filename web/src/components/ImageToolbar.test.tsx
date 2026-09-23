// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { GalleryProvider } from "@/state/useGallery"
import { ImageToolbar } from "@/components/ImageToolbar"
import { ICON_BUTTON_ARMED } from "@/lib/styles"
import { isCountedField, type CountedField } from "@/lib/types"

// One render test per state (rest / armed / busy). ReprocessBar.test.tsx
// already exercises the interaction sequence in depth; this file's job is
// narrower - pin what each of the three states actually renders.

const PARAMS = {
  version: "test-engine", groups: [],
  params: [] as { key: string; label: string; min: number; max: number;
                  default: number; step: number; group: string }[],
}

const field = (level: number): CountedField => ({
  names: ["a.tif"], count: 3, width: 100, height: 100, centers: [],
  grid_x: [], grid_y: [], diameter: 22, level, grid_cols: 0, grid_rows: 0,
  squares: [], frame: null, base_image: "", stages: [], stitch: null,
})

let resolveCount: (() => void) | null = null

beforeEach(() => {
  resolveCount = null
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("progress")) return new Response("{}", { status: 404 })
    if (url.includes("params")) {
      return new Response(JSON.stringify(PARAMS),
        { status: 200, headers: { "Content-Type": "application/json" } })
    }
    // The count request only resolves once the test releases it, so a
    // mid-flight ("busy") render can be observed rather than raced past.
    await new Promise<void>(resolve => { resolveCount = resolve })
    return new Response(JSON.stringify({ fields: [field(2)] }),
      { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
  const { openFiles, field: f, setShowStages } = useCounter()
  return (
    <>
      <button type="button" onClick={() => setShowStages(true)}>steps</button>
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
  // The initial count from openFiles is held open by the fetch mock; wait for
  // it to actually be in flight before releasing it, or this races the 250ms
  // debounce and releases nothing.
  await waitFor(() => expect(resolveCount).toBeTruthy())
  resolveCount?.()
  await waitFor(() => expect(screen.getByTestId("level").textContent).toBe("2"))
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull())
}

it("at rest: a quiet Recount that counts again at the same level", async () => {
  await open()
  expect(screen.queryByRole("button", { name: /Reprocess this image/i })).toBeNull()
  const button = screen.getByRole("button", { name: /Recount this image at Normal/i })
  expect(button.className).not.toContain(ICON_BUTTON_ARMED.split(" ")[0])

  const calls = () => vi.mocked(fetch).mock.calls.filter(c => String(c[0]).includes("/api/count")).length
  const before = calls()
  fireEvent.click(button)
  fireEvent.click(await screen.findByRole("button", { name: /^Reprocess$/ }))
  await waitFor(() => expect(calls()).toBe(before + 1))
  resolveCount?.()
})

it("armed: the Reprocess button carries ICON_BUTTON_ARMED", async () => {
  await open()
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })

  const button = await screen.findByRole("button", { name: /Reprocess this image/i })
  for (const cls of ICON_BUTTON_ARMED.split(" ")) {
    expect(button.className).toContain(cls)
  }
})

it("busy: the Reprocess control is gone, and a run is announced instead", async () => {
  await open()
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  fireEvent.click(await screen.findByRole("button", { name: /Reprocess this image/i }))
  fireEvent.click(await screen.findByRole("button", { name: /^Reprocess$/ }))

  // Mid-flight: the armed button is replaced by the run ring, which announces
  // progress via role="status"/"progressbar" rather than sitting silent.
  await waitFor(() => expect(screen.queryByRole("button", { name: /Reprocess this image/i })).toBeNull())
  expect(await screen.findByLabelText("Counting…")).toBeTruthy()

  resolveCount?.()
  await waitFor(() => expect(screen.queryByLabelText("Counting…")).toBeNull())
})

// The switch never counts (user, 2026-09-21). It arms the button instead, read
// off the field itself: this image has no steps, so one press fetches them.
it("steps on over a field without them: armed, and the switch sent no count", async () => {
  await open()
  const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls
  const before = calls.filter(c => String(c[0]).includes("/api/count")).length
  fireEvent.click(screen.getByText("steps"))
  const button = await screen.findByRole("button", { name: /pipeline steps/i })
  expect(button.className).toContain(ICON_BUTTON_ARMED.split(" ")[0])
  await new Promise(r => setTimeout(r, 400))
  expect(calls.filter(c => String(c[0]).includes("/api/count")).length).toBe(before)
})
