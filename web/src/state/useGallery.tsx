import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react"
import { toast } from "sonner"
import { count as apiCount, fetchPairs, fetchParams, fetchSweepProgress } from "@/lib/api"
import { PROGRESS_MIN_COMPARISONS, remainingLabel, sweepComparisons } from "@/lib/overlap"
import { newToken, trackCount } from "@/lib/progressBus"
import { rejectMessage } from "@/components/DropZone"
import { REFUSED_STITCH_MSG } from "@/lib/messages"
import { fingerprintOf } from "@/lib/geom"
import { DEFAULT_LEVEL, SEED_RATE, needsLevel } from "@/lib/levels"
import type { SessionSeed } from "@/lib/session"
import { groupByName, hasNamePattern } from "@/lib/nameGroups"
import type { NameGroup } from "@/lib/nameGroups"
import {
  assignTo, claimedPairs, groupFrom, projectGroups, pruneGroups, seedFromAuto,
} from "@/lib/manualGroups"
import type { ManualGroup } from "@/lib/manualGroups"
import {
  isFailedField, type GalleryItem, type ItemStatus, type Pt, type SkippedPair,
} from "@/lib/types"
import { isCapture } from "@/lib/utils"
import { useCounterActions, useCounterSession, useCounterValues } from "@/state/useCounter"

export type View =
  | "intake" | "confirm" | "scan" | "processing" | "review" | "gallery" | "edit"

/** The overlap sweep that runs between "Count" and the first count. `found` is
 *  null while the server is still comparing captures. */
export interface ScanState {
  n: number
  found: number | null
  skipped?: SkippedPair[]
  /** Set only for a sweep long enough to be worth a bar (see
   *  `PROGRESS_MIN_COMPARISONS`). `done` counts comparisons finished across
   *  every band of the run, not just the one in flight.
   *
   *  `eta` is worked out here rather than on the screen because it needs a
   *  clock: the run knows when it started, and a component that read the time
   *  while rendering would be deriving a different answer on every pass. */
  progress?: { done: number; total: number; eta: string }
}

/** One undecided overlap between two gallery items. Decided pairs are removed. */
export interface OverlapCandidate {
  aId: string
  bId: string
  dx: number
  dy: number
  seam_y: number
  ncc: number
  rotation_deg?: number            // the fine rotation stitch_pair applied, if any
  swapped?: boolean               // true: b is the upper capture, a sits at (dx, dy)
  aImage?: string                 // raw-capture JPGs from /api/pairs: the review
  bImage?: string                 // screen runs before any count exists
}

const keyOf = (f: File) => `${f.name} ${f.size}`
/** A deliberate beat so a result the user never asked to read still registers.
 *  Resolves early on abort - a Stop must not be held up by a cosmetic pause. */
const pause = (ms: number, ac: AbortController) => new Promise<void>(res => {
  const t = setTimeout(res, ms)
  ac.signal.addEventListener("abort", () => { clearTimeout(t); res() }, { once: true })
})
/** A name for one band's sweep, unique across tabs and windows. `crypto` has
 *  `randomUUID` on every browser this ships to, but not on an insecure origin
 *  in older Chromium, and the app is also served over plain http on a LAN. */
