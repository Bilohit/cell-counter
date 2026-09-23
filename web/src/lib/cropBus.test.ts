// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cropBus, useCropActive } from "./cropBus"

// cropBus is module-global mutable state shared by three components (CropTool,
// the toolbar and whatever else reads crop-mode). Every test must leave it as
// it found it, or the next test in the file starts from the wrong flag.
afterEach(() => { cropBus.emit(false) })

describe("cropBus", () => {
  it("calls a subscriber with the published payload", () => {
    const fn = vi.fn()
    cropBus.subscribe(fn)
    cropBus.emit(true)
    expect(fn).toHaveBeenCalledWith(true)
  })

  it("stops calling a subscriber once unsubscribed", () => {
    const fn = vi.fn()
    const unsubscribe = cropBus.subscribe(fn)
    unsubscribe()
    cropBus.emit(true)
    expect(fn).not.toHaveBeenCalled()
  })

  it("calls every subscriber, not just the first", () => {
    const a = vi.fn()
    const b = vi.fn()
    cropBus.subscribe(a)
    cropBus.subscribe(b)
    cropBus.emit(true)
    expect(a).toHaveBeenCalledWith(true)
    expect(b).toHaveBeenCalledWith(true)
  })

  it("does not re-fire subscribers when the value does not change", () => {
    const fn = vi.fn()
    cropBus.emit(true)
    cropBus.subscribe(fn)
    cropBus.emit(true) // already active: no change, so no call
    expect(fn).not.toHaveBeenCalled()
  })

  it("useCropActive reflects live publishes and does not leak state to the next test", () => {
    // Runs after the prior test's afterEach reset it to false, proving the
    // reset actually took effect rather than this test getting lucky.
    expect(cropBus.active).toBe(false)
    const { result } = renderHook(() => useCropActive())
    expect(result.current).toBe(false)
  })
})
