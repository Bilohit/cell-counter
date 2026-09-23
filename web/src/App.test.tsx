// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CounterProvider } from "@/state/useCounter"
import { GalleryProvider, useGallery } from "@/state/useGallery"
import { OverlapBoard } from "@/components/OverlapBoard"
import App, { Shell } from "./App"

// A build that compiles can still crash on mount. This is the cheapest thing
// that fails when it does: real render, stubbed server.
const PARAMS = {
  version: "test-engine",
  groups: ["Cell check"],
  params: [{ key: "diameter", label: "Cell diameter (px)", min: 6, max: 60,
             default: 22, step: 1, group: "Cell check" }],
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes("params") ? PARAMS : { fields: [] }),
                 { status: 200, headers: { "Content-Type": "application/json" } })))
  // jsdom has neither, and Radix/ScrollArea reach for both.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
// No vitest globals, so Testing Library does not unmount between tests on its
// own. Without this every earlier <App /> stayed mounted with its document-level
// drop listener live, and the stash test's drop was also staged by the idle App
// the first test left behind - whose confirm screen answered the final query.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it("mounts on the intake view and shows the drop target", async () => {
  render(<App />)
  expect(screen.getByTestId("view-intake")).toBeTruthy()
  expect(screen.getByRole("button", { name: /Open image/i })).toBeTruthy()
  expect(screen.getByText(/Drop hemocytometer captures/i)).toBeTruthy()
  // A returning user starts on this screen, so the way back into a saved
  // session has to be reachable from it.
  expect(screen.getByRole("button", { name: /Load session/i })).toBeTruthy()
})

// The review screen is only reachable with candidates in the store; the cheap
// check is that it mounts and offers a way out when the queue is already empty.
it("overlap review falls back to a way out with no candidates left", () => {
  render(
    <TooltipProvider><CounterProvider><GalleryProvider>
      <OverlapBoard />
    </GalleryProvider></CounterProvider></TooltipProvider>)
  expect(screen.getByTestId("view-review")).toBeTruthy()
  expect(screen.getByRole("button", { name: /Back to the gallery/i })).toBeTruthy()
})

it("renders the edit workbench with no tuning sliders left in it", async () => {
  render(
    <TooltipProvider><CounterProvider><GalleryProvider>
      <Shell />
    </GalleryProvider></CounterProvider></TooltipProvider>)
  expect(screen.getByText("cells counted")).toBeTruthy()
  // The 26 processing sliders were removed on 2026-09-04 in favour of the one
  // quality level. A parameter the server still publishes must not find its way
  // back onto the panel just because it is in /api/params.
  await waitFor(() => expect(screen.getByRole("switch", { name: /Show grid lines/i })).toBeTruthy())
  expect(screen.queryByText("Cell diameter (px)")).toBeNull()

  // The engine version moved out of the footer and into Image properties when
  // the footer took the settings and info controls. A stale server still has to
  // be visible somewhere, so the path to it is what is asserted now.
  fireEvent.click(screen.getByRole("button", { name: /Image properties/i }))
  await waitFor(() => expect(screen.getByText(/test-engine/)).toBeTruthy())
})

// The workbench's own DropZone (shown when no field is open) used to hand
// dropped files straight to openFiles, bypassing every intake guard the
// document-level drop handler enforces. A drop there must land in the
// gallery's intake path exactly like the whole-window drop does.
function ItemCount() {
  const { items } = useGallery()
  return <div data-testid="item-count">{items.length}</div>
}

// A drop mid-run (the scan/processing/review screens block intake) used to be
// refused outright and lost. It is now stashed and offered back, as an action,
// the moment the run lands - never auto-added, since it was a decision about
// a different batch than the one that just finished.
it("stashes captures dropped during a run and offers them once it lands", async () => {
  // A single new capture skips the confirm screen (useGallery.intake's "lone"
  // path) and goes straight to processing on one /api/count call - held open
  // here so the drop below lands while the run still owns the screen.
  let resolveCount!: (v: Response) => void
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("progress")) return new Response("{}", { status: 404 })
    // The confirm screen asks for TIF previews. app.py's /api/thumbs answers a
    // 200 with one {name, image} per upload, in upload order - never anything
    // else; falling through to the `{fields: []}` default handed BatchConfirm a
    // body with no `thumbs` and threw inside its setState updater.
    if (url.includes("/api/thumbs")) {
      const sent = (init!.body as FormData).getAll("images") as File[]
      return new Response(JSON.stringify({ thumbs: sent.map(f => ({ name: f.name, image: "" })) }),
        { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (url.includes("params")) {
      return new Response(JSON.stringify(PARAMS),
        { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (url.includes("/api/count")) {
      return new Promise<Response>(resolve => { resolveCount = resolve })
    }
    if (url.includes("/api/pairs")) {
      return new Response(JSON.stringify({ pairs: [], count: 0, skipped: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify({ fields: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } })
  }))

  render(<App />)
  const input = screen.getByRole("button", { name: /Open image/i })
    .querySelector("input[type=file]") as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(["a"], "a.tif", { type: "image/tiff" })] } })
  // The run now owns the screen; /api/count is left unresolved on purpose.
  await waitFor(() => expect(resolveCount).toBeTruthy())

  const dropped = Array.from({ length: 4 }, (_, i) =>
    new File(["x"], `dropped${i}.tif`, { type: "image/tiff" }))
  fireEvent.drop(document, { dataTransfer: { files: dropped } })
  expect(await screen.findByText(/busy with the current batch\. 4 captures/i)).toBeTruthy()

  resolveCount(new Response(JSON.stringify({ fields: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } }))

  const action = await screen.findByRole(
    "button", { name: "Add the 4 captures you dropped" }, { timeout: 5000 })
  fireEvent.click(action)

  // The stash goes back through intakeDrop -> intake -> stage, exactly as if
  // it had just been dropped: a 4-file batch reaches the confirm screen,
  // proving all four - and only those four - were offered.
  expect(await screen.findByRole("button", { name: /Count 4 captures/ })).toBeTruthy()
})

it("routes a drop on the workbench DropZone through gallery intake", async () => {
  render(
    <TooltipProvider><CounterProvider><GalleryProvider>
      <ItemCount />
      <Shell />
    </GalleryProvider></CounterProvider></TooltipProvider>)

  expect(screen.getByTestId("item-count").textContent).toBe("0")

  const file = new File(["x"], "capture.png", { type: "image/png" })
  const input = screen.getByRole("button", { name: /Open image/i })
    .querySelector("input[type=file]") as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })

  await waitFor(() => expect(screen.getByTestId("item-count").textContent).toBe("1"))
})