const newJobId = () =>
  globalThis.crypto?.randomUUID?.() ?? `sweep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

/** Follow a running sweep and report it into `scan.progress` until it stops.
 *
 *  Returns the stopper. Every figure is clamped forward: a poll that lands
 *  before the server has registered the job answers 0, and a bar that dropped
 *  back to the previous band's total would read as the sweep restarting. The
 *  bar is also never allowed to reach the end on its own - the work is done
 *  when the response arrives, not when the last comparison is counted, and a
 *  bar sitting at 100 % through the upload of the previous band's previews is
 *  the exact lie this whole feature exists to stop telling.  */
function pollSweep(
  job: string, offset: number, total: number, startedAt: number,
  ac: AbortController, set: React.Dispatch<React.SetStateAction<ScanState | null>>,
) {
  let stopped = false
  const tick = async () => {
    const { done } = await fetchSweepProgress(job)
    if (stopped || ac.signal.aborted || done <= 0) return
    const at = Math.min(offset + done, total - 1)
    set(prev => (prev?.progress && at > prev.progress.done
      ? { ...prev, progress: { done: at, total, eta: remainingLabel(at, total, Date.now() - startedAt) } }
      : prev))
  }
  // 400 ms: six comparisons of movement per tick at the measured 64 ms each,
  // so the bar advances visibly without the poll itself becoming traffic.
  const id = setInterval(tick, 400)
  void tick()
  return () => { stopped = true; clearInterval(id) }
}

const errText = (e: unknown) => (e as Error)?.message || "Count failed"
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError"

function useGalleryState() {
  // The gallery counts with exactly the parameters the edit view uses, so a
  // batch result and a re-count of the same capture agree.
  //
  // Read through the narrow useCounter* hooks, not the merged useCounter():
  // that merge subscribes to every one of useCounter's contexts regardless of
  // what is destructured from it, and this hook backs GalleryProvider - a
  // full subscription here would re-render every gallery consumer (the grid,
  // every card) on each tick of the workbench's opacity slider, which touches
  // none of what this store actually reads.
  const { openFiles, setQuad, setByField } = useCounterActions()
  const { boundary } = useCounterSession()
  const { fields, fieldsFor, quad, busy, files } = useCounterValues()

  // The level the whole gallery is asking for. Like the edit view's, it is a
  // request: moving it recounts nothing and only re-marks the cards.
  const [galleryLevel, setGalleryLevel] = useState(DEFAULT_LEVEL)
  // Seconds per image, per level. Seeded from the workstation measurements and
  // overwritten by what this machine actually achieves, so the button's
  // estimate stops being a workstation's promise after the first image.
  const rate = useRef<Record<number, number>>({ ...SEED_RATE })
  // Wall-clock seconds per image across a whole run, as opposed to `rate`'s
  // per-image mean: with two counts running at once, per-image time over-states
  // a batch's actual wait by roughly the parallel gain. Seeded lazily from
  // `rate` until a run has actually finished once (see `batchRateFor`).
  const batchRate = useRef<Record<number, number>>({})
  // How many counts the server will run at once (1 or 2), from GET
  // /api/params. Fetched once on mount, not tied to useCounter's own fetch of
  // the same endpoint: this store does not read useCounter's version state,
  // and a second cheap request to a local server is not worth threading a prop
  // through for.
  const slotsRef = useRef(1)
  useEffect(() => {
    let live = true
    fetchParams().then(p => {
      if (live && p.count_slots) slotsRef.current = p.count_slots
    }).catch(() => { /* stays at 1; useCounter's own fetch already reports the server as down */ })
    return () => { live = false }
  }, [])
  // Which items the run in flight is counting, so the gallery can show progress
  // in place instead of a full-screen processing view.
  const [runIds, setRunIds] = useState<Set<string> | null>(null)
  // Everything ONE trip through the intake produced, whatever state each part
  // is in. The processing screen lists this rather than the whole gallery: a
  // merged pair stands in the batch in place of the two captures it was made
  // from, so the run still accounts for every capture staged, while captures
  // from an earlier batch stay out of it.
  const [batchIds, setBatchIds] = useState<Set<string> | null>(null)

  const [view, setViewRaw] = useState<View>("intake")
  const [items, setItems] = useState<GalleryItem[]>([])
  const [pending, setPending] = useState<File[]>([])
  /** Hand-made capture groups for the confirm screen. Empty means "nobody has
   *  touched the board": the filename rule is in charge and the screen shows
   *  what it worked out. The first edit seeds this from that same answer, so
   *  customising is editing, never starting from a blank page. */
  const [manual, setManual] = useState<ManualGroup[]>([])
  // Whether the overlap sweep is confined to captures whose filenames share a
  // prefix. Armed automatically when the staged names form a pattern, and the
  // user can turn it off again - so this is a tri-state in spirit: once they
  // touch it, auto-arming stops second-guessing them for this batch.
  const [nameGroups, setNameGroups] = useState(false)
  const nameGroupsTouched = useRef(false)
  const [candidates, setCandidates] = useState<OverlapCandidate[]>([])
  /** Why a capture in this run ended up in no pair at all. The scan screen
   *  already flashes this for a beat and then loses it; the board keeps it,
   *  because "these two could not be lined up" is exactly what the person
   *  deciding the merges is entitled to know, and the 3.2 s it used to get was
   *  the only chance anyone ever had to read it. */
  const [unpaired, setUnpaired] = useState<SkippedPair[]>([])
  const [scan, setScan] = useState<ScanState | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [galleryScroll, setGalleryScroll] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Whether the gallery is in select mode. Held here, not in the grid, so a
  // stale selection cannot outlive the mode that made it: any path that turns
  // this off - Done, Remove, or one nobody has written yet - clears the
  // selection through the one effect below, instead of each call site having
  // to remember to.
  const [selecting, setSelectingRaw] = useState(false)

  // Latest-value mirrors: the async flows below read state after an await, and
  // a stale closure there would decide against a gallery that has moved on.
  const itemsRef = useRef(items)
  const candsRef = useRef(candidates)
  const pendingRef = useRef(pending)
  const params = useRef<Record<string, number>>({})
  const quadRef = useRef<Pt[] | null>(null)
  // The crop each item's stored field was produced under, keyed by item id. A
  // field counted through a hand-drawn quad is a crop of the capture, and the
  // gallery card holds it — so reopening the card has to put the edit view back
  // into that crop. Without it the workbench showed a cropped picture while its
  // `quad` was null: Reset had nothing to undo and a second crop was measured
  // against pixels the server had already thrown away.
  const cropOf = useRef<Record<string, Pt[] | null>>({})
  useEffect(() => {
    itemsRef.current = items
    candsRef.current = candidates
    pendingRef.current = pending
    quadRef.current = quad
    params.current = { boundary: boundary ? 1 : 0, level: galleryLevel }
  })

  // The current triple-line rule, for staleAt - which is a stable callback and
  // must not close over a changing `boundary`.
  const boundaryRef = useRef(boundary)
  useEffect(() => { boundaryRef.current = boundary })

  const viewRef = useRef<View>(view)
  useEffect(() => { viewRef.current = view })

  // Leaving the overlap review with pairs still undecided is a cancel, whoever
  // asks for it: the review screen's own "Back to the gallery", App's routing,
  // anything. Those captures are parked at status "pending" — a hold that only
  // a decision used to lift — so walking away stranded them in the gallery with
  // a spinner and no way back. Cancelling now means "no merges": the holds are
  // released and whatever still owes a count is counted. Wired through a ref
  // because the release path needs countUncounted, which is defined below.
  const cancelReview = useRef<(() => void) | null>(null)
  const setView = useCallback((v: View) => {
    if (viewRef.current === "review" && v !== "review" && candsRef.current.length) {
      cancelReview.current?.()      // it decides where we land
      return
    }
    setViewRaw(v)
  }, [])

  const seq = useRef(0)
  const newId = () => `it${++seq.current}`

  // One controller for every batch request; an unmount must not leave a queue
  // of counts running against a dead component.
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => { abort.current?.abort() }, [])

  const patch = useCallback((id: string, p: Partial<GalleryItem>) => {
    setItems(prev => prev.map(i => (i.id === id ? { ...i, ...p } : i)))
  }, [])

  const setStatusOf = useCallback((ids: string[], p: Partial<GalleryItem>) => {
    const s = new Set(ids)
    setItems(prev => prev.map(i => (s.has(i.id) ? { ...i, ...p } : i)))
  }, [])

  // An abort stops a run wherever it stands, so every capture it never reached
  // would otherwise sit at "queued"/"counting" for ever — a spinner nothing will
  // ever finish. Settle them before bailing out. A capture that already holds a
  // count goes back to it: a stopped Reprocess must not throw away the perfectly
  // good result the image had before the run started.
  const cancelSweep = useCallback((mine: Set<string>) => {
    setItems(prev => prev.map(i =>
      mine.has(i.id) && (i.status === "queued" || i.status === "counting")
        ? i.field
          ? { ...i, status: "ready" as ItemStatus }
          : { ...i, status: "error" as ItemStatus, error: "cancelled" }
        : i))
  }, [])

  /** Count a run of items and write each result straight back. A pool of
   *  `slotsRef.current` workers pulls items off the run in order; the server
   *  caps how many counts it will actually run at once (`count_slots`), so a
   *  slot count of 1 here still behaves exactly like the old strictly
   *  sequential loop. Returns the items that produced a field, in RUN order
   *  (not finish order - callers such as importSession match them back up
   *  against `seeds` by position), or null if the run was aborted (having
   *  swept whatever it never reached to "cancelled" first). */
  const runCounts = useCallback(async (
    run: GalleryItem[], p: Record<string, number>, ac: AbortController,
    /** Per-item quality rung, by index into `run`, for the one caller that has
     *  one: a restored session, where each capture carries the rung its count
     *  was saved at. `undefined` for an entry means `p.level`. */
    levels?: (number | undefined)[],
  ): Promise<GalleryItem[] | null> => {
    const mine = new Set(run.map(i => i.id))
    // Indexed by position in `run`, not pushed - with two workers, items
    // finish out of order, and callers (importSession, the lone-capture path)
    // depend on `counted` lining up with `run`/`seeds` by index.
    const counted: (GalleryItem | undefined)[] = new Array(run.length)
    // This run's own timing, which replaces the seeded rate as soon as one
    // image has finished. A mean over the run rather than the last image: one
    // slow capture should not make the whole estimate jump.
    let secs = 0, done = 0
    const runStart = performance.now()
    let next = 0
    let aborted = false

    const worker = async () => {
      while (!aborted) {
        const idx = next++
        if (idx >= run.length) return
        const it = run[idx]
        if (ac.signal.aborted) { aborted = true; return }
        const itemLevel = levels?.[idx]
        const params = itemLevel ? { ...p, level: itemLevel } : p
        // The rate is recorded against the rung this capture actually ran at, or
        // a restored session's mixed rungs would all feed one average.
        const lvl = Number(params.level) || DEFAULT_LEVEL
        patch(it.id, { status: "counting" })
        const t0 = performance.now()
        // One ticket per capture, followed for exactly as long as its own
        // request, keyed to the card so two counts running at once do not
        // stomp each other's progress on the bus.
        const token = newToken()
        const untrack = trackCount(token, it.id)
        try {
          const data = await apiCount({
            token,
            files: it.files, params,
            // The card's crop is a counting input like any other. Sending null
            // here made a restored session recount every cropped capture over
            // its whole frame, so the gallery disagreed with the card until
            // someone opened it.
            autocrop: "", quad: cropOf.current[it.id] ?? null,
            // A two-file item is always a confirmed pair - see the producers
            // listed on GalleryItem.files in lib/types.ts. That claim must be
            // stitched or refused, never silently re-litigated into two fields.
            pair: it.files.length > 1,
            stages: false, signal: ac.signal,
          })
          // A merged item carries both captures, and one field back means the
          // server stitched them. Two means it refused the seam and counted each
          // capture on its own - storing field[0] would put one capture's count
          // under both captures' names.
          if (it.files.length > 1 && data.fields.length !== 1) {
            throw new Error(REFUSED_STITCH_MSG)
          }
          const field0 = data.fields[0] ?? null
          // Cannot happen for a single capture or a confirmed pair - app.py
          // raises a whole-request 400 (caught below) rather than hand back one
          // field carrying a per-field refusal when there is only ever one
          // field to begin with. Guarded anyway: GalleryItem.field is always a
          // CountedField, never a FailedField (see types.ts), and this is the
          // one place a server response could disagree with that.
          if (field0 && isFailedField(field0)) throw new Error(field0.error)
          const field = field0
          // Record WHICH triple-line rule produced this number, so a later
          // toggle can mark the card stale - `field.level` alone cannot say it.
          const countedBoundary = !!params.boundary
          patch(it.id, { field, status: "ready", countedBoundary })
          if (field) counted[idx] = { ...it, field, status: "ready", countedBoundary }
          secs += (performance.now() - t0) / 1000
          rate.current[lvl] = secs / ++done
        } catch (e) {
          if (isAbort(e)) { aborted = true; untrack(); return }
          patch(it.id, { status: "error", error: errText(e) })
        } finally {
          untrack()
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(slotsRef.current, run.length) }, worker))
    if (aborted) { cancelSweep(mine); return null }

    const result = counted.filter((x): x is GalleryItem => !!x)
    // Wall-clock rate across the whole run: with two counts in flight, the
    // per-image mean above over-states a batch's actual wait by roughly the
    // parallel gain, so the batch ETA needs its own figure. Keyed by the
    // request's own level - a restored session's mixed per-item rungs still
    // share one wall clock, and that is the number a batch ETA is for.
    const baseLvl = Number(p.level) || DEFAULT_LEVEL
    batchRate.current[baseLvl] =
      (performance.now() - runStart) / 1000 / Math.max(1, result.length)
    return result
  }, [patch, cancelSweep])

  /** Take two captures off overlap hold. A capture that already carries a count
   *  goes back to it; one that does not is queued, because overlaps are now
   *  decided BEFORE counting and a split pair still owes two counts. */
  const releaseHold = useCallback((ids: string[]) => {
    const s = new Set(ids)
    setItems(prev => prev.map(i => (s.has(i.id) && i.status === "pending"
      ? { ...i, status: (i.field ? "ready" : "queued") as ItemStatus } : i)))
  }, [])

  /** Every item still waiting for a count once the overlap queue is empty.
   *  This is where ALL counting happens for a batch that had overlaps: the
   *  review phase decides seams and nothing else, so a merged pair is in this
   *  run like any other item. Callers that just changed `items` write the new
   *  list into itemsRef first - it is a render behind, and a merged item that
   *  is not in it yet would be left queued for ever. */
  const countUncounted = useCallback(async () => {
    // The board is done with, so its footnote is too: carrying it into the next
    // batch would report this run's gaps against that run's captures.
    setUnpaired([])
    const run = itemsRef.current.filter(i => !i.field && i.status !== "error")
    if (!run.length) { setView("gallery"); return }
    setView("processing")
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setStatusOf(run.map(i => i.id), { status: "queued" })
    await runCounts(run, params.current, ac)
    setView("gallery")
  }, [runCounts, setStatusOf, setView])

  useEffect(() => {
    cancelReview.current = () => {
      const held = [...new Set(candsRef.current.flatMap(c => [c.aId, c.bId]))]
      candsRef.current = []
      setCandidates([])
      releaseHold(held)
      void countUncounted()
    }
  }, [releaseHold, countUncounted])

  /** Drop decided/void candidates and go wherever that leaves us. */
  const settle = useCallback((keep: (c: OverlapCandidate) => boolean) => {
    const rest = candsRef.current.filter(keep)
    candsRef.current = rest
    setCandidates(rest)
    if (rest.length) { setView("review"); return }
    void countUncounted()
  }, [countUncounted, setView])

  // ---------- intake ----------
  const stage = useCallback((files: File[]) => {
    if (!files.length) return
    // Name + size is the identity a user actually has: dropping the same folder
    // twice must not queue every capture a second time — and a capture already
    // counted in the gallery is just as much a duplicate as a staged one.
    const seen = new Set([
      ...itemsRef.current.flatMap(i => i.files.map(keyOf)),
      ...pendingRef.current.map(keyOf),
    ])
    const add: File[] = []
    for (const f of files) {
      const k = keyOf(f)
      if (seen.has(k)) continue
      seen.add(k)
      add.push(f)
    }
    // A mixed drop stages only the new captures; a drop of nothing but
    // duplicates has no confirm screen to show, so it says why instead.
    // On the confirm screen there is no gallery yet — the duplicate is sitting
    // in the list right in front of the user, and naming a screen they are not
    // on reads as a different, missing place.
    if (!add.length) {
      toast.info(viewRef.current === "confirm" ? "Already staged." : "Already in the gallery.")
      return
    }
    setPending(prev => {
      const have = new Set(prev.map(keyOf))
      const fresh = add.filter(f => !have.has(keyOf(f)))
      return fresh.length ? [...prev, ...fresh] : prev
    })
    setView("confirm")
  }, [setView])

  const removePending = useCallback((name: string, size?: number) => {
    setPending(prev => {
      const i = prev.findIndex(f => f.name === name && (size === undefined || f.size === size))
      return i < 0 ? prev : [...prev.slice(0, i), ...prev.slice(i + 1)]
    })
  }, [])

  // Cancelling the staging screen goes back where the user came from. Once a
  // session holds counted captures, that is the gallery: dropping them onto the
  // intake screen would hide every count behind a drop zone with no way back.
  const clearPending = useCallback(() => {
    setPending([])
    setManual([])
    nameGroupsTouched.current = false
    setNameGroups(false)
    setView(itemsRef.current.length > 0 ? "gallery" : "intake")
  }, [setView])

  const pendingKeys = useMemo(() => pending.map(keyOf), [pending])

  /** How the staged filenames split, recomputed from what is staged RIGHT NOW.
   *  Derived, never stored: grouping captured at drop time goes stale the
   *  moment a capture is removed, and the sweep would then run against a set
   *  that no longer exists. */
  const autoGroups = useMemo(() => groupByName(pending.map(f => f.name)), [pending])

  /** The same rule for the hand-made board: a capture the user removed cannot
   *  leave a band behind naming it. Pruned on the way out rather than in an
   *  effect, so there is never a render where a band shows a file that is gone.
   */
  const manualGroups = useMemo(
    () => pruneGroups(manual, pendingKeys), [manual, pendingKeys])
  const custom = manualGroups.length > 0

  /** What the screen draws, always as editable bands with identities — the
   *  automatic answer seeded into the same shape when nobody has edited yet.
   *  That is what lets every band carry a rename and a drop target without the
   *  screen having to know which mode it is in. */
  const board = useMemo(
    () => (custom ? manualGroups : seedFromAuto(pendingKeys, autoGroups)),
    [custom, manualGroups, pendingKeys, autoGroups])
  const groups = useMemo(
    () => projectGroups(pendingKeys, board), [pendingKeys, board])

  /** Every board edit goes through here: it seeds from the automatic answer the
   *  first time, so `addGroup`/`assignGroup` never have to know whether the
   *  user has customised yet. */
  const editGroups = useCallback(
    (fn: (g: ManualGroup[]) => ManualGroup[]) => {
      setManual(prev => {
        const base = pruneGroups(prev, pendingKeys)
        // The FIRST edit builds on the very bands the user is looking at, not
        // on a fresh `seedFromAuto`: that would mint fresh ids, and the id they
        // just dropped onto would name a group that no longer exists.
        return fn(base.length ? base : board)
      })
      nameGroupsTouched.current = true
      setNameGroups(true)
    },
    [pendingKeys, board])

  /** Put these captures in a brand-new group, taking them out of wherever they
   *  were. Used by both the selection bar and a drag onto empty space. */
  const addGroup = useCallback(
    (keys: string[]) => editGroups(g => groupFrom(g, keys)), [editGroups])

  /** Move captures into `target`, or out to the ungrouped tray when it is null.
   *  A group left empty by the move disappears on its own. */
  const assignGroup = useCallback(
    (keys: string[], target: string | null) => editGroups(g => assignTo(g, keys, target)),
    [editGroups])

  /** Break a band up: its captures go back to the tray, the band goes away. */
  const ungroup = useCallback(
    (id: string) => editGroups(g => {
      const hit = g.find(x => x.id === id)
      return hit ? assignTo(g, hit.keys, null) : g
    }),
    [editGroups])

  const renameGroup = useCallback(
    (id: string, name: string) =>
      editGroups(g => g.map(x => (x.id === id ? { ...x, name } : x))),
    [editGroups])

  /** Hand the board back to the filename rule. */
  const resetGroups = useCallback(() => setManual([]), [])

  // Arm the switch the first time a staged batch shows a naming pattern, and
  // keep re-deciding as captures are added or removed - until the user works
  // the switch themselves, after which it is theirs for the rest of the batch.
  // The FILENAME pattern, never the board: this is what the one-time flyout
  // announces ("the names line up, the sweep will be faster"), and a board the
  // user built by hand has nothing to announce about names.
  const armed = hasNamePattern(autoGroups)
  useEffect(() => {
    if (nameGroupsTouched.current) return
    // oxlint-disable-next-line react/set-state-in-effect
    setNameGroups(armed)
  }, [armed])

  const toggleNameGroups = useCallback((on: boolean) => {
    nameGroupsTouched.current = true
    setNameGroups(on)
  }, [])

  /** Put one gallery item on the workbench. Takes the item rather than its id
   *  because the lone-capture path opens a card the instant its count lands,
   *  and `itemsRef` is a render behind at that moment — looking the id up there
   *  would find a field-less item and make the workbench order the same count a
   *  second time. */
  const openGalleryItem = useCallback((it: GalleryItem) => {
    setActiveId(it.id)
    setView("edit")
    // A run in flight owns this card: its `field` is the PREVIOUS count, and
    // seeding it would put a stale result on the workbench and re-record it as
    // satisfied, so the level the run is counting at would never appear.
    // "pending" belongs here too: an undecided overlap owes a decision, not a
    // count, so opening the card must not quietly produce one and call it ready.
    const inFlight = it.status === "counting" || it.status === "queued" ||
      it.status === "pending"
    const crop = cropOf.current[it.id] ?? null
    // At its own level, not the gallery's: opening a card must not be a way to
    // silently recount an image someone pinned higher. A field with no level at
    // all - counted with raw engine params, which this UI never does - has no
    // opinion to honour, so it opens at the gallery's.
    // Its own count comes with it: the gallery already ran this capture, and
    // opening the card is a look at that result, not a reason to reproduce it.
    // A cropped field cannot be seeded either: openFiles clears the quad, so the
    // seed would stand for an uncropped view it is not. The crop is restored
    // instead and the count is remade through it.
    const seed = inFlight || crop ? undefined : (it.field ?? undefined)
    // While a run owns the card, `it.field.level` is the level of the count
    // being REPLACED. Opening at it would count the same capture twice at two
    // different levels and let the older one win the write-back race.
    // it.files.length > 1 is always a confirmed pair - see the producers
    // listed on GalleryItem.files in lib/types.ts - and the card must keep
    // honouring that claim on every later re-count, not just this one, hence
    // passing it through explicitly rather than leaving openFiles to infer it.
    openFiles(
      it.files, inFlight ? galleryLevel : (it.field?.level || galleryLevel), seed,
      it.files.length > 1,
    )
    if (crop) setQuad(crop)          // after openFiles, which clears it
  }, [openFiles, setQuad, setView, galleryLevel])

  // ---------- batch counting ----------
  /** Count a staged drop: sweep for overlaps, decide them, count what is left.
   *  `openAfter` is the lone-capture path — the same machinery, one different
   *  destination at the end, so the gallery is built identically either way. */
  const runBatch = useCallback(async (
    staged: File[],
    openAfter = false,
    /** Confine the overlap sweep to captures whose filenames share a prefix.
     *  Passed in rather than read from state so the run uses the switch as it
     *  stood when Count was pressed. */
    useGroups = false,
    /** Hand-made groups, when the user built any. Same reason as `useGroups`:
     *  the run uses the board as it stood when Count was pressed, not as the
     *  screen left it while the sweep was in flight. */
    manualGroups: ManualGroup[] = [],
  ) => {
    if (!staged.length) return
    // One capture cannot overlap anything, so it skips the sweep screen and
    // goes straight to counting - a sweep that can only report "none" is a
    // second of the user's time spent saying nothing.
    const sweeping = staged.length > 1
    setView(sweeping ? "scan" : "processing")

    // The sweep plan is worked out BEFORE the cards exist, because the cards
    // carry it: a band on the counted screen is the band the sweep used, and
    // nothing downstream should have to reconstruct it from filenames again.
    //
    // The filter lives HERE and nowhere else: /api/pairs and
    // pipeline.group_captures never learn what a filename is, so the standing
    // "renaming a file must not change the answer" ruling still holds for every
    // pair that is actually tested. Grouping can only withhold a candidate,
    // never invent one.
    //
    // MEASURED on data/png: 69 captures, 2346 comparisons down to 234.
    // Recomputed from `staged`, not read off the confirm screen's memo:
    // `pending` is already cleared by the time this runs, and a grouping
    // captured earlier could describe a set that no longer exists. Hand-made
    // groups survive that by holding file keys rather than indices, so they are
    // simply re-projected onto whatever is actually staged.
    const stagedKeys = staged.map(keyOf)
    const hand = useGroups ? pruneGroups(manualGroups, stagedKeys) : []
    const sweeps: NameGroup[] = !useGroups
      ? [{ key: "", indices: staged.map((_, i) => i), ungrouped: true }]
      : hand.length
        ? projectGroups(stagedKeys, hand)
        : groupByName(staged.map(f => f.name))
    // What this run is actually going to cost, in the unit the wait is made of.
    // A short sweep gets no bar: it is over before one could say anything, and
    // a bar that appears and vanishes is a flicker, not an answer.
    const totalCmp = sweepComparisons(sweeps.map(g => g.indices.length))
    const tracked = sweeping && totalCmp >= PROGRESS_MIN_COMPARISONS
    setScan(sweeping
      ? { n: staged.length, found: null, ...(tracked ? { progress: { done: 0, total: totalCmp, eta: "" } } : {}) }
      : null)

    // Only a named band is a band. The bucket the prefix rule gave up on is
    // "everything else", which is exactly what an absent group already means.
    const bandOf = new Map<number, string>()
    for (const g of sweeps) {
      if (g.ungrouped || !g.key) continue
      for (const i of g.indices) bandOf.set(i, g.key)
    }

    const fresh: GalleryItem[] = staged.map((f, i) => ({
      id: newId(), files: [f], name: f.name, field: null, status: "queued" as ItemStatus,
      ...(bandOf.has(i) ? { group: bandOf.get(i) } : {}),
    }))
    setItems(prev => [...prev, ...fresh])
    setBatchIds(new Set(fresh.map(i => i.id)))

    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac

    const mine = new Set(fresh.map(f => f.id))

    // Overlaps are decided BEFORE anything is counted. A merged pair is counted
    // once, as the stitched field, so counting both halves first was work the
    // merge threw away - and at "three looks, eight ways" that is minutes.
    let found: OverlapCandidate[] = []
    // Why a capture got no partner - different sizes, an unstitchable seam.
    // api_pairs reports one only for a capture that ended up in no pair at
    // all, so it names a real gap rather than a pair the review screen shows.
    let skipped: SkippedPair[] = []
    // Which index pairs the server actually offered, so a group the user built
    // by hand can be checked against the answer.
    const pairedIdx = new Set<string>()
    const idxKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
    if (staged.length > 1) {
      // One request per band, or one over everything when the switch is off.
      // Comparisons finished by the bands already answered. The band in flight
      // reports its own count from the server and is added on top, so the bar
      // measures the whole run rather than restarting at each band.
      let doneBefore = 0
      // One clock for the whole run, not one per band: the user is waiting for
      // the sweep, and an estimate that reset at every band would be answering
      // a question about the band instead.
      const startedAt = Date.now()
      try {
        for (const g of sweeps) {
          // A lone capture has nobody to pair with, so its request could only
          // ever come back empty. Skipping it is also what keeps a drop of
          // unrelated names from firing one near-empty request per file.
          if (g.indices.length < 2) continue
          const bandCmp = sweepComparisons([g.indices.length])
          // One name per band, unique across tabs: the registry it lands in is
          // one dictionary on a server that may be serving two windows, and the
          // gallery's own `it3` ids repeat in every one of them.
          const job = tracked ? newJobId() : undefined
          const stop = job ? pollSweep(job, doneBefore, totalCmp, startedAt, ac, setScan) : undefined
          let res
          try {
            res = await fetchPairs(g.indices.map(i => staged[i]), ac.signal, job)
          } finally {
            stop?.()
          }
          doneBefore += bandCmp
          // The band is answered, so its comparisons are done exactly - no
          // poll needed, and no chance of the bar sitting one tick short while
          // the next band's uploads go up.
          if (tracked && !ac.signal.aborted) {
            setScan(prev => (prev
              ? { ...prev, progress: {
                  done: doneBefore, total: totalCmp,
                  eta: remainingLabel(doneBefore, totalCmp, Date.now() - startedAt),
                } }
              : prev))
          }
          if (ac.signal.aborted) { cancelSweep(mine); return }
          // Every index the server reports is local to the slice that was
          // uploaded. Mapped back through that slice's own index list, never by
          // arithmetic - an offset would be right until a group was skipped.
          const at = (k: number) => g.indices[k]
          skipped = [...skipped,
            ...res.skipped.map(d => ({ ...d, i: at(d.i), j: at(d.j) }))]
          for (const p of res.pairs) pairedIdx.add(idxKey(at(p.i), at(p.j)))
          found = [...found, ...res.pairs
            .filter(p => fresh[at(p.i)] && fresh[at(p.j)])
            .map(p => ({
              aId: fresh[at(p.i)].id, bId: fresh[at(p.j)].id,
              dx: p.dx, dy: p.dy, seam_y: p.seam_y, ncc: p.ncc, swapped: p.swapped,
              rotation_deg: p.rotation_deg,
              aImage: p.a_image, bImage: p.b_image,
            }))]
        }
      } catch (e) {
        if (isAbort(e)) { cancelSweep(mine); return }
        found = []        // pairing is advisory: a failure just leaves every
      }                   // capture standing on its own

      // Answer the claims. Putting two captures in a group by hand says "these
      // two are one field"; the sweep still decides from the pixels, but a
      // claim it turned down has to be SAID. Silent is the one outcome that
      // cannot be told apart from a merge that worked: the user would see two
      // separate counts and no reason, and a field counted twice is a doubled
      // cells/mL. `skipped` is the channel the scan screen already reads.
      for (const [i, j] of claimedPairs(stagedKeys, hand)) {
        if (pairedIdx.has(idxKey(i, j))) continue
        if (skipped.some(sk => idxKey(sk.i, sk.j) === idxKey(i, j))) continue
        skipped = [...skipped, {
          i, j,
          names: [staged[i].name, staged[j].name],
          reason: "you grouped these two, but they do not overlap. "
            + "Each one is counted as its own field.",
        }]
      }
    }
    if (ac.signal.aborted) { cancelSweep(mine); return }

    if (sweeping) {
      // The verdict gets its own beat. "No overlaps found" is the answer to a
      // question the user asked by pressing Count, and a screen that flashes it
      // for one frame on the way to a progress bar has not answered anything.
      setScan({ n: staged.length, found: found.length, skipped })
      // A reason the user has to read needs longer than a verdict they only
      // have to see.
      await pause(skipped.length ? 3200 : found.length ? 950 : 1500, ac)
      setScan(null)
      if (ac.signal.aborted) { cancelSweep(mine); return }
    }

    if (found.length) {
      setStatusOf(found.flatMap(c => [c.aId, c.bId]), { status: "pending" })
      // A candidate outlives its captures if anything removed one while the
      // offer stood, and a dangling pair resurfaces on the next batch's review
      // screen naming a capture that is not there. Outstanding offers for
      // captures that still exist are real, so they are kept, not cleared.
      const alive = new Set(itemsRef.current.map(i => i.id))
      const next = [...candsRef.current.filter(c => alive.has(c.aId) && alive.has(c.bId)),
        ...found]
      candsRef.current = next
      setCandidates(next)
      setUnpaired(skipped)
      setView("review")
      return              // the leftovers are counted once the queue is empty
    }
    setView("processing")
    const counted = await runCounts(fresh, params.current, ac)
    if (!counted) return
    // The lone capture goes straight to its own result. A count that failed has
    // nothing to show, so that one lands on the gallery, where the card carries
    // the error and the retry.
    if (openAfter && counted.length === 1) { openGalleryItem(counted[0]); return }
    setView("gallery")
  }, [runCounts, cancelSweep, setStatusOf, setView, openGalleryItem])

  const confirm = useCallback(async () => {
    const staged = pending
    if (!staged.length) return
    const useGroups = nameGroups
    const board = manualGroups
    setPending([])
    setManual([])
    nameGroupsTouched.current = false
    await runBatch(staged, false, useGroups, board)
  }, [pending, nameGroups, manualGroups, runBatch])

  /** Every drop enters here. A drop that is exactly ONE capture the session has
   *  never seen, with nothing already staged, has no decision to make: no
   *  confirm screen, no overlap sweep (one capture cannot overlap anything) and
   *  no gallery of one card between the user and their number. It counts at the
   *  default level and opens the workbench; Back goes to the gallery, which
   *  holds the card the batch path would have built, because this IS the batch
   *  path — only the last line differs. Anything else keeps the confirm screen.
   */
  const intake = useCallback((files: File[]) => {
    const lone = files.length === 1
      && !pendingRef.current.length
      && viewRef.current !== "confirm"
      && !itemsRef.current.some(i => i.files.some(f => keyOf(f) === keyOf(files[0])))
    if (!lone) { stage(files); return }   // it dedupes and says why, as before
    void runBatch(files, true)
  }, [stage, runBatch])

  /** Captures dropped while a run owns the screen, held so they are not simply
   *  lost. `intakeDropRef` breaks the circular dependency: the "run landed"
   *  effect below calls back into `intakeDrop` itself, which is defined after
   *  it needs to exist. */
  const [dropStash, setDropStash] = useState<File[]>([])
  const intakeDropRef = useRef<(files: File[]) => void>(() => {})

  /** The guarded door every drop must use, wherever it lands: the whole-window
   *  drop (App.tsx) and the workbench's own DropZone (Viewer.tsx) both call
   *  this instead of intake() directly, so the two paths cannot drift apart.
   *  A run owns the screen while it lasts (the scan, processing and review
   *  views below block a drop) — those drops are stashed rather than refused
   *  outright, and offered back once the run lands (see the effect below). A
   *  non-capture file is refused with a reason instead of silently vanishing,
   *  and only what is left is staged. */
  const intakeDrop = useCallback((files: File[]) => {
    if (!files.length) return
    if (viewRef.current === "scan" || viewRef.current === "processing"
      || viewRef.current === "review") {
      setDropStash(prev => [...prev, ...files])
      toast.info(
        `Busy with the current batch. ${files.length} `
        + `${files.length === 1 ? "capture" : "captures"} will be offered once it finishes.`)
      return
    }
    const fs = files.filter(isCapture)
    const bad = files.filter(f => !isCapture(f))
    if (bad.length) toast.error(rejectMessage(bad))
    if (fs.length) intake(fs)
  }, [intake])
  useEffect(() => { intakeDropRef.current = intakeDrop })

  /** The moment a run stops owning the screen, any stash built up during it is
   *  offered back — once, as an action, never auto-added: a drop mid-run was
   *  a decision the user made about a different batch than the one that just
   *  landed, and re-running intakeDrop on click puts it through every guard
   *  (dedupe, non-capture filter) exactly as if it had just been dropped. */
  const prevView = useRef(view)
  useEffect(() => {
    const busy = (v: View) => v === "scan" || v === "processing" || v === "review"
    if (busy(prevView.current) && !busy(view) && dropStash.length) {
      const stashed = dropStash
      setDropStash([])
      const n = stashed.length
      toast(`${n} ${n === 1 ? "capture" : "captures"} were dropped while busy.`, {
        action: {
          label: `Add the ${n} ${n === 1 ? "capture" : "captures"} you dropped`,
          onClick: () => intakeDropRef.current(stashed),
        },
      })
    }
    prevView.current = view
  }, [view, dropStash])

  // ---------- overlap decisions ----------
  /** Record one seam decision. The review phase is strictly about seams: a
   *  merge builds the joined item but counts NOTHING, so no count is paid for
   *  until every mergeable pair has been answered and countUncounted() runs
   *  the whole batch at once. */
  /** Apply a decision to several pairs at once, then settle ONCE.
   *
   *  The board answers every pair it shows in one press, so the per-pair path
   *  this used to take would have run one setItems, one setBatchIds and one
   *  settle per pair - and each settle can start the batch run, so the second
   *  one would be ordering a count against a list the first had already moved
   *  on from. Everything is folded into one `next` array instead, written to
   *  the mirror before the single settle at the end.
   *
   *  `picks` is applied in order. A merge swallows its two captures, so a later
   *  pick naming one of them has nothing left to act on and is dropped - the
   *  same cascade the one-at-a-time path got from its `settle` filter.
   */
  const decideAll = useCallback(async (
    picks: readonly { c: OverlapCandidate; action: "merge" | "split" }[],
  ) => {
    let next = itemsRef.current
    /** Captures already folded into a merged item by an earlier pick. */
    const gone = new Set<string>()
    /** aId/bId -> the merged item that replaced them, for the batch set. */
    const swaps: { from: [string, string]; to: string }[] = []
    /** Split pairs come off hold here rather than through releaseHold, so the
     *  whole screen's worth of changes is one array and itemsRef stays true. */
    const freed = new Set<string>()

    for (const { c, action } of picks) {
      if (gone.has(c.aId) || gone.has(c.bId)) continue
      if (action === "split") { freed.add(c.aId); freed.add(c.bId); continue }

      const a = next.find(i => i.id === c.aId)
      const b = next.find(i => i.id === c.bId)
      if (!a || !b) continue

      // Both captures in one item, still uncounted: the server stitches the pair
      // and counts the joined field once when the run comes - counting the two
      // halves separately would double-count the overlap band.
      const merged: GalleryItem = {
        id: newId(), files: [a.files[0], b.files[0]], name: `${a.name} + ${b.name}`,
        field: null, status: "queued", mergedFrom: [a.name, b.name],
        // Two halves of one field were in one band by construction; the field
        // they become belongs to it too, or the merge would quietly drop a
        // capture out of the sample it was counted for.
        ...(a.group ?? b.group ? { group: a.group ?? b.group } : {}),
      }
      const at = Math.max(0, next.findIndex(i => i.id === c.aId || i.id === c.bId))
      const rest = next.filter(i => i.id !== c.aId && i.id !== c.bId)
      next = [...rest.slice(0, at), merged, ...rest.slice(at)]
      gone.add(c.aId); gone.add(c.bId)
      swaps.push({ from: [c.aId, c.bId], to: merged.id })
    }

    if (freed.size) {
      next = next.map(i => (freed.has(i.id) && i.status === "pending"
        ? { ...i, status: (i.field ? "ready" : "queued") as ItemStatus } : i))
    }

    // The mirror is written here rather than waited for: settle() may start the
    // batch run this same tick, and itemsRef is a render behind.
    itemsRef.current = next
    setItems(next)
    // One field where there were two captures: each merged item inherits their
    // place in the batch, so the run still accounts for every capture staged.
    if (swaps.length) {
      setBatchIds(prev => {
        if (!prev) return prev
        const s = new Set(prev)
        let touched = false
        for (const { from: [aId, bId], to } of swaps) {
          if (!s.has(aId) && !s.has(bId)) continue
          s.delete(aId); s.delete(bId); s.add(to)
          touched = true
        }
        return touched ? s : prev
      })
    }
    // What survives: a candidate nobody answered AND whose two captures both
    // still exist. Not simply "none" - `candidates` can also hold an offer left
    // standing by an earlier batch (runBatch keeps the live ones) or one the
    // user has just made by hand, and those were never on this board.
    const answered = new Set(picks.map(p => p.c))
    settle(x => !answered.has(x) && !gone.has(x.aId) && !gone.has(x.bId))
  }, [settle])

  /** One pair. The hand-pairing path (`addManualPair`) offers exactly one, and
   *  the bulk board is the same engine over the whole list. */
  const decide = useCallback((c: OverlapCandidate, action: "merge" | "split") =>
    decideAll([{ c, action }]), [decideAll])

  const addManualPair = useCallback(async (aId: string, bId: string) => {
    const a = itemsRef.current.find(i => i.id === aId)
    const b = itemsRef.current.find(i => i.id === bId)
    if (!a || !b || a === b) throw new Error("Pick two different captures.")

    // Read at call time, not captured earlier: loadSession, a new batch and
    // reprocess all reassign/abort this same controller, and this is a user
    // action, not a sweep — it must be cancellable like the others rather
    // than barging in with a stale answer once whatever cancelled it has
    // already moved the gallery on.
    // `abort.current` is guaranteed set here: hand-pairing needs two selected
    // cards, which needs the gallery view, which is only reachable after a
    // sweep has run and assigned it. If a future path ever reached this
    // function without a sweep first, the optional chain above would degrade
    // silently to an un-cancellable request instead of failing loudly.
    const signal = abort.current?.signal
    try {
      const res = await fetchPairs([a.files[0], b.files[0]], signal)
      // stitch_pair's own gate is the authority. A forced stitch of two
      // captures that do not overlap produces a confidently wrong count, so
      // it is refused.
      if (!res.pairs.length) throw new Error("These two captures do not overlap.")

      const p = res.pairs[0]
      setStatusOf([aId, bId], { status: "pending" })
      const next = [...candsRef.current,
        { aId, bId, dx: p.dx, dy: p.dy, seam_y: p.seam_y, ncc: p.ncc, swapped: p.swapped,
          rotation_deg: p.rotation_deg }]
      candsRef.current = next
      setCandidates(next)
      setView("review")
    } catch (e) {
      // Whatever cancelled this has already decided where the gallery lands;
      // bail quietly rather than fighting it, and leave a/b exactly as it did.
      if (isAbort(e)) return
      throw e
    }
  }, [setStatusOf, setView])

  // ---------- gallery ----------
  const openItem = useCallback((id: string) => {
    const it = itemsRef.current.find(i => i.id === id)
    if (it) openGalleryItem(it)
  }, [openGalleryItem])

  // ---------- reprocess ----------
  /** The items a Reprocess at `level` would actually run: everything whose count
   *  was not made at that exact level, in either direction, OR was made under
   *  the other triple-line rule. An item that failed or has no count yet
   *  carries level 0, so it is always included.
   *
   *  `boundary` belongs here for the same reason `level` does - it changes the
   *  number the server returns. Judging on the level alone meant a triple-line
   *  toggle silently left a gallery holding two different counting rules at
   *  once (flow audit 2026-09-21, row 1). A card counted before this field
   *  existed has `countedBoundary` undefined, which is read as "not the current
   *  rule" only when the rule is off, so the default-on case does not sweep
   *  every restored card into a recount.
   */
  const staleAt = useCallback((level: number, only?: Set<string>) =>
    itemsRef.current.filter(i => (!only || only.has(i.id))
      && (needsLevel(i.field?.level, level)
        || (!!i.field && (i.countedBoundary ?? true) !== boundaryRef.current))),
  [])

  /** Recount at the gallery level: `ids` when a selection is standing, else
   *  every image that needs it. `keepEdits` false drops the hand corrections of
   *  exactly the fields being recounted, never anyone else's. */
  const reprocess = useCallback(async (ids?: string[], keepEdits = true, force = false) => {
    // `force`: the same-level recount - every targeted card, each at its OWN
    // rung, as the workbench's quiet button does for one image.
    const only = ids && new Set(ids)
    const run = force
      ? itemsRef.current.filter(i => (!only || only.has(i.id)) && (i.field || i.status === "error"))
      : staleAt(galleryLevel, only)
    if (!run.length) return
    if (!keepEdits) {
      // Only the hand corrections. The excluded squares are a choice about the
      // field, not a correction to a count, and "start clean" was not an offer
      // to throw those away too.
      const drop = new Set(run.flatMap(i => (i.field ? [fingerprintOf(i.field)] : [])))
      setByField(prev => {
        const next = { ...prev }
        for (const k of drop) {
          if (next[k]) next[k] = { ...next[k], edits: { added: [], removed: [] } }
        }
        return next
      })
    }
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    const mine = new Set(run.map(i => i.id))
    setRunIds(mine)
    setStatusOf([...mine], { status: "queued" })
    await runCounts(run, params.current, ac, force ? run.map(i => i.field?.level) : undefined)
    // Cleared whoever aborted it - Stop, a session load, a drop that starts a
    // fresh batch - but never on top of a NEWER run that has already claimed it.
    setRunIds(prev => (prev === mine ? null : prev))
  }, [galleryLevel, staleAt, runCounts, setStatusOf, setByField])

  /** Stop mid-run. Every image the run never reached keeps the count it had. */
  const stopReprocess = useCallback(() => {
    abort.current?.abort()
    setRunIds(null)
  }, [])

  // A re-count in the edit view is that item's new result: write it straight
  // back, so the gallery card and any export stay in step with the edit view.
  // The edit view's count is debounced, so on opening another item `fields`
  // still holds the previous one's. `fieldsFor` is the files array that count
  // was made from, and openItem hands openFiles the item's own array, so
  // reference equality is exact provenance — names are not, two captures from
  // different sessions can carry the same filename.
  useEffect(() => {
    const f = fields[0]
    if (!activeId || !f) return
    const it = itemsRef.current.find(i => i.id === activeId)
    // A run still owns a counting/queued card, and an undecided overlap owns a
    // pending one. Writing back here would overwrite the run's newer result
    // with the edit view's, and would flip a pending card to "ready" while its
    // overlap decision is still outstanding.
    const owned = it?.status === "counting" || it?.status === "queued" ||
      it?.status === "pending"
    if (it && !owned && fieldsFor === it.files) {
      // The crop travels with the field it produced (null once Reset clears it),
      // so reopening the card reproduces exactly this view.
      cropOf.current[activeId] = quadRef.current
      // A per-field refusal (app.py: one bad group in an otherwise-good batch)
      // has no place in GalleryItem.field, which is always a CountedField -
      // write it to the item's own `error` instead, the same shape a failed
      // runCounts call already reports. Clear `field` too: GalleryGrid reads
      // item.field to compute the card's total and thumbnail, and leaving the
      // stale one in place would show a count that no longer has a result
      // behind it.
      patch(activeId, isFailedField(f)
        ? { field: null, status: "error", error: f.error }
        : { field: f, status: "ready", countedBoundary: boundaryRef.current })
      // The workbench just committed a rung; the gallery's own bar has to hear
      // about it. Without this the two levels drifted apart behind identical
      // bars: recount one capture at Finest, walk back, and every card - the
      // one just recounted included - wore a red "Finest -> Normal" downgrade
      // chip, and one press of the gallery's Reprocess undid the upgrade (flow
      // audit 2026-09-21, row 10). Raised only, never lowered: the gallery
      // level is a floor for the batch, and dropping the whole gallery to a
      // rung because one capture was recounted cheaply is not what that press
      // said.
      // The external system this effect synchronises with is the SERVER's
      // answer: `fields[0]` is a count that just landed, and the rung it was
      // made at is a fact about it, not something derivable during render. The
      // guard makes it converge in one extra render and never loop - it only
      // ever raises, and only when the landed field sits above the current
      // level, so the next pass cannot satisfy the condition again.
      // Functional, and `galleryLevel` is NOT a dep: with it listed, every
      // downward slider move re-ran this effect and snapped the level back up
      // to the last-opened capture's rung, so the gallery slider could not be
      // dragged below it (2026-09-21). Only a landed count may raise it.
      // oxlint-disable-next-line react/set-state-in-effect
      if (!isFailedField(f)) setGalleryLevel(l => Math.max(l, f.level))
    }
  }, [activeId, fields, fieldsFor, patch])

  const removeItems = useCallback((ids: string[]) => {
    const dead = new Set(ids)
    for (const id of ids) delete cropOf.current[id]
    setItems(prev => prev.filter(i => !dead.has(i.id)))
    setCandidates(prev => {
      const rest = prev.filter(c => !dead.has(c.aId) && !dead.has(c.bId))
      candsRef.current = rest
      return rest
    })
    setSelected(prev => new Set([...prev].filter(id => !dead.has(id))))
    setActiveId(id => (id && dead.has(id) ? null : id))
  }, [])

  /** Display-only rename. Hand edits are keyed to the FIELD fingerprint (the
   *  filenames the server echoes back plus the stitch offsets), never to this
   *  string, so renaming cannot detach a correction. It changes what the UI, the
   *  export file names and a saved session call the capture. */
  const renameItem = useCallback((id: string, name: string) => {
    const clean = name.trim()
    if (!clean) return
    setItems(prev => prev.map(i => (i.id === id ? { ...i, name: clean } : i)))
  }, [])

  /** Rename a band on the counted screen. Display only, like `renameItem`:
   *  bands never reach a count, so this cannot change a number. A name already
   *  in use would merge the two bands into one, which is a thing the user can
   *  do on purpose and never a thing that loses anything. */
  const renameBand = useCallback((group: string, name: string) => {
    const clean = name.trim()
    if (!clean) return
    setItems(prev => prev.map(i => (i.group === group ? { ...i, group: clean } : i)))
  }, [])

  /** Break a band up. Its captures keep their counts and fall into the
   *  ungrouped leftovers; with one band left the gallery goes back to a plain
   *  grid by itself. */
  const ungroupBand = useCallback((group: string) => {
    setItems(prev => prev.map(i => (i.group === group ? { ...i, group: undefined } : i)))
  }, [])

  /** Put a hand-picked selection into a band of its own, on the counted screen.
   *  The sweep's bands are made from filenames before anything is counted, and
   *  a run whose names formed no pattern arrives here as one heap - this is the
   *  way back. The name is a placeholder the user renames from the band's own
   *  header; picking one for them would be a guess, and an empty one would
   *  ungroup instead. Moving a capture out of a band it was swept into is
   *  allowed: a band is a label over counts, never a counting input. */
  const groupItems = useCallback((ids: string[], name?: string) => {
    if (!ids.length) return
    const set = new Set(ids)
    setItems(prev => {
      const taken = new Set(prev.map(i => i.group).filter(Boolean) as string[])
      let key = name?.trim() ?? ""
      if (!key) {
        let n = 1
        while (taken.has(`Group ${n}`)) n++
        key = `Group ${n}`
      }
      return prev.map(i => (set.has(i.id) ? { ...i, group: key } : i))
    })
  }, [])

  const toggleSelected = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const clearSelected = useCallback(() => setSelected(new Set()), [])

  // The one place the selection is cleared on leaving select mode: whatever
  // sets `selecting` false - Done, Remove, a future third path - clears it
  // here rather than at each call site having to remember to.
  // Leaving select mode clears the selection, in ONE place: this setter is the
  // only way `selecting` ever changes (the raw useState setter is private to
  // this hook and never exported), so Done, Remove and any path nobody has
  // written yet all come through here. No call site has to remember.
  // Not an effect: an effect runs after paint, so the reprocess bar and the
  // header's "N selected" would read the dead selection for one committed
  // frame - exactly the flicker this clear exists to prevent. Both setters
  // land in the same event, so React commits one render with both applied.
  const setSelecting = useCallback((on: boolean) => {
    setSelectingRaw(on)
    if (!on) setSelected(new Set())
  }, [])

  const selectAll = useCallback(
    () => setSelected(new Set(itemsRef.current.map(i => i.id))), [])

  /** Restore a saved session. The seeds replace whatever the gallery holds, and
   *  every one of them is recounted through the same sequential machinery a
   *  fresh batch uses — a session file stores captures and decisions, never
   *  counts, so what comes back is always what today's engine says.
   *
   *  Pair detection is deliberately skipped: each item was saved with its
   *  overlap decision already made, so a merged item recounts as its two-file
   *  self and a split one as a lone capture. Re-offering the same overlaps would
   *  ask the user to decide again what they already decided.
   *
   *  Hand corrections are not carried here at all. They live in
   *  `useCounter.byField`, keyed by field fingerprint (filenames + stitch
   *  geometry), and the recount reproduces those fingerprints exactly — so the
   *  restored edits reattach to their fields by themselves. That is the whole
   *  design: nothing has to map old ids onto new ones.
   *
   *  Crops DO travel: `SessionItemV1.crop` carries the quad each capture was
   *  counted through, so `cropOf` is rebuilt from the seeds against the freshly
   *  minted ids. It is replaced wholesale, never merged, so a restored item
   *  cannot inherit the crop of whatever held its id before. A seed with no crop
   *  - every item in a session written before this field existed - restores
   *  uncropped, as it always did. */
  const importSession = useCallback(async (
    seeds: SessionSeed[], opts?: { params?: Record<string, number> },
  ): Promise<GalleryItem[] | null> => {
    abort.current?.abort()

    // Ids are re-minted from this store's own counter. The ids inside a session
    // file were handed out by a different run of the app and could collide with
    // ones this session will mint later; they serve only to tie file entries to
    // items inside the file, and nothing outside it refers to them.
    const fresh: GalleryItem[] = seeds.map(s => ({
      id: newId(), files: s.files, name: s.name, field: null,
      status: "queued" as ItemStatus, mergedFrom: s.mergedFrom,
      ...(s.group ? { group: s.group } : {}),
    }))
    setItems(fresh)
    cropOf.current = Object.fromEntries(
      fresh.map((it, i) => [it.id, seeds[i].crop ?? null]))
    setBatchIds(new Set(fresh.map(i => i.id)))
    candsRef.current = []
    setCandidates([])
    setPending([])
    setSelected(new Set())
    setActiveId(null)
    // A restored session is a different list: keeping the previous scroll offset
    // would open the gallery part-way down it, on nothing the user chose.
    setGalleryScroll(0)
    setView(fresh.length ? "processing" : "gallery")
    if (!fresh.length) return []

    const ac = new AbortController()
    abort.current = ac
    // The restored parameters are handed in rather than read from the mirror:
    // the caller writes them to useCounter in this same tick, and `params` only
    // catches up on the next render — a whole session would count with the old
    // values.
    //
    // The LEVEL is each capture's own, when the file recorded one this app
    // still has (`sessionSeeds` drops a rung that no longer exists). It used to
    // be the gallery's for every card, which silently discarded the choice the
    // user saved: a session counted at Finest came back at whatever rung the
    // gallery opened on, with no warning and a different number (flow audit
    // 2026-09-21, row 2). A capture whose seed carries no level still falls
    // back to the gallery's, which is what every older session does.
    const base = { ...(opts?.params ?? params.current), level: galleryLevel }
    const counted = await runCounts(fresh, base, ac, seeds.map(s => s.level))
    if (!counted) return null            // aborted: the caller has nothing to check
    setView("gallery")
    // The counted fields go back to the caller so it can tell whether every
    // restored correction set found a field to attach to.
    return counted
  }, [runCounts, setView, galleryLevel])

  // A ref, read at click and at render: the estimate is an estimate, and a
  // re-render per finished image is what the progress panel already does.
  const rateFor = (level: number) => rate.current[level] ?? SEED_RATE[level] ?? 1

  return {
    view, setView, items, pending, candidates, unpaired, scan, batchIds, activeId,
    galleryScroll, setGalleryScroll, selected, toggleSelected, clearSelected, selectAll,
    selecting, setSelecting,
    // The staging screen's name grouping: how the staged files split, whether
    // the sweep will use that split, and whether the names formed a pattern at
    // all (which is what the one-time flyout announces).
    groups, nameGroups, toggleNameGroups, namePattern: armed,
    // The hand-made board: whether the user has taken it over, and the six
    // edits the confirm screen can make to it.
    customGroups: custom, board, addGroup, assignGroup, ungroup, renameGroup,
    resetGroups, pendingKeys,
    stage, intake, intakeDrop, removePending, clearPending, confirm, decide, decideAll,
    openItem, addManualPair,
    removeItems, renameItem, renameBand, ungroupBand, groupItems, importSession,
    // The crops the cards are holding, for a session save. A ref, so it is read
    // at save time rather than driving a re-render on every crop.
    cropsById: () => Object.fromEntries(
      Object.entries(cropOf.current).filter((e): e is [string, Pt[]] => !!e[1])),
    galleryLevel, setGalleryLevel, staleAt, reprocess, stopReprocess, runIds,
    // The card whose workbench count is still running. The count lives in the
    // counter provider, so walking back to the gallery does not stop it; this
    // is what lets that card say so until the write-back above lands.
    liveId: busy && activeId && items.find(i => i.id === activeId)?.files === files
      ? activeId : null,
    // A ref, read at click and at render: the estimate is an estimate, and a
    // re-render per finished image is what the progress panel already does.
    rateFor,
    // Wall-clock seconds per image across a whole run, for a BATCH ETA -
    // `rateFor` alone would over-state the wait once two counts run at once.
    // Before any run has finished at this level, fall back to `rateFor`
    // divided by 1.4 - the measured two-at-once wall-clock gain - as a seed;
    // `batchRate` overwrites it with the real figure once a run lands.
    batchRateFor: (level: number) =>
      batchRate.current[level] ?? rateFor(level) / (slotsRef.current > 1 ? 1.4 : 1),
  }
}

export type Gallery = ReturnType<typeof useGalleryState>
const Ctx = createContext<Gallery | null>(null)

export function GalleryProvider({ children }: { children: React.ReactNode }) {
  return <Ctx.Provider value={useGalleryState()}>{children}</Ctx.Provider>
}

// This file's whole job is to hand out the gallery store, so a non-component
// export here is the point, not an accident - same reasoning as
// DropZone.tsx:10-12.
// oxlint-disable-next-line react/only-export-components
export function useGallery(): Gallery {
  const v = useContext(Ctx)
  if (!v) throw new Error("useGallery outside GalleryProvider")
  return v
}
