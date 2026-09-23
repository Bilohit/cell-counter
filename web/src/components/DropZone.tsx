import { useCallback, useRef, useState } from "react"
import { motion } from "framer-motion"
import { toast } from "sonner"
import { cn, isCapture } from "@/lib/utils"

const ACCEPT = ".tif,.tiff,.png,.jpg,.jpeg,image/*"

/** What to say when files are refused at intake. Shared by the window-level
 *  drop and the DropZone's own file picker so both refuse in the same words.
 *  One exported helper beside the component costs a fast-refresh warning; two
 *  copies of the sentence would cost the user two different refusals. */
// oxlint-disable-next-line react/only-export-components
export function rejectMessage(bad: File[]): string {
  const names = bad.slice(0, 3).map(f => f.name).join(", ")
  const more = bad.length > 3 ? `, and ${bad.length - 3} more` : ""
  return bad.length === 1
    ? `${names} is not an image. Cell Counter reads TIF, PNG and JPG captures.`
    : `${bad.length} files were skipped (${names}${more}). Cell Counter reads TIF, PNG and JPG captures.`
}

/** First-run target: the whole app starts here, so it carries the full
 *  instruction — one capture, or the two halves of one field to stitch. */
export function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)
  const depth = useRef(0)

  const browse = useCallback(() => input.current?.click(), [])

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label="Open image"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      onClick={browse}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); browse() }
      }}
      // The window-level drop is owned by App; this only drives the hover look.
      onDragEnter={e => { e.preventDefault(); depth.current++; setHover(true) }}
      onDragOver={e => { e.preventDefault(); setHover(true) }}
      onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setHover(false) } }}
      onDrop={() => { depth.current = 0; setHover(false) }}
      className={cn(
        // hairline-ok: dashed, always — a dashed border cannot be expressed as
        // an inset ring (box-shadow has no dash), and every state here only
        // recolours the same dash, never turns it solid, so there is no
        // moment this needs to be a real border for one state and a ring for
        // another (see _constraints.md substitution rule / rule 4).
        "w-[min(560px,90%)] cursor-pointer rounded-2xl border-[1.5px] border-dashed",
        "border-line-hi px-10 py-16 text-center text-dim outline-none",
        "transition-[border-color,background-color] duration-150 ease-out",
        "hover:border-brand hover:bg-brand-dim/10",
        "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/60",
        hover && "border-brand bg-brand-dim/10",
      )}
    >
      <svg
        width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" className="mx-auto mb-3.5 opacity-70"
      >
        <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
      </svg>
      <b className="mb-1 block text-base font-semibold text-balance text-foreground">
        Drop hemocytometer captures: one field, several, or a whole batch
      </b>
      Click to browse · TIF, PNG, JPG · drop a field's two halves ("first three rows" + "last three
      rows") together and they stitch automatically
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={e => {
          const all = [...(e.target.files ?? [])]
          e.target.value = ""          // re-picking the same file must still fire
          const fs = all.filter(isCapture)
          // A refused file used to disappear without a word: the picker closed,
          // nothing was staged, and nothing said why.
          const bad = all.filter(f => !isCapture(f))
          if (bad.length) toast.error(rejectMessage(bad))
          if (fs.length) onFiles(fs)
        }}
      />
    </motion.div>
  )
}
