import { useMemo, useState } from "react"
import { Info, RotateCw, Settings } from "lucide-react"
import { ImageInfoDialog } from "@/components/ImageInfoDialog"
import { QualitySlider } from "@/components/QualitySlider"
import { ReprocessDialog, type ReprocessPlan } from "@/components/ReprocessDialog"
import { RunRing } from "@/components/RunRing"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fingerprintOf } from "@/lib/geom"
import type { FieldEdits } from "@/lib/geom"
import { humanSecs, levelName, needsLevel } from "@/lib/levels"
import { BAR, ICON_BUTTON, ICON_BUTTON_ARMED } from "@/lib/styles"
import type { GalleryItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useCounterByField } from "@/state/useCounter"
import { useGallery } from "@/state/useGallery"

/** Hand corrections carried by the images a run is about to recount. */
function editStats(targets: GalleryItem[], byField: Record<string, FieldEdits>) {
  let images = 0, count = 0, off = 0
  for (const it of targets) {
    if (!it.field) continue
    const s = byField[fingerprintOf(it.field)]
    const n = (s?.edits.added.length ?? 0) + (s?.edits.removed.length ?? 0)
    if (n) { images++; count += n }
    // Exclusions survive a run like the hand edits do, and change the number
    // as much - the dialog is the one place that can say so.
    off += s?.off.length ?? 0
  }
  return { images, count, off }
}

/**
 * The batch control: the level, and the one button that commits it.
 *
 * Laid out exactly like the workbench bar — Quality, the track, the rung's name,
 * then whatever acts on it. Nothing announces that there is nothing to do: with
 * every card already counted at this level there is simply no button, so the bar
 * is the slider and the eye has one fewer thing to read. While the run is going
 * the button becomes the ring, in its own place, and the ring is also the stop.
 *
 * The right end is what the app itself owns — properties, then settings —
 * exactly as the workbench bar ends, so the bottom-right corner means the
 * same one thing in both views. It is not gated on `items.length`: an empty
 * gallery still needs a way to Settings, and this is the only bar it has.
 */
export function GalleryReprocessBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const {
    items, selected, galleryLevel, setGalleryLevel, reprocess, stopReprocess, runIds, rateFor,
  } = useGallery()
  const { byField } = useCounterByField()
  const [plan, setPlan] = useState<ReprocessPlan | null>(null)
  const [info, setInfo] = useState(false)

  // A standing selection is the target; with nothing selected it is every image
  // that needs it.
  const scope = useMemo(
    () => (selected.size ? items.filter(i => selected.has(i.id)) : items),
    [items, selected])
  const stale = useMemo(
    () => scope.filter(i => needsLevel(i.field?.level, galleryLevel)), [scope, galleryLevel])
  // Nothing stale: the button stays, quiet, and recounts the scope at the level
  // each card already has - the workbench bar's same-level recount, for many.
  const armed = stale.length > 0
  const targets = useMemo(
    () => (armed ? stale : scope.filter(i => i.field || i.status === "error")),
    [armed, stale, scope])

  const running = !!runIds
  const done = runIds
    ? items.filter(i => runIds.has(i.id) && (i.status === "ready" || i.status === "error")).length
    : 0
  const total = runIds?.size ?? 0

  const start = () => {
    const { images, count, off } = editStats(targets, byField)
    setPlan({
      n: targets.length,
      level: galleryLevel,
      secs: targets.length * rateFor(galleryLevel),
      skipped: scope.length - targets.length,
      downgrades: armed ? targets.filter(i => (i.field?.level ?? 0) > galleryLevel).length : 0,
      editedImages: images,
      editCount: count,
      offCount: off,
    })
  }

  // The count and the cost are the button's REASON, not its face: on a wall of
  // thirty cards a number in the label changes with every tick of the selection
  // and the button jumps about. They belong where a user who wants them looks.
  const verb = armed ? "Reprocess" : "Recount"
  const label = selected.size
    ? `${verb} ${targets.length} selected at ${levelName(galleryLevel)} · ${humanSecs(targets.length * rateFor(galleryLevel))}`
    : `${verb} ${targets.length} at ${levelName(galleryLevel)} · ${humanSecs(targets.length * rateFor(galleryLevel))}`

  return (
    <>
      <div className={BAR}>
        {items.length > 0 && (
          <>
            <QualitySlider value={galleryLevel} onChange={setGalleryLevel} disabled={running} />

            {/* A standing selection changes this bar's scope silently -
                "Reprocess N selected" said so once, in a label nobody reads
                until they hover the button. A chip says it at rest, whether
                or not the button is even showing. */}
            {selected.size > 0 && (
              <span className="rounded-full border border-transparent inset-ring inset-ring-line px-2 py-0.5 text-[12px] tabular-nums text-dim">
                selection: {selected.size}
              </span>
            )}

            {running ? (
              <RunRing
                value={total ? done / total : 0}
                onStop={stopReprocess}
                label="Stop the run"
              />
            ) : targets.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button" aria-label={label} onClick={start}
                    className={cn(ICON_BUTTON, armed && ICON_BUTTON_ARMED)}
                  >
                    <RotateCw className="size-[17px]" strokeWidth={1.9} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{label}</TooltipContent>
              </Tooltip>
            ) : null}
          </>
        )}

        <span className="flex-1" />

        {/* The bottom-right corner means one thing, in both views: Settings.
            The gallery header used to carry its own gear (and no Info at
            all) - two different corners for the same control. This is the
            same pattern the workbench bar ends on (ImageToolbar.tsx). */}
        <div className="flex flex-none items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Info"
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
      </div>

      <ReprocessDialog
        plan={plan}
        onOpenChange={v => { if (!v) setPlan(null) }}
        onConfirm={keep => {
          const ids = targets.map(i => i.id)
          setPlan(null)
          void reprocess(ids, keep, !armed)
        }}
      />

      {/* Mounted only while open: ImageInfoDialog reads the full useCounter(),
          and this bar sits inside the memoised GalleryGrid subtree (A10) -
          a standing subscriber there would re-render the whole gallery on
          every opacity tick the workbench makes, exactly what that memo
          exists to prevent. */}
      {info && <ImageInfoDialog open={info} onOpenChange={setInfo} />}
    </>
  )
}
