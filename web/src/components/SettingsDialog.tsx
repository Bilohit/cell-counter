import { useState } from "react"
import { Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { THEMES } from "@/state/useTheme"
import { useCounter } from "@/state/useCounter"
import { SCALE_MAX, SCALE_MIN, SCALE_STEP, useSettings } from "@/state/useSettings"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  theme: string
  setTheme: (id: string) => void
}

export function SettingsDialog({ open, onOpenChange, theme, setTheme }: Props) {
  const { burnCount, setBurnCount, uiScalePct, setUiScalePct } = useSettings()
  const { showStages, setShowStages } = useCounter()

  // The field holds what is typed until it is committed, so half-typed "1" on
  // the way to "150" is not clamped to 50 under the user's fingers.
  const [draft, setDraft] = useState<string | null>(null)
  const commitScale = () => {
    if (draft !== null && Number.isFinite(+draft) && draft.trim() !== "") setUiScalePct(+draft)
    setDraft(null)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog is taller than a 700 px laptop viewport once the themes and
          the shortcut list are both in it: without a ceiling the title left the
          top of the screen and the document itself scrolled. The header stays
          put and only the body under it scrolls. */}
      {/* No border-color override: DialogContent's own base already draws its
          hairline as inset-ring-border, which resolves to the same --line
          token this used to spell out with `border-line`. That literal class
          was a real 1px border underneath the base's `border-transparent`
          (same-slot color conflict twMerge does NOT dedupe, since `border`
          the WIDTH class and `border-line` the COLOR class are different
          groups) — it reintroduced a real border, doubled on top of the
          ring, on this dialog's rounded corners. Removed rather than paired
          with the base's ring, since it added nothing the default lacked. */}
      <DialogContent className="flex max-h-[min(88svh,640px)] max-w-[440px] flex-col gap-0 overflow-hidden bg-panel p-[20px_22px]">
        <DialogHeader className="flex-none gap-0">
          <DialogTitle className="text-[15px] font-bold">Settings</DialogTitle>
          <DialogDescription className="mt-0.5 mb-3.5 text-[13px] text-dim">Theme</DialogDescription>
        </DialogHeader>

        {/* `-mt-1 pt-1` (and the matching pb-1) buy 4 px of room inside the
            scroll box without moving anything: Radix autofocuses the first
            theme swatch when this dialog opens, and its focus ring is
            `ring-2` + `ring-offset-2` - 4 px OUTSIDE the button's border box.
            The swatch row is this scroll box's first child, so with zero
            padding that ring fell outside the padding edge and was clipped
            flat across the top, which is the "broken highlight on the selected
            theme" (measured in the real dialog, headless Chrome, 2026-09-21).
            An inset ring cannot be clipped, which is why selection uses one -
            but a focus ring has to sit outside the control to be visible
            against it, so it needs room rather than inverting. */}
        <div className="-mx-[22px] -mt-1 min-h-0 flex-1 overflow-y-auto px-[22px] pt-1 pb-1">
        {/* One swatch row, not a two-column list of named buttons: the colour is
            what picks a theme, and the row costs a third of the height. */}
        <div className="flex flex-wrap gap-2">
          {THEMES.map(t => {
            const active = theme === t.id
            return (
              <button
                key={t.id || "default"}
                type="button"
                aria-pressed={active}
                onClick={() => setTheme(t.id)}
                title={t.name}
                className={cn(
                  // An INSET ring, never a coloured border: Zen/WebRender seams a
                  // real border at a rounded corner (measured 2026-09-19, see
                  // _constraints.md).
                  "flex cursor-pointer items-center justify-center rounded-full border border-transparent inset-ring bg-panel2 p-[3px] transition-[color,box-shadow] duration-150 outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
                  // The selected swatch used to add an OUTER `ring-1 ring-brand`
                  // on top of the inset one. The swatch row is the first child
                  // of this dialog's `overflow-y-auto` body, so that ring's top
                  // pixel fell outside the scroll box and was clipped: the
                  // highlight read as a broken half-circle on the top row and
                  // whole on the rows below (2026-09-21). Selection is an inset
                  // ring only now - inset never leaves the element's own box, so
                  // no ancestor can crop it, which is the same reason the
                  // hairline rule prefers inset rings.
                  active
                    ? "inset-ring-2 inset-ring-brand"
                    : "inset-ring-line hover:inset-ring-line-hi",
                )}
              >
                <span
                  aria-hidden="true"
                  className="relative size-[26px] flex-none rounded-full border border-transparent inset-ring inset-ring-neutral-500/45"
                  style={{ background: t.bg }}
                >
                  <span
                    className="absolute -right-px -bottom-px size-3 rounded-full border border-transparent inset-ring inset-ring-black/25"
                    style={{ background: t.accent }}
                  />
                </span>
                <span className="sr-only">{t.name}</span>
              </button>
            )
          })}
        </div>

        <Separator className="my-4 bg-line" />

        <div className="mb-3.5">
          <p className="mb-2 text-[13px] text-dim">Display</p>
          <div className="flex items-center justify-between gap-3 text-[13px] font-medium">
            <label htmlFor="ui-scale">Interface scale</label>
            {/* A stepper, not a slider: the control resizes itself as it moves,
                and a slider whose track grows under the cursor fights the drag. */}
            <div className="flex flex-none items-center gap-1">
              <Button
                type="button" size="icon-xs" variant="outline" aria-label="Smaller interface"
                disabled={uiScalePct <= SCALE_MIN}
                onClick={() => { setDraft(null); setUiScalePct(uiScalePct - SCALE_STEP) }}
              >
                <Minus />
              </Button>
              <div className="relative">
                <input
                  id="ui-scale"
                  type="number"
                  inputMode="numeric"
                  min={SCALE_MIN} max={SCALE_MAX} step={SCALE_STEP}
                  value={draft ?? String(uiScalePct)}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={commitScale}
                  onKeyDown={e => { if (e.key === "Enter") commitScale() }}
                  className={cn(
                    // An INSET ring, never a coloured border: Zen/WebRender seams a
                    // real border at a rounded corner (measured 2026-09-19, see
                    // _constraints.md).
                    "h-7 w-[62px] rounded-md border border-transparent inset-ring inset-ring-line bg-panel2 pr-4 pl-2",
                    "text-center font-mono text-[13px] tabular-nums transition-[color,box-shadow] duration-150",
                    "hover:inset-ring-line-hi focus-visible:inset-ring-brand focus-visible:outline-none",
                    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
                  )}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[13px] text-dim"
                >
                  %
                </span>
              </div>
              <Button
                type="button" size="icon-xs" variant="outline" aria-label="Bigger interface"
                disabled={uiScalePct >= SCALE_MAX}
                onClick={() => { setDraft(null); setUiScalePct(uiScalePct + SCALE_STEP) }}
              >
                <Plus />
              </Button>
            </div>
          </div>
        </div>

        <Separator className="mb-4 bg-line" />

        <div className="mb-3.5">
          <p className="mb-2 text-[13px] text-dim">Export</p>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] font-medium">
            Include cell count on exported images
            <Switch checked={burnCount} onCheckedChange={setBurnCount} />
          </label>
        </div>

        <Separator className="mb-4 bg-line" />

        {/* Advanced: the stage images are a developer's view of the pipeline,
            and they sat in the sidebar at the same weight as the count. They
            are still reachable, one level down, where a curious user can find
            them and a bench user never trips over them. */}
        <div className="mb-3.5">
          <p className="mb-2 text-[13px] text-dim">Advanced</p>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] font-medium">
            Show pipeline steps
            <Switch checked={showStages} onCheckedChange={setShowStages} />
          </label>
          {/* A settings switch never counts (user, re-affirmed 2026-09-21,
              after a toggle-on recount double-counted the open image). The
              steps arrive with the next Reprocess, and only on one image. */}
          <p className="mt-1 text-[13px] leading-snug text-dim">
            Off at every start. Shown under a single image, after the next Reprocess.
          </p>
        </div>

        <p className="mt-4 text-center text-[13px] text-dim">~ by Biloheee &lt;3</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
