/** Gesture rules for the capture, taken from a map: a press that moves pans,
 *  a press that stays put is a click on the photo, a pinch magnifies. */

/** How far a press may wander and still count as a click rather than a pan.
 *  4 px absorbs the wobble of a trackpad tap without swallowing a deliberate
 *  nudge — a cell is ~22 px across, so the dot still lands where it was aimed. */
export const DRAG_SLOP = 4

/** The wheel-ish input a browser reports, narrowed to what the rule needs. */
export interface WheelLike {
  ctrlKey: boolean
  deltaMode: number
  deltaX: number
  deltaY: number
}

/** What a wheel event means over the capture.
 *
 *  A trackpad pinch arrives as a wheel event with `ctrlKey` set — the only
 *  signal the platform gives, and the same one the browser's own page zoom
 *  listens for, so claiming it means preventing that default.
 *
 *  Everything else has to be guessed, because no browser says which device
 *  sent it. A wheel notch is coarse, whole-numbered and purely vertical
 *  (100 px per notch in Chrome, one "line" — deltaMode 1 — in Firefox); a
 *  two-finger glide is fine-grained, usually fractional, and normally carries
 *  some sideways component. So the notch magnifies, the way every image tool
 *  treats a wheel, and the glide pans, the way two fingers move a map.
 *
 *  ponytail: a smooth-scroll mouse reads as a trackpad here and pans instead
 *  of magnifying. Recoverable — the slider, the +/- buttons and ctrl+wheel all
 *  still zoom — so it does not earn a real device-detection layer.
 */
/** Enough of a DOMRect to place a point on the photo. */
export interface Box { left: number; top: number; width: number; height: number }

/** The point the magnification has to hold still, held as a FRACTION of the
 *  photo plus the screen position it must come back to.
 *
 *  A fraction, because the photo's own position is not a constant: while it
 *  fits the box it is centred, and once it does not it is pinned to the scroll
 *  origin. Any formula phrased in scrollLeft alone quietly assumes the second,
 *  so it drifts through the whole first half of the range - fit -> 2x, the
 *  most common zoom there is, worst of all. */
export const anchorOn = (photo: Box, x: number, y: number): Anchor | null =>
  photo.width && photo.height
    ? { u: (x - photo.left) / photo.width, v: (y - photo.top) / photo.height, x, y }
    : null

export interface Anchor { u: number; v: number; x: number; y: number }

/** How far that point moved once the browser laid the new size out, in client
 *  px. Scrolling the stage by this puts it back under the cursor. Measured
 *  after the fact rather than predicted, so centring, clamping and rounding are
 *  all already in the number. */
export const anchorDrift = (photo: Box, a: Anchor) => ({
  dx: photo.left + a.u * photo.width - a.x,
  dy: photo.top + a.v * photo.height - a.y,
})

export function wheelIntent(e: WheelLike): "zoom" | "pan" {
  if (e.ctrlKey) return "zoom"
  // Lines and pages are only ever reported for a real wheel.
  if (e.deltaMode !== 0) return "zoom"
  return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50
    ? "zoom"
    : "pan"
}
