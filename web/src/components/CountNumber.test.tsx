// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { CountNumber } from "@/components/CountNumber"

afterEach(() => cleanup())

// The spring writes textContent to the animated node every frame - up to 60
// announcements for one recount when that node carried aria-live. The
// animated node must be silent to a screen reader, and the settled total
// must live in a separate, once-per-count live region.
it("hides the animated number from a screen reader and announces only the settled total", () => {
  const { container, rerender } = render(<CountNumber total={312} busy={false} />)
  const animated = container.querySelector("[aria-hidden='true']")
  expect(animated).toBeTruthy()
  expect(animated!.getAttribute("aria-live")).toBeNull()

  const live = screen.getByText("312", { selector: "[aria-live='polite']" })
  expect(live.className).toMatch(/sr-only/)
  expect(live).not.toBe(animated)

  rerender(<CountNumber total={340} busy={false} />)
  expect(screen.getByText("340", { selector: "[aria-live='polite']" })).toBeTruthy()
})
