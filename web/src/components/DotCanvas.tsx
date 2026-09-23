import { useCallback, useEffect, useRef } from "react"
import { useCropActive } from "@/lib/cropBus"
import { DOT_ADDED, DOT_AUTO } from "@/lib/dotColors"
import { gridLinesOf, squareKeyOfCell } from "@/lib/geom"
import { useCounter } from "@/state/useCounter"
import { isCountedField } from "@/lib/types"

const GRID_STROKE = "rgba(200,120,255,.75)"
const FRAME_STROKE = "rgba(255,210,90,.9)"
const GHOST_STROKE = "rgba(170,170,170,.9)"
const TAU = Math.PI * 2
/** ~64 MB of backing store, the ceiling the zoom control can drive us into. */
const MAX_CANVAS_PX = 16e6

/** The editable dot layer: grid, triple-line frame and every detected /
 *  hand-added / ghosted cell, drawn client-side so a click can edit them. */
export function DotCanvas({ width, height }: {
  width: number
  height: number
}) {
  const { field, dots, showGrid, clickAt, off } = useCounter()
  const cropping = useCropActive()
  const ref = useRef<HTMLCanvasElement>(null)

  const draw = useCallback(() => {
    const cv = ref.current
    // DotCanvas only ever mounts over a successfully counted field (Viewer's
    // error branch shows the plain-sentence reason instead), but the type
    // does not guarantee it, so this guard doubles as the narrowing that lets
    // field.frame below type-check.
    if (!cv || !isCountedField(field) || width <= 0 || height <= 0) return

    // Backing store follows the natural pixels, but never falls below the
    // physical pixels on screen — a natural-size canvas blown up on a HiDPI
    // display would otherwise soften every dot.
    //
    // Capped by AREA, because the viewer's zoom multiplies that on-screen size:
    // an 8x magnified 1360x1024 field asks for a ~90 megapixel backing store,
    // which Chrome refuses to allocate and the whole dot layer disappears with
    // it. Past the cap the dots soften while the photo underneath stays sharp,
    // which is the side of the trade the user is actually looking at.
    const rect = cv.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const want = rect.width ? (rect.width * dpr) / width : 1
    const s = Math.max(1, Math.min(want, Math.sqrt(MAX_CANVAS_PX / (width * height))))
    const w = Math.round(width * s), h = Math.round(height * s)
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }

    const g = cv.getContext("2d")
    if (!g) return
    g.setTransform(s, 0, 0, s, 0, 0)
    g.clearRect(0, 0, width, height)

    if (showGrid) {
      const { xs, ys } = gridLinesOf(field)
      g.lineWidth = 1
      g.strokeStyle = GRID_STROKE
      g.beginPath()
      xs.forEach(x => { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, height) })
      ys.forEach(y => { g.moveTo(0, y + 0.5); g.lineTo(width, y + 0.5) })
      g.stroke()
      if (field.frame) {
        const { x0, y0, x1, y1 } = field.frame
        g.lineWidth = 2
        g.strokeStyle = FRAME_STROKE
        g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1)
      }
    }

    // An excluded square greys out on the photo itself, so the region that is
    // not being counted is visible where the user is looking. Independent of
    // showGrid: exclusion changes the number, the lattice is only decor.
    if (off.size) {
      const { xs, ys } = gridLinesOf(field)
      g.fillStyle = "rgba(10, 10, 14, 0.55)"
      // Walk the lattice and ask which cells are excluded, rather than parsing
      // the keys: a key is the square's ORIGINAL-px position now, not its index
      // into these lines, precisely so a crop cannot re-point it (geom.ts).
      for (let r = 0; r < ys.length - 1; r++) {
        for (let c = 0; c < xs.length - 1; c++) {
          if (!off.has(squareKeyOfCell(field, c, r))) continue
          g.fillRect(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r])
        }
      }
    }

    dots.forEach(([x, y, kind]) => {
      g.beginPath()
      g.arc(x, y, kind === "ghost" ? 5 : 3, 0, TAU)
      if (kind === "ghost") {
        g.strokeStyle = GHOST_STROKE
        g.lineWidth = 1.5
        g.stroke()
      } else {
        g.fillStyle = kind === "added" ? DOT_ADDED : DOT_AUTO
        g.fill()
      }
    })
  }, [field, dots, showGrid, off, width, height])

  useEffect(() => { draw() }, [draw])

  // The backing store follows the on-screen size, but not *during* a zoom.
  // Reallocating it and repainting the grid, the frame and every dot costs more
  // than a frame at high magnification (16 MP is the cap), and the viewer's
  // wheel and pinch ask for it 60-120 times a second: paying it per event is
  // what made magnifying stutter. Between the settle points the browser stretches
  // the bitmap it already has - the dots soften for the length of the gesture,
  // the photo under them does not - and it is repainted sharp once the size
  // holds still. Same trade as a map blurring its tiles mid-pinch.
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(draw, 150)
    })
    ro.observe(cv)
    return () => { clearTimeout(t); ro.disconnect() }
  }, [draw])

  return (
    <canvas
      ref={ref}
      className="absolute left-0 top-0 z-[4] h-full w-full cursor-crosshair"
      // The layer keeps taking clicks while the viewer pans: a drag starts on
      // this canvas, bubbles to the stage and only the click is suppressed.
      style={cropping ? { pointerEvents: "none" } : undefined}
      onClick={e => {
        if (cropping) return
        const cv = e.currentTarget
        const b = cv.getBoundingClientRect()
        if (!b.width || !b.height) return
        clickAt((e.clientX - b.left) / b.width * width,
                (e.clientY - b.top) / b.height * height)
      }}
    />
  )
}
