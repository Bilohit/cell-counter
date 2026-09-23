import { useEffect } from "react"
import { PanelLeftClose } from "lucide-react"

import { useCounter, type Autocrop } from "@/state/useCounter"
import { cropBus, useCropActive } from "@/lib/cropBus"
import { gridLinesOf, squareKeyOfCell } from "@/lib/geom"
import { levelName } from "@/lib/levels"
import { isCountedField, isFailedField } from "@/lib/types"
import { CountNumber } from "@/components/CountNumber"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/* ---------------------------------------------------------------- section */

function Section({
  title, action, children, last,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <section className={"px-[22px] py-4" + (last ? "" : " border-b border-line")}>
      {title && (
        <h2 className="mb-3 flex items-center justify-between text-[13px] font-semibold uppercase tracking-[0.09em] text-dim">
          <span>{title}</span>
          {action}
        </h2>
      )}
      {children}
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2.5 last:mb-0">{children}</div>
  )
}

function RowLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <Label htmlFor={htmlFor} className="text-[13px] font-normal text-foreground">{children}</Label>
}

/* ---------------------------------------------------------------- sidebar */

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const {
    field, files, busy, total, edits, ghosts, quad,
    boundary, setBoundary, autocrop, setAutocrop,
    showGrid, setShowGrid,
    reset, squareCounts, off, toggleSquare,
  } = useCounter()

  const cropping = useCropActive()

  // A multi-file field is stitched and has no single capture to crop. A crop
  // already applied is no longer a blocker: CropTool maps its corners back
  // through the field transform, so cropping a crop lands where it is drawn.
  const cropBlocked = files.length > 1
  useEffect(() => {
    if (cropBlocked && cropping) cropBus.emit(false)
  }, [cropBlocked, cropping])

  // A per-field refusal (app.py: one bad capture in an otherwise-good batch)
  // carries only `names`/`error` - none of `count`/`level`/`grid_x` exist on
  // it (Field is now a discriminated union, see types.ts). A bare truthy
  // `field.error` check does NOT narrow the union (TS only narrows this way
  // when the property is absent, not `undefined`-typed, on the other member),
  // so every read below goes through these type guards instead.
  const counted = isCountedField(field)
  const failed = isFailedField(field)

  // A plain sentence, not three mono tokens ("auto 313 +0 -0"): the engine's
  // number and the user's own corrections read as English, and a correction
  // that has not been made says nothing at all.
  const tally = counted
    ? [`${field.count} found`]
      .concat(
        edits.added.length ? [`+${edits.added.length} added`] : [],
        edits.removed.length ? [`−${edits.removed.length} removed`] : [],
        ghosts > 0 ? [`${ghosts} of them no longer detected`] : [],
      ).join(", ")
    : ""

  // What the count on screen was made with, and nothing more. The stitch offset
  // and NCC fit used to ride along in this pill; they are a diagnostic, they
  // live in Image properties, and no bench user can act on either.
  const engine = !field ? "no image" : failed ? "not counted" : counted ? levelName(field.level) : "no image"

  // Derived from the same merged lines the dots are keyed against, so the
  // panel never disagrees with squareKeyOf about how many rows exist.
  // gridLinesOf itself returns {xs:[],ys:[]} for a failed field, but `failed`
  // is checked again below so the panel shows the real reason rather than the
  // generic "grid not detected" copy, which would be actively misleading for
  // an error that has nothing to do with the grid (e.g. two differently
  // sized captures).
  const { xs: gridXs, ys: gridYs } = gridLinesOf(field)
  const cols = Math.max(0, gridXs.length - 1)
  const rows = Math.max(0, gridYs.length - 1)
  // Three states, not two: no capture open at all is not a grid failure, and
  // telling a user to "crop tighter" before they have opened anything is
  // nonsense. Only a field that came back without a grid failed to measure.
  const hasGrid = !field || (!failed && cols > 0 && rows > 0)

  return (
      <aside className="flex h-full w-[308px] min-w-[308px] flex-col border-r border-line bg-panel">
        <ScrollArea className="h-full">
          {/* The panel folds away so the photo can have the whole window for dot
              editing; the count follows it out as a corner readout. The brand
              block, Open image and Export points that used to live here were the
              pre-gallery single-image app: the gallery owns intake and export
              now, and a second door into the counter bypassed the gallery, so
              the header name, the export and the write-back all went wrong. */}
          {/* count */}
          <div className="border-b border-line px-[22px] pt-3 pb-[18px]">
            {/* The fold-away button had a row to itself, which spent ~34 px of
                panel height showing nothing and pushed the count - the one thing
                this panel exists to say - that much further down, for no gain.
                It rides the count's own top line now, so every section below
                moves up by a row and the panel fits without scrolling. */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
            {/* No grid means the pipeline never found the ruled area, so the 0
                it returns is "not measured", not "no cells". A bold green zero
                said the opposite of what happened - and this is the one failure
                the app has that the user can actually fix. A `failed` field is
                a distinct, third state: the server's own plain-sentence reason,
                which may have nothing to do with the grid at all. */}
            {failed ? (
              <>
                <div className="text-[15px] font-semibold text-destructive">Not counted</div>
                <p className="mt-1 text-[13px] leading-relaxed text-dim">{field.error}</p>
              </>
            ) : hasGrid ? (
              <>
                <div className="flex items-baseline gap-2.5">
                  <CountNumber total={total} busy={busy} />
                  <span className="text-[13px] text-dim">cells counted</span>
                </div>
                <div className="mt-0.5 min-h-[16px] text-[13px] text-dim tabular-nums">{tally}</div>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold text-destructive">Grid not detected</div>
                <p className="mt-1 text-[13px] leading-relaxed text-dim">
                  Crop tighter to the ruled area, then count again.
                </p>
              </>
            )}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onCollapse}
                    aria-label="Hide the panel"
                    className="-mt-1 -mr-1 flex-none rounded-md p-1 text-dim transition-colors duration-150 ease-out hover:bg-panel-hover hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <PanelLeftClose className="size-[19px]" strokeWidth={1.8} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Hide the panel</TooltipContent>
              </Tooltip>
            </div>
            <span className="mt-2 inline-block rounded-full border border-transparent inset-ring inset-ring-line px-2 py-0.5 text-[13px] font-medium leading-[1.6] text-dim">
              {engine}
            </span>
          </div>

          {/* counting */}
          <Section title="Counting">
            <Row>
              <div className="min-w-0 flex-1 pr-2">
                <RowLabel htmlFor="sw-boundary">Count inside triple line only</RowLabel>
              </div>
              <Switch id="sw-boundary" checked={boundary} onCheckedChange={setBoundary} />
            </Row>
          </Section>

          {/* crop */}
          <Section title="Crop">
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={cropping ? "default" : "outline"}
                    disabled={cropBlocked}
                    onClick={() => cropBus.emit(!cropping)}
                  >
                    {cropping ? "Cancel crop" : "Crop"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[220px]">
                  Drag the corners to fit the area, straight or skewed, then Apply.
                </TooltipContent>
              </Tooltip>
              <Button size="sm" variant="outline" disabled={!quad && !autocrop} onClick={reset}>
                Reset crop
              </Button>
            </div>

            <Row>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Label
                    htmlFor="autocrop"
                    className="cursor-help text-[13px] font-normal text-foreground"
                  >
                    Auto-crop
                  </Label>
                </TooltipTrigger>
                <TooltipContent side="right">Automatic trim, no dragging needed</TooltipContent>
              </Tooltip>
              <Select
                value={autocrop || "off"}
                onValueChange={v => setAutocrop(v === "off" ? "" : (v as Autocrop))}
              >
                <SelectTrigger id="autocrop" size="sm" className="w-[150px] bg-panel2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="frame">counting area</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </Section>

          {/* view */}
          <Section title="View">
            <Row>
              <RowLabel htmlFor="sw-grid">Show grid lines</RowLabel>
              <Switch id="sw-grid" checked={showGrid} onCheckedChange={setShowGrid} />
            </Row>
          </Section>

          {/* grid squares */}
          <Section title="Grid squares" last>
            <div className="mb-2 flex justify-between text-[13px]">
              <span className="text-dim">Detected grid</span>
              <span className="text-[13px] tabular-nums text-foreground">
                {hasGrid ? `${cols} × ${rows}` : "not found"}
              </span>
            </div>

            {hasGrid && (
              <div
                className="mt-1.5 grid gap-1"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: rows }, (_, row) =>
                  Array.from({ length: cols }, (_, col) => {
                    // The key is the square's original-px position, not its
                    // index here: a crop moves these indices, and an exclusion
                    // must stay on the square the user pointed at (geom.ts).
                    const key = squareKeyOfCell(field, col, row)
                    const on = !off.has(key)
                    const n = squareCounts[key] ?? 0
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={on}
                        aria-label={`Square column ${col + 1}, row ${row + 1}: ${n} cells${on ? "" : " (excluded)"}`}
                        onClick={() => toggleSquare(key)}
                        className={
                          // `border-transparent` is NOT in this shared base: this file
                          // concatenates plain strings rather than using cn()/twMerge, so a
                          // conflicting `border-color` utility from a branch below would be
                          // resolved by the generated stylesheet's declaration order, not by
                          // string order — and `.border-transparent` is generated AFTER
                          // `.border-line`, so it would silently win and blank out the
                          // dashed branch's line. It lives in the `on` branch instead, where
                          // nothing else sets a border-color.
                          "flex aspect-square select-none items-center justify-center rounded-[5px] border inset-ring " +
                          "text-[13px] font-medium tabular-nums transition-[opacity,box-shadow] duration-100 " +
                          "hover:inset-ring-line-hi focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                          (on
                            ? "border-transparent inset-ring-line bg-panel2 text-foreground"
                            // hairline-ok: a dashed border cannot be drawn as an inset ring.
                            // `inset-ring-0` zeroes the base's unconditional bare `inset-ring`
                            // (box-shadow with color: currentcolor) so it does not paint a
                            // stray ring in `text-dim` behind the dash.
                            : "border-dashed border-line bg-transparent text-dim opacity-35 inset-ring-0")
                        }
                      >
                        {n}
                      </button>
                    )
                  })
                )}
              </div>
            )}

            {/* Only the empty state needs a line. The failure is already said
                once, at the count, where the user is looking; saying it twice in
                one panel made the panel the error rather than the image. */}
            {!field && (
              <p className="mt-2 text-[13px] leading-relaxed text-dim">
                Counts per detected hemocytometer square appear here.
              </p>
            )}
          </Section>
        </ScrollArea>
      </aside>
  )
}
