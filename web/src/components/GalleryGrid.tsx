import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  Calculator, CheckIcon, Download, FilePlus2, Group, ImagePlus, Layers, Pencil,
  Trash2, Ungroup,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ConcentrationDock } from "@/components/ConcentrationDock"
import { RenameField } from "@/components/RenameField"
import { SwapLabel } from "@/components/SwapLabel"
import { LoadSessionButton, SaveSessionButton } from "@/components/SessionControls"
import { bandTotals, bandsOf } from "@/lib/bands"
import type { Band } from "@/lib/bands"
import { openDockWith, writeDock } from "@/lib/concentration"
import { effectiveTotal, fingerprintOf } from "@/lib/geom"
import { levelTag, needsLevel } from "@/lib/levels"
import { groupColor } from "@/lib/nameGroups"
import { useCountProgress } from "@/lib/progressBus"
import { TILE, TILE_HOVER, TILE_MEDIA } from "@/lib/styles"
import { GalleryReprocessBar } from "@/components/ReprocessBar"
import { RunRing } from "@/components/RunRing"
import { cn, isCapture, midTruncate, pairable } from "@/lib/utils"
import type { GalleryItem } from "@/lib/types"
import { useCounterByField } from "@/state/useCounter"
import { useGallery } from "@/state/useGallery"

/**
 * The head of one band of captures.
 *
 * It is one frame the full width of the grid under it, so a band reads as a
 * band. The calculator button is pinned to its right edge and never moves: the
 * eye learns one place to look for it, and which band it belongs to is not a
 * guess, because it is inside that band's own frame.
 *
 * Rename and Ungroup live INSIDE the coloured edge and slide out of it when the
 * band is pointed at. They are the two things a user does to a band once in a
 * session; parked in the open they would be two more controls to read past on
 * every band, every time.
 */
