// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { useEffect } from "react"
import { isCountedField, type CountedField, type Field } from "@/lib/types"
import { Sidebar } from "@/components/Sidebar"

// The Cell check and Clusters sections were removed on 2026-09-04: the detector
// is chosen by the one quality level, and every other parameter keeps the
// default it was measured at. What the panel keeps is the view toggles - those
// are choices about what to see and count, not tuning. This test is the guard
// against a parameter creeping back in just because /api/params still lists it.
const PARAMS = {
  version: "test-engine",
  groups: ["Cell check"],
  params: [
    { key: "diameter", label: "Cell diameter (px)", min: 0, max: 100,
      default: 22, step: 1, group: "Cell check" },
    { key: "engine", label: "Detector engine (0 classical, 1 ML)", min: 0, max: 1,
      default: 1, step: 1, group: "Cell check" },
  ],
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes("params") ? PARAMS : { fields: [] }),
                 { status: 200, headers: { "Content-Type": "application/json" } })))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderSidebar() {
  return render(
    <TooltipProvider><CounterProvider>
      <Sidebar onCollapse={() => {}} />
    </CounterProvider></TooltipProvider>)
}

// Sidebar used to nest its own TooltipProvider inside the app-wide one
// (App.tsx:235, delayDuration={300}); the inner one fell back to radix's
// default 700 ms, so a tooltip's delay depended on which provider radix
// picked up first won. There must be exactly one provider in the tree, at
// the app-wide 300 ms.
it("renders inside exactly one TooltipProvider, at the app-wide 300ms delay", async () => {
  const calls: number[] = []
  const { TooltipProvider: RealProvider } = await vi.importActual<
    typeof import("@/components/ui/tooltip")
  >("@/components/ui/tooltip")
  function SpyProvider(props: React.ComponentProps<typeof RealProvider>) {
    calls.push(props.delayDuration ?? 0)
    return <RealProvider {...props} />
  }
  render(
    <SpyProvider delayDuration={300}><CounterProvider>
      <Sidebar onCollapse={() => {}} />
    </CounterProvider></SpyProvider>)
  await waitFor(() => expect(screen.getByRole("switch", { name: /Show grid lines/i })).toBeTruthy())
  expect(calls).toEqual([300])
})

it("keeps the view toggles", async () => {
  renderSidebar()
  for (const name of [/Count inside triple line only/i, /Show grid lines/i]) {
    expect(await screen.findByRole("switch", { name })).toBeTruthy()
  }
  // The overlay-opacity slider was removed 2026-09-21 with the contour overlay
  // it faded; the dots the user can actually click are what marks the cells.
  expect(screen.queryByLabelText(/Overlay opacity/i)).toBeNull()
})

it("offers no detector switch and no tuning sliders", async () => {
  renderSidebar()
  // Wait for /api/params to land, so this is not asserting on an empty panel.
  await waitFor(() => expect(screen.getByRole("switch", { name: /Show grid lines/i })).toBeTruthy())

  expect(screen.queryByRole("switch", { name: /ML detector/i })).toBeNull()
  expect(screen.queryByText("Cell diameter (px)")).toBeNull()
  expect(screen.queryByText(/Reprocess clusters/i)).toBeNull()
  expect(screen.queryByRole("button", { name: /reset all/i })).toBeNull()
})

/* ------------------------------------------------ grid failure and wording */

function fieldWith(over: Partial<CountedField>): CountedField {
  return {
    names: ["a.tif"], count: 312, width: 100, height: 100, centers: [],
    grid_x: [0, 50, 100], grid_y: [0, 50, 100], diameter: 22, level: 2,
    grid_cols: 2, grid_rows: 2, squares: [], frame: null,
    base_image: "", stages: [], stitch: null,
    ...over,
  }
}

/** The gallery's own door in: openFiles takes the field it already counted, so
 *  a test can put a result in the panel without a server. Accepts either half
 *  of the union: a FailedField (app.py: one bad group in an otherwise-good
 *  batch) has no `level` of its own, so it seeds at level 3 regardless - the
 *  error-state tests below only care what the panel renders, not the level. */
function Seed({ field }: { field: Field }) {
  const { openFiles } = useCounter()
  useEffect(() => {
    openFiles([new File(["x"], "a.tif")], isCountedField(field) ? field.level : 3, field)
  }, [openFiles, field])
  return null
}

const withField = (field: Field) => render(
  <TooltipProvider><CounterProvider>
    <Seed field={field} />
    <Sidebar onCollapse={() => {}} />
  </CounterProvider></TooltipProvider>)

it("reads the count as a plain sentence", async () => {
  withField(fieldWith({}))
  expect(await screen.findByText(/312 found/)).toBeTruthy()
})

it("says the grid was not detected instead of showing a green 0", async () => {
  withField(fieldWith({ count: 0, grid_x: [], grid_y: [], grid_cols: 0, grid_rows: 0 }))
  await waitFor(() => expect(screen.getAllByText(/Grid not detected/i).length).toBeGreaterThan(0))
  expect(screen.queryByText("0")).toBeNull()
  expect(screen.getByText(/crop tighter to the ruled area/i)).toBeTruthy()
})

// A per-field refusal (app.py: one bad group in an otherwise-good batch)
// carries only names/error - none of count/level/grid_x exist on it. Mounting
// the panel with one selected used to crash the whole app (gridLinesOf did
// `[...lines]` over the undefined grid_x it does not have) - a Viewer-only
// test could not catch this, since Sidebar reads the field independently.
it("shows the server's own reason instead of crashing when an error field is selected", async () => {
  expect(() => withField({ names: ["tiny.png"], error: "No ruled grid was found in this image." }))
    .not.toThrow()
  expect(await screen.findByText("No ruled grid was found in this image.")).toBeTruthy()
  expect(screen.queryByText(/\d+ found/)).toBeNull()
  expect(screen.queryByText("undefined")).toBeNull()
})

it("keeps the debug stage toggle out of the panel", async () => {
  renderSidebar()
  await waitFor(() => expect(screen.getByRole("switch", { name: /Show grid lines/i })).toBeTruthy())
  expect(screen.queryByRole("switch", { name: /pipeline steps/i })).toBeNull()
})

// The boundary switch changes the count itself (it is in the count effect's
// dep list and the count key), unlike everything else that used to sit
// alongside it under "View", which only changes what is drawn. Filing it
// there told the user the opposite of what it does.
it("files the boundary switch under Counting, not under View", async () => {
  renderSidebar()
  const sw = await screen.findByRole("switch", { name: /Count inside triple line only/i })
  const section = sw.closest("section")
  expect(section).toBeTruthy()
  expect(section!.textContent).toMatch(/Counting/)
  expect(section!.textContent).not.toMatch(/View/)
})
