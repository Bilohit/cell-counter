import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

/** The inline rename input, shared by the workbench header and the gallery
 *  card so a capture is renamed the same way in both places.
 *
 *  Renaming is safe: hand corrections are keyed to the FIELD fingerprint (the
 *  filenames the server echoes back plus the stitch offsets), never to this
 *  string. What changes is what the UI, an export file name and a saved session
 *  call the capture. */
export function RenameField({ value, onCommit, onCancel, className }: {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)

  // Opens with the base name selected, not the extension: renaming a capture
  // almost never means retyping ".tif".
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = value.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : value.length)
  }, [value])

  const commit = () => {
    const v = ref.current?.value.trim()
    // An empty name would leave a capture with nothing to identify it in the
    // gallery or in an export, so it reverts instead of being accepted.
    if (v && v !== value) onCommit(v)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Capture name"
      spellCheck={false}
      maxLength={160}
      // The gallery card underneath is itself a button, and the workbench
      // header steers the arrow keys: neither may act while a name is typed.
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === "Enter") commit()
        else if (e.key === "Escape") { e.preventDefault(); onCancel() }
      }}
      onBlur={commit}
      className={cn(
        // An INSET ring, never a coloured border: Zen/WebRender seams a real
        // border at a rounded corner (measured 2026-09-19, see _constraints.md).
        "w-full min-w-0 rounded-md border border-transparent inset-ring inset-ring-brand bg-panel2 px-2 py-1",
        "font-mono text-xs text-foreground outline-none ring-[3px] ring-ring/40",
        className,
      )}
    />
  )
}
