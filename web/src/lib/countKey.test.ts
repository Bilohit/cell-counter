import { describe, expect, it } from "vitest"
import { countKey } from "./countKey"
import type { Pt } from "./types"

const BASE = {
  level: 3, seq: 0,
  quad: null as Pt[] | null, autocrop: "", boundary: true, pair: false,
}

describe("countKey", () => {
  // The four regressions the old four-field record caused.
  it("changes when a crop is drawn and again when it is taken back", () => {
    const q: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const cropped = countKey({ ...BASE, quad: q })
    expect(cropped).not.toBe(countKey(BASE))
    expect(countKey({ ...BASE, quad: [...q] })).toBe(cropped)   // by value, not reference
  })

  it("changes when auto-crop turns on and back off", () => {
    expect(countKey({ ...BASE, autocrop: "frame" })).not.toBe(countKey(BASE))
    expect(countKey({ ...BASE, autocrop: "" })).toBe(countKey(BASE))
  })

  it("changes when the triple-line switch moves", () => {
    expect(countKey({ ...BASE, boundary: false })).not.toBe(countKey(BASE))
  })

  it("changes when a confirmed pair is opened", () => {
    expect(countKey({ ...BASE, pair: true })).not.toBe(countKey(BASE))
  })

  it("ignores auto-crop while a hand-drawn quad is present, as the request does", () => {
    const q: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(countKey({ ...BASE, quad: q, autocrop: "frame" }))
      .toBe(countKey({ ...BASE, quad: q, autocrop: "" }))
  })

  it("changes on level and on a retry", () => {
    expect(countKey({ ...BASE, level: 2 })).not.toBe(countKey(BASE))
    expect(countKey({ ...BASE, seq: 1 })).not.toBe(countKey(BASE))
  })

  // "Show pipeline steps" was in this key until 2026-09-21, which made a
  // DISPLAY toggle fire a full recount - the rule the quality slider is held
  // to, broken by a switch buried in the settings dialog. The type no longer
  // has the field at all, so a future caller cannot quietly put it back.
  it("has no stages field to key on", () => {
    // Via variables, not literals: a caller that still carries `stages` must
    // type-check and must key the same either way. (The old body asserted on
    // this file's own BASE literal, so no change to countKey could fail it.)
    const on = { ...BASE, stages: true }
    const off = { ...BASE, stages: false }
    expect(countKey(on)).toBe(countKey(off))
    expect(countKey(on)).toBe(countKey(BASE))
  })
})
