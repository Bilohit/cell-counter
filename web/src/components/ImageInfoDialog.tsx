import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { gridLinesOf } from "@/lib/geom"
import { levelName } from "@/lib/levels"
import { useCounter } from "@/state/useCounter"
import { isCountedField, isFailedField } from "@/lib/types"

const kb = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  })

function Rows({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  if (!rows.length) return null
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="mb-1.5 text-[13px] font-semibold tracking-[0.09em] text-dim uppercase">
        {title}
      </h3>
      <dl className="divide-y divide-line border-y border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="flex-none text-[13px] text-dim">{k}</dt>
            <dd
              className="min-w-0 text-right font-mono text-[13px] break-words tabular-nums text-foreground"
              title={v}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * Everything the app knows about the capture on screen. The engine version
 * lives here now that the footer carries controls instead: a stale server is
 * still one click away rather than invisible.
 *
 * The browser hands a page only name, type, size and modified time for a file
 * it cannot decode, and a TIF is one of those - so there is no EXIF or TIFF tag
 * to show. Everything below the file rows is measured by the pipeline.
 */
export function ImageInfoDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { files, field, imgSize, version, edits, total } = useCounter()

  const fileRows: Array<[string, string]> = files.flatMap(f => {
    const rows: Array<[string, string]> = [[f.name, kb(f.size)]]
    if (f.lastModified) rows.push([`${f.name} modified`, when(f.lastModified)])
    return rows
  })

  // A per-field refusal (app.py: one bad capture in an otherwise-good batch)
  // carries only `names`/`error` - Field is a discriminated union (types.ts),
  // so none of width/height/stitch/diameter/frame/count/level exist on this
  // branch. gridLinesOf(field) itself returns {xs:[],ys:[]} for it. A bare
  // truthy `field.error` check does not narrow the union, so every read below
  // goes through isCountedField/isFailedField instead.
  const counted = isCountedField(field)
  const failed = isFailedField(field)
  const { xs, ys } = gridLinesOf(field)
  const cols = Math.max(0, xs.length - 1)
  const rows = Math.max(0, ys.length - 1)

  const image: Array<[string, string]> = []
  if (counted) {
    image.push(["Counted pixels", `${field.width} × ${field.height}`])
    if (imgSize && (imgSize[0] !== field.width || imgSize[1] !== field.height)) {
      image.push(["On screen", `${imgSize[0]} × ${imgSize[1]}`])
    }
    image.push(["Captures in this field", field.names.join(", ")])
    // "scroll 408 px, fit 0.85" named two engineer's quantities and explained
    // neither. What a bench user needs is whether this field is one capture or
    // two joined, how far apart they sat, and how well they lined up.
    image.push(["Stitched", field.stitch
      ? `two captures, ${field.stitch.dy} px apart, ${Math.round(field.stitch.ncc * 100)} % match`
      : "single capture"])
    image.push(["Detected grid", cols && rows ? `${cols} × ${rows} squares` : "not found"])
    image.push(["Cell diameter", `${field.diameter} px`])
    image.push(["Counting frame", field.frame
      ? `${field.frame.x0}, ${field.frame.y0} to ${field.frame.x1}, ${field.frame.y1}`
      : "not found"])
  } else if (failed) {
    image.push(["Captures in this field", field.names.join(", ")])
  }

  const count: Array<[string, string]> = counted
    ? [
      ["Detected", String(field.count)],
      ["Hand corrections", `+${edits.added.length} / −${edits.removed.length}`],
      ["Reported total", String(total)],
    ]
    : []

  // Always shown, with or without a capture: the version is how a stale server
  // stays visible now that the footer carries controls instead of it.
  const engine: Array<[string, string]> = [
    ["Version", version || "unknown"],
    ["Quality level", counted ? levelName(field.level) : "—"],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Image properties</DialogTitle>
          <DialogDescription>
            {!field
              ? "Nothing is open yet. Drop a capture to see its properties."
              : failed
                ? "This capture could not be counted."
                : "What the app read from this capture and what the engine measured in it."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(58*var(--vh))] pr-3">
          <Rows title="File" rows={fileRows} />
          {failed && (
            <p className="mt-3 text-[13px] leading-relaxed text-destructive">{field.error}</p>
          )}
          <Rows title="Image" rows={image} />
          <Rows title="Count" rows={count} />
          <Rows title="Engine" rows={engine} />
          {counted && (
            <p className="mt-3 text-[13px] leading-snug text-dim">
              An EVOS TIF carries no EXIF the browser can read, so everything below the file
              rows is measured by the pipeline rather than read from the file.
            </p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
