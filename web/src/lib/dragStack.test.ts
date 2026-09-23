// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { buildFanImage } from "./dragStack"

afterEach(() => { document.body.innerHTML = "" })

describe("buildFanImage", () => {
  it("attaches the node, because a detached one is silently ignored", () => {
    const { node, cleanup } = buildFanImage({ urls: ["a"], count: 1 })
    expect(node.isConnected).toBe(true)
    cleanup()
    expect(node.isConnected).toBe(false)
  })

  it("shows a badge only when more than one capture is moving", () => {
    const one = buildFanImage({ urls: ["a"], count: 1 })
    expect(one.node.textContent).toBe("")
    one.cleanup()

    const many = buildFanImage({ urls: ["a", "b", "c"], count: 3 })
    expect(many.node.textContent).toBe("3")
    many.cleanup()
  })

  it("caps the pile but not the count: the badge carries the real number", () => {
    const { node, cleanup } = buildFanImage({
      urls: ["a", "b", "c", "d", "e", "f"], count: 6,
    })
    expect(node.querySelectorAll("img")).toHaveLength(4)
    expect(node.textContent).toBe("6")
    cleanup()
  })

  it("fans deterministically, so the same drag always looks the same", () => {
    // Cards only: the count badge carries no transform.
    const rots = (n: HTMLElement) => [...n.querySelectorAll("div")]
      .map(d => d.style.transform).filter(Boolean)
    const a = buildFanImage({ urls: ["a", "b"], count: 2 })
    const first = rots(a.node)
    a.cleanup()
    const b = buildFanImage({ urls: ["a", "b"], count: 2 })
    const second = rots(b.node)
    b.cleanup()
    expect(second).toEqual(first)
    // And the top card sits square under the pointer.
    expect(first[first.length - 1]).toBe("rotate(0deg)")
  })

  it("flattens the fan for a reader who asked for less motion", () => {
    const { node, cleanup } = buildFanImage({
      urls: ["a", "b", "c"], count: 3, reduced: true,
    })
    const rots = [...node.querySelectorAll("div")]
      .filter(d => d.style.transform)
      .map(d => d.style.transform)
    expect(rots.every(r => r === "rotate(0deg)")).toBe(true)
    // The badge stays: it is information, not decoration.
    expect(node.textContent).toBe("3")
    cleanup()
  })

  it("survives a capture with no thumbnail yet", () => {
    const { node, cleanup } = buildFanImage({ urls: [undefined, "b"], count: 2 })
    expect(node.querySelectorAll("img")).toHaveLength(1)
    expect(node.querySelectorAll("div").length).toBeGreaterThanOrEqual(2)
    cleanup()
  })
})
