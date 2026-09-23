import { useCallback, useEffect, useRef, type RefObject } from "react"
import { motion } from "framer-motion"
import { cropBus } from "@/lib/cropBus"
import { toOrig } from "@/lib/geom"
import { useCounter } from "@/state/useCounter"
import { isCountedField, type Pt } from "@/lib/types"

type Quad = [Pt, Pt, Pt, Pt]

const clamp = (v: number, hi: number) => Math.max(0, Math.min(v, hi))

/** One tool: drag the four corners to fit the ruled area (keep them square for
 *  a straight crop, drag them independently for a skewed capture), then Apply.
 *  The elements are built once and only repositioned during a drag — a rebuild
 *  per pointermove breaks pointer capture and makes dragging jerky. */
export function CropTool({
  imgRef,
  onApply,
}: {
  imgRef: RefObject<HTMLImageElement | null>
  onApply: (cornersInOriginalPx: Pt[]) => void
}) {
  // The picture on screen is whatever the last count produced — which may
  // already be a crop of the capture. `transform` takes ORIGINAL px to those
  // displayed px, so the corners are mapped back through its inverse; sending
  // displayed px as if they were original px is what made a second crop land on
  // the wrong part of the slide.
  const { field } = useCounter()
  const quad = useRef<Quad>([[0, 0], [0, 0], [0, 0], [0, 0]])
  const poly = useRef<SVGPolygonElement>(null)
  const handles = useRef<(HTMLDivElement | null)[]>([null, null, null, null])

  const paint = useCallback(() => {
    poly.current?.setAttribute("points", quad.current.map(p => `${p[0]},${p[1]}`).join(" "))
    handles.current.forEach((d, i) => {
      if (d) d.style.transform = `translate(${quad.current[i][0]}px, ${quad.current[i][1]}px)`
    })
  }, [])

  const box = useCallback(() => imgRef.current?.getBoundingClientRect() ?? null, [imgRef])

  // Seed at a 10 % inset of the displayed image, and re-seed if the image
  // itself is swapped or resized before the first drag.
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const seed = () => {
      const b = img.getBoundingClientRect()
      if (!b.width || !b.height) return
      const mx = b.width * 0.1, my = b.height * 0.1
      quad.current = [[mx, my], [b.width - mx, my],
                      [b.width - mx, b.height - my], [mx, b.height - my]]
      paint()
    }
    seed()
    const ro = new ResizeObserver(seed)
    ro.observe(img)
    return () => ro.disconnect()
  }, [imgRef, paint])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to whatever is on top: a dialog or an open Select closes
      // itself with it, and the crop tool must not be dismissed underneath.
      if (e.key !== "Escape") return
      if (document.querySelector("[data-slot='dialog-content'], [data-radix-popper-content-wrapper]")) return
      cropBus.emit(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const dragCorner = (i: number) => (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault()
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    const move = (m: PointerEvent) => {
      const b = box()
      if (!b) return
      quad.current[i] = [clamp(m.clientX - b.left, b.width), clamp(m.clientY - b.top, b.height)]
      paint()
    }
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }

  const dragBody = (ev: React.PointerEvent<SVGPolygonElement>) => {
    ev.preventDefault()
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    let last: Pt = [ev.clientX, ev.clientY]
    const move = (m: PointerEvent) => {
      const b = box()
      if (!b) return
      const xs = quad.current.map(p => p[0]), ys = quad.current.map(p => p[1])
      const dx = Math.max(-Math.min(...xs), Math.min(b.width - Math.max(...xs), m.clientX - last[0]))
      const dy = Math.max(-Math.min(...ys), Math.min(b.height - Math.max(...ys), m.clientY - last[1]))
      quad.current = quad.current.map(([x, y]) => [x + dx, y + dy]) as Quad
      last = [m.clientX, m.clientY]
      paint()
    }
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }

  const apply = () => {
    const img = imgRef.current
    if (!img) return
    const b = img.getBoundingClientRect()
    const nw = img.naturalWidth || b.width, nh = img.naturalHeight || b.height
    if (!b.width || !b.height) return
    onApply(quad.current.map(([x, y]): Pt => {
      const d: Pt = [x / b.width * nw, y / b.height * nh]
      const o = isCountedField(field) ? toOrig(field, d) : d
      return [Math.round(o[0]), Math.round(o[1])]
    }))
    cropBus.emit(false)
  }

  return (
    <motion.div
      className="absolute inset-0 z-[5]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <polygon
          ref={poly}
          fill="rgba(255,210,74,.12)"
          stroke="#ffd24a"
          strokeWidth={2}
          style={{ cursor: "move", pointerEvents: "fill", touchAction: "none" }}
          onPointerDown={dragBody}
        />
      </svg>

      {[0, 1, 2, 3].map(i => (
        <div
          key={i}
          ref={el => { handles.current[i] = el }}
          role="slider"
          aria-label={["Top left", "Top right", "Bottom right", "Bottom left"][i] + " crop corner"}
          aria-valuetext="drag to move"
          tabIndex={-1}
          onPointerDown={dragCorner(i)}
          // An INSET ring, never a coloured border: Zen/WebRender seams a real
          // border at a rounded corner (measured 2026-09-19, see _constraints.md).
          className="absolute left-0 top-0 z-[6] -ml-2.5 -mt-2.5 h-5 w-5 cursor-grab rounded-full
                     border-2 border-transparent inset-ring-2 inset-ring-[#0b0f14] bg-[#ffd24a] shadow-[0_1px_6px_rgba(0,0,0,.5)]
                     touch-none active:cursor-grabbing"
        />
      ))}

      {/* Fixed dark/yellow chrome: it sits over the photo, so it must read on
          every theme rather than inherit one. */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-[7] -translate-x-1/2 whitespace-nowrap
                      rounded-lg bg-[rgba(10,14,20,.8)] px-3 py-[5px] text-xs text-[#ffd24a]">
        Drag the corners to fit the grid, or drag inside to move it
      </div>

      {/* An INSET ring, never a coloured border, on all three controls below:
          Zen/WebRender seams a real border at a rounded corner (measured
          2026-09-19, see _constraints.md). */}
      <div className="absolute bottom-3.5 left-1/2 z-[7] flex -translate-x-1/2 gap-2 rounded-[10px]
                      border border-transparent inset-ring inset-ring-[rgba(255,210,74,.4)] bg-[rgba(10,14,20,.85)] p-2">
        <button
          type="button"
          onClick={apply}
          className="rounded-md border border-transparent inset-ring inset-ring-[#8a6b1f] bg-[#8a6b1f] px-3 py-1.5 text-xs font-medium
                     text-[#fafafa] transition-[color,background-color] hover:bg-[#a07f26]
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffd24a]"
        >
          Apply crop
        </button>
        <button
          type="button"
          onClick={() => cropBus.emit(false)}
          className="rounded-md border border-transparent inset-ring inset-ring-[#3a4556] bg-[#131c29] px-3 py-1.5 text-xs font-medium
                     text-[#fafafa] transition-[color,box-shadow] hover:inset-ring-[#5b6a80]
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffd24a]"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  )
}
