import { useSyncExternalStore } from "react"

const BURN_KEY = "cc-burn-count"
const SCALE_KEY = "cc-ui-scale-pct"
const PANEL_KEY = "cc-sidebar-open"

/** Interface scale, in percent of the app's own working size.
 *
 *  100 is not the browser's 100 %: the workbench at true 1x reads too small on
 *  a lab monitor, so 100 % here means 1.6x, the size the app is meant to be
 *  used at. The percentage is the user's dial, SCALE_BASE is what it multiplies.
 *  (Previous key `cc-ui-scale` stored a raw multiplier - a new key so an old
 *  1.8 is never read back as 1.8 %.) */
export const SCALE_MIN = 50
export const SCALE_MAX = 200
export const SCALE_STEP = 5
const SCALE_BASE = 1.6
const DEFAULT_PCT = 100

export const clampScale = (v: number) =>
  Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v)))

// Module-level store: every mounted useSettings() shares one value, so the
// export dialog and the settings dialog can never disagree (M-9).
function read<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    return saved === null ? fallback : parse(saved)
  } catch { return fallback }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

/** Interface scale, as a transform rather than CSS `zoom`.
 *
 *  `zoom` was the obvious choice - it is what the browser's own zoom control
 *  does, and every px-sized rule scales together. It is also unusable here:
 *  Safari before 26.4 divides getBoundingClientRect() by the zoom while leaving
 *  mouse clientX/clientY in page px (WebKit bug 77998, open thirteen years).
 *  Every pointer-to-image conversion in this app is the ratio
 *  `(clientX - rect.left) / rect.width`, so on those Safaris - which includes
 *  every Safari that runs on the macOS 13/14 the release zip still supports -
 *  the ratio came out 1.6x too large against a shifted origin. Reported from a
 *  lab Mac: slider thumbs pinned to an end and ignored the drag, and
 *  press-and-drag panning slammed to the scroll limit. Hand-placed dots and
 *  crop corners run the same ratio and were off by the same factor.
 *
 *  A transform is reported inside getBoundingClientRect() by every engine, so
 *  the two units agree and the existing ratio math is right everywhere.
 *
 *  On <body>, not #root: dialogs, selects, tooltips and toasts all portal to
 *  document.body, so that is the element whose scaling they have to inherit.
 *  Body is sized to the inverse of the scale, which makes the scaled box cover
 *  exactly the viewport - and keeps `position: fixed` children full-screen,
 *  since a transformed body becomes their containing block. */
function applyScale(pct: number) {
  const z = +((pct * SCALE_BASE) / 100).toFixed(4)
  const inv = `${+(100 / z).toFixed(4)}%`
  const s = document.body.style
  s.transformOrigin = "0 0"
  s.transform = `scale(${z})`
  s.width = inv
  s.height = inv
  // `vh` is measured against the real viewport, which the transform then
  // multiplies - a 52vh cap would cover 83 % of a 1.6x screen. --vh is one
  // percent of the screen expressed in the scaled-down units the content is
  // laid out in, so `calc(52 * var(--vh))` means 52 % of the screen again.
  s.setProperty("--vh", `calc(1vh / ${z})`)
}

let snap = {
  burnCount: read(BURN_KEY, s => s === "1", true),
  uiScalePct: read(SCALE_KEY, s => (Number.isFinite(+s) ? clampScale(+s) : DEFAULT_PCT),
                   DEFAULT_PCT),
  // Collapsing the workbench panel is a working posture, not a one-off: a user
  // who edits dots full-bleed wants the next capture that way too.
  sidebarOpen: read(PANEL_KEY, s => s === "1", true),
}

// At import time, not in an effect: the scale has to be on the root element
// before React's first paint or the whole UI visibly jumps on load.
applyScale(snap.uiScalePct)

const subs = new Set<() => void>()
const emit = () => subs.forEach(fn => fn())

function setBurnCount(v: boolean) {
  snap = { ...snap, burnCount: v }
  write(BURN_KEY, v ? "1" : "0")
  emit()
}

function setUiScalePct(v: number) {
  const pct = clampScale(v)
  snap = { ...snap, uiScalePct: pct }
  write(SCALE_KEY, String(pct))
  applyScale(pct)
  emit()
}

function setSidebarOpen(v: boolean) {
  snap = { ...snap, sidebarOpen: v }
  write(PANEL_KEY, v ? "1" : "0")
  emit()
}

export function useSettings() {
  const s = useSyncExternalStore(
    cb => { subs.add(cb); return () => { subs.delete(cb) } },
    () => snap,
  )
  return { ...s, setBurnCount, setUiScalePct, setSidebarOpen }
}
