import { useEffect, useRef } from "react"
import { useReducedMotion, useSpring } from "framer-motion"
import { cn } from "@/lib/utils"

/**
 * The total counts up to its new value instead of snapping, so a re-count reads
 * as the same number moving rather than a different number appearing. Driven by
 * a motion value written straight to the DOM: no re-render per frame.
 *
 * Shared by the sidebar and the collapsed-panel readout so both animate the
 * same number the same way.
 */
export function CountNumber({ total, busy, className }: {
  total: number
  busy: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const spring = useSpring(total, { stiffness: 140, damping: 26, mass: 0.6 })

  useEffect(() => {
    if (reduce) spring.jump(total)
    else spring.set(total)
  }, [total, reduce, spring])

  useEffect(() => spring.on("change", v => {
    if (ref.current) ref.current.textContent = String(Math.round(v))
  }), [spring])

  return (
    <>
      <div
        ref={ref}
        aria-hidden="true"
        className={cn(
          "font-sans text-[56px] font-bold leading-[1.05] tracking-[-0.03em] tabular-nums",
          "text-brand transition-opacity duration-200 ease-out",
          busy ? "opacity-35" : "opacity-100",
          className,
        )}
      >
        {total}
      </div>
      {/* The spring above writes textContent every animation frame, which used
          to sit behind aria-live="polite" and made a screen reader announce
          every intermediate value on the way to the settled count - as many as
          60 announcements for one recount. This span is a plain React child:
          it only changes, and is only announced, once `total` itself changes -
          i.e. once per completed count. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{total}</span>
    </>
  )
}
