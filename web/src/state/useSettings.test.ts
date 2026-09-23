// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { it, expect } from "vitest"
import { useSettings } from "./useSettings"

it("two mounted consumers see the same value", () => {
  const a = renderHook(() => useSettings())
  const b = renderHook(() => useSettings())
  act(() => a.result.current.setBurnCount(false))
  expect(a.result.current.burnCount).toBe(false)
  expect(b.result.current.burnCount).toBe(false)   // the M-9 desync
  expect(localStorage.getItem("cc-burn-count")).toBe("0")
  act(() => a.result.current.setBurnCount(true))
})

it("interface scale is a percentage of the app's working size, 100 by default", () => {
  const { result } = renderHook(() => useSettings())
  expect(result.current.uiScalePct).toBe(100)
  // 100 % is 1.6x: the size the workbench is meant to be used at, not the
  // browser's own 1x.
  expect(document.body.style.transform).toBe("scale(1.6)")
  // Body is sized to the inverse so the scaled box covers exactly the viewport.
  expect(document.body.style.width).toBe("62.5%")

  act(() => result.current.setUiScalePct(200))
  expect(document.body.style.transform).toBe("scale(3.2)")
  expect(localStorage.getItem("cc-ui-scale-pct")).toBe("200")

  // Never CSS `zoom`: Safari < 26.4 reports getBoundingClientRect() unscaled
  // under zoom while clientX stays in page px, which breaks every pointer-to-
  // image ratio in the app (WebKit 77998).
  expect(document.documentElement.style.getPropertyValue("zoom")).toBe("")

  act(() => result.current.setUiScalePct(10))
  expect(result.current.uiScalePct).toBe(50)          // clamped, not applied raw

  act(() => result.current.setUiScalePct(100))
})
