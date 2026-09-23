import { useState } from "react"
import { Info, RotateCw, Settings } from "lucide-react"
import { ImageInfoDialog } from "@/components/ImageInfoDialog"
import { QualitySlider } from "@/components/QualitySlider"
import { ReprocessDialog, type ReprocessPlan } from "@/components/ReprocessDialog"
import { RunRing } from "@/components/RunRing"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { humanSecs, levelName, needsLevel } from "@/lib/levels"
import { useCountProgress } from "@/lib/progressBus"
import { BAR, ICON_BUTTON, ICON_BUTTON_ARMED } from "@/lib/styles"
import { isCountedField } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useCounterActions, useCounterValues } from "@/state/useCounter"
import { useGallery } from "@/state/useGallery"

/**
 * The workbench's one horizontal bar. It replaced two — a slider row and a
 * status footer — because the pair spent 76 px of a bench screen restating the
 * capture name the header above already carries.
 *
 * Left end is what changes the count: the quality slider and the single button
 * that commits it. Right end is what the app itself owns: properties, then
 * settings. Nothing in the middle, so neither end can drift.
 */
/* The ring used to be driven by `useElapsed`: a 120 ms interval easing toward
 * a 0.95 cap against the level's measured seconds-per-image. It knew nothing
 * about the count - on a slower lab laptop it reached the cap and sat there,
 * and on a fast one it lagged behind a count that had already finished. Deleted
 * 2026-09-21 for the server's own step reporting (lib/progressBus.ts,
 * app.py's /api/progress/{token}), which is measured rather than guessed.
 */

export function ImageToolbar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  // useCounterValues(), NOT the merged useCounter(): the merged hook subscribes
  // to all four contexts, including the gallery-wide `byField` map and the
  // session facts, neither of which this bar reads. This bar is mounted for the
  // whole life of the workbench, so the narrow hook is what keeps a hand edit
  // on one card from re-rendering it.
  const { field, busy, level, edits, off, status, showStages } = useCounterValues()
  const { setLevel, reprocess, clearEdits } = useCounterActions()
  const { rateFor } = useGallery()
  const [plan, setPlan] = useState<ReprocessPlan | null>(null)
  const [info, setInfo] = useState(false)

  // A failed field (app.py: one bad group in an otherwise-good batch) carries
  // no `level` at all - it was never counted at any rung, so it is treated as
  // level 0 (needsLevel's own "no count at all" case), which keeps Reprocess
  // armed so the user can retry it rather than silently disabling the one
  // control that could fix it.
  // ALSO armed after a failure, whatever the level says. A failed count clears
  // the field, so the level test alone hid the one control that could retry it
  // - and `runSeq` exists precisely to make that retry send a request even when
  // nothing else changed (flow audit 2026-09-21, row 7).
  // What the count is actually doing, straight from the server. Its own bus,
  // not the counter store, so ticking it several times a second re-renders this
  // bar and nothing else.
  const progress = useCountProgress()
  // What to call the run, in the user's words. A queued count is WAITING on
  // another one - saying "counting" there, over a bar that cannot move, is the
  // thing that reads as a hang.
  const runLabel = !progress || progress.state === "running"
    ? (progress?.label || "Counting…")
    : progress.state === "queued"
      ? "Waiting for the count ahead…"
      : "Counting…"

  // Pipeline steps asked for, but this count was made without them. The switch
  // never counts (user, 2026-09-21); it arms this button, and the press is what
  // fetches them. Read off the field, so each image answers for itself.
  const wantsSteps = showStages && isCountedField(field) && field.stages.length === 0
  const armed = status === "error" || wantsSteps
    || (!!field && needsLevel(isCountedField(field) ? field.level : undefined, level))
  const editCount = edits.added.length + edits.removed.length
  // The replacement is stated in the same breath as the cost: this button is
  // the one place a per-image recount starts, and there is no way back to the
  // number it overwrites. It is the button's reason, not its face.
  const label = wantsSteps && !needsLevel(isCountedField(field) ? field.level : undefined, level)
    ? `Reprocess this image to show its pipeline steps · ${humanSecs(rateFor(level))}`
    : armed
    ? `Reprocess this image at ${levelName(level)} · ${humanSecs(rateFor(level))} · replaces the current count`
    : `Recount this image at ${levelName(level)} · ${humanSecs(rateFor(level))} · replaces the current count`

  return (
    <>
      <footer
        aria-label="Image controls"
        // One row, never two: Quality, the track, the rung's name, then the one
        // control that acts on them. Nothing else lives at this end, so there is
        // nothing left to wrap. `BAR` is shared with the gallery's own bottom
        // bar (lib/styles.ts), so the two stay pixel-identical by construction.
        className={BAR}
      >
        <QualitySlider value={level} onChange={setLevel} disabled={busy || !field} />

        {/* Three states, one position. At rest the button is still there, but
            quiet: a same-level recount used to need the slider moved away and
            back (2026-09-21). It is the SAME press - same dialog, same
            reprocess(), whose runSeq bump is what makes an unchanged level
            count again - so `level` is still not a counting input. Lit only
            when the level differs, which is the state worth noticing. */}
        {busy ? (
          <div className="flex flex-none items-center gap-2">
            {/* `frac` absent means the server could not say how far in this is -
                a poll that 404'd, or the first moments before one lands. The
                ring then sweeps instead of filling: an indeterminate spinner is
                honest, a 0 % on a count that may be nearly done is not. */}
            <RunRing value={progress?.frac} label={runLabel} />
            {/* The words carry the honesty. The detector is 76-97 % of a count
                (pipeline.PROGRESS_WEIGHTS), so the arc barely moves for most of
                the run; a label that advances through named steps is what says
                the app is working rather than hung. */}
            <span className="min-w-0 truncate text-[13px] text-dim">{runLabel}</span>
          </div>
        ) : field || armed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                onClick={() => setPlan({
                  n: 1,
                  level,
                  secs: rateFor(level),
                  skipped: 0,
                  downgrades: isCountedField(field) && field.level > level ? 1 : 0,
                  editedImages: editCount ? 1 : 0,
                  editCount,
                  offCount: off.size,
                })}
                className={cn(ICON_BUTTON, armed && ICON_BUTTON_ARMED)}
              >
                <RotateCw className="size-[17px]" strokeWidth={1.9} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{label}</TooltipContent>
          </Tooltip>
        ) : null}

        <div className="ml-auto flex flex-none items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Image properties"
                onClick={() => setInfo(true)}
                className={ICON_BUTTON}
              >
                <Info className="size-[17px]" strokeWidth={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Image properties</TooltipContent>
          </Tooltip>

          {onOpenSettings && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Settings"
                  onClick={onOpenSettings}
                  className={cn(ICON_BUTTON, "duration-300 hover:rotate-45 motion-reduce:hover:rotate-0")}
                >
                  <Settings className="size-[17px]" strokeWidth={1.8} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Settings</TooltipContent>
            </Tooltip>
          )}
        </div>
      </footer>

      <ReprocessDialog
        plan={plan}
        onOpenChange={v => { if (!v) setPlan(null) }}
        onConfirm={keep => {
          setPlan(null)
          if (!keep) clearEdits()
          reprocess()
        }}
      />

      <ImageInfoDialog open={info} onOpenChange={setInfo} />
    </>
  )
}
