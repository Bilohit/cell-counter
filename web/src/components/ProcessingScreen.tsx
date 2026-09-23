import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { SEED_RATE } from "@/lib/levels"
import { cn } from "@/lib/utils"
import { useGallery } from "@/state/useGallery"
import type { GalleryItem, ItemStatus } from "@/lib/types"

const DONE: ItemStatus[] = ["ready", "error"]

function RowIcon({ status }: { status: ItemStatus }) {
  if (status === "ready") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="text-brand">
        <path d="m5 12 5 5L20 7" />
      </svg>
    )
  }
  if (status === "error") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="text-destructive">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    )
  }
  if (status === "counting") {
    // A stroked arc, not a bordered box. A 12px circle drawn as four 2px
    // borders rounds each edge to the device pixel grid separately, so at a
    // fractional browser zoom (110 %) the ring came out lumpy on two sides and
    // the gap flickered as it turned. One path rounds once, at any zoom.
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"
        className="text-brand motion-safe:animate-spin">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" strokeDasharray="38 12.3" />
      </svg>
    )
  }
  // queued
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-dim" />
}

const LABEL: Record<ItemStatus, string> = {
  queued: "queued", counting: "counting…", pending: "queued", ready: "done", error: "failed",
}

function Row({ item }: { item: GalleryItem }) {
  const done = DONE.includes(item.status)
  const error = item.status === "error"
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      // A fixed, WHOLE-pixel height, not padding around fractional text: a 1px
      // border on a box that ends mid-pixel renders heavier on two sides than
      // the other two, which is the uneven outline the gallery chips showed.
      // 44px also gives the row back the height it reads as a list item at -
      // py-2 around 13px text came out at 33px, and thirty of those stacked
      // read as a wall of text rather than rows.
      className={cn(
        // `flex-none` is load-bearing, not tidiness: the list is a column flex
        // box with a max height, so a thirty-row batch had every row shrunk
        // from its 44px down to a few pixels of clipped text. A fixed height is
        // only fixed if the row is also refused as a shrink target.
        "relative flex h-11 flex-none items-center gap-3 overflow-hidden rounded-md border border-transparent inset-ring inset-ring-line bg-panel2 px-3.5",
        item.status === "counting" && "scanning",
      )}
    >
      <RowIcon status={item.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={item.name}>
        {item.name}
      </span>
      {/* A merged pair was counted on the review screen, as one stitched field.
          It arrives here already done, and saying why is cheaper than leaving
          the user to wonder which row their decision became. */}
      {item.mergedFrom && (
        <span className="flex flex-none items-center gap-1 rounded-full border border-transparent inset-ring inset-ring-line px-1.5 py-0.5 text-[13px] text-dim">
          <Layers className="size-3" strokeWidth={1.8} aria-hidden="true" />
          merged
        </span>
      )}
      <span
        className={cn(
          "flex-none text-[13px] tabular-nums",
          error ? "text-destructive" : done ? "text-brand" : "text-dim",
        )}
        title={error ? item.error : undefined}
      >
        {error && item.error ? item.error : LABEL[item.status]}
      </span>
    </motion.li>
  )
}

/** Keyed on the image being counted, so each one starts its own clock at mount
 *  rather than an effect resetting shared state on every change. */
function Escape({ after, onStop }: { after: number; onStop: () => void }) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setStuck(true), after)
    return () => clearTimeout(t)
  }, [after])
  if (!stuck) return null
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-transparent inset-ring inset-ring-line bg-panel2 px-3 py-2.5">
      <span className="text-[13px] leading-snug text-dim">
        This image is taking much longer than usual.
      </span>
      <Button type="button" variant="outline" className="flex-none text-[15px]" onClick={onStop}>
        Stop and show the gallery
      </Button>
    </div>
  )
}

/** Runs unattended: the store drives the whole pass and routes onward itself
 *  once every staged capture has resolved to a count or an error. */
export function ProcessingScreen() {
  const { items, batchIds, galleryLevel, stopReprocess, setView } = useGallery()

  // The batch is the store's: everything this one trip through the intake
  // produced, a pair merged on the review screen included. Snapshotting
  // "whatever is queued right now" at mount used to drop that merged capture
  // from the list entirely - it was counted during the review and reached this
  // screen already done. The mount snapshot survives as the fallback for a run
  // the store never named (the single-capture flow).
  const [ownIds] = useState(
    () => new Set(items.filter(i => i.status === "queued" || i.status === "counting").map(i => i.id)),
  )
  const ids = batchIds ?? ownIds
  const batch = items.filter(i => ids.has(i.id))
  const total = batch.length
  const doneCount = batch.filter(i => DONE.includes(i.status)).length
  const pct = total ? Math.round((doneCount / total) * 100) : 0

  // "Clearly abnormal" for the level being counted at, floored at a minute so a
  // fast level never offers the door over an ordinary slow image. SEED_RATE is
  // the measured seconds per image; eight times that, or 60 s, whichever is
  // longer.
  const countingId = batch.find(i => i.status === "counting")?.id
  const budget = Math.max(60, (SEED_RATE[galleryLevel] ?? 2) * 8) * 1000

  return (
    <div data-testid="view-processing" className="mx-auto flex h-full w-[min(640px,92%)] flex-col justify-center gap-5 py-10">
      <div>
        <b className="block text-base font-semibold text-foreground">Counting captures…</b>
        <span className="text-[13px] tabular-nums text-dim">
          {doneCount} of {total} done
        </span>
      </div>

      <Progress value={pct} className="h-1.5" />

      {/* `pr-2` is the gutter the scrollbar stands in. Without it the bar is
          drawn over the right edge of every row - on Windows it sits on the
          rows' border and the "done" text runs under it. */}
      <ol className="flex max-h-[calc(60*var(--vh))] flex-col gap-1.5 overflow-y-auto pr-2">
        {batch.map(it => <Row key={it.id} item={it} />)}
      </ol>

      {/* The only way out if the server never answers. Deliberately NOT a
          timeout that cancels by itself: the backend serialises counts behind a
          lock, so a queued image can legitimately sit here for minutes and an
          automatic abort would throw away good runs. This only offers the door
          once one image has been counting for far longer than its level costs,
          and the user decides. Stopping keeps every count already made; the
          images it never reached are marked cancelled and can be recounted from
          the gallery. */}
      {countingId && (
        <Escape
          key={countingId}
          after={budget}
          onStop={() => { stopReprocess(); setView("gallery") }}
        />
      )}
    </div>
  )
}
