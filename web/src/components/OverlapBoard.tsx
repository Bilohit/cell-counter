import { useCallback, useMemo, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { Layers } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { ComparePair } from "@/components/ComparePair"
import { PairSwitch, type PairChoice } from "@/components/PairSwitch"
import { TILE, TILE_HOVER, TILE_MEDIA } from "@/lib/styles"
import { cn } from "@/lib/utils"
import type { GalleryItem } from "@/lib/types"
import { useGallery, type OverlapCandidate } from "@/state/useGallery"

/** A candidate's identity for the choice map. Two candidates can never name the
 *  same ordered pair of captures, so the two ids are enough - and unlike the
 *  object itself this survives the list being rebuilt. */
const keyOf = (c: OverlapCandidate) => `${c.aId}|${c.bId}`

/** One pair, as the thing it will become: the stitched field, under the switch
 *  that decides whether it is ever stitched at all. */
function PairCard({ c, a, b, choice, onChoose, onOpen }: {
  c: OverlapCandidate
  a: GalleryItem
  b: GalleryItem
  choice: PairChoice
  onChoose: (v: PairChoice) => void
  onOpen: () => void
}) {
  const merging = choice === "merge"
  return (
    <motion.li
      layout
      variants={{
        hidden: { opacity: 0, y: 10, scale: 0.97 },
        visible: { opacity: 1, y: 0, scale: 1 },
      }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
      className="min-w-0"
    >
      {/* The thumbnail is the way into the comparison, because the comparison
          is the only thing that answers "are these the same field?" - and a
          separate button for it would compete with the switch, which is the
          control this screen is actually about. */}
      <button
        type="button"
        onClick={onOpen}
        title={`Compare ${a.name} and ${b.name}`}
        aria-label={`Compare ${a.name} and ${b.name}`}
        className={cn(
          // One tile recipe for the whole app (lib/styles.ts), including the
          // inset ring - never a coloured border, which is rasterised as four
          // separate edges and comes out heavier on two sides of any box that
          // ends mid-device-pixel.
          TILE, TILE_HOVER, "w-full cursor-zoom-in aspect-[4/3]",
          merging
            ? "shadow-[inset_0_0_0_2px_var(--accent)] motion-safe:hover:shadow-[inset_0_0_0_2px_var(--accent),0_12px_26px_-18px_var(--shadow)]"
            : "hover:inset-ring-line-hi",
        )}
      >
        {c.aImage ? (
          <img
            src={c.aImage}
            alt=""
            draggable={false}
            className={TILE_MEDIA}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[13px] text-dim">
            {a.files[0]?.name.split(".").pop()?.toUpperCase() ?? "TIF"}
          </span>
        )}

        {/* Where the merge will join them, and - when it will not - where the
            two captures stay two. The same x either way, so flipping the switch
            reads as one state changing rather than the picture moving. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-[52%] w-px bg-brand transition-opacity duration-200",
            merging ? "opacity-50" : "opacity-0",
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 transition-opacity duration-200",
            "bg-[linear-gradient(90deg,transparent_calc(52%-2px),var(--bg)_calc(52%-2px),var(--bg)_calc(52%+2px),transparent_calc(52%+2px))]",
            merging ? "opacity-0" : "opacity-100",
          )}
        />
      </button>

      {/* Both names on one row. Each truncates in its own track, so the "+"
          never moves and neither name can push the other out of the card. */}
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-baseline gap-1.5 px-0.5 text-[13px] leading-tight text-dim">
        <span className="truncate text-right" title={a.name}>{a.name}</span>
        <span aria-hidden="true" className="text-line-hi">+</span>
        <span className="truncate" title={b.name}>{b.name}</span>
      </div>

      <PairSwitch
        value={choice}
        onChange={onChoose}
        labels={["Merge", "Keep both"]}
        label={`What to do with ${a.name} and ${b.name}`}
        className="mt-2.5"
      />
    </motion.li>
  )
}

/** Captures the sweep could not line up. A footnote, not a card: there is no
 *  decision here, and putting it on the board as an object would say there is. */
function Unpaired({ rows }: { rows: { names: string[]; reason: string }[] }) {
  if (!rows.length) return null
  const n = new Set(rows.flatMap(r => r.names)).size
  return (
    <section className="mt-6 max-w-[78ch] border-t border-line pt-3.5 text-[13px] text-dim">
      <b className="font-medium text-foreground">
        {n} {n === 1 ? "capture" : "captures"} could not be lined up
      </b>
      {" "}and will be counted on their own.
      <ul className="mt-1.5 grid gap-1">
        {rows.map(r => (
          <li key={r.names.join("|")} className="flex items-baseline gap-2">
            <span aria-hidden="true" className="mt-1.5 size-[5px] flex-none rounded-full bg-line-hi" />
            <span>{r.names.join(" + ")} - {r.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Every overlapping pair the sweep found, on one page. Each is primed to merge
 *  or to stay apart; nothing happens until Overlap. */
export function OverlapBoard() {
  const { candidates, unpaired, items, decideAll, setView } = useGallery()
  const reduce = useReducedMotion()

  // Keyed by pair, not by object: the candidate list is rebuilt whenever the
  // store touches it, and a Map keyed by identity would silently forget every
  // choice the user had made.
  const [picked, setPicked] = useState<Record<string, PairChoice>>({})
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  /** Only the pairs whose two captures both still exist can be shown, let alone
   *  decided: a candidate can outlive a capture the user removed. */
  const rows = useMemo(() => candidates
    .map(c => ({ c, a: byId.get(c.aId), b: byId.get(c.bId) }))
    .filter((r): r is { c: OverlapCandidate; a: GalleryItem; b: GalleryItem } => !!r.a && !!r.b),
    [candidates, byId])

  /** Merge is the default because it is what the sweep is claiming: these two
   *  are one field, and counting them separately counts the overlap twice. */
  const choiceOf = useCallback((c: OverlapCandidate): PairChoice =>
    picked[keyOf(c)] ?? "merge", [picked])

  const set = useCallback((c: OverlapCandidate, v: PairChoice) =>
    setPicked(prev => ({ ...prev, [keyOf(c)]: v })), [])

  const setAll = useCallback((v: PairChoice) =>
    setPicked(Object.fromEntries(rows.map(r => [keyOf(r.c), v]))), [rows])

  const merging = rows.filter(r => choiceOf(r.c) === "merge").length
  /** The board-wide switch reports before it commands: with the pairs split
   *  between the two settings it claims neither, rather than rounding to one
   *  and telling the user something untrue about their own board. */
  const allValue: PairChoice | "mixed" =
    merging === rows.length ? "merge" : merging === 0 ? "split" : "mixed"

  // What the run about to be ordered will actually do. Counted off the items
  // that still owe a count, NOT off `items.length`: a session can already hold
  // counted captures from an earlier batch, and reporting those as "fields to
  // count" would promise work that is not going to happen. Each merge turns
  // two of these into one.
  const captures = items.filter(i => !i.field && i.status !== "error").length
  const fields = captures - merging

  const open = openKey ? rows.find(r => keyOf(r.c) === openKey) : undefined

  const run = useCallback(async () => {
    setBusy(true)
    try {
      await decideAll(rows.map(r => ({ c: r.c, action: choiceOf(r.c) })))
      // decideAll routes on its own: settling the last pair starts the count.
    } catch (e) {
      toast.error((e as Error).message || "Merging the captures failed.")
    } finally {
      // Unconditional: React 18 does not warn on a post-unmount setState, and a
      // guard ref here would stay disarmed through StrictMode's remount and
      // leave the button dead after a cancelled run.
      setBusy(false)
    }
  }, [rows, choiceOf, decideAll])

  if (!rows.length) {
    return (
      <div data-testid="view-review" className="flex h-full flex-col items-center justify-center gap-3 p-7">
        <span className="text-sm text-dim">Nothing left to review.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setView("gallery")}>
          Back to the gallery
        </Button>
      </div>
    )
  }

  return (
    <div data-testid="view-review" className="flex h-full flex-col">
      <header className="flex flex-none flex-wrap items-end justify-between gap-3 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <b className="block text-base font-semibold text-foreground">
            {rows.length} {rows.length === 1 ? "pair" : "pairs"} of captures overlap
          </b>
          {/* The running answer to "what will this do?", in the one place the
              app already puts a run's arithmetic. It moves with every switch,
              so the button never has to resize to say it. */}
          <span className="block text-[13px] tabular-nums text-dim">
            {captures} {captures === 1 ? "capture" : "captures"} · {merging} to merge ·{" "}
            {fields} {fields === 1 ? "field" : "fields"} to count
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <PairSwitch
            size="bar"
            value={allValue}
            onChange={setAll}
            labels={["Merge all", "Keep all"]}
            label="Prime every pair"
          />
          <Button type="button" size="sm" disabled={busy} onClick={run}>
            <Layers aria-hidden="true" />
            Overlap
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <motion.ul
          initial={reduce ? false : "hidden"}
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.035 } } }}
          className="grid list-none grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3.5 p-0"
        >
          {rows.map(({ c, a, b }) => (
            <PairCard
              key={keyOf(c)}
              c={c} a={a} b={b}
              choice={choiceOf(c)}
              onChoose={v => set(c, v)}
              onOpen={() => setOpenKey(keyOf(c))}
            />
          ))}
        </motion.ul>

        <Unpaired rows={unpaired} />
      </div>

      {/* Over the board, never away from it: the user opened this because they
          were unsure about ONE pair, and losing the other nineteen to answer
          that is the thing this screen exists to stop. */}
      <Dialog open={!!open} onOpenChange={v => !v && setOpenKey(null)}>
        {/* Sized to the stitched pair, not to the screen: two captures stacked
            on a ~500 px shift make a portrait union, and a 1100 px dialog
            framed it with more empty ground than picture. */}
        <DialogContent className="max-w-[min(760px,92vw)] sm:max-w-[min(760px,92vw)]">
          {open && (
            <>
              <DialogHeader className="flex-row items-center justify-between gap-3 pr-8">
                <DialogTitle>Are these the same field?</DialogTitle>
                {/* The same switch a third time. The doubt is here, so the
                    decision is here too. */}
                <PairSwitch
                  size="bar"
                  value={choiceOf(open.c)}
                  onChange={v => set(open.c, v)}
                  labels={["Merge", "Keep both"]}
                  label={`What to do with ${open.a.name} and ${open.b.name}`}
                />
              </DialogHeader>
              <ComparePair c={open.c} a={open.a} b={open.b} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
