// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { GalleryProvider } from "@/state/useGallery"
import { useSettings } from "@/state/useSettings"
import { Viewer } from "@/components/Viewer"
import type { Field } from "@/lib/types"

// A per-field refusal (app.py: a group with no grid, in an otherwise-good
// batch) comes back as fields[i].error with none of the image fields set.
// The viewer must show that sentence for the bad field and still let the
// good field be viewed - never index into base_image/width/height on it.

const PARAMS = { version: "test-engine", groups: [], params: [] }

const good: Field = {
  names: ["a.tif"], count: 3, width: 100, height: 100, centers: [],
  grid_x: [], grid_y: [], diameter: 22, level: 2, grid_cols: 0, grid_rows: 0,
  squares: [], frame: null, base_image: "data:image/png;base64,x", stages: [], stitch: null,
}

const bad = {
  names: ["tiny.png"],
  error: "No hemocytometer grid was found in this image, so there is nothing to count in.",
} as unknown as Field

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    return new Response(
      JSON.stringify(url.includes("params") ? PARAMS : { fields: [good, bad] }),
      { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

function Harness() {
  const { openFiles } = useCounter()
  const { setSidebarOpen } = useSettings()
  return (
    <>
      <button type="button" onClick={() => openFiles([
        new File(["x"], "a.tif"), new File(["y"], "tiny.png"),
      ], 3)}>open</button>
      <button type="button" onClick={() => setSidebarOpen(false)}>fold sidebar</button>
      <button type="button" onClick={() => setSidebarOpen(true)}>open sidebar</button>
      <Viewer onIntake={() => {}} />
    </>
  )
}

async function open() {
  render(
    <TooltipProvider><CounterProvider><GalleryProvider>
      <Harness />
    </GalleryProvider></CounterProvider></TooltipProvider>)
  fireEvent.click(await screen.findByText("open"))
  await screen.findByRole("button", { name: /^a\.tif$/i })
}

it("shows the field's own error instead of an image, without touching the good field", async () => {
  await open()
  // Field 0 (good) shows first, no error text.
  expect(screen.queryByText(/no hemocytometer grid/i)).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: /tiny\.png/i }))
  expect(await screen.findByText(/no hemocytometer grid/i)).toBeTruthy()

  // Switching back to the good field still renders its photo, proving the
  // error field's absent width/height/base_image never got read as the good
  // field's.
  fireEvent.click(screen.getByRole("button", { name: /^a\.tif$/i }))
  await waitFor(() => expect(screen.queryByText(/no hemocytometer grid/i)).toBeNull())
  expect(screen.getByAltText("Sample")).toBeTruthy()
})

// base_image is an /api/image/<id> path into a byte-bounded
// store now, not inlined data: URIs, so the id's bytes can be evicted under
// memory pressure and the <img> can 404 with no data: URI equivalent to fall
// back to (app.py's _IMAGE_STORE). The broken-image icon that leaves behind
// tells a lab researcher nothing, so it must be replaced with a sentence
// that says what happened and what to do.
it("tells the user to re-run the count when the counted image 404s", async () => {
  await open()
  const img = screen.getByAltText("Sample")
  fireEvent.error(img)
  expect(await screen.findByText(/no longer on the server/i)).toBeTruthy()
})

// The sidebar carries this same sentence, but it is hidden while the sidebar
// is folded - precisely when dot editing happens and the hint is needed. So a
// folded sidebar re-shows it once per session (sessionStorage), even to a
// user who already dismissed it forever in localStorage.
it("re-shows the dot hint once per session when the sidebar is folded", async () => {
  localStorage.setItem("cellcounter.dotHint", "1")
  await open()
  fireEvent.click(screen.getByRole("button", { name: "fold sidebar" }))
  expect(await screen.findByText(/add or remove a dot/i)).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: "Got it" }))
  await waitFor(() => expect(screen.queryByText(/add or remove a dot/i)).toBeNull())
})

it("keeps the dot hint hidden when the sidebar is open and already learned", async () => {
  localStorage.setItem("cellcounter.dotHint", "1")
  await open()
  fireEvent.click(screen.getByRole("button", { name: "open sidebar" }))
  expect(screen.queryByText(/add or remove a dot/i)).toBeNull()
})
