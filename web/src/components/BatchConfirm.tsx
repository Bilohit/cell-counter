import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { Check, Plus, Undo2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { QualitySlider } from "@/components/QualitySlider"
import { NameGroupSwitch } from "@/components/NameGroupSwitch"
import { RenameField } from "@/components/RenameField"
import { bandColumns, groupColor, sweepCost } from "@/lib/nameGroups"
import type { ManualGroup } from "@/lib/manualGroups"
import { ungroupedKeys } from "@/lib/manualGroups"
import { fetchThumbs } from "@/lib/api"
import { humanSecs } from "@/lib/levels"
import { buildFanImage } from "@/lib/dragStack"
import { TILE, TILE_HOVER_GROUP, TILE_MEDIA } from "@/lib/styles"
import { cn, midTruncate } from "@/lib/utils"
import { useGallery } from "@/state/useGallery"

/** The identity a staged capture is grouped, keyed and deduped by. Same rule as
 *  `keyOf` in the store: two captures from different sessions can share a name,
 *  and the size is what tells them apart. */
const keyOf = (f: File) => `${f.name} ${f.size}`

/** One shared empty set, so "nothing in flight" is a stable reference and the
 *  memoised tiles do not all re-render when a drag ends. */
const EMPTY: ReadonlySet<string> = new Set<string>()

/** Drag payload. One key, always: a drag that started on a selected tile moves
 *  the whole selection, and the drop handler works that out from the selection
 *  it already has rather than from what was stuffed in the DataTransfer. */
const DRAG_TYPE = "text/plain"

/** One staged file's thumbnail: an object URL when the browser can decode it
 *  (PNG/JPG), a neutral file tile otherwise — a TIF never even attempts to
 *  render, so it never has a chance to show a broken-image glyph. */
function Thumb({ file, served, onRemove, selectable, selected, onToggle, onDragStart,
                dressDrag, onDragEnd, flying }: {
  file: File
  /** A server-rendered JPEG for a file the browser cannot decode. */
  served?: string
  onRemove: () => void
  /** Grouping is on, so the tile is also the control that picks it. */
  selectable?: boolean
  selected?: boolean
  onToggle?: () => void
  onDragStart?: () => void
  /** Replaces the browser's single-tile ghost with the fanned stack of the
   *  whole selection. Given the event, because `setDragImage` may only be
   *  called from inside the dragstart handler. */
  dressDrag?: (key: string, e: React.DragEvent) => void
  onDragEnd?: () => void
  /** This tile's capture is in flight: it dims in place, so the pile under the
   *  pointer reads as the captures having been picked up. */
  flying?: boolean
}) {
  const isTiff = /\.tiff?$/i.test(file.name)
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  // Created and revoked inside one effect, so the URL's lifetime matches the
  // effect that owns it. Minting it in a useState initializer instead left
  // StrictMode's simulated unmount revoking the only URL there would ever be,
  // so every PNG/JPG thumbnail was a broken tile in dev and fine in prod.
  useEffect(() => {
    if (isTiff) return
    const u = URL.createObjectURL(file)
    // An object URL is the external resource this rule carves out: it cannot
    // be derived during render, because it has to be revoked again.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(u)
    setBroken(false)
    return () => { setUrl(null); URL.revokeObjectURL(u) }
  }, [file, isTiff])

  const ext = (file.name.split(".").pop() ?? "").toUpperCase()
  // The server renders what the browser cannot: a TIF only falls back to the
  // file glyph while its thumbnail is still on the way, or if it never comes.
  const src = url ?? served ?? null
  const showIcon = broken || !src

  const picture = (
    <>
      {showIcon ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-dim">
          <svg
            width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            className="opacity-70"
          >
            <path d="M14 3v5a1 1 0 0 0 1 1h5" />
            <path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z" />
          </svg>
          <span className="text-[13px] font-semibold tracking-wide">{ext}</span>
        </div>
      ) : (
        <img
          src={src ?? undefined}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
          className={cn(TILE_MEDIA, selected && "opacity-90")}
        />
      )}
      {/* The tick. The tile itself is the control, so a real checkbox here would
          be a second tab stop for one action. */}
      {selectable && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1 left-1 flex size-5 items-center justify-center rounded-[5px]",
            "border border-transparent bg-clip-padding inset-ring transition-[color,box-shadow] duration-150",
            selected
              ? "inset-ring-brand bg-brand text-on-brand"
              : "inset-ring-white/55 bg-black/45 text-transparent",
          )}
        >
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </>
  )

  // The highlight is an INSET RING, not a coloured border: a 1px border is
  // rasterised as four separate edges, so a tile whose box ends mid-device-pixel
  // — which every tile in a fractional grid column does, and which browser zoom
  // changes — gets a heavier line on two sides than the other two.
  // The hover is owned by the wrapping row, not by the tile, so this takes the
  // group-prefixed half of the one tile recipe (lib/styles.ts). `rounded-lg`
  // and the square aspect are this screen's own: a staged capture is a smaller,
  // denser object than a counted field's card.
  const shell = cn(
    TILE, TILE_HOVER_GROUP, "aspect-square rounded-lg group-hover:inset-ring-line-hi",
    selected && "shadow-[inset_0_0_0_2px_var(--accent)]",
  )

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      // No exit variant: the list is not wrapped in AnimatePresence, and adding
      // one to animate a removal the `layout` reflow already covers is not worth
      // the extra tree.
      transition={{ duration: 0.24, ease: "easeOut" }}
      // While this capture is in the pile under the pointer, the tile it came
      // from stands back: the selection converging into the stack is the whole
      // point of the gesture, and a tile left at full strength reads as having
      // stayed put. Opacity and scale only, and framer's MotionConfig already
      // honours the reader's motion preference for both.
      animate={flying
        ? { opacity: 0.45, y: 0, scale: 0.97 }
        : { opacity: 1, y: 0, scale: 1 }}
      className="group relative"
    >
      {selectable ? (
        <button
          type="button"
          draggable
          onDragStart={e => {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData(DRAG_TYPE, keyOf(file))
            // beginDrag FIRST: it makes the dragged tile the selection when it
            // was not one, and the stack that follows has to draw the selection
            // this drag actually moves.
            onDragStart?.()
            dressDrag?.(keyOf(file), e)
          }}
          onDragEnd={() => onDragEnd?.()}
          onClick={onToggle}
          aria-pressed={selected}
          aria-label={`${selected ? "Deselect" : "Select"} ${file.name}`}
          className={cn(shell, "block w-full cursor-pointer text-left outline-none",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50")}
        >
          {picture}
        </button>
      ) : (
        <div className={shell}>{picture}</div>
      )}

      {/* Outside the tile, never inside it: while grouping is on the tile is a
          button, and a button inside a button is not a thing. */}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className={cn(
          // top/right-[5px], not -1: the tick is placed from inside the tile's 1px
          // border, this from outside it, so -1 sat a pixel off the tick.
          "absolute top-[5px] right-[5px] z-10 flex size-5 items-center justify-center rounded-full",
          "bg-black/60 text-white opacity-0 outline-none",
          "transition-[opacity,translate] duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
          // Rides the tile's hover lift (TILE_HOVER_GROUP) with the tick.
          "motion-safe:group-hover:-translate-y-[2px]",
          "hover:bg-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <X className="size-3" strokeWidth={2.5} />
      </button>

      <div
        className="mt-1 truncate px-0.5 text-[13px] leading-tight text-dim"
        title={file.name}
      >
        {midTruncate(file.name, 34)}
      </div>
    </motion.li>
  )
}

/** Server-rendered thumbnails for the staged files the browser cannot decode.
 *  Keyed by name+size, the same identity the list keys tiles by: two captures
 *  from different sessions can share a filename. */
function useServedThumbs(pending: File[]): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  // Only the undecodable ones, and only the ones not already fetched: dropping
  // more captures onto the screen must not re-encode the whole staging area.
  const wanted = pending.filter(f => /\.tiff?$/i.test(f.name) && !thumbs[keyOf(f)])

  const key = wanted.map(keyOf).join(" ")
  useEffect(() => {
    if (!key) return
    const ac = new AbortController()
    const files = wanted
    fetchThumbs(files, ac.signal)
      .then(({ thumbs: got }) => {
        // By position, not by the name the server echoes: upload order is the
        // contract, and two staged files can carry the same name.
        // oxlint-disable-next-line react/set-state-in-effect
        setThumbs(prev => {
          const next = { ...prev }
          files.forEach((f, i) => {
            const img = got[i]?.image
            if (img) next[keyOf(f)] = img
          })
          return next
        })
      })
      // A missing preview is a grey tile, which is exactly what this screen
      // showed before. Not worth a toast on top of the file list.
      .catch(() => {})
    return () => ac.abort()
    // `wanted` is derived from `key`; listing it would refire on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return thumbs
}

/** Everything a tile needs that does not come from the file itself. Passed as
 *  one object because every level of this screen forwards all of it unchanged. */
interface TileCtx {
  served: Record<string, string>
  onRemove: (name: string, size: number) => void
  /** Absent when grouping is off: the tiles are then just a preview. */
  select?: {
    has: (key: string) => boolean
    toggle: (key: string) => void
    /** A drag that starts on an unselected tile selects it first, so dragging
     *  and ticking never disagree about what is about to move. */
    beginDrag: (key: string) => void
    /** Draws the fanned stack of the whole selection under the pointer. */
    dressDrag: (key: string, e: React.DragEvent) => void
    endDrag: () => void
    /** Keys whose captures are currently in the pile. */
    flying: ReadonlySet<string>
  }
}

/** The tile grid. `columns` lays a group out in whole rows; without it the grid
 *  fills by width. */
function Tiles({ files, ctx, columns }: {
  files: File[]
  ctx: TileCtx
  columns?: number
}) {
  return (
    <motion.ul
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.035 } } }}
      className={cn("grid gap-3", !columns && "grid-cols-[repeat(auto-fill,minmax(120px,1fr))]")}
      style={columns
        // A band lays its captures out in whole rows. The max-width keeps a
        // two-file group at tile size rather than stretching it across the page.
        ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            maxWidth: `${columns * 134}px` }
        : undefined}
    >
      {files.map(f => {
        const k = keyOf(f)
        return (
          <Thumb
            key={k}
            file={f}
            served={ctx.served[k]}
            onRemove={() => ctx.onRemove(f.name, f.size)}
            selectable={!!ctx.select}
            selected={ctx.select?.has(k)}
            onToggle={() => ctx.select?.toggle(k)}
            onDragStart={() => ctx.select?.beginDrag(k)}
            dressDrag={ctx.select?.dressDrag}
            onDragEnd={ctx.select?.endDrag}
            flying={ctx.select?.flying.has(k)}
          />
        )
      })}
    </motion.ul>
  )
}

