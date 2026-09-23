import { CountNumber } from "@/components/CountNumber"
import { gridLinesOf } from "@/lib/geom"
import { useCounter } from "@/state/useCounter"
import { isFailedField } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The readout that stands in for the sidebar while the panel is collapsed. It
 * carries exactly what a user editing dots needs to watch: the number they will
 * report, and how far their own corrections have moved it from the engine's.
 */
export function CountBadge() {
  const { field, total, busy, edits } = useCounter()
  if (!field) return null

  // A per-field refusal (app.py: one bad capture in an otherwise-good batch)
  // carries only `names`/`error` - Field is a discriminated union (types.ts),
  // so `field.count`/`field.centers` etc. do not exist on this branch, and
  // gridLinesOf(field) itself returns {xs:[],ys:[]} for it (same guard as
  // dotsNow). Handled first, and separately from "grid not detected" below,
  // because the real reason may have nothing to do with the grid at all.
  if (isFailedField(field)) {
    return (
      <div
        data-testid="count-badge"
        className={cn(
          "absolute top-4 right-4 z-20 max-w-[240px] rounded-[var(--radius)]",
          // An INSET ring, never a coloured border: Zen/WebRender seams a real
          // border at a rounded corner (measured 2026-09-19, see _constraints.md).
          "border border-transparent inset-ring inset-ring-line bg-panel/90 px-2.5 py-1.5 backdrop-blur-md",
          "shadow-[0_18px_50px_-24px_var(--shadow)]",
        )}
      >
        <div className="text-[15px] font-semibold text-destructive">Not counted</div>
        <div className="mt-1 text-[13px] leading-snug text-dim">{field.error}</div>
      </div>
    )
  }

  const added = edits.added.length
  const removed = edits.removed.length

  // One sentence rather than three mono tokens ("auto 313 +0 -0"): the count
  // and the hand corrections read as English, and the corrections disappear
  // when there are none instead of showing two zeroes.
  const tally = [`${field.count} found`]
    .concat(added ? [`+${added} added`] : [], removed ? [`−${removed} removed`] : [])
    .join(", ")

  // No grid means the pipeline never found the ruled area, so the 0 it returns
  // is "not measured", not "no cells". Rendered as a confident green zero it
  // said the opposite of what happened - the one failure the app has that a
  // user can actually fix, and it read as a result.
  const { xs, ys } = gridLinesOf(field)
  const measured = xs.length > 1 && ys.length > 1

  return (
    <div
      data-testid="count-badge"
      // Top right, opposite the panel-reopen button and clear of the zoom row
      // docked under the picture: the bottom-right corner used to hold both
      // this and the zoom pill, and whichever drew last hid the other.
      className={cn(
        "absolute top-4 right-4 z-20 max-w-[240px] rounded-[var(--radius)]",
        // An INSET ring, never a coloured border: Zen/WebRender seams a real
        // border at a rounded corner (measured 2026-09-19, see _constraints.md).
        "border border-transparent inset-ring inset-ring-line bg-panel/90 px-2.5 py-1.5 backdrop-blur-md",
        "shadow-[0_18px_50px_-24px_var(--shadow)]",
      )}
    >
      {measured ? (
        <>
          <CountNumber total={total} busy={busy} className="text-[26px] leading-none" />
          <div className="mt-1 text-[13px] leading-none text-dim">cells counted</div>
          <div className="mt-1.5 border-t border-line pt-1.5 text-[13px] leading-snug text-dim tabular-nums">
            {tally}
          </div>
        </>
      ) : (
        <>
          <div className="text-[15px] font-semibold text-destructive">Grid not detected</div>
          <div className="mt-1 text-[13px] leading-snug text-dim">
            Crop tighter to the ruled area, then count again.
          </div>
        </>
      )}
    </div>
  )
}
