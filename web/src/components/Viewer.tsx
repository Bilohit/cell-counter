import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { motion } from "framer-motion"
import { Maximize2, X, ZoomIn, ZoomOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { DRAG_SLOP, anchorDrift, anchorOn, wheelIntent, type Anchor } from "@/lib/gesture"
import { useCropActive } from "@/lib/cropBus"
import { CropTool } from "@/components/CropTool"
import { DotCanvas } from "@/components/DotCanvas"
import { DropZone } from "@/components/DropZone"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCounter } from "@/state/useCounter"
import { useSettings } from "@/state/useSettings"
import { isCountedField, isFailedField } from "@/lib/types"

/** 1 is fit-to-window; 8 is the practical ceiling for picking a single cell out
 *  of a clump. Never below 1: fitting already shows the whole capture. */
const MIN_ZOOM = 1
const MAX_ZOOM = 8
const STEP = 1.5

const clampZoom = (v: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v))

/** Editing dots is a click on the photo and nothing on the photo says so. The
 *  sidebar said it, but the sidebar folds away precisely so the picture can have
 *  the window for editing — the hint went with it exactly when it was needed. So
 *  it is said once, here, and dismissed for good: localStorage, not session
 *  storage, because a user learns this once and not once per tab. */
const HINT_KEY = "cellcounter.dotHint"
/** Once learned, the sidebar's own copy of this line normally carries it —
 *  except the sidebar is folded, which is exactly when dot editing happens and
 *  exactly when its copy is invisible. So a folded sidebar re-shows this hint
 *  once per session: sessionStorage, not localStorage, because the user
 *  already learned the gesture and only needs the reminder for this tab. */
const SESSION_KEY = "cellcounter.dotHint.session"

function hintDone(): boolean {
  try { return localStorage.getItem(HINT_KEY) === "1" } catch { return false }
}

function sessionHintDone(): boolean {
  try { return sessionStorage.getItem(SESSION_KEY) === "1" } catch { return false }
}

function DotHint() {
  const { sidebarOpen } = useSettings()
  const [done, setDone] = useState(hintDone)
  const [sessionDone, setSessionDone] = useState(sessionHintDone)
  if (done && (sidebarOpen || sessionDone)) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-7 z-20 flex justify-center px-7">
      {/* An INSET ring, never a coloured border: Zen/WebRender seams a real
          border at a rounded corner (measured 2026-09-19, see _constraints.md). */}
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-transparent inset-ring inset-ring-line
                      bg-panel/90 py-1 pr-1 pl-3 text-[13px] text-foreground shadow-lg backdrop-blur-sm">
        Click to add or remove a dot.
        <Button
          type="button" size="icon" variant="ghost"
          className="size-7 rounded-full" aria-label="Got it"
          onClick={() => {
            setDone(true)
            setSessionDone(true)
            try { localStorage.setItem(HINT_KEY, "1") } catch { /* it just asks again */ }
            try { sessionStorage.setItem(SESSION_KEY, "1") } catch { /* it just asks again */ }
          }}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}

/** The zoom row, docked under the picture rather than floating over its corner.
 *  Floating, it shared the bottom-right corner with the count badge and the two
 *  covered each other whenever the sidebar was collapsed; docked, neither can.
 *  There is no tool to pick here; the gesture says what the user meant (see
 *  `lib/gesture.ts`). */
