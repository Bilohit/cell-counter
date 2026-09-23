import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { ChevronDown, Undo2, X } from "lucide-react"
import { bandsOf } from "@/lib/bands"
import {
  concentrationOf, countedDefaults, dockOpens, formatSci, isFullSquare,
  parseCount, parseDilution, partialReason, readDock, subscribeDock, writeDock,
} from "@/lib/concentration"
import type { DockState } from "@/lib/concentration"
import { groupColor } from "@/lib/nameGroups"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useCounterByField } from "@/state/useCounter"
import { useGallery } from "@/state/useGallery"

type SlotKey = "cells" | "squares" | "dilution"

const CAPTION: Record<SlotKey, string> = {
  cells: "cells counted",
  squares: "full squares",
  dilution: "dilution",
}

/** One editable position in the formula. The caption is absolutely placed so
 *  revealing it costs no layout: the boxes stay tucked against the rule and the
 *  fraction keeps reading as a fraction. */
function Slot({ id, value, onChange, edited, caption, place, width, coached }: {
  id: SlotKey
  /** The raw string, not a number: parsing on every keystroke would collapse
   *  "1." back to "1" and make "1.5" unreachable. Parsed on use instead. */
  value: string
  onChange: (v: string) => void
  edited: boolean
  caption: string
  place: "above" | "below"
  width: string
  coached: boolean
}) {
  return (
    <span className="group relative flex justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap",
          // Decelerating ease over a linear one, and long enough to read as a
          // movement rather than a flicker: the caption travels 4px, and at
          // 200ms/ease-out that reads as a jump. Opacity and transform are the
          // only two properties, so this stays on the compositor.
          // No `will-change`: it promotes this caption to its own compositor
          // layer FOR EVER, not just while it moves, and a promoted layer with
          // text is re-rasterised at the layer's resolution - which is where
          // stray hairlines at fractional zoom come from. The travel is 3px;
          // there is nothing here for a layer to save.
          "font-mono text-[13px]",
          "transition-[opacity,transform] duration-[280ms] ease-[cubic-bezier(.16,1,.3,1)]",
          "motion-reduce:transition-none",
          place === "above" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
          coached
            ? "text-amber opacity-100 translate-y-0"
            : cn(
                "text-dim opacity-0",
                place === "above" ? "translate-y-[3px]" : "-translate-y-[3px]",
                "group-hover:translate-y-0 group-hover:opacity-100",
                "group-focus-within:translate-y-0 group-focus-within:opacity-100",
              ),
        )}
      >
        {caption}
      </span>
      <input
        id={`conc-${id}`}
        aria-label={caption}
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={cn(
          width,
          "rounded-md border border-transparent inset-ring inset-ring-border px-1.5 py-1 text-center font-mono text-[15px] tabular-nums",
          "transition-[background-color,box-shadow,transform] duration-200 ease-out",
          "focus-visible:outline-none focus-visible:inset-ring focus-visible:inset-ring-brand focus-visible:-translate-y-px",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "motion-reduce:transition-none motion-reduce:focus-visible:translate-y-0",
          coached && "inset-ring-amber ring-[3px] ring-amber/30",
          edited
            ? "border-dashed border-amber inset-ring-0 bg-amber/10 text-foreground" // hairline-ok: a dashed border cannot be drawn as an inset ring; the dash is the "hand-edited" signal
            : "inset-ring-brand/40 bg-brand/[.08] text-foreground hover:inset-ring-brand/70",
        )}
      />
    </span>
  )
}

