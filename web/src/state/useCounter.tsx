import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { count as apiCount, fetchParams } from "@/lib/api"
import { dotsNow, effectiveTotal, fingerprintOf, squareKeyOf, toDisp, toOrig } from "@/lib/geom"
import { newToken, trackCount } from "@/lib/progressBus"
import type { FieldEdits } from "@/lib/geom"
import { countKey } from "@/lib/countKey"
import { DEFAULT_LEVEL, levelName } from "@/lib/levels"
import { REFUSED_STITCH_MSG } from "@/lib/messages"
import { isCountedField, type Dot, type Field, type Pt } from "@/lib/types"

export type Autocrop = "" | "frame"

type FieldState = FieldEdits
const emptyFieldState = (): FieldState => ({ edits: { added: [], removed: [] }, off: [] })
// Shared fallback for a field with no corrections yet: a fresh object per render
// would give `total` a new input every time and defeat its memo.
const NO_EDITS: FieldState = { edits: { added: [], removed: [] }, off: [] }

/** A boolean that survives a reload, for a DISPLAY preference only.
 *
 *  localStorage, wrapped: a private window, or a browser with site data
 *  blocked, throws on both read and write, and a settings toggle is never worth
 *  a crash. A blocked store simply means the app forgets, which is what it did
 *  before this existed.
 */
function usePersistedFlag(key: string, fallback: boolean) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : raw === "1"
    } catch { return fallback }
  })
  const set = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setV(prev => {
      const value = typeof next === "function" ? next(prev) : next
      try { localStorage.setItem(key, value ? "1" : "0") } catch { /* private mode */ }
      return value
    })
  }, [key])
  return [v, set] as const
}

