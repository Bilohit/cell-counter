import { useCallback, useId, useMemo, useState } from "react"
import { Download, FolderOpen, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { countedDots, effectiveTotal, fingerprintOf } from "@/lib/geom"
import { exportZip, saveFile } from "@/lib/exporters"
import type { ExportItem, Formats } from "@/lib/exporters"
import type { GalleryItem } from "@/lib/types"
import { useCounter } from "@/state/useCounter"
import { useGallery } from "@/state/useGallery"
import { useSettings } from "@/state/useSettings"

/** Which captures an export run covers, and how the user asked for them — the
 *  dialog says it back so nobody saves the wrong half of a session. */
export interface ExportScope {
  ids: string[]
  kind: "selection" | "all" | "one"
}

type FormatKey = keyof Formats

const FORMATS: ReadonlyArray<{ key: FormatKey; name: string; note: string }> = [
  { key: "zip", name: "Annotated images", note: "each capture as a PNG with its cells marked" },
  { key: "csv", name: "Counts (CSV)", note: "one row per capture: filename and count" },
  { key: "pdf", name: "PDF report", note: "summary table, then one page per capture" },
  { key: "json", name: "Cell centres (JSON)", note: "every point in original-image pixels" },
]

const DEFAULTS: Formats = { zip: true, csv: true, pdf: false, json: false }

/** The one export path: gallery selection, whole gallery, or the capture open
 *  in the workbench all arrive here and leave as one saved file. */
export function ExportDialog({ open, onOpenChange, scope }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  scope: ExportScope
}) {
  const { items } = useGallery()
  const { byField } = useCounter()
  const { burnCount } = useSettings()
  const [fmts, setFmts] = useState<Formats>(DEFAULTS)
  const [busy, setBusy] = useState(false)
  const uid = useId()
  // The chosen folder's name, or null when the browser owns the destination.
  // Only ever the name the picker gave us: the page is never told the path, and
  // guessing one would be a lie on the one line whose job is to be true.

  const chosen = useMemo(() => {
    const want = new Set(scope.ids)
    return items.filter(i => want.has(i.id))
  }, [items, scope.ids])

  const ready = useMemo(
    () => chosen.filter((i): i is GalleryItem & { field: NonNullable<GalleryItem["field"]> } =>
      i.status === "ready" && !!i.field),
    [chosen])
  const skipped = chosen.length - ready.length

  // Exactly the dots and the number the card and the workbench report: the
  // export re-uses their rule rather than re-deriving it.
  const exportItems: ExportItem[] = useMemo(() => ready.map(i => {
    const s = byField[fingerprintOf(i.field)]
    const [w, h] = [i.field.width, i.field.height]
    return {
      name: i.name, field: i.field,
      dots: countedDots(i.field, s, w, h),
      total: effectiveTotal(i.field, s, w, h),
    }
  }), [ready, byField])

  const picked = FORMATS.filter(f => fmts[f.key]).length
  const cells = exportItems.reduce((n, i) => n + i.total, 0)

  const scopeLine = scope.kind === "one"
    ? (chosen[0]?.name ?? "this capture")
    : scope.kind === "all"
      ? `Whole gallery, ${chosen.length} ${chosen.length === 1 ? "capture" : "captures"}`
      : `${chosen.length} selected`

  const run = useCallback(async () => {
    setBusy(true)
    try {
      const file = await exportZip(exportItems, fmts, burnCount)
      saveFile(file)
      const n = exportItems.length
      onOpenChange(false)
      // A download has no path the page can read, so the destination is named
      // the only honest way. The folder picker was removed 2026-09-21: it was a
      // Chrome/Edge-and-secure-context-only affordance whose failure modes (a
      // renamed folder, an unmounted drive, a lapsed permission) all ended in
      // this same download anyway.
      toast.success(
        `Exported ${n} ${n === 1 ? "capture" : "captures"} to your downloads folder.`)
    } catch (e) {
      toast.error((e as Error).message || "The export could not be written.")
    } finally {
      setBusy(false)
    }
  }, [exportItems, fmts, burnCount, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export counts</DialogTitle>
          <DialogDescription>
            {scopeLine}
            {exportItems.length > 0 && (
              <>
                {": "}
                <span className="font-mono tabular-nums">{cells}</span>
                {" cells in "}
                <span className="font-mono tabular-nums">{exportItems.length}</span>
                {exportItems.length === 1 ? " capture" : " captures"}
              </>
            )}
            .
          </DialogDescription>
        </DialogHeader>

        <ul className="grid gap-1.5">
          {FORMATS.map(f => (
            <li key={f.key}>
              <label
                htmlFor={`${uid}-${f.key}`}
                className={
                  // An INSET ring, never a coloured border: Zen/WebRender seams a
                  // real border at a rounded corner (measured 2026-09-19, see
                  // _constraints.md).
                  "flex cursor-pointer items-start gap-2.5 rounded-[9px] border border-transparent " +
                  "inset-ring inset-ring-line " +
                  "bg-panel2 px-2.5 py-2 transition-[color,box-shadow] duration-150 hover:inset-ring-line-hi " +
                  "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55"
                }
              >
                <Checkbox
                  id={`${uid}-${f.key}`}
                  className="mt-0.5"
                  disabled={busy}
                  checked={fmts[f.key]}
                  onCheckedChange={v => setFmts(p => ({ ...p, [f.key]: v === true }))}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] leading-tight font-medium text-foreground">
                    {f.name}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-dim">{f.note}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        {/* Never a silent drop: a capture that failed or is still waiting on an
            overlap decision has no count to export, and the user is told so. */}
        {skipped > 0 && (
          <p className="text-[13px] leading-snug text-amber">
            {skipped} {skipped === 1 ? "capture is" : "captures are"} not counted yet and will be
            left out.
          </p>
        )}

        {/* Where the file lands, before it lands. The export used to finish
            with a toast that named no destination at all. */}
        <div className={
          // An INSET ring, never a coloured border: Zen/WebRender seams a real
          // border at a rounded corner (measured 2026-09-19, see _constraints.md).
          "flex items-center gap-2 rounded-[9px] border border-transparent inset-ring inset-ring-line bg-panel2 px-2.5 py-2 " +
          "text-[13px] text-dim"
        }>
          <FolderOpen className="size-4 shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">
            Saves to: <span className="font-medium text-foreground">your downloads folder</span>
          </span>
        </div>

        <DialogFooter className="items-center">
          {!exportItems.length ? (
            <span className="mr-auto text-[13px] text-dim">Nothing counted to export.</span>
          ) : picked === 0 ? (
            <span className="mr-auto text-[13px] text-dim">Pick at least one format.</span>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={busy}
                  onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy || !picked || !exportItems.length}
                  onClick={run}>
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            {busy ? "Preparing…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
