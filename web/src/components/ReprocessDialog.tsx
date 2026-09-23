import { useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { humanSecs, levelName } from "@/lib/levels"
import { cn } from "@/lib/utils"

export interface ReprocessPlan {
  /** Images this run will actually count. */
  n: number
  level: number
  secs: number
  /** Already at this level, so untouched. Gallery only. */
  skipped: number
  /** In the run and counted at a HIGHER level: this run lowers them. */
  downgrades: number
  /** Images carrying hand corrections, and how many corrections in total. */
  editedImages: number
  editCount: number
  /** Squares excluded from the total across the run. They change the number as
   *  much as a hand edit does and they SURVIVE the run either way, which this
   *  dialog is the only place to say - it used to mention the hand edits and
   *  leave the exclusions unannounced (flow audit 2026-09-21, row 15). */
  offCount?: number
}

function Choice({ on, onPick, title, sub }: {
  on: boolean; onPick: () => void; title: string; sub: string
}) {
  // A real <input type="radio"> in a shared name group, not a hand-rolled
  // role="radio" button: the browser then gives roving tabindex (checked
  // input is the only tab stop) and ArrowDown/ArrowRight selection for free,
  // which the hand-rolled version never had - both choices were tab stops
  // and arrow keys moved nothing.
  return (
    <label
      className={cn(
        // An INSET ring, never a coloured border: Zen/WebRender seams a real
        // border at a rounded corner (measured 2026-09-19, see _constraints.md).
        "flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-transparent inset-ring px-3 py-2.5 text-left",
        "transition-[color,background-color,box-shadow] duration-150 ease-out has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
        on ? "inset-ring-brand bg-brand/8" : "inset-ring-line bg-panel2 hover:inset-ring-line-hi",
      )}
    >
      <input
        type="radio"
        name="reprocess-keep-edits"
        checked={on}
        onChange={onPick}
        // Browsers already roving-tabindex a native radio group once one
        // option is checked, but only after a user has tabbed through it
        // once; setting it explicitly makes the checked input the sole tab
        // stop from first render, matching the audit requirement exactly.
        tabIndex={on ? 0 : -1}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          // Same rule: inset ring, not a border, on this rounded-full dot.
          "mt-[3px] size-3.5 flex-none rounded-full border border-transparent inset-ring transition-[box-shadow] duration-150",
          on ? "inset-ring-brand shadow-[inset_0_0_0_3.5px_var(--accent)]" : "inset-ring-dim",
        )}
      />
      <span className="min-w-0">
        <b className="block text-[13px] font-medium text-foreground">{title}</b>
        <span className="block text-[12px] leading-snug text-dim">{sub}</span>
      </span>
    </label>
  )
}

/** One dialog for the whole run, never one per image. */
export function ReprocessDialog({ plan, onOpenChange, onConfirm }: {
  plan: ReprocessPlan | null
  onOpenChange: (v: boolean) => void
  onConfirm: (keepEdits: boolean) => void
}) {
  // Mounted only while there is a plan, which is what makes "keep" the
  // preselected answer EVERY time: a dialog that remembered "start clean" from
  // last time would discard corrections the user never agreed to discard again.
  if (!plan) return null
  return <Body plan={plan} onOpenChange={onOpenChange} onConfirm={onConfirm} />
}

function Body({ plan, onOpenChange, onConfirm }: {
  plan: ReprocessPlan
  onOpenChange: (v: boolean) => void
  onConfirm: (keepEdits: boolean) => void
}) {
  const [keep, setKeep] = useState(true)
  const { n, level, secs, skipped, downgrades, editedImages, editCount, offCount } = plan
  const one = n === 1

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{one ? "Reprocess this image" : `Reprocess ${n} images`}</DialogTitle>
          <DialogDescription className="text-[13px]">
            {levelName(level)} · about {humanSecs(secs).replace("~", "")}
            {skipped > 0 && ` · ${skipped} already at this level, skipped`}
          </DialogDescription>
        </DialogHeader>

        {/* Said for EVERY run, not only a downgrade: there is no history and no
            way back to the old number, and a same-level or upward recount used
            to say nothing at all, which reads as "adds a result". */}
        <p className="-mt-1 text-[13px] text-dim">
          {one
            ? "This replaces the current count for this image. The number showing now will be gone."
            : `This replaces the current count for these ${n} images. The numbers showing now will be gone.`}
        </p>

        {/* Only when the run actually lowers something. The gallery level wins
            by design; losing a slower, more accurate count is still the one
            thing here that cannot be undone, so it is said out loud. */}
        {downgrades > 0 && (
          <p className="-mt-1 text-[13px] text-destructive">
            {downgrades === 1
              ? "1 image counted at a higher level will be recounted lower"
              : `${downgrades} images counted at a higher level will be recounted lower`}
          </p>
        )}

        {!!offCount && offCount > 0 && (
          <p className="-mt-1 text-[13px] text-dim">
            {offCount === 1
              ? "1 excluded square stays excluded."
              : `${offCount} excluded squares stay excluded.`}
          </p>
        )}

        {editCount > 0 && (
          <div role="radiogroup" aria-label="Hand edits" className="flex flex-col gap-2">
            <Choice
              on={keep}
              onPick={() => setKeep(true)}
              title="Keep my hand edits"
              sub={`${editedImages} ${editedImages === 1 ? "image carries" : "images carry"} ${editCount} added or removed ${editCount === 1 ? "cell" : "cells"}.`}
            />
            <Choice
              on={!keep}
              onPick={() => setKeep(false)}
              title="Start clean"
              sub={`Discard all ${editCount}.`}
            />
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => onConfirm(keep)}>
            Reprocess
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
