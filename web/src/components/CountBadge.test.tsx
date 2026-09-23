// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { CountBadge } from "@/components/CountBadge"
import type { CountedField, FailedField } from "@/lib/types"
import { useEffect } from "react"

const PARAMS = { version: "test-engine", groups: [], params: [] }

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
 *  a test can put a result on screen without a server. */
function Seed({ field }: { field: CountedField }) {
  const { openFiles } = useCounter()
  useEffect(() => {
    openFiles([new File(["x"], "a.tif")], field.level, field)
  }, [openFiles, field])
  return null
}

const show = (field: CountedField) => render(
  <CounterProvider><Seed field={field} /><CountBadge /></CounterProvider>)

/** A per-field refusal (app.py: one bad field in an otherwise-good batch)
 *  never reaches CountBadge through the seed door above - GalleryItem.field
 *  is always a CountedField (types.ts), so the one place a FailedField lands
 *  in useCounter's `fields` is a real (here, mocked) /api/count response,
 *  same as Viewer.test.tsx exercises it. */
function HarnessFailed() {
  const { openFiles } = useCounter()
  useEffect(() => {
    openFiles([new File(["x"], "tiny.png")], 3)
  }, [openFiles])
  return null
}

const showFailed = (field: FailedField) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes("params") ? PARAMS : { fields: [field] }),
                 { status: 200, headers: { "Content-Type": "application/json" } })))
  return render(<CounterProvider><HarnessFailed /><CountBadge /></CounterProvider>)
}

it("reads the count as a plain sentence", async () => {
  show(fieldWith({}))
  expect(await screen.findByText(/312 found/)).toBeTruthy()
})

it("does not show a confident zero when the grid was not detected", async () => {
  show(fieldWith({ count: 0, grid_x: [], grid_y: [], grid_cols: 0, grid_rows: 0 }))
  await waitFor(() => expect(screen.getByTestId("count-badge")).toBeTruthy())
  // The number itself must be gone: a bold green 0 reads as "there are no
  // cells", not as "I could not measure this".
  expect(screen.queryByText("0")).toBeNull()
  expect(screen.getByText(/Grid not detected/i)).toBeTruthy()
  expect(screen.getByText(/crop tighter to the ruled area/i)).toBeTruthy()
})

it("shows the server's own reason, not a count, for a failed field", async () => {
  showFailed({ names: ["tiny.png"], error: "No hemocytometer grid was found in this image." })
  await waitFor(() => expect(screen.getByTestId("count-badge")).toBeTruthy())
  expect(screen.getByText("Not counted")).toBeTruthy()
  expect(screen.getByText(/no hemocytometer grid was found/i)).toBeTruthy()
  // Never the "Grid not detected / crop tighter" copy: the real reason may
  // have nothing to do with the grid, and never a stray count either.
  expect(screen.queryByText(/crop tighter to the ruled area/i)).toBeNull()
  expect(screen.queryByText(/found$/)).toBeNull()
})
