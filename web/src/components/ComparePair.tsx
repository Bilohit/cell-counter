import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Slider } from "@/components/ui/slider"
import { fitScale, placePair } from "@/lib/overlap"
import { cn } from "@/lib/utils"
import type { GalleryItem } from "@/lib/types"
import type { OverlapCandidate } from "@/state/useGallery"

/** pipeline.ROTATION_DEG_MIN. stitch_pair REPORTS the tilt it measured but only
 *  CORRECTS one at or above this, so a preview that rotated by every reported
 *  angle would show a picture the merge does not produce — the same failure in
 *  the other direction. */
const ROTATION_DEG_MIN = 0.15

/** The rotation the merge will actually apply to the lower capture, as a CSS
 *  angle. pipeline warps with getRotationMatrix2D((w/2, h/2), -angle): about
 *  the image centre — which is the CSS default transform-origin — and OpenCV's
 *  negative angle is a clockwise turn, which is CSS's positive one. */
// Exported for its unit test only — the sign and the gate are the whole point
// of it, and a wrong sign is invisible on screen at 0.2 deg.
// oxlint-disable-next-line react/only-export-components
export function appliedRotation(deg: number | undefined): number {
  return deg && Math.abs(deg) >= ROTATION_DEG_MIN ? deg : 0
}

/** Read defensively: `PairCandidate` (lib/types) carries `rotation_deg`, but
 *  the candidate the gallery hands down is its own narrower record, and both a
 *  server and a saved session predating tilt correction simply omit it. */
const rotationOf = (c: OverlapCandidate): number | undefined =>
  (c as { rotation_deg?: number }).rotation_deg

/** Measure the box a fitted image may occupy. The cross-fade needs real pixels:
 *  aspect-ratio alone cannot letterbox against both a max width and a max
 *  height without distorting one of them. */
function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    read()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, box] as const
}

/** The raw capture, when the browser can decode it.
 *
 *  EVOS captures are TIF and no browser will render one, so the fallback is the
 *  item's own counted `base_image`. That substitution is only geometrically
 *  honest because the gallery counts with autocrop "" (see useGallery.confirm):
 *  with no crop, base_image pixels ARE the original capture's pixels, so the
 *  pair's dx/dy still line the two images up. If batch counting ever gains a
 *  crop, this fallback has to transform dx/dy by the field's `transform`. */
function useCaptureSrc(item: GalleryItem | undefined, fallback?: string) {
  const file = item?.files[0]
  const decodable = !!file && !/\.tiff?$/i.test(file.name)
  // Created and revoked inside one effect, so the URL's lifetime matches the
  // subscription that owns it. Minting it in a useState initializer instead
  // would leave StrictMode's simulated unmount revoking the only URL there
  // will ever be, and every PNG/JPG capture would fall back to base_image in
  // dev while looking correct in production.
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!file || !decodable) return
    const u = URL.createObjectURL(file)
    // An object URL is exactly the external resource this rule carves out: it
    // cannot be derived during render because it has to be revoked again.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(u)
    setBroken(false)
    return () => { setUrl(null); URL.revokeObjectURL(u) }
  }, [file, decodable])

  const raw = broken ? null : url
  // `fallback` is the raw-capture JPG /api/pairs returns. The overlap review
  // runs before any counting, so base_image usually does not exist yet.
  return {
    src: raw ?? fallback ?? item?.field?.base_image ?? null,
    onError: () => setBroken(true),
  }
}

interface Layer {
  item: GalleryItem | undefined
  src: string | null
  onError: () => void
  size: [number, number] | null
  onLoad: (w: number, h: number) => void
}

/** Two captures in one frame, A under B, B offset by the measured stage shift.
 *  Positions are percentages of the union box, so the same numbers hold at
 *  every fitted size. */