export function ConcentrationDock() {
  const { items } = useGallery()
  const { byField } = useCounterByField()
  const reduce = useReducedMotion()

  const [open, setOpen] = useState(false)
  // Which partials, and why, is a follow-up question - collapsed until asked.
  const [details, setDetails] = useState(false)
  // Typed entries are raw strings, and they live in sessionStorage: the dock is
  // unmounted on every trip to the workbench, and a dilution the user typed
  // once must not have to be typed again on the way back.
  const [typed, setTyped] = useState<DockState>(() => readDock())
  // A restored session writes the dock from underneath us; re-read on every
  // write rather than only at mount, or a saved dilution would never appear.
  // The same bus a restored session writes on. A band sent from a header lands
  // here as a write plus a bumped counter - a plain "open" flag could not tell a
  // second send from the first, and the panel would stay shut.
  const seen = useRef(dockOpens())
  useEffect(() => subscribeDock(() => {
    setTyped(readDock())
    if (dockOpens() !== seen.current) { seen.current = dockOpens(); setOpen(true) }
  }), [])
  const edit = useCallback((patch: DockState) => {
    setTyped(t => { const next = { ...t, ...patch }; writeDock(next); return next })
  }, [])

  // Partial captures are out by default: their cells and their share of the
  // divisor are both guesses off the rows in frame. The box lets a user who
  // scanned mostly partials count them anyway.
  const partial = typed.partial === "1"

  // Two bands are two samples. Adding both into one fraction reports a cells/mL
  // that describes neither - and it looks exactly like a right answer, which is
  // why the panel refuses to guess and waits to be handed one. One band, or a
  // session that was never grouped, has nothing to be wrong about, so it still
  // fills itself in.
  const bands = useMemo(() => bandsOf(items), [items])
  const many = bands.length > 1
  // A band that was renamed or broken up while the panel held it is gone, and
  // showing its old number for captures that have moved is the one thing this
  // is here to prevent.
  const band = many && typed.group !== undefined
    && bands.some(b => b.key === typed.group) ? typed.group : undefined
  const scope = many ? band : undefined
  const blind = many && band === undefined

  const counted = useMemo(
    () => countedDefaults(items, byField, partial, scope),
    [items, byField, partial, scope])
  // Blank, not zero: an empty numerator is a question, and 0 is an answer.
  const cellsText = typed.cells ?? (blind ? "" : String(counted.cells))
  const squaresText = typed.squares ?? (blind ? "" : String(counted.squares))
  const dilutionText = typed.dilution ?? "1"
  const edited = typed.cells !== undefined || typed.squares !== undefined
    || typed.dilution !== undefined

  const value = concentrationOf(
    parseCount(cellsText), parseCount(squaresText), parseDilution(dilutionText))

  // The walkthrough: each slot lights for 700 ms in reading order, once per
  // open. It teaches which value goes where without a permanent label, and it
  // never runs for a reader who asked for less motion.
  const [coached, setCoached] = useState<SlotKey | null>(null)
  useEffect(() => {
    if (!open || reduce) return
    const order: SlotKey[] = ["cells", "squares", "dilution"]
    const timers = order.flatMap((k, i) => [
      setTimeout(() => setCoached(k), 420 + i * 760),
      setTimeout(() => setCoached(c => (c === k ? null : c)), 420 + i * 760 + 700),
    ])
    return () => timers.forEach(clearTimeout)
  }, [open, reduce])

  // The result is the panel's one output, so an edit has to visibly land on it.
  const [shown, setShown] = useState(value)
  const frame = useRef(0)
  useEffect(() => {
    if (reduce) { setShown(value); return }
    const from = shown, t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 340)
      setShown(from + (value - from) * (1 - Math.pow(1 - k, 3)))
      if (k < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
    // `shown` is deliberately not a dependency: it is the animation's start
    // point, and reading it here would restart the roll on every frame.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce])

  const sci = formatSci(shown)
  // The checkbox is not a typed value, so Reset leaves it where the user put it.
  const reset = useCallback(() => {
    setTyped(t => {
      // The band is not a typed value either: Reset puts the numbers back to
      // what was counted FOR THIS BAND, not back to the whole session.
      const next = { partial: t.partial, group: t.group }
      writeDock(next); return next
    })
  }, [])

  const mine = scope === undefined ? items : items.filter(i => (i.group ?? "") === scope)
  const partials = mine.filter(i => i.field && !isFullSquare(i.field))
  const nPart = partials.length

  // Escape closes it, the way every other transient panel in the app does.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    // A button that lives in the bar, with its calculator hung above it. The
    // panel used to be a floating pill pinned to the viewport corner, where it
    // covered the gallery's Reprocess button at every width.
    <div className="flex min-h-[46px] flex-none items-center border-t border-line bg-panel px-4 py-2">
      {/* Same metrics as BAR (lib/styles.ts), because the two sit side by side:
          py-2.5 made this the taller of the pair, and the bar beside it stopped
          short, leaving a strip of page background at the window's bottom. */}
      <span className="relative">
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="dock"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 10 }}
            transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
            style={{ transformOrigin: "100% 100%" }}
            // Anchored to the button below it, never to the viewport corner: a
            // free-floating pill sat on top of Reprocess at every width.
            // No `overflow-hidden`: nothing here needs clipping, and a rounded
            // box that clips a SCALED child leaves the parent's border drawn at
            // the untransformed radius - two stray square corners along the top
            // edge, which is exactly what this panel was showing.
            className={cn(
              "absolute right-0 bottom-[calc(100%+8px)] z-30 w-[306px] rounded-xl",
              "border border-transparent inset-ring inset-ring-line bg-panel shadow-[0_20px_48px_-20px_var(--shadow)]",
            )}
          >
            {/* One title bar, never two. With a band in hand the band IS the
                title - a panel headed "Concentration" over a line naming the
                band says the same thing twice, and the thing worth saying is
                which captures this number is about. */}
            <div
              // `rounded-t-[11px]` — the panel's 12px radius less its own 1px
              // border — is what makes the band's rail belong to the panel: a
              // square 3px border on a rounded box overshoots the corner and
              // leaves a coloured spur sticking past the panel's edge.
              className="flex items-center gap-2 rounded-t-[11px] border-b border-line py-2 pr-1 pl-3"
              // The rail is an inset shadow, not `border-left`: a real border on
              // a rounded box seams at the corner in Zen/WebRender (2026-09-19;
              // this one was missed until 2026-09-21).
              style={band === undefined ? undefined
                : { boxShadow: `inset 3px 0 0 ${groupColor(bands.findIndex(b => b.key === band))}` }}
            >
              {band !== undefined && (
                <span
                  aria-hidden="true"
                  className="size-[7px] flex-none rounded-full"
                  style={{ background: groupColor(bands.findIndex(b => b.key === band)) }}
                />
              )}
              <b
                data-testid="dock-title"
                className="min-w-0 truncate text-[15px] font-semibold text-foreground"
              >
                {band === undefined ? "Concentration"
                  : bands.find(b => b.key === band)?.name}
              </b>
              <span className="flex-1" />
              {band !== undefined && (
                <Button
                  type="button" size="icon-sm" variant="ghost"
                  aria-label="Back to the whole session" title="Back to the whole session"
                  onClick={() => edit({ group: undefined, cells: undefined, squares: undefined })}
                >
                  <Undo2 />
                </Button>
              )}
              <Button
                type="button" size="icon-sm" variant="ghost"
                aria-label="Close the calculator" title="Close the calculator"
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </div>

            <div className="flex flex-col gap-2.5 px-3 pb-3 pt-1.5">
              {/* Asymmetric on purpose: the room above is for the numerator's
                  hover caption, and there is no caption below the last row. */}
              <div className="flex items-center justify-center gap-2.5 pt-6 pb-4">
                <span className="flex flex-col items-stretch gap-1">
                  <Slot
                    id="cells" value={cellsText} edited={typed.cells !== undefined}
                    caption={CAPTION.cells} place="above" width="w-[7ch]"
                    coached={coached === "cells"}
                    onChange={v => edit({ cells: v })}
                  />
                  <motion.span
                    aria-hidden="true"
                    initial={reduce ? false : { scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.42, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
                    className="h-0.5 origin-left rounded-full bg-dim"
                  />
                  <Slot
                    id="squares" value={squaresText} edited={typed.squares !== undefined}
                    // Same width as the numerator. A narrower denominator made
                    // the fraction read as two unrelated boxes stacked on a
                    // rule rather than one divided by the other.
                    caption={CAPTION.squares} place="below" width="w-[7ch]"
                    coached={coached === "squares"}
                    onChange={v => edit({ squares: v })}
                  />
                </span>
                <span className="font-mono text-base text-dim">&times;</span>
                <Slot
                  id="dilution" value={dilutionText} edited={typed.dilution !== undefined}
                  caption={CAPTION.dilution} place="below" width="w-[5ch]"
                  coached={coached === "dilution"}
                  onChange={v => edit({ dilution: v })}
                />
                <span className="font-mono text-base text-dim">&times;</span>
                <span className="font-mono text-base text-foreground">
                  10<sup>4</sup>
                </span>
              </div>

              <motion.div
                key={sci ? sci.mantissa + sci.exponent : "none"}
                initial={reduce ? false : { scale: 1 }}
                animate={reduce ? {} : { scale: [1, 1.06, 1] }}
                transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-baseline justify-center gap-2"
              >
                <span className="font-mono text-base text-dim">=</span>
                <span className={cn(
                  "font-mono text-2xl font-semibold tabular-nums",
                  sci ? "text-brand" : "text-dim",
                )}>
                  {sci ? <>{sci.mantissa} &times; 10<sup>{sci.exponent}</sup></> : "—"}
                </span>
                <span className="text-[13px] text-dim">cells / mL</span>
              </motion.div>

              {edited && (
                <Button
                  type="button" size="sm" variant="outline"
                  className="self-start" onClick={reset}
                >
                  Reset to counted values
                </Button>
              )}

              <label className="flex cursor-pointer items-center gap-2 border-t border-line pt-2.5 text-[13px] text-dim">
                <Checkbox
                  checked={partial}
                  onCheckedChange={v => edit({ partial: v === true ? "1" : undefined })}
                />
                Count partial captures
              </label>

              {/* Only the partials. The full-square count sat here too and was
                  the divisor spelled out twice: the "full squares" field above
                  IS that number (countedDefaults sums the same captures), so it
                  restated the input the reader had just looked at. Nothing
                  partial in the band means nothing to say here at all. */}
              {nPart > 0 && (
                <div className="flex items-center gap-2">
                  <p className="flex-1 truncate font-mono text-[13px] whitespace-nowrap tabular-nums text-dim">
                    {nPart} partial capture{nPart === 1 ? "" : "s"}
                  </p>
                  <Button
                    type="button" size="icon-sm" variant="ghost"
                    className="-mr-1 size-6 flex-none text-dim hover:text-foreground"
                    aria-expanded={details}
                    aria-label={details ? "Hide which captures are partial"
                      : "Show which captures are partial"}
                    title="Which captures are partial"
                    onClick={() => setDetails(d => !d)}
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 transition-transform duration-[280ms]",
                        "ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none",
                        details && "rotate-180",
                      )}
                    />
                  </Button>
                </div>
              )}

              <AnimatePresence initial={false}>
                {nPart > 0 && details && (
                  <motion.ul
                    key="why"
                    // Height, not display: the panel is anchored to its bottom
                    // edge, so an instant show would jump the whole calculator.
                    initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                    exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    className="flex flex-col gap-1 overflow-hidden text-[13px] text-dim"
                  >
                    {partials.map(i => (
                      <li key={i.id} className="leading-snug">
                        <span className="text-foreground">{i.name}</span>: {partialReason(i.field)}
                      </li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Button
        type="button" size="sm" variant="outline"
        aria-expanded={open}
        aria-label="Open the concentration calculator"
        title="Open the concentration calculator"
        onClick={() => setOpen(o => !o)}
      >
        <span className="font-mono italic text-brand">fx</span> Concentration
      </Button>
      </span>
    </div>
  )
}
