// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ fetchCountProgress: vi.fn() }))
import { fetchCountProgress } from "@/lib/api"
import { newToken, trackCount, useCountProgress } from "./progressBus"

describe("newToken", () => {
  it("mints a different ticket every time", () => {
    const a = newToken(), b = newToken()
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })
})

describe("trackCount", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(fetchCountProgress).mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it("polls the token it is given and stops when told to", async () => {
    vi.mocked(fetchCountProgress).mockResolvedValue({
      state: "running", frac: 0.4, label: "Running the detector",
    })

    const stop = trackCount("tok-1")
    await vi.advanceTimersByTimeAsync(600)
    const calls = vi.mocked(fetchCountProgress).mock.calls.length
    expect(calls).toBeGreaterThan(1)
    expect(vi.mocked(fetchCountProgress).mock.calls[0][0]).toBe("tok-1")

    stop()
    await vi.advanceTimersByTimeAsync(1000)
    // Nothing after the stop: a poll outliving its count would report the wrong
    // run's progress onto the next one.
    expect(vi.mocked(fetchCountProgress).mock.calls.length).toBe(calls)
  })

  it("survives a poll that fails or 404s", async () => {
    // null is what api.ts returns for an unknown or evicted token, and for a
    // network failure. It must not throw and must not become 0 %.
    vi.mocked(fetchCountProgress).mockResolvedValue(null)
    const stop = trackCount("tok-2")
    await vi.advanceTimersByTimeAsync(600)
    expect(vi.mocked(fetchCountProgress)).toHaveBeenCalled()
    stop()
  })

  it("keeps two cards' progress apart", async () => {
    // mockImplementation, not mockResolvedValue: the latter resolves every
    // call to the SAME object, so card-a's and card-b's poll would land the
    // identical reference and the identity check below would fail for a
    // mock artifact, not a real leak between keys.
    vi.mocked(fetchCountProgress).mockImplementation(async () => ({
      state: "running", frac: 0.4, label: "Running the detector",
    }))

    let a: () => void = () => {}
    let b: () => void = () => {}
    // trackCount emits synchronously before the first poll, but the subscriber
    // has to exist first to see it - so track inside act() with the hooks
    // already rendered, rather than before renderHook.
    const { result: ra } = renderHook(() => useCountProgress("card-a"))
    const { result: rb } = renderHook(() => useCountProgress("card-b"))
    act(() => {
      a = trackCount("tok-a", "card-a")
      b = trackCount("tok-b", "card-b")
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(ra.current).not.toBeNull()
    expect(rb.current).not.toBeNull()
    expect(ra.current).not.toBe(rb.current)

    act(() => { a() })
    expect(ra.current).toBeNull()
    expect(rb.current).not.toBeNull()
    act(() => { b() })
  })
})