function CrossFade({ a, b, dx, dy, swapped, rotation, t, className }: {
  a: Layer; b: Layer; dx: number; dy: number; swapped: boolean
  /** Degrees the merge rotates the LOWER capture by, already gated through
   *  `appliedRotation`. dx/dy are measured AFTER that rotation, so rotating
   *  about the layer's own centre and then placing it at dx/dy is exactly the
   *  order stitch_pair uses. */
  rotation: number
  t: number
  className?: string
}) {
  const [ref, box] = useBox<HTMLDivElement>()

  // The arithmetic — including which capture is the upper one — lives in
  // lib/overlap.ts, where it is unit-tested for swapped and negative-dx pairs.
  const { ax, ay, aw, ah, bx, by, bw, bh, x0, y0, uw, uh } =
    placePair(dx, dy, swapped, a.size, b.size)
  const fit = fitScale(uw, uh, box.w, box.h)
  const pct = (v: number, whole: number) => `${(v / whole) * 100}%`

  const layer = (
    l: Layer, x: number, y: number, w: number, h: number, opacity: number, deg = 0,
  ) => (
    <img
      src={l.src ?? undefined}
      alt={l.item?.name ?? ""}
      draggable={false}
      onLoad={e => l.onLoad(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
      onError={l.onError}
      style={{
        left: pct(x - x0, uw), top: pct(y - y0, uh),
        width: pct(w, uw), height: pct(h, uh), opacity,
        ...(deg ? { transform: `rotate(${deg}deg)` } : {}),
      }}
      className="absolute select-none"
    />
  )

  return (
    // A measured box needs a height of its own: inside a dialog a flex-1 child
    // can resolve to zero and the fit would never be computed.
    <div ref={ref} className={cn("relative w-full flex-none", className)}>
      {/* Sized off-screen until measured, so a first paint never flashes full-bleed. */}
      <div
        style={fit ? { width: uw * fit, height: uh * fit } : { width: 0, height: 0 }}
        className={cn(
          "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden",
          // An INSET ring, never a coloured border: Zen/WebRender seams a real
          // border at a rounded corner (measured 2026-09-19, see _constraints.md).
          "rounded-[var(--radius)] border border-transparent inset-ring inset-ring-line bg-panel2",
          "shadow-[0_18px_50px_-20px_var(--shadow)]",
        )}
      >
        {a.src && layer(a, ax, ay, aw, ah, 1 - t, swapped ? rotation : 0)}
        {b.src && layer(b, bx, by, bw, bh, t, swapped ? 0 : rotation)}
      </div>
    </div>
  )
}

/** The comparison itself: two captures in one frame and the fade between them.
 *  Owns nothing but the fade — what to DO about the pair is asked beside it, by
 *  whoever opened this. */
export function ComparePair({ c, a, b, className }: {
  c: OverlapCandidate
  a: GalleryItem
  b: GalleryItem
  className?: string
}) {
  const [t, setT] = useState(50)
  const [aSize, setASize] = useState<[number, number] | null>(null)
  const [bSize, setBSize] = useState<[number, number] | null>(null)
  const aSrc = useCaptureSrc(a, c.aImage)
  const bSrc = useCaptureSrc(b, c.bImage)

  const onLoadA = useCallback((w: number, h: number) => setASize([w, h]), [])
  const onLoadB = useCallback((w: number, h: number) => setBSize([w, h]), [])

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <CrossFade
        a={{ item: a, ...aSrc, size: aSize, onLoad: onLoadA }}
        b={{ item: b, ...bSrc, size: bSize, onLoad: onLoadB }}
        dx={c.dx} dy={c.dy} swapped={!!c.swapped}
        rotation={appliedRotation(rotationOf(c))} t={t / 100}
        className="h-[clamp(260px,64vh,660px)]"
      />

      <div className="flex flex-none items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-right text-[13px] text-dim" title={a.name}>
          {a.name}
        </span>
        <Slider
          value={[t]} min={0} max={100} step={1}
          onValueChange={([v]) => setT(v)}
          aria-label={`Cross-fade between ${a.name} and ${b.name}`}
          thumbLabel={`Cross-fade between ${a.name} and ${b.name}`}
          className="w-[min(22rem,40%)] flex-none"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-dim" title={b.name}>
          {b.name}
        </span>
      </div>
    </div>
  )
}
