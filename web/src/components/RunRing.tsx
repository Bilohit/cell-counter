import { cn } from "@/lib/utils"

const R = 13
const C = 2 * Math.PI * R

/**
 * What the Reprocess button becomes while the run it started is running.
 *
 * It takes the button's own place and its own size, so nothing moves and no
 * second control appears beside it: the ring IS the progress, and the ring is
 * also the stop. Pointing at it swaps the percentage for a red cross, because a
 * stop that is always visible invites the accident, and a stop that is nowhere
 * leaves a long run with no way out.
 *
 * `value` absent means "one image, no way to say how far in" — the ring spins a
 * short arc instead of filling. `onStop` absent means the run cannot be stopped
 * — a single count runs to its end — and then this is a plain indicator with no
 * cross to point at, because a stop that does nothing is worse than none.
 */
export function RunRing({ value, onStop, label = "Stop the run", className }: {
  /** 0..1, or undefined for an indeterminate run. */
  value?: number
  onStop?: () => void
  label?: string
  className?: string
}) {
  const pct = value === undefined ? null : Math.max(0, Math.min(1, value))
  const Tag = onStop ? "button" : "span"
  return (
    <Tag
      {...(onStop
        ? { type: "button" as const, onClick: onStop, "aria-label": label, title: label }
        : { role: "status" as const, "aria-label": label, title: label })}
      className={cn(
        "group relative flex size-8 flex-none items-center justify-center rounded-full",
        onStop && "cursor-pointer focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
      {...(pct !== null
        ? { role: "progressbar", "aria-valuenow": Math.round(pct * 100),
            "aria-valuemin": 0, "aria-valuemax": 100 }
        : {})}
    >
      <svg
        viewBox="0 0 32 32" aria-hidden="true"
        className={cn(
          "absolute size-8 -rotate-90",
          pct === null && "motion-safe:animate-spin",
        )}
      >
        <circle cx="16" cy="16" r={R} fill="none" strokeWidth="2.5" className="stroke-line" />
        <circle
          cx="16" cy="16" r={R} fill="none" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - (pct ?? 0.22))}
          className={cn(
            "stroke-brand transition-[stroke-dashoffset,stroke] duration-300 ease-out motion-reduce:transition-none",
            onStop && "group-hover:stroke-destructive group-focus-visible:stroke-destructive",
          )}
        />
      </svg>

      {pct !== null && (
        <span
          aria-hidden="true"
          className={cn(
            "font-mono text-[10px] tabular-nums text-dim transition-opacity duration-150",
            onStop && "group-hover:opacity-0 group-focus-visible:opacity-0",
          )}
        >
          {Math.round(pct * 100)}
        </span>
      )}

      {onStop && (
        <svg
          viewBox="0 0 24 24" aria-hidden="true" strokeWidth="2" strokeLinecap="round"
          className="absolute size-3.5 fill-none stroke-destructive opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      )}
    </Tag>
  )
}
