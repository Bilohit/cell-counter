/** The Finder-style drag image: the selection converging into a slightly messy
 *  fanned stack under the pointer, with a count badge.
 *
 *  Why a drag IMAGE rather than an animated stack that follows the cursor: the
 *  staging screen's drag is HTML5 drag-and-drop, and every drop target on that
 *  screen (`useDropTarget` in BatchConfirm) is built on it. A hand-rolled
 *  pointer drag would have to replace all of that to animate the same pixels,
 *  which is a rewrite of working code for a flourish. `setDragImage` takes a
 *  snapshot of a real DOM node, so the stack is built once, handed over, and
 *  the browser drags it - the fan is exactly as messy as it is drawn here.
 *
 *  The snapshot is why nothing here animates: a drag image is a still. The
 *  motion in this interaction lives on the tiles left behind (they dim while
 *  their captures are in flight) and on the drop, where the grid's own `layout`
 *  transition carries the tiles into their new band.
 */

/** How many tiles the stack shows before it stops adding them. Four reads as
 *  "a pile"; more is a smear at 96 px, and the badge carries the real number. */
const MAX_TILES = 4

/** Deterministic per index, never random: a stack that fans differently each
 *  time the same drag starts looks like a bug, and a test cannot pin it. The
 *  angles alternate so the pile leans both ways, as a dropped stack of cards
 *  does. Degrees and pixels. */
const FAN: ReadonlyArray<{ rot: number; dx: number; dy: number }> = [
  { rot: -7, dx: -9, dy: 4 },
  { rot: 6, dx: 7, dy: -3 },
  { rot: -3, dx: 3, dy: 7 },
  { rot: 0, dx: 0, dy: 0 },      // the top card sits square, under the pointer
]

const TILE = 96

export interface FanOptions {
  /** Thumbnail URLs, topmost LAST (it is drawn last, so it sits on top). */
  urls: (string | undefined)[]
  /** How many captures are really moving - the badge's number. */
  count: number
  /** Honour the reader's motion preference by flattening the fan: no rotation,
   *  no scatter, just a neat stack. The badge and the pile stay, because they
   *  carry the information; only the jaunty angles go. */
  reduced?: boolean
}

/** Build the stack, attach it off-screen, and return it with its cleanup.
 *
 *  The node MUST be in the document when `setDragImage` is called - a detached
 *  element is silently ignored and the browser falls back to dragging the
 *  source element - and must be removed afterwards, which is what `cleanup` is
 *  for. Call it on `dragend`, not immediately: Safari and Firefox read the node
 *  after the handler returns.
 */
export function buildFanImage({ urls, count, reduced }: FanOptions): {
  node: HTMLElement
  cleanup: () => void
  /** Where the pointer should sit on the image: the middle of the top card. */
  offset: [number, number]
} {
  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  // Off-screen, not `display:none` and not `visibility:hidden`: both of those
  // make the snapshot blank. -10000px is off any real screen and still painted.
  host.style.cssText =
    `position:fixed;top:-10000px;left:-10000px;width:${TILE + 40}px;height:${TILE + 40}px;`
    + "pointer-events:none;"

  const shown = urls.slice(-MAX_TILES)
  shown.forEach((url, i) => {
    // Index into FAN from the END, so the LAST tile always gets FAN[3] - the
    // square one on top - whether the stack holds one tile or four.
    const f = FAN[FAN.length - shown.length + i] ?? FAN[FAN.length - 1]
    const card = document.createElement("div")
    const rot = reduced ? 0 : f.rot
    const dx = reduced ? 0 : f.dx
    const dy = reduced ? 0 : f.dy
    card.style.cssText = [
      "position:absolute",
      `left:${20 + dx}px`,
      `top:${20 + dy}px`,
      `width:${TILE}px`,
      `height:${TILE}px`,
      `transform:rotate(${rot}deg)`,
      "border-radius:10px",
      "overflow:hidden",
      "background:var(--panel2, #1c1d22)",
      // An INSET ring, never a coloured border: Zen/WebRender seams a real
      // border at a rounded corner (2026-09-19, _constraints.md).
      "box-shadow:inset 0 0 0 1px var(--line, #333), 0 6px 16px -8px rgba(0,0,0,.6)",
    ].join(";")
    if (url) {
      const img = document.createElement("img")
      img.src = url
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block"
      card.appendChild(img)
    }
    host.appendChild(card)
  })

  if (count > 1) {
    const badge = document.createElement("div")
    badge.textContent = String(count)
    badge.style.cssText = [
      "position:absolute",
      "right:6px",
      "top:6px",
      "min-width:22px",
      "height:22px",
      "padding:0 6px",
      "border-radius:999px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "font:600 12px/1 ui-sans-serif,system-ui,sans-serif",
      "color:#fff",
      "background:var(--brand, #51d98b)",
      "box-shadow:0 2px 6px -1px rgba(0,0,0,.5)",
    ].join(";")
    host.appendChild(badge)
  }

  document.body.appendChild(host)
  return {
    node: host,
    cleanup: () => { host.remove() },
    offset: [20 + TILE / 2, 20 + TILE / 2],
  }
}
