import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/** How long the one-time announcement stays up if nothing dismisses it. Long
 *  enough to read two short lines without being a thing to wait out. */
const FLYOUT_MS = 6000

/** The staging screen's one extra control: confine the overlap sweep to
 *  captures whose filenames share a prefix.
 *
 *  The label never changes - it carried a live "9 groups / all captures
 *  compared" sub-line, and a control that resizes on its own state drags
 *  whatever sits beside it out from under the pointer. The group count lives in
 *  the header line instead, where nothing sits to its right.
 */
export function NameGroupSwitch({ on, onChange, pattern, speedup }: {
  on: boolean
  onChange: (on: boolean) => void
  /** Whether the staged names formed a pattern. The flyout fires once per
   *  batch that finds one, and never for a batch that does not. */
  pattern: boolean
  /** Full comparisons over grouped ones, for the one number the flyout shows. */
  speedup: number
}) {
  const reduce = useReducedMotion()
  const [flyout, setFlyout] = useState(false)
  // One announcement per pattern, not one per render: `armed` latches so that
  // adding a capture to an already-grouped batch does not re-announce it.
  const armed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!pattern) { armed.current = false; return }
    if (armed.current) return
    armed.current = true
    // oxlint-disable-next-line react/set-state-in-effect
    setFlyout(true)
    timer.current = setTimeout(() => setFlyout(false), FLYOUT_MS)
    return () => clearTimeout(timer.current)
  }, [pattern])

  const dismiss = () => { clearTimeout(timer.current); setFlyout(false) }

  // Any click that is not on the flyout or the switch puts it away - the same
  // thing every other transient surface in the app does.
  useEffect(() => {
    if (!flyout) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest("[data-namegroup]")) dismiss()
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [flyout])

  return (
    <div data-namegroup className="relative flex items-center">
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2.5 rounded-full border border-transparent inset-ring py-1.5 pr-3 pl-2.5",
          "transition-[background-color,box-shadow] duration-200 ease-out",
          on
            ? "inset-ring-brand/45 bg-brand/[.08]"
            : "inset-ring-line hover:bg-panel-hover",
        )}
      >
        <Switch checked={on} onCheckedChange={onChange} aria-label="Name groups" />
        <span className="text-[13px] font-medium whitespace-nowrap">Name groups</span>
      </label>

      <AnimatePresence>
        {flyout && (
          <motion.div
            role="status"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            // `max-content`, so the box hugs two single lines instead of
            // padding a fixed width out with empty space. Centred on the
            // switch, not pinned to its right edge: the box is wider than the
            // control, so `right-0` hung the whole thing off to one side and it
            // read as belonging to whatever sat left of the switch. The cap
            // bounds the overhang - it is above the natural width, so it only
            // bites if a longer number or a wider font would push the box past
            // the header's padding, and then it wraps instead of growing.
            className={cn(
              "absolute top-[calc(100%+9px)] left-1/2 z-30 -translate-x-1/2",
              "w-max max-w-[min(17rem,calc(100vw-3rem))] rounded-[10px]",
              "border border-transparent inset-ring inset-ring-line bg-panel px-[11px] py-2 text-[12.5px] leading-[1.35]",
              "shadow-[0_12px_30px_-14px_var(--shadow)]",
            )}
          >
            <b className="block font-semibold">File naming pattern found</b>
            <span className="text-[11.5px] tabular-nums text-dim">
              Overlap scan{" "}
              <span className="text-brand">
                about {speedup.toFixed(1).replace(/\.0$/, "")}&times; faster
              </span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
