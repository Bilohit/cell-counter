import { expect, it } from "vitest"
import { anchorDrift, anchorOn, wheelIntent, type WheelLike } from "./gesture"

const ev = (o: Partial<WheelLike>): WheelLike =>
  ({ ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 0, ...o })

// The pinch is the one case the platform reports honestly, so it must never
// fall through to the guesswork below.
it("a trackpad pinch always magnifies", () => {
  expect(wheelIntent(ev({ ctrlKey: true, deltaY: -3.5 }))).toBe("zoom")
  expect(wheelIntent(ev({ ctrlKey: true, deltaY: 2, deltaX: 1.5 }))).toBe("zoom")
})

it("a wheel notch magnifies", () => {
  expect(wheelIntent(ev({ deltaY: 100 }))).toBe("zoom")   // Chrome / Edge
  expect(wheelIntent(ev({ deltaY: -100 }))).toBe("zoom")
  expect(wheelIntent(ev({ deltaMode: 1, deltaY: 3 }))).toBe("zoom")  // Firefox, in lines
})

it("a two-finger glide pans", () => {
  expect(wheelIntent(ev({ deltaY: -8.5 }))).toBe("pan")    // fine and fractional
  expect(wheelIntent(ev({ deltaY: 4 }))).toBe("pan")       // whole, but far short of a notch
  expect(wheelIntent(ev({ deltaX: 120, deltaY: 0 }))).toBe("pan")   // sideways: no wheel does this
  expect(wheelIntent(ev({ deltaX: 12, deltaY: 100 }))).toBe("pan")  // notch-sized but skewed
})

// A 400x400 box holding a 400x300 photo: it fits, so the photo is centred and
// starts 50 px down. Magnifying 2x about (100, 200) makes it 800x600, which
// overflows and so lays out at the scroll origin. The point the user pointed at
// is a quarter across and half down the photo, and it has to stay under (100,
// 200) - which it only does if the 50 px of centring is in the arithmetic. It
// was not, and that was the drift.
it("the pointed-at spot comes back under the cursor across the centred-to-overflowing switch", () => {
  const a = anchorOn({ left: 0, top: 50, width: 400, height: 300 }, 100, 200)!
  expect(a.u).toBeCloseTo(0.25)
  expect(a.v).toBeCloseTo(0.5)

  const { dx, dy } = anchorDrift({ left: 0, top: 0, width: 800, height: 600 }, a)
  // The spot now sits at (200, 300); scrolling by this lands it back on (100, 200).
  expect(dx).toBeCloseTo(100)
  expect(dy).toBeCloseTo(100)
})

it("a photo that did not move does not scroll", () => {
  const box = { left: 12, top: 34, width: 400, height: 300 }
  const { dx, dy } = anchorDrift(box, anchorOn(box, 300, 200)!)
  expect(dx).toBeCloseTo(0)
  expect(dy).toBeCloseTo(0)
})

it("an unmeasured photo yields no anchor rather than a NaN one", () => {
  expect(anchorOn({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBeNull()
})
