// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { useEffect } from "react"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { StageStrip } from "@/components/StageStrip"
import type { CountedField } from "@/lib/types"

afterEach(() => cleanup())

// jsdom has no layout engine, so it does not implement scrollIntoView; the
// strip calls it to keep the selection visible.
HTMLElement.prototype.scrollIntoView ??= () => {}

const field: CountedField = {
  names: ["a.tif"], count: 3, width: 100, height: 100, centers: [],
  grid_x: [], grid_y: [], diameter: 22, level: 2, grid_cols: 0, grid_rows: 0,
  squares: [], frame: null, base_image: "",
  stages: [
    { name: "grid", n: "1", group: "grid", image: "s1.png" },
    { name: "mask", n: "2", group: "mask", image: "s2.png" },
  ],
  stitch: null,
}

/** Seeds a counted field with stages and turns the debug strip on, the same
 *  door Sidebar.test.tsx uses to put a result in state without a server. */
function Seed() {
  const { openFiles, setShowStages } = useCounter()
  useEffect(() => {
    openFiles([new File(["x"], "a.tif")], field.level, field)
    setShowStages(true)
  }, [openFiles, setShowStages])
  return null
}

function renderStrip() {
  return render(
    <CounterProvider>
      <Seed />
      <StageStrip />
    </CounterProvider>)
}

it("is one tab stop: only the selected thumbnail is tabbable", async () => {
  renderStrip()
  const options = await screen.findAllByRole("option")
  expect(options).toHaveLength(3) // 2 stages + the result
  const tabbable = options.filter(o => o.tabIndex === 0)
  expect(tabbable).toHaveLength(1)
  expect(options.filter(o => o.tabIndex === -1)).toHaveLength(2)
})

it("moves the selection with ArrowRight/ArrowLeft on the container", async () => {
  renderStrip()
  const listbox = await screen.findByRole("listbox", { name: /Pipeline stages/i })
  const options = () => screen.getAllByRole("option")

  const startSel = options().findIndex(o => o.getAttribute("aria-selected") === "true")

  listbox.focus()
  listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  await waitFor(() => {
    const nowSel = options().findIndex(o => o.getAttribute("aria-selected") === "true")
    expect(nowSel).toBe((startSel + 1) % 3)
  })
})
