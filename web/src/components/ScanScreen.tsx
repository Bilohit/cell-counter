import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Check, Layers, Radar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useGallery } from "@/state/useGallery"

/** The bar under a long sweep.
 *
 *  Only a long one gets it: the store attaches `scan.progress` when the run is
 *  past the point where a sweep outlasts a spinner's welcome (see
 *  `PROGRESS_MIN_COMPARISONS`), and a short sweep keeps the screen it always
 *  had. Same 1.5px bar and the same `N of M` caption the counting screen uses,
 *  because these are the app's two waits and the user should recognise the
 *  second one from the first - the only difference is what is being counted.
 *
 *  What it deliberately does NOT show: which files are being compared. The
 *  question a stuck-looking screen raises is "is this moving", and a scroll of
 *  filenames answers a question nobody asked while making the screen busier. */
function SweepProgress({ done, total, eta }: { done: number; total: number; eta: string }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0

  return (
    <motion.div
      // Already-visible default, one short rise: the bar is an answer arriving,
      // not an element announcing itself.
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      className="flex w-[min(420px,80%)] flex-col gap-2"
    >
      <Progress
        value={pct}
        className="h-1.5"
        aria-label="Overlap check progress"
      />
      {/* items-center, not items-baseline: an EMPTY eta box has its baseline
          at its bottom edge, so baseline alignment pushed it a line down and
          the row was 37px tall until "almost done" arrived and shrank it,
          jolting the whole centred column (measured 2026-09-21). */}
      <div className="flex items-center justify-between gap-3 text-[13px] text-dim">
        <span className="tabular-nums">{done} of {total} comparisons</span>
        {/* The estimate arrives once it is worth trusting, and leaves without
            taking the row's height with it - a caption that reflows the bar
            every few seconds is its own kind of restlessness. */}
        <span className="min-h-[1lh] tabular-nums">
          <AnimatePresence mode="wait" initial={false}>
            {eta && (
              <motion.span
                key={eta}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="inline-block"
              >
                {eta}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>
    </motion.div>
  )
}

/** The way out if the sweep never answers. Owns its own clock and is replaced,
 *  not reset, whenever the caller's key changes - a component that cleared this
 *  state from inside an effect would be starting a second render to undo the
 *  first. A minute is far past any sweep measured (1.3 s for eight TIFs), and
 *  it is still an offer rather than an automatic cancel: the backend serialises
 *  counts behind one lock, and a sweep queued behind a count is slow for a good
 *  reason. */
function Escape({ onStop }: { onStop: () => void }) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setStuck(true), 60_000)
    return () => clearTimeout(t)
  }, [])
  if (!stuck) return null
  return (
    <Button type="button" variant="outline" className="text-[15px]" onClick={onStop}>
      Stop and show the gallery
    </Button>
  )
}

/**
 * The beat between "Count" and the first count: the server compares every
 * staged capture against every other and says whether any two are halves of one
 * field. It exists because merging AFTER counting threw a count away — and
 * because a user who dropped five captures and lands on a merge screen deserves
 * to have been told the app was looking.
 */
export function ScanScreen() {
  const { scan, stopReprocess, setView } = useGallery()

  if (!scan) return null

  const checking = scan.found === null
  const found = scan.found ?? 0

  const line = checking
    ? `Comparing ${scan.n} captures for a shared field…`
    : found === 0
      ? "No overlaps. Every capture is its own field."
      : found === 1
        ? "One pair overlaps. You decide whether to merge it."
        : `${found} pairs overlap. You decide which to merge.`

  return (
    <div
      data-testid="view-scan"
      className="flex h-full flex-col items-center justify-center gap-6 px-7"
    >
      <div className="relative flex size-20 items-center justify-center">
        {/* One authored moment: the sweep keeps pulsing while the server works
            and stops the instant it has an answer, so the animation IS the
            status rather than decoration next to it. */}
        {checking && (
          <motion.span
            aria-hidden="true"
            // An INSET ring, never a coloured border: Zen/WebRender seams a real
            // border at a rounded corner (measured 2026-09-19, see _constraints.md).
            className="absolute inset-0 rounded-full border border-transparent inset-ring inset-ring-brand/40"
            initial={{ scale: 0.55, opacity: 0.7 }}
            animate={{ scale: 1, opacity: 0 }}
            transition={{ duration: 1.6, ease: "easeOut", repeat: Infinity }}
          />
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={checking ? "scanning" : found ? "found" : "none"}
            initial={{ opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.86 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="flex size-12 items-center justify-center rounded-full border border-transparent inset-ring inset-ring-line bg-panel2 text-brand shadow-[0_18px_50px_-28px_var(--shadow)]"
          >
            {checking
              ? <Radar className="size-6" strokeWidth={1.6} />
              : found
                ? <Layers className="size-6" strokeWidth={1.6} />
                : <Check className="size-6" strokeWidth={1.9} />}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className="max-w-[46ch] text-center">
        <b className="block text-base font-semibold text-foreground">
          {checking ? "Checking for overlaps" : "Overlap check done"}
        </b>
        <motion.p
          key={line}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          aria-live="polite"
          className="mt-1.5 text-sm leading-relaxed text-dim"
        >
          {line}
        </motion.p>
        {/* The verdict alone is a half-truth when a capture was never even
            offered: "no overlaps" reads as "these do not overlap" when the real
            answer is "these two are different sizes". api_pairs has always
            built this reason; until now nothing showed it (AUDIT-2026-09-05 #8). */}
        {scan.skipped?.map(s => (
          <p key={`${s.i}-${s.j}`} className="mt-1.5 text-[13px] leading-relaxed text-dim">
            {s.names[0]} and {s.names[1]}: {s.reason}
          </p>
        ))}
      </div>

      {checking && scan.progress && (
        <SweepProgress {...scan.progress} />
      )}

      {/* Keyed on the bar's own figure, so the minute restarts every time the
          sweep moves - the same shape as the counting screen's escape, which is
          keyed on the image being counted. A big drop is legitimately minutes
          of work (2016 comparisons at the measured 64 ms is over two), and
          offering a way out of something the user can watch advancing says the
          app doubts its own progress bar. Standing still for a minute is the
          only thing that has ever meant stuck. */}
      {checking && (
        <Escape
          key={scan.progress?.done ?? 0}
          onStop={() => { stopReprocess(); setView("gallery") }}
        />
      )}
    </div>
  )
}
