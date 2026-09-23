// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ReprocessDialog, type ReprocessPlan } from "@/components/ReprocessDialog"

afterEach(() => cleanup())

// A hand-rolled role="radio" button pair used to make both choices tab
// stops with ArrowDown/ArrowRight moving nothing - neither behaviour a real
// radio group gives for free. Real <input type="radio"> inputs sharing one
// `name` fix both: the browser makes only the checked input a tab stop and
// wires arrow-key navigation itself.
const plan: ReprocessPlan = {
  n: 2, level: 3, secs: 4, skipped: 0, downgrades: 0, editedImages: 2, editCount: 5,
}

it("uses real radio inputs: one tab stop, checked input is the tabbable one", () => {
  render(<ReprocessDialog plan={plan} onOpenChange={() => {}} onConfirm={() => {}} />)
  const radios = screen.getAllByRole("radio") as HTMLInputElement[]
  expect(radios).toHaveLength(2)
  expect(radios[0].checked).toBe(true)
  expect(radios[0].tabIndex).toBe(0)
  expect(radios[1].checked).toBe(false)
  expect(radios[1].tabIndex).toBe(-1)
  // Same name group, so the browser owns arrow-key selection - not a
  // hand-rolled keydown handler this component has to maintain.
  expect(radios[0].name).toBe(radios[1].name)
})

it("moves the selection and the tab stop together when the other choice is picked", () => {
  render(<ReprocessDialog plan={plan} onOpenChange={() => {}} onConfirm={() => {}} />)
  const radios = screen.getAllByRole("radio") as HTMLInputElement[]
  fireEvent.click(radios[1])
  expect(radios[1].checked).toBe(true)
  expect(radios[1].tabIndex).toBe(0)
  expect(radios[0].checked).toBe(false)
  expect(radios[0].tabIndex).toBe(-1)
})