function BandHead({ band, index, onRename, onUngroup }: {
  band: Band
  index: number
  /** Both absent for the leftovers: there is no group there to rename or break
   *  up. They still get the calculator button — captures nobody grouped are
   *  still a set of fields someone may want a number for. */
  onRename?: (name: string) => void
  onUngroup?: () => void
}) {
  const { byField } = useCounterByField()
  const [renaming, setRenaming] = useState(false)
  const t = bandTotals(band, byField)
  const colour = groupColor(index)

  return (
    <div
      className="group/band mb-2.5 flex items-center gap-2.5 rounded-[9px] border border-transparent bg-clip-padding inset-ring inset-ring-line bg-panel2 py-1 pr-1.5"
      // The group colour is an inset SHADOW, not `border-left`: a real border on
      // a rounded box is what Zen/WebRender seams at the corners (2026-09-19),
      // and this one was missed by that pass (hooks at both left corners,
      // 2026-09-21). Tailwind's own inset-shadow slot, so it stacks with the
      // inset-ring rather than replacing it.
      style={{ "--tw-inset-shadow": `inset 3px 0 0 ${colour}` } as React.CSSProperties}
    >
      {/* The tools open to the RIGHT, pushing the name and the tally along. The
          alternative - floating them over the name - hides the one thing that
          says which band is being edited. */}
      <span className="flex items-center self-stretch pl-2">
        {!!onRename && !!onUngroup && (
          <span
            className={cn(
              "flex w-0 items-center gap-0.5 overflow-hidden opacity-0",
              "transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
              // 66px is the two 32px buttons plus their 2px gap. It was 58px, which
              // clipped the right edge of Ungroup and left the name sitting on
              // top of its hover target.
              "group-hover/band:w-[66px] group-hover/band:opacity-100",
              "group-focus-within/band:w-[66px] group-focus-within/band:opacity-100",
            )}
          >
            <Button
              type="button" size="icon-sm" variant="ghost"
              aria-label={`Rename ${band.name}`} title="Rename"
              onClick={() => setRenaming(true)}
            >
              <Pencil />
            </Button>
            <Button
              type="button" size="icon-sm" variant="ghost"
              aria-label={`Ungroup ${band.name}`} title="Ungroup"
              onClick={onUngroup}
            >
              <Ungroup />
            </Button>
          </span>
        )}
      </span>

      {renaming && onRename ? (
        <RenameField
          value={band.name}
          className="max-w-[220px]"
          onCommit={n => { setRenaming(false); onRename(n) }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <b className="flex-none text-sm font-semibold text-foreground">{band.name}</b>
      )}

      {/* What was counted, then what the calculator can use: the cells are
          every field's, full square or not, and the full-square tally says how
          many of them carry a divisor. A band of partials reads as counted but
          not measurable, instead of as counted nothing. */}
      <span className="min-w-0 truncate font-mono text-xs tabular-nums text-dim">
        <em className="not-italic text-foreground">{band.items.length}</em>
        {band.items.length === 1 ? " field" : " fields"} &middot;{" "}
        <em className="not-italic text-foreground">{t.counted}</em> cells &middot;{" "}
        <em className="not-italic text-foreground">{t.full}</em> full{" "}
        {t.full === 1 ? "square" : "squares"}
        {t.partial > 0 && (
          <> &middot; <em className="not-italic text-foreground">{t.partial}</em> partial</>
        )}
      </span>

      <span className="flex-1" />
      <span aria-hidden="true" className="w-px self-stretch bg-line" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button" size="icon-sm" variant="ghost"
            aria-label={`Send ${band.name} to the concentration calculator`}
            onClick={() => openDockWith(band.key)}
          >
            <Calculator />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Send to the calculator</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** What to draw in a card: the counted field's own render when there is one,
 *  else the raw file, and for a TIF — which no browser decodes — a file tile. */
function useThumbSrc(item: GalleryItem) {
  const file = item.files[0]
  const counted = item.field?.base_image
  const decodable = !!file && !counted && !/\.tiff?$/i.test(file.name)
  // Minted and revoked inside one effect so the URL's lifetime matches the
  // subscription that owns it — a useState initializer would leave StrictMode's
  // simulated unmount revoking the only URL there will ever be (the reasoning
  // OverlapReview's useCaptureSrc records at length).
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!decodable) return
    const u = URL.createObjectURL(file)
    // An object URL cannot be derived during render: it has to be revoked again.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(u)
    setBroken(false)
    return () => { setUrl(null); URL.revokeObjectURL(u) }
  }, [file, decodable])

  return {
    src: counted ?? (broken ? null : url),
    onError: () => setBroken(true),
    ext: (file?.name.split(".").pop() ?? "").toUpperCase(),
  }
}

function FileTile({ ext }: { ext: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-dim">
      <svg
        width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="opacity-70"
      >
        <path d="M14 3v5a1 1 0 0 0 1 1h5" />
        <path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z" />
      </svg>
      <span className="text-[13px] font-semibold tracking-wide">{ext}</span>
    </div>
  )
}

/** What the next Reprocess would do to this card, drawn as a rail and a chip.
 *  Green gains accuracy, red loses it, nothing means it will be skipped. The
 *  thumbnail itself is never tinted: the dots on it are what the card exists to
 *  show, and the chip carries the exact move for anyone who cannot separate the
 *  two hues. */
function levelMove(counted: number | undefined, want: number) {
  // No count yet, or a count that failed: the run picks it up, so it has to be
  // marked, or the button's number contradicts the cards. There is no level to
  // move FROM, so it names only the destination.
  if (!counted) return { dir: "up" as const, label: `→ ${levelTag(want)}` }
  if (!needsLevel(counted, want)) return { dir: "same" as const, label: levelTag(counted) }
  return {
    dir: counted < want ? ("up" as const) : ("down" as const),
    label: `${levelTag(counted)} → ${levelTag(want)}`,
  }
}

