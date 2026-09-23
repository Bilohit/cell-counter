import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Layers, Pencil } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RenameField } from "@/components/RenameField"
import { cn, midTruncate, pairable } from "@/lib/utils"
import type { GalleryItem } from "@/lib/types"
import { useGallery } from "@/state/useGallery"
import { useCropActive } from "@/lib/cropBus"

/** Arrow keys belong to whatever the user is actually operating: a slider, a
 *  text field, or an open dialog all move with them. The header only takes the
 *  key when nothing else wants it. */
function keyIsFree(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  const t = e.target as HTMLElement | null
  if (t?.closest("input, textarea, select, [contenteditable='true'], [role='slider']")) return false
  // A Select, a dropdown and a popover all render into a Radix popper portal
  // and all take the arrow keys for their own options; without this the header
  // stepped to the next capture underneath an open menu.
  return !document.querySelector(
    "[data-slot='dialog-content'], [data-radix-popper-content-wrapper]")
}

function PickPartner({ open, onOpenChange, options, onPick, busy }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  options: GalleryItem[]
  onPick: (id: string) => void
  busy: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Which capture overlaps this one?</DialogTitle>
          <DialogDescription>
            Pick the other half of the same field. The two are checked for a real overlap
            before anything is stitched.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid max-h-[calc(52*var(--vh))] grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3 overflow-y-auto">
          {options.map(o => (
            <li key={o.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(o.id)}
                className={cn(
                  "group block w-full cursor-pointer overflow-hidden rounded-[var(--radius)]",
                  "border border-transparent inset-ring inset-ring-line bg-panel2 text-left outline-none transition-[color,background-color,box-shadow] duration-150",
                  "hover:inset-ring-brand focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  "disabled:cursor-progress disabled:opacity-60",
                )}
              >
                <div className="aspect-[4/3] overflow-hidden bg-panel">
                  {o.field?.base_image
                    ? <img src={o.field.base_image} alt="" draggable={false} className="h-full w-full object-cover" />
                    : <span className="flex h-full items-center justify-center font-mono text-[10px] text-dim">no preview</span>}
                </div>
                <div className="line-clamp-2 border-t border-line px-2 py-1.5 font-mono text-[11px] break-words text-foreground" title={o.name}>
                  {midTruncate(o.name, 34)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** The bar above the workbench: how the user got here, and how to leave — back
 *  to the gallery, or straight on to the next capture. */
export function EditNav({ onExport }: { onExport?: () => void }) {
  const { items, activeId, openItem, setView, addManualPair, renameItem } = useGallery()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const cropping = useCropActive()

  const idx = items.findIndex(i => i.id === activeId)
  const item = items[idx]

  const step = useCallback((d: 1 | -1) => {
    if (items.length < 2 || idx < 0) return
    openItem(items[(idx + d + items.length) % items.length].id)
  }, [items, idx, openItem])

  useEffect(() => {
    // Navigating away mid-crop discards the crop, so the arrows belong to the crop tool while it is open.
    if (items.length < 2 || cropping) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      if (!keyIsFree(e)) return
      e.preventDefault()
      step(e.key === "ArrowRight" ? 1 : -1)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [items.length, step, cropping])

  const pick = useCallback(async (id: string) => {
    if (!activeId) return
    setBusy(true)
    try {
      await addManualPair(activeId, id)     // the store routes to the review queue
    } catch (e) {
      toast.error((e as Error).message || "Those two captures could not be paired.")
    } finally {
      // Closed either way: the toast is the whole answer, and leaving the picker
      // standing open reads as if the pick had not registered at all.
      setPicking(false)
      setBusy(false)
    }
  }, [activeId, addManualPair])

  // Reached without a gallery item (the single-capture flow): nothing to
  // navigate between, so the workbench stands on its own.
  if (!item) return null

  const partners = items.filter(i => i.id !== item.id && pairable(i))
  const canPair = pairable(item) && partners.length > 0

  return (
    <>
      <header className="flex flex-none items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button" size="icon-sm" variant="ghost"
              aria-label="Back to the gallery" onClick={() => setView("gallery")}
            >
              <ArrowLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back to the gallery</TooltipContent>
        </Tooltip>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameField
              value={item.name}
              onCommit={name => { renameItem(item.id, name); setRenaming(false) }}
              onCancel={() => setRenaming(false)}
              className="max-w-[420px]"
            />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* The whole name, wrapped rather than cut. A merged capture is
                    two EVOS filenames joined, and the tail of each is what names
                    the field - a middle ellipsis dropped exactly the half that
                    identifies it. Two lines is the limit; past that the clamp
                    takes over and the tooltip still carries the rest. */}
                <button
                  type="button"
                  aria-label={`Rename ${item.name}`}
                  onClick={() => setRenaming(true)}
                  className={cn(
                    "-mx-1.5 flex max-w-full cursor-text items-start gap-1.5 rounded-md px-1.5 py-1",
                    "text-left text-foreground transition-colors duration-150",
                    "hover:bg-panel-hover focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    "focus-visible:outline-none",
                  )}
                >
                  <span className="line-clamp-2 font-mono text-[13px] leading-snug break-words">
                    {item.name}
                  </span>
                  {/* The name is editable, and nothing but this said so: a bare
                      run of text reads as a label. Same pencil the gallery card
                      carries, so the two places mean the same thing. */}
                  <Pencil className="mt-0.5 size-3.5 flex-none text-dim" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[420px] break-words">
                Rename — {item.name}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {canPair && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="sm" variant="outline" onClick={() => setPicking(true)}>
                <Layers /> Add overlap
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[230px]">
              Stitch this capture with another one of the same field.
            </TooltipContent>
          </Tooltip>
        )}

        {/* This capture on its own: the corrections just made are what gets
            written, without a trip back to the gallery to select it. */}
        {onExport && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="sm" variant="outline" onClick={onExport}>
                <Download /> Export
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Save this capture's count, with your corrections.
            </TooltipContent>
          </Tooltip>
        )}

        {items.length > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[11px] tabular-nums text-dim">
              {idx + 1} / {items.length}
            </span>
            <Button
              type="button" size="icon-sm" variant="outline"
              aria-label="Previous capture (Left arrow)" onClick={() => step(-1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button" size="icon-sm" variant="outline"
              aria-label="Next capture (Right arrow)" onClick={() => step(1)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </header>

      <PickPartner
        open={picking} onOpenChange={setPicking}
        options={partners} onPick={pick} busy={busy}
      />
    </>
  )
}
