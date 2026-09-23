import { Slider } from "@/components/ui/slider"
import { LEVELS, MAX_LEVEL, MIN_LEVEL, levelName } from "@/lib/levels"
import { cn } from "@/lib/utils"

/** The one detector control. Four discrete stops; the name beside it is the
 *  whole explanation, which is why no rung carries a description.
 *
 *  It writes to state on every move, not on release. The `onValueCommit` rule
 *  exists because a processing slider used to fire a count per value — this one
 *  fires none at all, so the handle and the label can track the pointer while
 *  the Reprocess button waits to be pressed.
 *
 *  Always laid out the same way — the word, the track, the rung's name — so the
 *  gallery bar and the workbench bar read as one control the user learned once.
 *  Whatever commits the level follows the name, against the control it commits.
 */
export function QualitySlider({ value, onChange, disabled, className }: {
  value: number
  onChange: (n: number) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex flex-none items-center gap-3", className)}>
      <span className="font-mono text-[10px] tracking-[0.14em] text-dim uppercase">Quality</span>

      <div className="relative flex w-[172px] min-w-[76px] shrink items-center">
        {/* The four stops, drawn behind the track so a discrete control does not
            read as a continuous one. Decoration only — the slider is the
            control, and these never take a pointer or the focus ring. */}
        {/* Inset by half the thumb (size-4, so 0.5rem): Radix keeps the thumb
            inside the root, so at either end its centre sits half a thumb in (less half a stop, since justify-between aligns stop EDGES)
            from the edge. Stops and track drawn edge to edge left the handle
            ~7px off the Quick and Finest stops (measured 2026-09-21). */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-[calc(0.5rem-3.5px)] flex items-center justify-between">
          {/* The groove itself. The Radix track is made transparent below so the
              stops sit ON the line rather than behind it. */}
          <span className="absolute inset-x-0 h-[3px] rounded-full bg-line" />
          {/* The fill is drawn IN the groove, first stop's centre to the current
              stop's centre, at the groove's own 3px. Radix's range was a 6px bar
              laid over the 3px groove and dots, and it ran into the handle, so
              the handle read as a disc welded onto a thick stub (2026-09-21).
              Same curve and duration as the handle (ui/slider.tsx). */}
          <span
            className="absolute left-0 h-[3px] rounded-full bg-primary transition-[width] duration-[190ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
            style={{ width: `calc(3.5px + (100% - 7px) * ${(value - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)})` }}
          />
          {LEVELS.map(l => (
            <span
              key={l.n}
              className={cn(
                "relative size-[7px] rounded-full transition-colors duration-150",
                l.n <= value ? "bg-primary" : "bg-line",
              )}
            />
          ))}
        </div>
        <Slider
          thumbLabel="Quality level"
          thumbValueText={levelName(value)}
          min={MIN_LEVEL}
          max={MAX_LEVEL}
          step={1}
          value={[value]}
          disabled={disabled}
          // Locked while a count runs, but never dimmed: a half-faded control
          // mid-run read as broken rather than busy (2026-09-21).
          onValueChange={v => onChange(v[0])}
          className="relative z-10 data-[disabled]:opacity-100 [&_[data-slot=slider-track]]:mx-2 [&_[data-slot=slider-track]]:bg-transparent [&_[data-slot=slider-range]]:bg-transparent"
        />
      </div>

      {/* Exactly six monospace characters wide — the length of the longest rung
          name, and every name is five or six. The box cannot change width, so
          the button beside it never moves under the pointer, and it is no wider
          than the word, so the button sits right against it. */}
      <span className="w-[6ch] flex-none font-mono text-xs text-brand">{levelName(value)}</span>
    </div>
  )
}