/** A surface captures can be dropped onto. The highlight is kept in local state
 *  rather than CSS `:hover`, because a drag does not fire hover. */
function useDropTarget(onDrop: () => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        // Without this the browser refuses the drop and the whole gesture ends
        // in a "no entry" cursor over a target that is perfectly valid.
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        if (!over) setOver(true)
      },
      onDragLeave: (e: React.DragEvent) => {
        // A drag crossing a CHILD fires dragleave on the parent; without this
        // the highlight flickers off over every tile in the band.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        setOver(false)
        onDrop()
      },
    },
  }
}

/** One group: its name, its captures, and the two ways to put a capture in it —
 *  drop it here, or tick some tiles and press Move here. */
function Band({ group, hue, files, ctx, selCount, onMoveHere, onDropHere, onRename, onUngroup }: {
  group: ManualGroup
  hue: string
  files: File[]
  ctx: TileCtx
  selCount: number
  onMoveHere: () => void
  onDropHere: () => void
  onRename: (name: string) => void
  onUngroup: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const drop = useDropTarget(onDropHere)

  return (
    <section
      {...drop.props}
      style={{ "--gc": hue } as React.CSSProperties}
      className={cn(
        "rounded-lg transition-[background-color,box-shadow] duration-150",
        // An inset ring rather than a border: a border here would shift the
        // whole band's layout by 1px the moment a drag entered it.
        drop.over && "bg-brand/[.06] shadow-[inset_0_0_0_2px_var(--accent)]",
        drop.over ? "-m-2 p-2" : "",
      )}
    >
      <div className="mb-2.5 flex min-h-8 items-center gap-2.5 border-b border-line pb-1.5">
        <span aria-hidden="true" className="size-[9px] flex-none rounded-[3px] bg-[var(--gc)]" />
        {renaming ? (
          <RenameField
            value={group.name}
            className="max-w-[220px] text-[13px]"
            onCommit={name => { onRename(name); setRenaming(false) }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          // The name is the rename control. A separate pencil is one more thing
          // on a screen whose whole job is to be obvious.
          <button
            type="button"
            onClick={() => setRenaming(true)}
            title="Rename this group"
            className={cn(
              "-mx-1 min-w-0 cursor-pointer truncate rounded px-1 text-[13px] font-semibold",
              "outline-none transition-colors duration-150 hover:bg-panel-hover",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            {group.name}
          </button>
        )}
        <span className="flex-none text-[13px] tabular-nums text-dim">
          · {files.length} {files.length === 1 ? "capture" : "captures"}
        </span>

        <span className="flex-1" />

        {selCount > 0 && (
          <Button type="button" size="xs" variant="outline" onClick={onMoveHere}>
            Move {selCount} here
          </Button>
        )}
        <Button
          type="button" size="xs" variant="ghost"
          className="text-dim hover:text-foreground"
          onClick={onUngroup}
          title="Break this group up — its captures go back to Ungrouped"
        >
          Ungroup
        </Button>
      </div>
      <Tiles files={files} ctx={ctx} columns={bandColumns(files.length)} />
    </section>
  )
}

/** Where a capture sits when it belongs to no group. Always visible once it has
 *  anything in it: the thing that makes hand-grouping frightening is a capture
 *  you forgot to place, so there is nowhere for one to hide. */
function Tray({ files, ctx, selCount, onMoveHere, onDropHere }: {
  files: File[]
  ctx: TileCtx
  selCount: number
  onMoveHere: () => void
  onDropHere: () => void
}) {
  const drop = useDropTarget(onDropHere)
  return (
    <section
      {...drop.props}
      className={cn(
        "rounded-lg transition-[background-color,box-shadow] duration-150",
        drop.over && "-m-2 bg-brand/[.06] p-2 shadow-[inset_0_0_0_2px_var(--accent)]",
      )}
    >
      <div className="mb-2.5 flex min-h-8 items-center gap-2.5 border-b border-line pb-1.5">
        <span aria-hidden="true" className="size-[9px] flex-none rounded-[3px] border border-transparent inset-ring inset-ring-dim/60" />
        <span className="text-[13px] font-semibold">Ungrouped</span>
        <span className="flex-none text-[13px] tabular-nums text-dim">
          · {files.length} {files.length === 1 ? "capture" : "captures"}
        </span>
        <span className="flex-1" />
        {selCount > 0 && (
          <Button type="button" size="xs" variant="outline" onClick={onMoveHere}>
            Move {selCount} here
          </Button>
        )}
      </div>
      <Tiles files={files} ctx={ctx} />
    </section>
  )
}

/** Staging area between intake and a processing run: review what's queued,
 *  drop more on top (routed by App's window-level handler), then commit. */
export function BatchConfirm() {
  const {
    pending, removePending, clearPending, confirm, galleryLevel, setGalleryLevel, batchRateFor,
    groups, nameGroups, toggleNameGroups, namePattern,
    board, customGroups, addGroup, assignGroup, ungroup, renameGroup, resetGroups,
  } = useGallery()
  const served = useServedThumbs(pending)
  const cost = sweepCost(groups, pending.length)

  const [sel, setSel] = useState<Set<string>>(new Set())
  const grouping = nameGroups && pending.length > 1

  const byKey = new Map(pending.map(f => [keyOf(f), f]))
  const keys = pending.map(keyOf)
  const loose = ungroupedKeys(keys, board).map(k => byKey.get(k)!).filter(Boolean)

  // A capture the user removed cannot stay selected: the next Move would name a
  // file that is not staged any more.
  const live = sel.size ? new Set([...sel].filter(k => byKey.has(k))) : sel
  if (live.size !== sel.size) setSel(live)

  // Grouping off, or nothing selected any more: the bar and the ticks go away
  // together, so the screen never shows a selection it cannot act on.
  const selected = grouping ? live : new Set<string>()

  // Which captures are in the pile under the pointer, so their tiles can stand
  // back while they are in flight. Cleared on dragend, whether the drag landed
  // on a band or was abandoned - a tile left dim would read as removed.
  const [flying, setFlying] = useState<ReadonlySet<string>>(EMPTY)

  /** Replace the browser's one-tile ghost with the selection as a fanned stack.
   *
   *  The whole selection moves on a drop (see `move` below), and the ghost said
   *  otherwise: one tile, however many were ticked. The stack is drawn from the
   *  thumbnails already served for these captures, so it is the real captures
   *  the user picked up, and the badge carries the count the pile cannot show.
   *
   *  `setDragImage` may only be called inside the dragstart handler, which is
   *  why this takes the event rather than returning a node. */
  const dressDrag = (key: string, e: React.DragEvent) => {
    // `beginDrag` has already run, but its setState has not landed yet, so the
    // set this drag moves is computed the same way the drop will: the selection
    // if this tile is in it, otherwise just this tile.
    const keys = selected.has(key) ? [...selected] : [key]
    setFlying(new Set(keys))
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const { node, cleanup, offset } = buildFanImage({
      // The dragged tile last, so it is the card on top of the pile.
      urls: [...keys.filter(k => k !== key), key].map(k => served[k]),
      count: keys.length,
      reduced,
    })
    e.dataTransfer.setDragImage(node, offset[0], offset[1])
    // Not before the handler returns: Firefox and Safari read the node after
    // it does, and removing it early drops back to the default ghost.
    setTimeout(cleanup, 0)
  }
  const clear = () => setSel(new Set())
  /** Every edit ends the selection. The tick means "about to move these", and a
   *  tick left standing after the move reads as "these did not go". */
  const act = (fn: () => void) => { fn(); clear() }
  const ctx: TileCtx = {
    served,
    onRemove: removePending,
    select: grouping
      ? {
          has: k => selected.has(k),
          toggle: k => setSel(prev => {
            const next = new Set(prev)
            if (!next.delete(k)) next.add(k)
            return next
          }),
          beginDrag: k => { if (!selected.has(k)) setSel(new Set([k])) },
          dressDrag,
          endDrag: () => setFlying(EMPTY),
          flying,
        }
      : undefined,
  }
  /** A drop moves THE SELECTION, not the DataTransfer payload. `beginDrag` has
   *  already made the dragged tile the selection if it was not one, and that
   *  state change lands long before the drop does — so by the time this runs,
   *  "what is ticked" and "what is being dragged" are the same set. It also
   *  means dragging one tile of five ticked ones moves all five, which is what
   *  the ticks promised. */
  const move = (target: string | null) => act(() => assignGroup([...selected], target))

  return (
    <div data-testid="view-confirm" className="flex h-full flex-col">
      <header className="flex flex-none flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-line px-6 py-4">
        <div>
          <b className="block text-base font-semibold text-foreground">Confirm captures</b>
          {/* The estimate lives here, not on the button: it changes with the
              quality slider, and a button that resizes under the cursor while
              sliding is unusable. */}
          <span className="text-[13px] tabular-nums text-dim">
            {pending.length} {pending.length === 1 ? "capture" : "captures"} staged
            {/* The group count lives here, not on the switch: this line is
                flush left with nothing to its right, so a changing length
                costs no layout. On the switch it moved Cancel and Count. */}
            {pending.length > 1 && ` · ${nameGroups
              ? `${groups.length} ${groups.length === 1 ? "group" : "groups"}`
              : "no groups"}`}
            {pending.length > 0 && ` · ${humanSecs(pending.length * batchRateFor(galleryLevel))}`}
          </span>
        </div>
        {/* The level belongs here, not only in the gallery: this is the last
            screen before the FIRST count, and picking the rung afterwards would
            mean paying for a run twice. Same control, same state - the gallery
            bar and this header write the one `galleryLevel`. */}
        {/* Buttons first in the DOM, reordered on wide screens: below xl the
            row has to wrap, and wrapping the slider onto its own line keeps
            the primary action on the header row. The other way round buried
            Count under the slider. */}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-x-5 gap-y-3">
          <div className="order-1 flex items-center gap-2 xl:order-2">
            <Button type="button" variant="outline" size="sm" onClick={clearPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!pending.length} onClick={confirm}>
              Count {pending.length} {pending.length === 1 ? "capture" : "captures"}
            </Button>
          </div>
          <div className="order-2 flex basis-full items-center justify-end gap-4 xl:order-1 xl:basis-auto">
            <QualitySlider value={galleryLevel} onChange={setGalleryLevel} />
            {pending.length > 1 && (
              <NameGroupSwitch
                on={nameGroups}
                onChange={toggleNameGroups}
                pattern={namePattern}
                speedup={cost.grouped ? cost.full / cost.grouped : 1}
              />
            )}
            {/* Only once the board is the user's. Until then the groups ARE the
                filenames, and offering to undo that is offering to undo
                nothing. */}
            {grouping && customGroups && (
              <Button
                type="button" size="xs" variant="ghost"
                className="text-dim hover:text-foreground"
                onClick={() => act(resetGroups)}
              >
                <Undo2 className="size-3.5" aria-hidden="true" />
                Reset to automatic
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {pending.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-dim">
            Nothing staged. Drop more captures anywhere to add them.
          </div>
        ) : grouping ? (
          // Grouped: the bands ARE the explanation. What is compared with what
          // is visible, so the screen says nothing about comparison counts.
          <div className="flex flex-col gap-5 pb-16">
            {board.map((g, i) => (
              <Band
                key={g.id}
                group={g}
                hue={groupColor(i)}
                files={g.keys.map(k => byKey.get(k)!).filter(Boolean)}
                ctx={ctx}
                selCount={selected.size}
                onMoveHere={() => move(g.id)}
                onDropHere={() => move(g.id)}
                onRename={name => renameGroup(g.id, name)}
                onUngroup={() => act(() => ungroup(g.id))}
              />
            ))}

            {loose.length > 0 && (
              <Tray
                files={loose}
                ctx={ctx}
                selCount={selected.size}
                onMoveHere={() => move(null)}
                onDropHere={() => move(null)}
              />
            )}

            <NewGroupZone
              selCount={selected.size}
              onMake={() => act(() => addGroup([...selected]))}
              onDropHere={() => act(() => addGroup([...selected]))}
            />
          </div>
        ) : (
          <Tiles files={pending} ctx={ctx} />
        )}

        {/* The one thing that tells a user what their ticks are FOR. It sits
            over the list rather than in the header, because the list is where
            the ticks are and a bar at the top of a scrolled page is off
            screen. */}
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "sticky bottom-3 z-20 mx-auto flex w-max items-center gap-2 rounded-full",
              "border border-transparent inset-ring inset-ring-line bg-panel px-2 py-1.5",
              "shadow-[0_18px_40px_-18px_var(--shadow)]",
            )}
          >
            <span className="px-2 text-[13px] tabular-nums whitespace-nowrap">
              {selected.size} selected
            </span>
            <Button type="button" size="xs" onClick={() => act(() => addGroup([...selected]))}>
              <Plus className="size-3.5" aria-hidden="true" />
              New group
            </Button>
            <Button
              type="button" size="xs" variant="outline"
              onClick={() => act(() => assignGroup([...selected], null))}
            >
              Ungroup
            </Button>
            <Button
              type="button" size="xs" variant="ghost"
              className="text-dim hover:text-foreground" onClick={clear}
            >
              Clear
            </Button>
          </motion.div>
        )}
      </div>
    </div>
  )
}

/** The empty band at the bottom. Both ways to make a group land here: press it
 *  with tiles ticked, or drag a capture onto it. */
function NewGroupZone({ selCount, onMake, onDropHere }: {
  selCount: number
  onMake: () => void
  onDropHere: () => void
}) {
  const drop = useDropTarget(onDropHere)
  return (
    <button
      type="button"
      {...drop.props}
      onClick={onMake}
      disabled={selCount === 0}
      className={cn(
        "flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-lg",
        // hairline-ok: dashed at rest, so it cannot be drawn as an inset ring (a
        // box-shadow can't be dashed). The `drop.over` state below is left as a
        // real border too, on purpose, not only by default: it is the SAME box
        // toggling `border-style` (dashed <-> solid) at a fixed 1px width, and
        // splitting the two states across two different rendering mechanisms
        // (border here, box-shadow there) would make the one moment a user sees
        // — the switch to solid mid-drag — a visible change of technique, not
        // just of style, with no guarantee both agree on geometry during the
        // colour/style transition between them. The resting dashed state is the
        // one on screen almost all the time; the solid one is a transient drag
        // affordance, not a static rounded control, so it does not carry the
        // measured seam risk the same way the gallery/thumb tiles did.
        "border border-dashed border-line text-[13px] text-dim outline-none",
        "transition-[color,background-color,border-color] duration-150",
        "hover:border-line-hi hover:bg-panel-hover hover:text-foreground",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-dim",
        drop.over && "border-solid border-brand bg-brand/[.06] text-foreground",
      )}
    >
      <Plus className="size-4" aria-hidden="true" />
      {selCount > 0
        ? `New group from ${selCount} selected`
        : "Drag a capture here to start a new group"}
    </button>
  )
}
