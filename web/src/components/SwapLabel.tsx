import { cn } from "@/lib/utils"

/** A label that swaps text without resizing its button.
 *
 *  Every option is rendered into the SAME grid cell, so the box is always as
 *  wide as the longest one and the button never resizes when only its wording
 *  changes - a control that grows under the pointer moves whatever sits beside
 *  it, and "Select all" / "Select none" differ by a character.
 *
 *  The inactive options stay in the tree, hidden from assistive tech and from
 *  the pointer, which is also what lets the visible one cross-fade rather than
 *  cut.
 */
export function SwapLabel({ options, value, className }: {
  options: readonly string[]
  /** Which option to show. Must be one of `options`. */
  value: string
  className?: string
}) {
  return (
    <span className={cn("grid", className)}>
      {options.map(o => (
        <span
          key={o}
          aria-hidden={o === value ? undefined : "true"}
          className={cn(
            "col-start-1 row-start-1 text-center whitespace-nowrap",
            "transition-opacity duration-200 ease-out motion-reduce:transition-none",
            o === value ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {o}
        </span>
      ))}
    </span>
  )
}
