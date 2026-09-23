import { useEffect, useRef, type KeyboardEvent } from "react"
import { useCounter } from "@/state/useCounter"
import { isCountedField } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Thumb {
  /** null for the final "Result" entry, which restores the live view. */
  name: string | null
  label: string
  src: string
}

/**
 * The debug strip under the viewer: one thumbnail per pipeline stage plus the
 * result. Selection is keyed by stage NAME and lives in the hook, so a
 * recount while tuning a slider keeps you on the stage you were looking at.
 */
export function StageStrip() {
  const { field, showStages, selectedStage, setSelectedStage } = useCounter()
  const stripRef = useRef<HTMLDivElement>(null)

  // A failed field (app.py: one bad group in an otherwise-good batch) has no
  // stages at all - the strip has nothing to show for it.
  const stages = isCountedField(field) ? field.stages : []
  const on = showStages && stages.length > 0

  useEffect(() => {
    if (!on) return
    const el = stripRef.current?.querySelector<HTMLElement>("[data-selected='true']")
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
  }, [on, selectedStage, stages.length])

  if (!on || !isCountedField(field)) return null

  const thumbs: Thumb[] = [
    ...stages.map(s => ({
      name: s.name,
      label: (s.n ? `${s.n}. ` : "") + s.name,
      src: s.image,
    })),
    // The result entry shows the capture itself: the dots, the grid and the
    // frame are drawn over it in the browser, so there is no server render of
    // the result to thumbnail.
    { name: null, label: "Result", src: field.base_image },
  ]

  // Roving tabindex: the strip is one tab stop (the selected thumb), and
  // Left/Right move both the selection and focus together, matching the
  // native listbox pattern instead of making every thumbnail its own stop.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    const i = thumbs.findIndex(t => (selectedStage ?? null) === t.name)
    const delta = e.key === "ArrowRight" ? 1 : -1
    const next = thumbs[(i + delta + thumbs.length) % thumbs.length]
    setSelectedStage(next.name)
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-key="${next.name ?? "__result__"}"]`)
      ?.focus()
  }

  return (
    <div
      ref={stripRef}
      role="listbox"
      aria-label="Pipeline stages"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex flex-none gap-2.5 overflow-x-auto border-t border-line bg-panel2 px-3.5 py-2.5"
    >
      {thumbs.map(t => {
        const sel = (selectedStage ?? null) === t.name
        return (
          <button
            key={t.name ?? "__result__"}
            data-key={t.name ?? "__result__"}
            type="button"
            role="option"
            aria-selected={sel}
            data-selected={sel}
            tabIndex={sel ? 0 : -1}
            title={t.label}
            onClick={() => setSelectedStage(t.name)}
            className="group w-[132px] flex-none cursor-pointer rounded-md text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel2"
          >
            <img
              src={t.src}
              alt=""
              loading="lazy"
              draggable={false}
              className={cn(
                // An INSET ring, never a coloured border: Zen/WebRender seams a
                // real border at a rounded corner (measured 2026-09-19, see
                // _constraints.md). inset-ring-[1.5px] is the bare-ring
                // companion, sized to match the original border-[1.5px] width.
                "h-[84px] w-full rounded-md border-[1.5px] border-transparent object-cover inset-ring-[1.5px] transition-[box-shadow] duration-150 group-hover:inset-ring-brand",
                sel ? "inset-ring-brand" : "inset-ring-line",
              )}
            />
            <div
              className={cn(
                "mt-1 overflow-hidden font-mono text-[10px] leading-tight font-medium text-ellipsis whitespace-nowrap",
                sel ? "text-brand" : "text-dim",
              )}
            >
              {t.label}
            </div>
          </button>
        )
      })}
    </div>
  )
}