/** The counting card's live words, subscribed to the progress bus on its own so
 *  a tick several times a second re-renders this span and not the grid. */
function CardProgress({ id }: { id: string }) {
  const p = useCountProgress(id)
  if (!p || p.state === "queued") return <>counting…</>
  // No fraction means nobody can honestly say how far in this is (the poll
  // 404'd, or the first moments before one lands): say it is counting rather
  // than print a number that is not known.
  const pct = p.frac === undefined ? null : Math.round(p.frac * 100)
  return <>{pct === null ? "counting…" : `counting… ${pct}%`}</>
}

/** The workbench's own ring, on the card whose workbench count is still
 *  running after the user walked back - the same object in both places. */
function LiveRing() {
  const p = useCountProgress()
  return <RunRing value={p?.frac} label={p?.label || "Counting…"} className="bg-black/70" />
}

const Card = React.memo(function Card({ item, selecting, checked, wantLevel, activate }: {
  item: GalleryItem
  selecting: boolean
  checked: boolean
  wantLevel: number
  // The STABLE callback, not a per-card closure. React.memo compares props
  // shallowly, so passing `() => activate(id, failed)` from the parent would
  // hand every card a fresh function identity on every GalleryGrid render -
  // one card flipping counting->ready re-renders the whole list - and every
  // card would fail the shallow check. Card builds its own closure below,
  // where nothing compares it.
  activate: (id: string, failed: boolean) => void
}) {
  const { byField } = useCounterByField()
  const { renameItem, liveId } = useGallery()
  const { src, onError, ext } = useThumbSrc(item)
  const [renaming, setRenaming] = useState(false)

  // The card reports what the workbench would: the server's count with this
  // field's hand edits re-applied, bounded by the field's own pixel size. A
  // re-count in the edit view writes its CROPPED field back to the item, so
  // those bounds are what decide whether an added dot is still on screen —
  // exactly the test the edit view's total makes against the image it shows.
  // Memoised on the field's own fingerprint-relevant inputs: `byField` is one
  // shared object for the whole gallery, so without this every card in a
  // 30-card grid recomputed its total on any OTHER card's edit.
  const fstate = item.field ? byField[fingerprintOf(item.field)] : undefined
  const total = useMemo(
    () => (item.field ? effectiveTotal(item.field, fstate, item.field.width, item.field.height) : 0),
    [item.field, fstate])

  const live = liveId === item.id
  const working = item.status === "queued" || item.status === "counting" || live
  const failed = item.status === "error"
  // Not while it is counting: that card's mark is the spinner. A failed card
  // still gets its chip - it is in the next run - but keeps its own red border.
  const move = working ? null : levelMove(item.field?.level, wantLevel)
  // A working card's only visible mark is its spinner - nothing in the name
  // said a card was still counting versus just sitting there ready, so a
  // screen-reader user got no status at all for it.
  const label = selecting
    ? `${checked ? "Deselect" : "Select"} ${item.name}`
    : failed
      ? `Retry ${item.name} — ${item.error ?? "count failed"}`
      : item.status === "counting"
        ? `Open ${item.name} — counting…`
        : item.status === "queued"
          ? `Open ${item.name} — queued`
          : `Open ${item.name}${item.status === "ready" ? `, ${total} cells` : ""}` +
            (move && move.dir !== "same"
              ? `, will be recounted ${move.dir === "up" ? "higher" : "lower"} at ${move.label}`
              : "")

  return (
    <motion.li
      layout
      variants={{
        hidden: { opacity: 0, y: 10, scale: 0.97 },
        visible: { opacity: 1, y: 0, scale: 1 },
      }}
      exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.14 } }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* The card is one button, so the rename control cannot live inside it:
          it sits over the card's own footer instead. */}
      <div className="group/card relative">
      <button
        type="button"
        onClick={() => activate(item.id, item.status === "error")}
        aria-label={label}
        aria-pressed={selecting ? checked : undefined}
        className={cn(
          // One tile recipe for the whole app (lib/styles.ts): the lift, the
          // curve, the press and the focus ring all live there, so a gallery
          // card and a staged capture cannot drift into two different objects.
          // No longer ever disabled - a failed card retries on click instead -
          // so there is no disabled state left to style here.
          TILE, TILE_HOVER, "w-full cursor-pointer",
          checked
            ? "inset-ring-brand shadow-[0_10px_28px_-18px_var(--shadow)]"
            : failed
              ? "inset-ring-destructive/60 bg-destructive/5"
              // The highlight is an INSET RING, not a coloured border. A 1px
              // border is rasterised as four separate edges, so a card whose
              // box ends mid-device-pixel - which every card in a fractional
              // grid column does, and which browser zoom changes - gets a
              // heavier line on two sides than the other two. One inset shadow
              // is one antialiased rounded-rect path: even on all four sides at
              // any zoom. The border underneath stays `inset-ring-line`, where an
              // uneven edge has never been visible.
              : move?.dir === "up"
                // The lift travels with the accent ring: naming only the ring
                // in the hover shadow replaced TILE_HOVER's shadow outright, so
                // a card marked for a level move rose with no shadow under it.
                ? "inset-ring-line shadow-[inset_3px_0_0_var(--accent),inset_0_0_0_1px_var(--accent)] motion-safe:hover:shadow-[inset_3px_0_0_var(--accent),inset_0_0_0_2px_var(--accent),0_12px_26px_-18px_var(--shadow)]"
                : move?.dir === "down"
                  ? "inset-ring-line shadow-[inset_3px_0_0_var(--danger),inset_0_0_0_1px_var(--danger)] motion-safe:hover:shadow-[inset_3px_0_0_var(--danger),inset_0_0_0_2px_var(--danger),0_12px_26px_-18px_var(--shadow)]"
                  : "inset-ring-line hover:inset-ring-line-hi",
        )}
      >
        <div className={cn("relative aspect-[4/3] overflow-hidden bg-panel", working && "scanning")}>
          {src ? (
            <img
              src={src}
              alt=""
              draggable={false}
              onError={onError}
              className={cn(
                TILE_MEDIA,
                // The push-in and the brightness lift this used to cancel for a
                // counting card are gone from TILE_MEDIA itself (variant C
                // leaves the picture still), so there is nothing left to cancel
                // here - only the dimming that says the render is stale.
                working ? "opacity-40" : checked ? "opacity-90" : "opacity-100",
              )}
            />
          ) : (
            <FileTile ext={ext} />
          )}

          {/* Two captures stitched into one field. A mark on the capture, not a
              caption under it: on a wall of thirty cards the eye finds a badge
              and skips a line of grey text. It sits beside the selection tick
              rather than under it, so neither ever hides the other. */}
          {/* Marks on the capture, not captions under it: on a wall of thirty
              cards the eye finds a badge and skips a line of grey text. They
              share one row beside the selection tick, so no two ever stack on
              each other or on it. */}
          <div className={cn("absolute top-2 flex items-center gap-1", selecting ? "left-9" : "left-2")}>
            {item.mergedFrom && (
              <span
                title="Merged field: two captures stitched into one"
                aria-label="merged field"
                className={cn(
                  "flex size-5 items-center justify-center rounded-full",
                  "bg-black/70 font-mono text-[11px] leading-none font-semibold text-white",
                  "ring-1 ring-white/25",
                )}
              >
                M
              </span>
            )}
            {/* One boundary of this field's counting frame was only found on the
                second look, at a lower bar than the rest clear. The count is
                good and the line is real - but this is the field to open first
                if the concentration looks wrong, and nothing else on this screen
                would ever have said so. Amber, not red: it is a look-here, not a
                failure. */}
            {item.field?.frame?.recovered && (
              <span
                title="Check this one: part of the counting frame was recovered from the grid, not read straight off the line"
                aria-label="counting frame recovered, worth checking"
                className={cn(
                  "flex size-5 items-center justify-center rounded-full",
                  "bg-black/70 font-mono text-[11px] leading-none font-semibold text-amber",
                  "ring-1 ring-amber/45",
                )}
              >
                !
              </span>
            )}
          </div>

          {/* Selection tick. Purely visual: the card itself is the control, so a
              real checkbox here would be a second tab stop for one action. */}
          {selecting && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-2 left-2 flex size-5 items-center justify-center rounded-[5px]",
                "border border-transparent bg-clip-padding inset-ring transition-[color,box-shadow] duration-150",
                checked
                  ? "inset-ring-brand bg-brand text-on-brand"
                  : "inset-ring-white/50 bg-black/55 text-transparent",
              )}
            >
              <CheckIcon className="size-3.5" strokeWidth={3} />
            </span>
          )}

          {item.status === "ready" && !live && (
            <span className={cn(
              // No backdrop-blur on anything riding the tile's lift: the filter is
              // re-run every frame of the translate and the glyphs on it shimmer
              // (the "M" and the count, reported 2026-09-21). An opaque-enough
              // fill reads the same at rest.
              "absolute top-2 right-2 rounded-full bg-black/70 px-2 py-0.5",
              "font-mono text-[13px] font-semibold tabular-nums text-white",
            )}>
              {total}
            </span>
          )}
          {item.status === "pending" && (
            <span className={cn(
              "absolute top-2 right-2 rounded-full border border-transparent inset-ring inset-ring-amber/45 bg-black/65 px-2 py-0.5",
              "text-[13px] font-medium tracking-[0.02em] text-amber",
            )}>
              awaiting overlap decision
            </span>
          )}
          {live && item.status !== "counting" && item.status !== "queued" && (
            <span className="absolute top-1.5 right-1.5"><LiveRing /></span>
          )}
          {working && !live && (
            <span className={cn(
              "absolute top-2 right-2 rounded-full bg-black/70 px-2 py-0.5",
              "text-[13px] text-white/85",
            )}>
              {/* The card that is actually counting reports the server's own
                  step, so walking back to the gallery mid-run shows the same
                  truth the workbench was showing rather than a word that never
                  changes. Only that card: the queued ones are waiting, and a
                  percentage on a card that has not started would be a lie. */}
              {item.status === "counting" ? <CardProgress id={item.id} /> : "queued"}
            </span>
          )}
        </div>

        <div className="border-t border-line px-2.5 py-2">
          {/* One line, always. Middle-ellipsis, not a head-anchored cut: EVOS
              names share a long prefix, so the tail ("sq2.1.tif") is the only
              part that tells two cards apart. `truncate` is the backstop for a
              name with no space to cut at. */}
          <div className="truncate pr-6 text-[13px] leading-tight text-foreground" title={item.name}>
            {midTruncate(item.name, 34)}
          </div>
          {/* Only a failure earns a second line. "merged field" and "counted at
              balanced" were captions nobody read on a wall of cards: the merge
              is the M badge on the thumbnail, and the level is on the slider
              that set it. */}
          {failed && (
            // `title`, because the line is truncated and the server's reason is
            // the only actionable text about the failure - unreachable without
            // it (flow audit 2026-09-21, row 18). ProcessingScreen's own row
            // has carried one all along.
            <div
              className="mt-0.5 truncate text-[13px] leading-tight text-destructive"
              title={item.error ?? "count failed"}
            >
              {item.error ?? "count failed"}
            </div>
          )}
          {/* The rail's colour said "this card moves" to anyone who can tell the
              two hues apart and nothing at all to anyone who cannot. The move
              itself, in words, on the card. */}
          {move && move.dir !== "same" && (
            // A fixed height and leading-none, not padding around leading-tight
            // text: the chip's height came out fractional, and a 1px border on
            // a box that ends mid-pixel renders heavier on two sides than the
            // other two - the uneven outline this chip was showing.
            <span className={cn(
              "mt-1.5 inline-flex h-[22px] items-center rounded-full border border-transparent inset-ring px-2",
              "text-[13px] font-medium leading-none",
              move.dir === "up"
                ? "inset-ring-brand/50 text-brand"
                : "inset-ring-destructive/50 text-destructive",
            )}>
              {move.label}
            </span>
          )}
        </div>
      </button>

      {renaming ? (
        <div className="absolute inset-x-0 bottom-0 z-20 rounded-b-[var(--radius)] border-t border-line bg-panel p-1.5">
          <RenameField
            value={item.name}
            onCommit={name => { renameItem(item.id, name); setRenaming(false) }}
            onCancel={() => setRenaming(false)}
            className="text-[13px]"
          />
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Rename ${item.name}`}
              onClick={e => { e.stopPropagation(); setRenaming(true) }}
              className={cn(
                "absolute right-1.5 bottom-1.5 z-10 flex size-6 cursor-pointer items-center",
                "justify-center rounded-md bg-panel/85 text-dim opacity-0 backdrop-blur-sm",
                "transition-[opacity,color,background-color] duration-150 ease-out",
                "group-hover/card:opacity-100 hover:bg-panel-hover hover:text-foreground",
                "focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "focus-visible:outline-none",
              )}
            >
              <Pencil className="size-3.5" strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Rename</TooltipContent>
        </Tooltip>
      )}
      </div>
    </motion.li>
  )
})

/** Removal is not undoable inside the session, so it is confirmed. */
function RemoveDialog({ open, onOpenChange, n, onConfirm }: {
  open: boolean; onOpenChange: (v: boolean) => void; n: number; onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {n} {n === 1 ? "capture" : "captures"}?</DialogTitle>
          <DialogDescription>
            They leave this session together with their counts and hand corrections. The
            files on disk are untouched, so they can be added again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Starting over throws away every count in the tab, so it is confirmed — and
 *  it reloads rather than resetting a dozen stores by hand: a reload is the one
 *  thing that cannot leave a stale edit or a half-cancelled run behind. The
 *  calculator's typed values live in sessionStorage, which a reload survives, so
 *  they are cleared first. */
function NewSessionDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start a new session?</DialogTitle>
          <DialogDescription>
            Every capture, count and hand correction in this session is discarded. Save the
            session first if you want it back. The files on disk are untouched.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button" variant="destructive" size="sm"
            onClick={() => { writeDock({}); window.location.reload() }}
          >
            New session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The counted session: every capture, its count, and the bulk actions over a
 *  selection. Clicking a card opens it in the workbench.
 *
 *  Memoised: this only reads useGallery(), never useCounter(), so a sibling
 *  that moves opacity or the level slider (CounterValuesContext) must not
 *  re-render it too. Without the memo it still would - an unmemoised
 *  component re-renders whenever ITS OWN parent does, whatever the reason,
 *  and `onExport`/`onOpenSettings` are stable across the app's lifetime. */
export const GalleryGrid = React.memo(function GalleryGrid({ onExport, onOpenSettings }: {
  onExport?: (ids: string[], kind: "selection" | "all") => void
  onOpenSettings?: () => void
}) {
  const {
    items, openItem, removeItems, selected, toggleSelected, clearSelected, selectAll,
    galleryScroll, setGalleryScroll, intake, addManualPair, galleryLevel,
    renameBand, ungroupBand, groupItems, reprocess, selecting, setSelecting, runIds,
  } = useGallery()
  const reduce = useReducedMotion()

  // One band means the session is not really grouped, so the grid stays the
  // flat wall of cards it has always been: a lone heading over everything is a
  // label, not a grouping.
  const bands = useMemo(() => bandsOf(items), [items])

  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [pairing, setPairing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  // Where the user left the grid, so returning from the workbench lands on the
  // card they opened rather than back at the top.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = galleryScroll
    return () => setGalleryScroll(el.scrollTop)
    // Mount/unmount only: `galleryScroll` is the value to restore, never a
    // reason to yank a scrolling user back to it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ids = useMemo(() => items.filter(i => selected.has(i.id)).map(i => i.id), [items, selected])
  const pair = ids.length === 2 && ids.every(id => {
    const it = items.find(i => i.id === id)
    return !!it && pairable(it)
  })

  // Clearing the selection is not this function's job any more: it happens in
  // one place, an effect in useGallery keyed on `selecting` itself, so every
  // path off select mode - this one, Remove, any future one - gets it free.
  const leaveSelect = useCallback(() => setSelecting(false), [setSelecting])

  const activate = useCallback((id: string, failed: boolean) => {
    if (selecting) { toggleSelected(id); return }
    // A retry aborts the shared controller, which cancels every OTHER card
    // still queued in the run - one click on a red card used to stop the whole
    // batch (flow audit 2026-09-21, row 8). While a run is going, the run owns
    // these cards: the click does nothing, and the retry is there afterwards.
    if (runIds) return
    // A failed card has no field to show, so opening it would land the
    // workbench on nothing. Retrying it is the useful click.
    if (failed) reprocess([id])
    else openItem(id)
  }, [selecting, toggleSelected, openItem, reprocess, runIds])

  const overlap = useCallback(async () => {
    setPairing(true)
    try {
      await addManualPair(ids[0], ids[1])
      leaveSelect()          // the store routes to the review queue itself
    } catch (e) {
      toast.error((e as Error).message || "Those two captures could not be paired.")
    } finally {
      setPairing(false)
    }
  }, [ids, addManualPair, leaveSelect])

  const remove = useCallback(() => {
    removeItems(ids)
    setConfirmRemove(false)
    setSelecting(false)
  }, [ids, removeItems, setSelecting])

  return (
    <div data-testid="view-gallery" className="relative flex h-full flex-col">
      <header className="flex flex-none flex-wrap items-end justify-between gap-3 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <b className="block text-base font-semibold text-foreground">Counted captures</b>
          <span className="block text-[13px] tabular-nums text-dim">
            {selecting
              ? `${ids.length} of ${items.length} selected`
              : `${items.length} ${items.length === 1 ? "capture" : "captures"} in this session`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.tif,.tiff"
            multiple
            hidden
            onChange={e => {
              // Same rule as the drop zone: `accept` is a hint the OS dialog can
              // be talked out of, so the picked files are filtered here too.
              const fs = [...(e.target.files ?? [])].filter(isCapture)
              e.target.value = ""
              if (fs.length) intake(fs)
            }}
          />

          {selecting ? (
            <>
              {/* One control, both directions: with everything picked the only
                  thing left to want is nothing picked. */}
              <Button
                type="button" size="sm" variant="outline"
                onClick={() => (ids.length === items.length ? clearSelected() : selectAll())}
              >
                <SwapLabel
                  options={["Select all", "Select none"]}
                  value={ids.length === items.length ? "Select none" : "Select all"}
                />
              </Button>

              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled button is not a tooltip trigger, so the span
                      keeps the reason for the disabled state reachable. */}
                  <span>
                    <Button
                      type="button" size="sm" variant="outline"
                      disabled={!pair || pairing} onClick={overlap}
                    >
                      <Layers /> Overlap
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[240px]">
                  {pair
                    ? "Check whether these two captures are the same field and offer to stitch them."
                    : "Select exactly two counted single captures to stitch them."}
                </TooltipContent>
              </Tooltip>

              {/* The way back into a band. The sweep builds bands out of
                  filenames before anything is counted, so a run whose names
                  formed no pattern lands here as one heap - and a heap cannot
                  be handed to the calculator one sample at a time. The new band
                  is named "Group n" because naming it for the user would be a
                  guess; the band's own header renames it. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      type="button" size="sm" variant="outline"
                      disabled={!ids.length}
                      onClick={() => { groupItems(ids); leaveSelect() }}
                    >
                      <Group /> Group
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[240px]">
                  {ids.length
                    ? "Put these captures in a group of their own, to hand to the calculator on their own."
                    : "Select the captures that belong to one sample."}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      type="button" size="sm" variant="outline"
                      disabled={!onExport || !ids.length}
                      onClick={() => onExport?.(ids, "selection")}
                    >
                      <Download /> Export
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {onExport ? "Save the selected counts to a file." : "coming in this build"}
                </TooltipContent>
              </Tooltip>

              <Button
                type="button" size="sm" variant="outline"
                disabled={!ids.length} onClick={() => setConfirmRemove(true)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 /> Remove
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={leaveSelect}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <ImagePlus /> Add captures
              </Button>
              {/* The batch case, one click: everything counted in this session.
                  Exporting a subset is what Select is for. */}
              <Button
                type="button" size="sm" variant="outline"
                disabled={!onExport || !items.length}
                onClick={() => onExport?.(items.map(i => i.id), "all")}
              >
                <Download /> Export
              </Button>
              <SaveSessionButton />
              <LoadSessionButton />
              <Button
                type="button" size="sm" variant="outline"
                disabled={!items.length} onClick={() => setConfirmNew(true)}
              >
                <FilePlus2 /> New session
              </Button>
              <Button
                type="button" size="sm" variant="outline"
                disabled={!items.length} onClick={() => setSelecting(true)}
              >
                Select
              </Button>
            </>
          )}
        </div>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-dim">
              No captures yet. Drop them anywhere on this window, or add them here.
            </p>
            <Button type="button" size="sm" onClick={() => fileRef.current?.click()}>
              <ImagePlus /> Add captures
            </Button>
          </div>
        ) : bands.length > 1 ? (
          // Grouped: one headed band per group, in the order their first
          // capture arrived, leftovers last. No stagger here - thirty cards
          // rippling in under four headings is motion for its own sake, and the
          // headings are what the eye is meant to land on.
          <div className="flex flex-col gap-7">
            {bands.map((b, i) => (
              <section key={b.key || "ungrouped:leftovers"}>
                <BandHead
                  band={b}
                  index={i}
                  {...(b.key
                    ? { onRename: (n: string) => renameBand(b.key, n),
                        onUngroup: () => ungroupBand(b.key) }
                    : {})}
                />
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
                  {b.items.map(it => (
                    <Card
                      key={it.id}
                      item={it}
                      selecting={selecting}
                      checked={selected.has(it.id)}
                      wantLevel={galleryLevel}
                      activate={activate}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <motion.ul
            className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4"
            initial={reduce ? false : "hidden"}
            animate="visible"
            variants={{ visible: { transition: { staggerChildren: 0.03 } } }}
          >
            <AnimatePresence initial={false}>
              {items.map(it => (
                <Card
                  key={it.id}
                  item={it}
                  selecting={selecting}
                  checked={selected.has(it.id)}
                  wantLevel={galleryLevel}
                  activate={activate}
                />
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>

      {/* Under the grid, not in the header row: the header already carries six
          controls, and a costly action does not belong beside Remove. */}
      <div className="flex flex-none items-stretch">
        <div className="min-w-0 flex-1">
          <GalleryReprocessBar onOpenSettings={onOpenSettings} />
        </div>
        <ConcentrationDock />
      </div>

      <NewSessionDialog open={confirmNew} onOpenChange={setConfirmNew} />

      <RemoveDialog
        open={confirmRemove} onOpenChange={setConfirmRemove} n={ids.length} onConfirm={remove}
      />

    </div>
  )
})
