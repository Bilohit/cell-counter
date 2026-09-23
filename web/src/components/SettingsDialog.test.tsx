// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CounterProvider } from "@/state/useCounter"
import { GalleryProvider } from "@/state/useGallery"
import { SettingsDialog } from "@/components/SettingsDialog"

const PARAMS = { version: "test-engine", groups: [], params: [] }

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(PARAMS),
                 { status: 200, headers: { "Content-Type": "application/json" } })))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The stage images are a developer's view of the pipeline; they used to sit in
// the sidebar at the same weight as the count. This is where they live now.
it("keeps the pipeline-step toggle under Advanced", async () => {
  render(
    <CounterProvider>
      <GalleryProvider><SettingsDialog open onOpenChange={() => {}} theme="" setTheme={() => {}} /></GalleryProvider>
    </CounterProvider>)
  expect(await screen.findByText("Advanced")).toBeTruthy()
  expect(screen.getByRole("switch", { name: /Show pipeline steps/i })).toBeTruthy()
})

// The dialog carried a four-row shortcut list (Esc, click a square, Left/Right,
// wheel/pinch). Removed 2026-09-21 on the user's instruction: one of its four
// rows was simply wrong - "Click a square - exclude it from the total" named a
// gesture the canvas does not have (clicking the photo edits dots; exclusion is
// a click in the sidebar's own grid panel) - and a settings dialog is where a
// bench user looks least. The key handlers themselves are untouched and keep
// their own tests (EditNav, Viewer's wheel listener, CropTool's Esc).
it("documents no keyboard shortcuts: the list was removed", async () => {
  render(
    <CounterProvider>
      <GalleryProvider><SettingsDialog open onOpenChange={() => {}} theme="" setTheme={() => {}} /></GalleryProvider>
    </CounterProvider>)
  expect(await screen.findByText("Settings")).toBeTruthy()
  expect(screen.queryByText("Esc")).toBeNull()
  expect(screen.queryByText(/Click a square/i)).toBeNull()
  expect(screen.queryByText(/Wheel \/ pinch/i)).toBeNull()
  // And the folder picker went with it.
  expect(screen.queryByText(/Save exports to/i)).toBeNull()
})

// Off at every load, whatever an earlier session left in storage (2026-09-21).
it("starts with pipeline steps off even if a past session stored them on", async () => {
  localStorage.setItem("cellcounter.showStages", "1")
  render(
    <CounterProvider>
      <GalleryProvider><SettingsDialog open onOpenChange={() => {}} theme="" setTheme={() => {}} /></GalleryProvider>
    </CounterProvider>)
  const sw = await screen.findByRole("switch", { name: /Show pipeline steps/i })
  expect(sw.getAttribute("aria-checked")).toBe("false")
})
