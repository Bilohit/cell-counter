import { describe, expect, it } from "vitest"
import { appliedRotation } from "./ComparePair"

/** The preview must rotate exactly when the merge does, and the same way:
 *  pipeline.stitch_pair reports every tilt it measures but only warps the lower
 *  capture once |angle| >= ROTATION_DEG_MIN (0.15 deg), with
 *  getRotationMatrix2D(centre, -angle) — a clockwise turn, which is a positive
 *  CSS rotate() of the same magnitude and sign. */
describe("appliedRotation", () => {
  it("ignores a tilt the merge does not correct", () => {
    expect(appliedRotation(0.018)).toBe(0)      // the measured stage jitter
    expect(appliedRotation(-0.14)).toBe(0)
    expect(appliedRotation(0)).toBe(0)
    expect(appliedRotation(undefined)).toBe(0)  // pre-correction server or session
  })
  it("passes a real tilt through unchanged in sign and size", () => {
    expect(appliedRotation(0.15)).toBe(0.15)
    expect(appliedRotation(0.9)).toBe(0.9)
    expect(appliedRotation(-0.9)).toBe(-0.9)
  })
})
