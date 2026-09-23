// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { QualitySlider } from "./QualitySlider"
import { LEVELS } from "@/lib/levels"

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => cleanup())

// The component renders only the CURRENT rung's name (there is one slot, not
// three) - so "every rung name renders" is tested as each level in turn
// producing its own published name, rather than expecting all three visible
// at once.
it("renders the current rung's published name for each of the three levels", () => {
  for (const l of LEVELS) {
    render(<QualitySlider value={l.n} onChange={() => {}} />)
    expect(screen.getByText(l.name)).toBeTruthy()
    cleanup()
  }
})

it("moving the slider calls onChange with the new level - the store, not this component, decides whether that touches countLevel", () => {
  const onChange = vi.fn()
  render(<QualitySlider value={2} onChange={onChange} />)
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  expect(onChange).toHaveBeenCalledWith(3)
})

it("disabled prevents further movement", () => {
  const onChange = vi.fn()
  render(<QualitySlider value={2} onChange={onChange} disabled />)
  fireEvent.keyDown(screen.getByRole("slider", { name: /Quality level/i }), { key: "ArrowRight" })
  expect(onChange).not.toHaveBeenCalled()
})