function ZoomBar({ zoom, onZoom }: {
  zoom: number
  onZoom: (v: number) => void
}) {
  const fit = zoom <= MIN_ZOOM + 0.001

  return (
    <div className="mt-2.5 flex flex-none items-center justify-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button" size="icon" variant="ghost" className="rounded-full"
            disabled={fit} aria-label="Zoom out"
            onClick={() => onZoom(zoom / STEP)}
          >
            <ZoomOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Zoom out</TooltipContent>
      </Tooltip>

      <Slider
        aria-label="Zoom"
        thumbLabel="Zoom"
        thumbValueText={`${Math.round(zoom * 100)} %`}
        className="mx-1 w-[190px] max-w-[40vw]"
        min={MIN_ZOOM} max={MAX_ZOOM} step={0.05}
        value={[zoom]}
        onValueChange={v => onZoom(v[0])}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button" size="icon" variant="ghost" className="rounded-full"
            disabled={zoom >= MAX_ZOOM - 0.001} aria-label="Zoom in"
            onClick={() => onZoom(zoom * STEP)}
          >
            <ZoomIn />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Zoom in</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button" size="sm" variant="ghost"
            className="h-9 min-w-[52px] rounded-full font-mono text-[13px] tabular-nums"
            disabled={fit} aria-label="Fit the capture to the window"
            onClick={() => onZoom(MIN_ZOOM)}
          >
            {fit ? <Maximize2 className="opacity-60" /> : Math.round(zoom * 100)}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{fit ? "Fitted to the window" : "Fit to the window"}</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function Viewer({ onIntake }: { onIntake: (files: File[]) => void }) {
  const {
    files, fields, field, fieldIdx, setFieldIdx, busy,
    setQuad, imgSize, setImgSize, selectedStage, showStages,
  } = useCounter()
  const cropping = useCropActive()
  const imgRef = useRef<HTMLImageElement>(null)
  // The photo's box is measured, not guessed from vh: the dot canvas and the
  // crop tool both sit in the box the photo makes, so any
  // constraint the box applies that the photo does not (a shorter max-height,
  // flex shrink) squashes the marks off the cells. Measured here, the photo
  // never outgrows its box. Was a fixed calc(100vh-130px), which ignored the
  // gallery nav, the step strip and the field tabs - a stitched (tall) field
  // then overflowed by ~20 %. The same box is now what "fit" means, and zoom
  // multiplies it.
  // One node, two handles: the observers below need the state so they re-run
  // once it exists, the scroll writes need a plain reference to write through.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const attachStage = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el
    setStageEl(el)
  }, [])
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!stageEl) return
    const ro = new ResizeObserver(() => setBox({ w: stageEl.clientWidth, h: stageEl.clientHeight }))
    ro.observe(stageEl)
    return () => ro.disconnect()
  }, [stageEl])

  const [zoom, setZoom] = useState(MIN_ZOOM)

  // Zoom holds a point still: the cursor when a wheel or a pinch drives it, the
  // middle of the view otherwise. Without this, magnifying a clump in a corner
  // throws it off screen and the user has to hunt for it again.
  //
  // The magnification lives in a ref as well as in state because a pinch fires
  // faster than React re-renders: reading the state here would let two events
  // in one frame both compute from the same stale value, which drops one step
  // and anchors the other against a size that is already gone.
  const zoomRef = useRef(MIN_ZOOM)
  // The point to hold still, recorded before the size changes and settled after
  // it has (`lib/gesture.ts` owns the geometry, and tests it).
  const anchor = useRef<Anchor | null>(null)

  const onZoom = useCallback((next: number, at?: { x: number; y: number }) => {
    const v = clampZoom(next)
    if (v === zoomRef.current) return
    const el = stageRef.current, im = imgRef.current
    if (el && im) {
      const b = el.getBoundingClientRect()
      anchor.current = anchorOn(im.getBoundingClientRect(),
                                at?.x ?? b.left + b.width / 2,
                                at?.y ?? b.top + b.height / 2)
    }
    zoomRef.current = v
    setZoom(v)
  }, [])

  // Put the held point back under the cursor, from the photo's real position
  // once the browser has laid the new size out - measured, not predicted.
  //
  // In a layout effect rather than a rAF: a rAF lets the browser paint one
  // frame at the new size with the old scroll, and that one-frame slide is what
  // the eye reads as the zoom being jittery and as landing off-target.
  useLayoutEffect(() => {
    // The ref trails the committed state by one line, here rather than during
    // render: a wheel event cannot land between the two, and writing a ref
    // while rendering is not something React promises to keep.
    zoomRef.current = zoom
    const a = anchor.current
    anchor.current = null
    const el = stageRef.current, im = imgRef.current
    if (!a || !el || !im) return
    const b = el.getBoundingClientRect()
    const { dx, dy } = anchorDrift(im.getBoundingClientRect(), a)
    // Client px -> scroll px: the body carries the interface-scale transform,
    // so the two are not the same unit and only the ratio between them is safe.
    const r = b.width ? el.clientWidth / b.width : 1
    el.scrollLeft += dx * r
    el.scrollTop += dy * r
  }, [zoom])

  // A pinch or a wheel notch magnifies at the cursor; a two-finger glide is
  // left alone, so the stage scrolls itself and the trackpad's own inertia
  // carries the pan. Registered by hand because preventDefault needs a
  // non-passive listener, which React's onWheel cannot give.
  useEffect(() => {
    if (!stageEl) return
    const onWheel = (e: WheelEvent) => {
      if (wheelIntent(e) === "pan") return
      e.preventDefault()      // a pinch would otherwise drive the browser's page zoom
      // Away from the user, and fingers apart, both report a negative delta and
      // both mean "closer". Pinch deltas are an order of magnitude smaller than
      // a wheel notch's, so they get their own gain - one factor for both
      // leaves the pinch feeling dead.
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      onZoom(zoomRef.current * Math.exp(-step * (e.ctrlKey ? 0.01 : 0.0016)),
             { x: e.clientX, y: e.clientY })
    }
    stageEl.addEventListener("wheel", onWheel, { passive: false })
    return () => stageEl.removeEventListener("wheel", onWheel)
  }, [stageEl, onZoom])

  // Press-and-drag panning, on every press: what separates a pan from an edit
  // is whether the pointer travelled, not which tool was armed beforehand.
  // Under DRAG_SLOP nothing moves and the click reaches DotCanvas as a cell
  // edit; past it the press becomes a pan and the click that follows is eaten.
  //
  // The pointer is captured only once the slop is crossed: capturing on
  // pointerdown would re-target the click at this container and no dot would
  // ever be editable again. The scroll position is read once at pointerdown
  // and moved by the pointer's total delta, so a slow drag accumulates no drift.
  const pan = useRef<
    { id: number; x: number; y: number; sl: number; st: number; r: number; moved: boolean } | null
  >(null)
  const dragged = useRef(false)
  const [dragging, setDragging] = useState(false)
  const startPan = (e: React.PointerEvent<HTMLDivElement>) => {
    dragged.current = false
    // Touch is left to the browser: native scrolling already pans, with
    // inertia, and a tap still arrives as a click on the dot layer.
    if (cropping || e.button !== 0 || e.pointerType === "touch") return
    const el = e.currentTarget
    const b = el.getBoundingClientRect()
    pan.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      sl: el.scrollLeft, st: el.scrollTop,
      r: b.width ? el.clientWidth / b.width : 1,
      moved: false,
    }
  }
  const movePan = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current
    if (!p || p.id !== e.pointerId) return
    const dx = e.clientX - p.x, dy = e.clientY - p.y
    if (!p.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return
      p.moved = true
      e.currentTarget.setPointerCapture(p.id)
      setDragging(true)
    }
    const el = e.currentTarget
    el.scrollLeft = p.sl - dx * p.r
    el.scrollTop = p.st - dy * p.r
  }
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current
    if (p?.id !== e.pointerId) return
    if (p.moved) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      dragged.current = true
      setDragging(false)
    }
    pan.current = null
  }

  // A different capture is a different frame of reference: keeping the previous
  // magnification would open it scrolled into a corner of an image nobody has
  // seen whole yet. Adjusted during render rather than in an effect, so the
  // capture never paints once at the old magnification first.
  const fieldKey = field?.names.join("+") ?? ""
  const [zoomedField, setZoomedField] = useState(fieldKey)
  if (zoomedField !== fieldKey) {
    setZoomedField(fieldKey)
    setZoom(MIN_ZOOM)
  }

  // base_image is now an /api/image/<id> path into a byte-bounded
  // store (app.py's _IMAGE_STORE, 128 MiB), not inlined data: URIs - so unlike
  // before, the id's bytes can be evicted under memory pressure and the <img>
  // can 404. A plain broken-image icon here leaves the researcher with no idea
  // what happened or what to do, so a failed load is tracked per field and
  // swapped for the same sentence exporters.ts already uses for this failure.
  // Reset whenever the field changes, so a stale broken flag from a previous
  // field does not blank out a fresh, perfectly good image.
  const [imgBroken, setImgBroken] = useState({ base: false })
  const brokenField = useRef(fieldKey)
  if (brokenField.current !== fieldKey) {
    brokenField.current = fieldKey
    setImgBroken({ base: false })
  }

  if (!field) {
    // The drop zone is the FIRST-RUN screen: "there is nothing here, give me a
    // capture". It must never appear over a capture that exists. With files on
    // screen (or a count in flight) and no field yet, the honest thing to say
    // is that the count is running - this is the gap a gallery card opens into
    // while its count lands, and filling it with an intake prompt read as the
    // app losing the image (2026-09-21).
    if (files.length || busy) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-7">
          <p className="text-[15px] text-muted-foreground" role="status">Counting…</p>
        </div>
      )
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-7">
        <DropZone onFiles={onIntake} />
      </div>
    )
  }

  // Shared by both the normal view and the per-field error view below, so a
  // failed field (app.py: one bad group in an otherwise-good batch) still
  // lets the user switch to the fields that DID count.
  const tabs = fields.length > 1 && (
    <div className="flex flex-none flex-wrap justify-center gap-1.5 pb-2.5">
      {fields.map((f, i) => (
        <button
          key={f.names.join("+") + i}
          type="button"
          aria-pressed={i === fieldIdx}
          title={isFailedField(f) ? f.error : undefined}
          onClick={() => setFieldIdx(i)}
          className={cn(
            // An INSET ring, never a coloured border: Zen/WebRender seams a
            // real border at a rounded corner (measured 2026-09-19, see
            // _constraints.md).
            "rounded-md border border-transparent inset-ring px-2.5 py-1 text-[13px] font-medium",
            "transition-[box-shadow,background-color] duration-150 ease-out",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            i === fieldIdx
              ? "inset-ring-amber bg-amber text-[#141005]"
              : isFailedField(f)
                ? "inset-ring-destructive/50 bg-panel2 text-destructive hover:inset-ring-destructive"
                : "inset-ring-line bg-panel2 text-foreground hover:inset-ring-line-hi hover:bg-panel-hover",
          )}
        >
          {(isCountedField(f) && f.stitch ? "merged: " : "") + f.names.join(" + ")}
        </button>
      ))}
    </div>
  )

  // A per-field refusal (no grid, say) carries no image, centers or transform
  // at all - just the plain sentence app.py wrote for it. Show that instead of
  // reaching into any of the other fields the server left this entry.
  if (isFailedField(field)) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col p-7">
        {tabs}
        <div className="flex flex-1 items-center justify-center">
          <p className="max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
            {field.error}
          </p>
        </div>
      </div>
    )
  }

  // A selected pipeline stage replaces the photo outright: the editable dots
  // belong to the final image, not to an intermediate one.
  // Turning the step strip off returns to the result view even if a stage is
  // still selected, and a stale selection (the step vanished between runs)
  // falls back to it too. Reads the already-narrowed `field`, not a fresh
  // `fields[fieldIdx]` index (which would be Field again, not CountedField).
  const stage = showStages && selectedStage
    ? field.stages.find(s => s.name === selectedStage)
    : undefined
  const src = stage?.image ?? field.base_image

  // Fit first, then magnify it. The source is the full-resolution render the
  // server sent, so magnifying reveals real pixels instead of enlarging a
  // downscaled copy, and DotCanvas sizes its backing store from the same box.
  const fitW = box.w && box.h
    ? Math.min(box.w, box.h * (field.width / field.height))
    : 0
  const width = fitW ? fitW * zoom : undefined

  return (
    <div className="relative flex min-h-0 flex-1 flex-col p-7">
      {tabs}

      <div
        ref={attachStage}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        // The click that ends a drag is not an edit. Killed in the capture
        // phase, before the dot layer under the pointer ever sees it.
        onClickCapture={e => {
          if (!dragged.current) return
          dragged.current = false
          e.stopPropagation()
        }}
        className={cn(
          // The glide-pans branch of the wheel rule leans on this scrolling,
          // and `overscroll-contain` keeps it from leaking to the page once
          // the capture is fitted and there is nothing left to scroll.
          //
          // The bars themselves are hidden, and not only because a map has
          // none: `box` above is measured from clientWidth, so the moment a
          // bar appears it takes ~15 px out of the box, which shrinks the fit
          // width, which shrinks the photo - mid-zoom, and in the narrow band
          // where that can un-overflow the box, back and forth. Zooming off
          // "fit" was the jumpiest point in the range because of it. No gutter,
          // no feedback loop. Scrolling itself is untouched.
          "min-h-0 flex-1 overflow-auto overscroll-contain",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          dragging && "[&_*]:cursor-grabbing! cursor-grabbing",
        )}
      >
        {/* `safe center` keeps a magnified capture centred while it fits and
            pins it to the top-left once it does not: plain centring would push
            the overflow out of both ends and make the left edge unreachable. */}
        <div
          className="flex min-h-full min-w-full"
          style={{ justifyContent: "safe center", alignItems: "safe center" }}
        >
          <motion.div
            key={fieldKey}
            initial={{ opacity: 0, scale: 0.995 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            // Before the box is measured there is no fit to multiply, so the
            // capture falls back to the container rather than its natural size.
            style={{ width, maxWidth: width ? undefined : "100%" }}
            className={cn(
              "relative shrink-0",
              busy && "scanning",
              cropping && "cursor-crosshair",
            )}
          >
            {imgBroken.base ? (
              // An INSET ring, never a coloured border: Zen/WebRender seams a real
              // border at a rounded corner (measured 2026-09-19, see _constraints.md).
              <div className="flex min-h-[240px] items-center justify-center rounded-[var(--radius)]
                               border border-transparent inset-ring inset-ring-line bg-panel2 p-7 text-center text-[13px]
                               leading-relaxed text-destructive">
                This image is no longer on the server. Re-run the count to see it again.
              </div>
            ) : (
              <img
                ref={imgRef}
                src={src}
                alt="Sample"
                draggable={false}
                // Only the result image reports its size: a stage image is downscaled
                // to 1400px by the server, and letting it through would shrink the
                // bounds that decide which hand-added dots still count.
                onLoad={e => {
                  if (!stage) setImgSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])
                }}
                // base_image is a /api/image/<id> path, not an inlined data: URI, so it
                // can 404 if the id's bytes were evicted (_IMAGE_STORE, 128 MiB) under
                // memory pressure. Swap the broken-image icon for the same sentence
                // exporters.ts already uses for this exact failure.
                onError={() => setImgBroken(b => ({ ...b, base: true }))}
                className="block w-full rounded-[var(--radius)]
                           shadow-[0_12px_40px_-12px_var(--shadow)]"
              />
            )}

            {/* The server's opacity slider was removed 2026-09-21: a second
                full-size JPEG per field was being stored, fetched and faded
                for it. What marks the cells is the dot canvas, which is also
                what the user can click. */}
            {!stage && !imgBroken.base && imgSize && (
              <DotCanvas width={imgSize[0]} height={imgSize[1]} />
            )}

            {cropping && <CropTool imgRef={imgRef} onApply={setQuad} />}
          </motion.div>
        </div>
      </div>

      {!stage && !cropping && <DotHint />}

      {/* With a stage selected the dot canvas is unmounted, so a click on the
          photo does nothing at all - the app's primary action failing in
          silence (flow audit 2026-09-21, row 17). One line, in the same place
          the hint would be. */}
      {stage && !cropping && (
        <div className="pointer-events-none absolute inset-x-0 top-7 z-20 flex justify-center px-7">
          <div className="rounded-full border border-transparent inset-ring inset-ring-line
                          bg-panel/90 px-3 py-1 text-[13px] text-dim shadow-lg backdrop-blur-sm">
            This is a pipeline step. Pick Result to edit dots.
          </div>
        </div>
      )}

      <ZoomBar zoom={zoom} onZoom={onZoom} />
    </div>
  )
}
