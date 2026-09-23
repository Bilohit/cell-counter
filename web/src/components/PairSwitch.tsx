import { cn } from "@/lib/utils"

/** What a pair is primed to do when the run starts. `mixed` is never a pair's
 *  own state — only the board-wide switch reads it, when the pairs disagree. */
export type PairChoice = "merge" | "split"

/** The one control this screen has, at two scales.
 *
 *  `card` sits under a thumbnail and primes that pair. `bar` sits in the header
 *  and primes every pair at once. Same track, same knob, same wording, so the
 *  global control is the per-pair control the user already understands rather
 *  than a second idea — and the header one states its height (`h-8`) instead of
 *  inheriting it from its labels, so it is exactly the `size="sm"` box every
 *  button beside it is.
 */
export function PairSwitch({ value, onChange, labels, size = "card", label, className }: {
  /** `mixed` fades the knob out: the switch is reporting that the pairs
   *  disagree, so it claims neither end rather than rounding to one. */
  value: PairChoice | "mixed"
  onChange: (v: PairChoice) => void
  /** [merge, split]. The board-wide switch says "all" so it cannot be misread
   *  as acting on one pair. */
  labels: [string, string]
  size?: "card" | "bar"
  /** Names what this switch primes, for assistive tech. */
  label: string
  className?: string
}) {
  const bar = size === "bar"
  const option = (v: PairChoice, text: string) => (
    <button
      key={v}
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={cn(
        "relative z-1 cursor-pointer rounded-md bg-transparent text-[13px] font-medium",
        "whitespace-nowrap text-dim transition-colors duration-150 ease-out",
        // No hover state of its own. Lighting the hovered half's label made the
        // two halves read as two buttons; the track answers the pointer instead,
        // as one control. Colour here is state, not pointer feedback.
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "focus-visible:outline-none motion-reduce:transition-none",
        bar ? "h-full px-3" : "h-7",
        value === v && (v === "merge" ? "text-on-brand" : "text-foreground"),
      )}
    >
      {text}
    </button>
  )

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "relative grid grid-cols-2 gap-[3px] rounded-[9px] border border-transparent inset-ring inset-ring-line bg-panel",
        // The whole switch is the thing under the pointer, so the whole switch
        // is what lifts: brighter edge plus the app's shadow, scaled to a 32px
        // control rather than a card.
        "transition-[box-shadow] duration-[220ms]",
        "ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none",
        "hover:inset-ring-line-hi hover:shadow-[0_10px_22px_-16px_var(--shadow)]",
        bar ? "h-8 items-stretch p-[2px]" : "p-[3px]",
        className,
      )}
    >
      {/* The knob is one element that slides, not two backgrounds that swap:
          the movement is what says the two options are one choice. Its width
          and offset have to land exactly on the far padding, or it sits a pixel
          short of the track at one end. */}
      <span
        aria-hidden="true"
        className={cn(
          // `bg-accent` is the app's selected-surface token. `bg-panel-hover`,
          // which this had, is a dead class: --panel-hover exists as a raw CSS
          // variable but is never mapped into @theme, so Tailwind emits no rule
          // for it at all and the knob painted nothing.
          "absolute z-0 rounded-md bg-accent",
          // `translate` as well as `transform`: Tailwind v4 emits translate-x as its
          // own `translate` property, which a transform-only transition would
          // snap through instead of sliding.
          "transition-[transform,translate,background-color,opacity] duration-[220ms]",
          "ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none",
          bar
            ? "top-[2px] bottom-[2px] left-[2px] w-[calc(50%-3.5px)]"
            : "top-[3px] bottom-[3px] left-[3px] w-[calc(50%-4.5px)]",
          value === "merge" && "translate-x-0 bg-primary",
          // The fill alone cannot carry this end. --accent-bg is panel2 stepped
          // 12 % toward the text, which against the --panel track measures
          // 1.06:1 (sage) to 1.32:1 (teal) - below the 3:1 WCAG floor for a UI
          // component on all ten themes, so beside a solid brand chip it reads
          // as no highlight at all. Measured over every theme in index.css, the
          // edge colours available give: --line-hi 2.02-2.52, --dim mixed 70 %
          // into the fill 2.69-3.82, --dim at full strength 4.60-7.74. --dim is
          // the only one that clears 3:1 everywhere. Inset, never a border: a
          // border would sit outside the knob's measured box and break the gap
          // arithmetic above.
          value === "split"
            && "translate-x-[calc(100%+3px)] shadow-[inset_0_0_0_1px_var(--dim)]",
          value === "mixed" && "opacity-0",
        )}
      />
      {option("merge", labels[0])}
      {option("split", labels[1])}
    </div>
  )
}