function useCounterState() {
  const [version, setVersion] = useState("")

  const [files, setFiles] = useState<File[]>([])
  const [fields, setFields] = useState<Field[]>([])
  // Which files array produced `fields`. Filenames do not identify a capture
  // (a microscope reuses them across sessions), so provenance is the array
  // reference the caller handed to openFiles.
  const [fieldsFor, setFieldsFor] = useState<File[] | null>(null)
  const [fieldIdx, setFieldIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("ready")
  const [imgSize, setImgSize] = useState<[number, number] | null>(null)

  // Two levels, on purpose. `level` is where the slider stands - a request, and
  // nothing more. `countLevel` is the level the count on screen was made at,
  // and it is the only one the counting effect watches, which is what makes
  // moving the slider free: it arms the button and recounts nothing.
  const [level, setLevel] = useState(DEFAULT_LEVEL)
  const [countLevel, setCountLevel] = useState(DEFAULT_LEVEL)
  const [runSeq, setRunSeq] = useState(0)

  const [autocrop, setAutocrop] = useState<Autocrop>("")
  const [boundary, setBoundary] = useState(true)
  // Two DISPLAY preferences, remembered like every other one (theme, interface
  // scale, burn-count, the folded sidebar). They sat in plain useState, so the
  // app remembered some of its settings across a reload and forgot these two,
  // with no pattern a user could learn (flow audit 2026-09-21, row 20).
  //
  // They are preferences, not work, which is what makes them exempt from the
  // reload-wipes-everything rule: neither carries a count, a capture or a hand
  // correction. `boundary` deliberately stays unremembered - it is a COUNTING
  // input, and a triple-line rule silently restored from a previous session
  // would change every number in the new one.
  // `showStages` is the exception: off at every load (user, 2026-09-21). It is
  // costly - every count ships its stage images - so it is switched on for a
  // session, never inherited from one.
  const [showStages, setShowStages] = useState(false)
  const [showGrid, setShowGrid] = usePersistedFlag("cellcounter.showGrid", true)
  const [quad, setQuad] = useState<Pt[] | null>(null)
  const [selectedStage, setSelectedStage] = useState<string | null>(null)

  // Per-field corrections and excluded squares, keyed by field fingerprint, so
  // switching fields (or re-cropping) never loses a field's own edits.
  const [byField, setByField] = useState<Record<string, FieldState>>({})

  // Startup params fetch, with retry: a server still warming up (or a
  // momentary hiccup) must not leave the app stuck forever at `ready = false`
  // with nothing on screen explaining why. 3 tries, 1 s apart; `serverDown`
  // is set only after all three fail, and `retryServer()` (bumped via
  // `retryTick`) starts the same loop again. Abort-aware because the
  // provider can unmount mid-retry (it does in tests): a `setState` after
  // that would be a real bug, not just a warning.
  const [serverDown, setServerDown] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const retryServer = useCallback(() => {
    setServerDown(false)
    setRetryTick(t => t + 1)
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    const wait = (ms: number) => new Promise<void>(resolve => {
      const t = setTimeout(resolve, ms)
      ac.signal.addEventListener("abort", () => { clearTimeout(t); resolve() })
    })
    const ATTEMPTS = 3
    async function run() {
      for (let i = 0; i < ATTEMPTS; i++) {
        if (ac.signal.aborted) return
        try {
          const spec = await fetchParams()
          if (ac.signal.aborted) return
          setVersion(spec.version)
          setServerDown(false)
          return
        } catch {
          if (ac.signal.aborted) return
          if (i < ATTEMPTS - 1) {
            await wait(1000)
          } else {
            setServerDown(true)
          }
        }
      }
    }
    run()
    return () => ac.abort()
  }, [retryTick])

  const field: Field | undefined = fields[fieldIdx]
  // A failed field (app.py: one bad group in an otherwise-good batch) has no
  // stable geometry to fingerprint and never carries hand edits, so it falls
  // back to the empty key - same as no field open at all.
  const fp = isCountedField(field) ? fingerprintOf(field) : ""
  const fstate = byField[fp] ?? NO_EDITS
  const edits = fstate.edits
  const off = useMemo(() => new Set(fstate.off), [fstate.off])

  const patchField = useCallback((key: string, fn: (s: FieldState) => FieldState) => {
    setByField(prev => ({ ...prev, [key]: fn(prev[key] ?? emptyFieldState()) }))
  }, [])

  // ---------- counting ----------
  const abort = useRef<AbortController | null>(null)
  const ready = !!version

  /** The exact inputs a field already on screen was produced from. While they
   *  still hold, the counting effect has nothing to do. This is what makes
   *  opening a gallery card free: the gallery already counted that capture, and
   *  re-running the pipeline to arrive at the identical field is a wait the
   *  user pays for twice. Any real change - the crop, the stage images, the
   *  level, a Reprocess - moves one of these fields and the count runs. */
  const satisfied = useRef<{ files: File[]; key: string } | null>(null)
  // Read inside openFiles, which must not re-create itself when they move.
  const live = useRef({ showStages, runSeq, boundary, level, countLevel })
  useEffect(() => { live.current = { showStages, runSeq, boundary, level, countLevel } })

  // Whether the files on screen are a confirmed pair (see openFiles). Set once
  // per openFiles call and read by every later count of the same files - a
  // crop, level change, reprocess or the triple-line toggle must keep sending
  // it, or the claim the user confirmed gets silently re-litigated the moment
  // any of those re-count the pair.
  const pairRef = useRef(false)

  useEffect(() => {
    if (!files.length || !ready) return
    const key = countKey({
      level: countLevel, seq: runSeq,
      quad, autocrop, boundary, pair: pairRef.current,
    })
    const s = satisfied.current
    if (s && s.files === files && s.key === key) return
    const t = setTimeout(async () => {
      abort.current?.abort()
      const ac = new AbortController()
      abort.current = ac
      setBusy(true)
      setStatus("counting…")
      // The progress ticket. Minted per request and followed until the response
      // lands, whichever way it lands: the ring reports the server's own step,
      // never a timer (the old one eased toward a 0.95 cap and knew nothing).
      const token = newToken()
      const untrack = trackCount(token)
      try {
        const data = await apiCount({
          token,
          files,
          params: { boundary: boundary ? 1 : 0, level: countLevel },
          autocrop: quad ? "" : autocrop,
          quad,
          // Read from the ref, NOT from the closure: `showStages` is a display
          // setting and must not be a dep of this effect, or toggling it counts
          // (see countKey's comment). Whatever it is when a count the user DID
          // ask for goes out, that is what the server renders.
          stages: live.current.showStages,
          pair: pairRef.current,
          signal: ac.signal,
        })
        // A confirmed pair that came back as two fields means the seam was
        // refused server-side (the ValueError became this response's error,
        // and this branch would not even run) - unless the server and client
        // ever disagree on what "confirmed" means. Either way two fields for
        // one claimed pair is not a card this view can show silently: the
        // gallery already treats it as a hard failure (useGallery.tsx), and
        // the card must not quietly hand the user a field switcher instead.
        if (pairRef.current && data.fields.length !== 1) {
          throw new Error(REFUSED_STITCH_MSG)
        }
        setFields(data.fields)
        setFieldsFor(files)
        satisfied.current = { files, key }
        setFieldIdx(i => (i >= data.fields.length ? 0 : i))
        setStatus("done")
      } catch (e) {
        if ((e as Error).name === "AbortError") return
        toast.error((e as Error).message || "Could not reach the counter.")
        // The fields on screen belong to the capture we were LEAVING, and the
        // header, the name and the navigation have already moved on. Keeping
        // them showed the previous capture's photo, dots and count under the
        // new capture's name - a number attributed to the wrong image (flow
        // audit 2026-09-21, row 6). A failed count has no field; say so.
        setFields([])
        setFieldsFor(files)
        setStatus("error")
      } finally {
        untrack()
        if (!ac.signal.aborted) setBusy(false)
      }
    }, 250)   // coalesces a burst of view changes into one request
    return () => clearTimeout(t)
    // `level` is deliberately absent: only `countLevel` recounts, and only
    // reprocess() and openFiles() move it. `showStages` is absent for the same
    // reason since 2026-09-21 - a display toggle is not a counting input.
  }, [files, boundary, autocrop, quad, ready, countLevel, runSeq])

  // ---------- intake ----------
  // `atLevel` is the level this capture was last counted at. The gallery hands
  // it in when opening a card, so an image pinned to a higher level opens at
  // its own level rather than being silently recounted at the batch level.
  const openFiles = useCallback((
    fs: File[], atLevel?: number, seed?: Field,
    // The files were a manual pair or a review-confirmed overlap (see
    // GalleryItem.files), so every count of them - not just this seeded one -
    // must stitch or refuse, never be silently re-derived into two fields by
    // group_captures. Persisted in `pairRef` because it has to outlive this
    // call: a crop, level change, reprocess or the triple-line toggle all
    // re-count these same two files later, through the effect below.
    pair = false,
  ) => {
    if (!fs.length) return
    pairRef.current = pair
    if (atLevel) {
      // A quality request the user staged but never committed is about to be
      // overwritten by the capture being opened. Say so rather than letting the
      // slider snap back with no sign it was dropped (flow audit 2026-09-21,
      // row 19). Read from the ref, not the closure: openFiles is a stable
      // callback and must not be rebuilt on every slider move.
      const staged = live.current.level
      if (staged !== live.current.countLevel && staged !== atLevel) {
        toast.info(`Quality request dropped: this capture opens at ${levelName(atLevel)}.`)
      }
      setLevel(atLevel)
      setCountLevel(atLevel)
    }
    // The gallery hands its own result in, and it is installed WHATEVER the
    // stage strip is doing. It used to be skipped when "Show pipeline steps"
    // was on, because the gallery counts with stages off and there would be no
    // stage images to show. The cost of that was the bug this replaced: with
    // stages on, nothing was installed at all, so `fields` stayed empty and the
    // workbench rendered its first-run drop zone over a capture that was
    // already counted (2026-09-21). An empty stage strip is a strip with
    // nothing in it; a drop zone is the app claiming there is no image.
    if (seed && atLevel) {
      // A count for the capture we are leaving can still be in flight; letting
      // it land would overwrite the seeded field with the previous capture's.
      abort.current?.abort()
      setBusy(false)
      setFields([seed])
      setFieldsFor(fs)
      setStatus("done")
      satisfied.current = {
        files: fs,
        key: countKey({
          level: atLevel, seq: live.current.runSeq,
          // openFiles clears both below, so the seed stands for the uncropped view
          quad: null, autocrop: "",
          boundary: live.current.boundary, pair,
        }),
      }
    }
    setFiles(fs)
    setFieldIdx(0)
    setQuad(null)
    // A crop belongs to the capture it was drawn on. Opening another capture
    // with the old autocrop still armed would recount it cropped and write
    // that field back onto the gallery item (M-1/M-2).
    setAutocrop("")
  }, [])

  // Reset brings the original capture back. It deliberately keeps the hand
  // corrections and the excluded squares: they are stored in original-image px
  // and follow the transform, so undoing a crop must not throw them away.
  // Auto-crop is cleared too: a user who pressed "auto-crop to frame" and then
  // "Reset crop" still had it armed, so the next count came back cropped even
  // though the button said the crop had just been cancelled.
  const reset = useCallback(() => { setQuad(null); setAutocrop("") }, [])

  // ---------- derived ----------
  const dots: Dot[] = useMemo(
    () => dotsNow(field, edits, imgSize?.[0], imgSize?.[1]),
    [field, edits, imgSize])

  const solid = useMemo(() => dots.filter(d => d[2] !== "ghost"), [dots])
  const ghosts = dots.length - solid.length

  const squareCounts = useMemo(() => {
    const m: Record<string, number> = {}
    if (!field) return m
    solid.forEach(d => {
      const k = squareKeyOf(field, [d[0], d[1]])
      m[k] = (m[k] ?? 0) + 1
    })
    return m
  }, [field, solid])

  // The same rule the gallery cards report, so a card and the workbench never
  // disagree about one field. Here it is bounded by the displayed image, so a
  // dot cropped out of view leaves the tally until the crop brings it back.
  const total = useMemo(
    () => effectiveTotal(field, fstate, imgSize?.[0], imgSize?.[1]),
    [field, fstate, imgSize])

  /** Commit the slider: the next count uses this level. Nothing else moves it,
   *  which is the whole "nothing recounts on release" rule in one line.
   *
   *  The sequence number is what makes a RETRY work. A count that failed leaves
   *  countLevel already equal to the armed level, so setting it again would
   *  change no state and fetch nothing - the button would look armed and do
   *  nothing at exactly the moment the user needs it most. */
  const reprocess = useCallback(() => {
    setCountLevel(level)
    setRunSeq(n => n + 1)
  }, [level])
  // ---------- edits ----------
  const clickAt = useCallback((x: number, y: number) => {
    // DotCanvas (the only caller) never mounts over a failed field, but the
    // guard is what narrows `field` for the reads below.
    if (!isCountedField(field)) return
    const r = (field.diameter || 22) * 0.5
    const near = (p: Pt) => Math.hypot(p[0] - x, p[1] - y) <= r
    patchField(fp, s => {
      const ai = s.edits.added.findIndex(p => near(toDisp(field, p)))
      if (ai >= 0) {                    // an added dot: take it back out
        const added = s.edits.added.slice()
        added.splice(ai, 1)
        return { ...s, edits: { ...s.edits, added } }
      }
      const remD = s.edits.removed.map(q => toDisp(field, q))
      const hit = field.centers.find(c => near(c) &&
        !remD.some(q => Math.hypot(q[0] - c[0], q[1] - c[1]) <= r))
      const o = toOrig(field, hit ?? [x, y]).map(Math.round) as Pt
      return hit                        // a detection: remove it (store original px)
        ? { ...s, edits: { ...s.edits, removed: [...s.edits.removed, o] } }
        : { ...s, edits: { ...s.edits, added: [...s.edits.added, o] } }
    })
  }, [field, fp, patchField])

  const toggleSquare = useCallback((key: string) => {
    patchField(fp, s => ({
      ...s,
      off: s.off.includes(key) ? s.off.filter(k => k !== key) : [...s.off, key],
    }))
  }, [fp, patchField])

  /** Drop this field's hand corrections. Only the Reprocess dialog's "start
   *  clean" calls it; changing the level never discards edits by itself. The
   *  excluded squares stay: those are a choice about the field, not a
   *  correction to a count. */
  const clearEdits = useCallback(() => {
    patchField(fp, s => ({ ...s, edits: { added: [], removed: [] } }))
  }, [fp, patchField])

  // Split for React.useContext's sake, not the caller's: everything below is
  // still handed out together through useCounter(). The actions half never
  // changes reference once mounted (every entry is a useCallback with stable
  // deps), so a consumer that only ever calls e.g. reprocess() can subscribe
  // to CounterActionsContext alone and skip every re-render this state hook
  // produces - level, a dot added, all of it.
  const actions = useMemo(() => ({
    retryServer, setLevel, reprocess,
    setFieldIdx, openFiles, reset,
    setAutocrop, setBoundary, setShowStages, setShowGrid, setQuad,
    setSelectedStage,
    setByField,
    clickAt, toggleSquare, clearEdits, setImgSize,
  }), [
    retryServer, setLevel, reprocess,
    setFieldIdx, openFiles, reset,
    setAutocrop, setBoundary, setShowStages, setShowGrid, setQuad,
    setSelectedStage,
    setByField,
    clickAt, toggleSquare, clearEdits, setImgSize,
  ])

  const values = useMemo(() => ({
    level, countLevel,
    files, fields, fieldsFor, field, fieldIdx, busy, status,
    autocrop, showStages,
    showGrid, quad,
    selectedStage,
    edits, off, dots, solid, ghosts, total, squareCounts,
    imgSize,
  }), [
    level, countLevel,
    files, fields, fieldsFor, field, fieldIdx, busy, status,
    autocrop, showStages,
    showGrid, quad,
    selectedStage,
    edits, off, dots, solid, ghosts, total, squareCounts,
    imgSize,
  ])

  // `byField` on its own context: it is what every gallery card reads (its
  // own effectiveTotal), and it only ever moves when a hand edit or an
  // excluded square changes - never on a slider tick. Folded into `values`
  // above, one workbench slider drag would re-render every card in a 30-card
  // grid on every tick, since a context update re-renders each of its
  // consumers regardless of which field of the bundle actually moved.
  const byFieldValue = useMemo(() => ({ byField }), [byField])

  // `version`/`boundary`/`serverDown`: the session-wide facts the gallery's
  // own toolbar reads (Save/Load session), which move once at startup or on
  // an explicit boundary toggle - never on the per-tick churn `values` above
  // carries (the crop quad, a hand edit). Same reasoning as `byFieldValue`:
  // bundled into `values`, a workbench tick would re-render the session
  // buttons in the gallery header.
  const session = useMemo(() => ({ version, serverDown, boundary }),
    [version, serverDown, boundary])

  return { actions, values, byFieldValue, session }
}

type CounterActions = ReturnType<typeof useCounterState>["actions"]
type CounterValues = ReturnType<typeof useCounterState>["values"]
type CounterByField = ReturnType<typeof useCounterState>["byFieldValue"]
type CounterSession = ReturnType<typeof useCounterState>["session"]
export type Counter =
  CounterActions & CounterValues & CounterByField & CounterSession

// Four contexts sharing one provider. `useCounter()` still hands out the
// merged shape every existing consumer expects; `useCounterActions()` is the
// escape hatch for a component that only ever calls the actions (the
// reprocess bars, the toolbar's slider commit) - see the module comment
// above `actions` for why that is worth a second context. `byField` and
// `session` are split out for the same reason, one level down - see the
// comments above `byFieldValue` and `session`. A fifth context held the
// overlay-opacity slider until 2026-09-21, when the contour overlay it
// controlled was removed.
// oxlint-disable-next-line react/only-export-components
const CounterActionsContext = createContext<CounterActions | null>(null)
// oxlint-disable-next-line react/only-export-components
const CounterValuesContext = createContext<CounterValues | null>(null)
// oxlint-disable-next-line react/only-export-components
const CounterByFieldContext = createContext<CounterByField | null>(null)
// oxlint-disable-next-line react/only-export-components
const CounterSessionContext = createContext<CounterSession | null>(null)
export function CounterProvider({ children }: { children: React.ReactNode }) {
  const { actions, values, byFieldValue, session } = useCounterState()
  return (
    <CounterActionsContext.Provider value={actions}>
      <CounterSessionContext.Provider value={session}>
        <CounterByFieldContext.Provider value={byFieldValue}>
          <CounterValuesContext.Provider value={values}>
            {children}
          </CounterValuesContext.Provider>
        </CounterByFieldContext.Provider>
      </CounterSessionContext.Provider>
    </CounterActionsContext.Provider>
  )
}

/** The gallery card's own narrow subscription: just the hand-edit map, so a
 *  workbench-only value (the crop quad, the slider level) moving never
 *  re-renders a single card. */
// oxlint-disable-next-line react/only-export-components
export function useCounterByField(): CounterByField {
  const v = useContext(CounterByFieldContext)
  if (!v) throw new Error("useCounterByField outside CounterProvider")
  return v
}

/** The gallery toolbar's own narrow subscription: version/boundary/serverDown,
 *  for Save/Load session - see the comment above `session` in useCounterState. */
// oxlint-disable-next-line react/only-export-components
export function useCounterSession(): CounterSession {
  const v = useContext(CounterSessionContext)
  if (!v) throw new Error("useCounterSession outside CounterProvider")
  return v
}

/** Everything in `values`: fields, edits, quad, dots, and the rest.
 *  `useGalleryState` (useGallery.tsx) is the reason this exists as a
 *  standalone export: it reads `fields`/`fieldsFor`/`quad` off useCounter()
 *  internally, and the merged useCounter() subscribes to every context
 *  regardless of what is destructured from it - so calling it there would
 *  make the WHOLE gallery re-render on every workbench tick, same as if
 *  `values` had never been split off `byField`/`session`. */
// oxlint-disable-next-line react/only-export-components
export function useCounterValues(): CounterValues {
  const v = useContext(CounterValuesContext)
  if (!v) throw new Error("useCounterValues outside CounterProvider")
  return v
}

// oxlint-disable-next-line react/only-export-components
export function useCounterActions(): CounterActions {
  const v = useContext(CounterActionsContext)
  if (!v) throw new Error("useCounterActions outside CounterProvider")
  return v
}

// This file's whole job is to hand out the counter store, so a non-component
// export here is the point, not an accident - same reasoning as
// DropZone.tsx:10-12.
// oxlint-disable-next-line react/only-export-components
export function useCounter(): Counter {
  const actions = useContext(CounterActionsContext)
  const values = useContext(CounterValuesContext)
  const byFieldValue = useContext(CounterByFieldContext)
  const session = useContext(CounterSessionContext)
  if (!actions || !values || !byFieldValue || !session) {
    throw new Error("useCounter outside CounterProvider")
  }
  return { ...actions, ...values, ...byFieldValue, ...session }
}
