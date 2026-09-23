export type Pt = [number, number]
export type M3 = number[][]

export interface ParamsResponse {
  version: string
  /** How many counts the server will run at once, 1 or 2. Optional: an older
   *  server that predates the parallel-count support omits it, and callers
   *  treat that as 1. */
  count_slots?: number
}

export interface Stitch {
  dx: number; dy: number; seam_y: number; ncc: number
  /** Stage tilt the stitcher measured, in degrees. It is only CORRECTED when
   *  it clears pipeline.ROTATION_DEG_MIN (0.15), so a reader must apply the
   *  same gate — see ROTATION_DEG_MIN in OverlapReview. Optional: sessions and
   *  servers older than the correction never send it, and 0 is "square". */
  rotation_deg?: number
}
export interface Frame {
  x0: number; y0: number; x1: number; y1: number
  sides?: { left: boolean; right: boolean; top: boolean; bottom: boolean }
  /** A boundary of this frame was only found on the second look, where the
   *  lattice says one must be, at a lower mass floor than the rest clear. The
   *  line is real - nothing accepts one that is not there - but this is the
   *  field to check first when a number looks wrong, so the card marks it.
   *  Optional: servers older than 2026-09-18 never send it. */
  recovered?: boolean
}
export interface Square { col: number; row: number; count: number }
// `image` is an `/api/image/<id>` path, same shape as CountedField.base_image.
export interface StageImage { n: string; group: string; name: string; image: string }

export interface CountedField {
  names: string[]
  count: number
  width: number             // base_image pixel size: the bounds a hand-edited
  height: number            // point has to fall inside to still be on screen
  centers: Pt[]
  grid_x: number[]
  grid_y: number[]
  diameter: number
  /** The quality level this field was actually counted at (0 = raw engine
   *  params). The server echoes it, so the gallery can tell which images a
   *  Reprocess would pick up without recomputing anything. */
  level: number
  grid_cols: number
  grid_rows: number
  squares: Square[]
  frame: Frame | null
  transform?: M3
  /** `/api/image/<id>` - fetched, not an inlined `data:image/jpeg;base64,...`
   *  URL (audit-backend.md #11: a batch's inlined base64 was unbounded, up to
   *  hundreds of MB in memory and in the browser at once). It is a normal
   *  path, so a bare `<img src={field.base_image}>` or
   *  `new Image().src = field.base_image` still works unchanged - the id
   *  lives behind the same string, just fetched by the browser instead of
   *  decoded inline. A wall-clock TTL was tried and removed: export re-fetches
   *  base_image at export time, and the TTL broke that. The id is only ever
   *  reclaimed by memory pressure (a byte-bounded store), never by time; if
   *  that happens, re-running the count gets a fresh path. */
  base_image: string
  stages: StageImage[]
  stitch: Stitch | null
  // Absent on a successful field, so `field.error` reads as a plain
  // `string | undefined` on the union instead of a compile error. Declaring
  // it here means a bare `if (field.error)` truthy check does NOT narrow the
  // union (TypeScript only narrows a discriminant this way when the property
  // is absent, not merely `undefined`-typed, on the other member) - use
  // `isCountedField`/`isFailedField` below wherever the branch needs to read
  // a member that only exists on one side.
  error?: undefined
}

/** Set when this one field, in an otherwise-successful batch, could not be
 *  counted (e.g. no grid found) - the server keeps every other field intact
 *  and 200s the request rather than discarding the whole batch. A plain
 *  sentence a lab researcher can act on. None of CountedField's other
 *  members are present on this entry - check `field.error` first, before
 *  reading anything else off a `Field`. */
export interface FailedField {
  names: string[]
  error: string
}

/** A discriminated union, not one interface with an optional `error`: the
 *  old shape let `count`/`grid_x`/`base_image` etc. type-check as always
 *  present, which is why Sidebar.tsx and CountBadge.tsx could read them
 *  unguarded on an error field and crash or print "undefined found" - `tsc`
 *  had no way to catch it. Every unguarded read of a CountedField-only
 *  member is now a compile error. */
export type Field = CountedField | FailedField

/** Type guards for the union above. Prefer these over a bare `field.error`
 *  check for anything beyond a one-off display: a plain truthy check reads
 *  fine but does not narrow `field`'s type (see the note on `error` above),
 *  so any member access past it still fails to compile - a real user-defined
 *  type guard is what actually narrows at every call site. */
// Keys on key PRESENCE (`"error" in f`), not on whether `error` is truthy or
// non-empty - a CountedField literal built with an explicit `error: undefined`,
// or a FailedField with `error: ""`, would classify wrongly. No producer does
// that today (the server never sends `error: ""`, and nothing hand-builds a
// CountedField with an explicit `error` key) - keep it that way rather than
// "fixing" this to a truthy check, which would break the compile-time
// narrowing the comment on CountedField.error above depends on.
export function isCountedField(f: Field | null | undefined): f is CountedField {
  return !!f && !("error" in f)
}
export function isFailedField(f: Field | null | undefined): f is FailedField {
  return !!f && "error" in f
}

export interface CountResponse { fields: Field[] }

/** Session-scoped hand corrections, in ORIGINAL-image px. */
export interface Edits { added: Pt[]; removed: Pt[] }

export type DotKind = "auto" | "added" | "ghost"
export type Dot = [number, number, DotKind]

export interface PairCandidate {
  i: number; j: number; dx: number; dy: number; seam_y: number; ncc: number
  /** As on `Stitch`: the tilt of the LOWER capture, applied by the merge only
   *  above ROTATION_DEG_MIN. The review preview has to apply the same rotation
   *  or it shows a picture the merge will not produce. */
  rotation_deg?: number
  swapped?: boolean       // true: j is the upper capture, so dx/dy place i under j
  // Full-resolution JPGs of the two raw captures, each an `/api/image/<id>`
  // path (see the note on CountedField.base_image) - fetched, not inlined.
  // The review screen runs before counting, so there is no base_image to
  // fall back on for a TIF.
  a_image?: string
  b_image?: string
}
/** Why a candidate pair was never offered - api_pairs only reports this for a
 *  capture that ended up in no pair at all (app.py's `paired` filter), so it
 *  names a real gap, never a pair the screen already shows. */
export interface SkippedPair {
  i: number; j: number
  reason: string        // e.g. "These two captures are different sizes ..."
  names: string[]        // the two filenames, [names[i], names[j]]
}
export interface PairsResponse { pairs: PairCandidate[]; count: number; skipped: SkippedPair[] }

export type ItemStatus = "queued" | "counting" | "pending" | "ready" | "error"
export interface GalleryItem {
  id: string
  // More than one file means a confirmed pair - see runCounts' `pair` flag.
  // Three producers put a second file here: useGallery.tsx's decideAll merge,
  // addManualPair, and importSession (which restores `files: s.files` from a
  // saved session).
  files: File[]; name: string
  // Always a CountedField, never a FailedField: a gallery item's own count
  // call throws (see runCounts in useGallery.tsx) rather than store a
  // per-field refusal here, and the item's OWN failure is `error` below
  // instead - a batch's per-field error (app.py: one bad group in an
  // otherwise-good run) is a workbench-only concept (useCounter's `fields`).
  field: CountedField | null; status: ItemStatus; error?: string
  /** The triple-line setting this card's count was made under.
   *
   *  `boundary` is a counting input exactly like the quality level, but only
   *  the level came back on the field, so staleness was judged on the level
   *  alone: toggling the triple-line switch recounted the OPEN capture and left
   *  every other card showing a number made under the other rule, unmarked and
   *  not offered a recount (flow audit 2026-09-21, row 1). The concentration
   *  calculator then averaged two counting rules into one cells/mL. Undefined
   *  on a card that has never counted. */
  countedBoundary?: boolean
  mergedFrom?: [string, string]     // names of the two originals, display only
  /** The band this capture was swept in, when the run used groups at all. The
   *  gallery lays its cards out under this, and the concentration calculator
   *  works one band at a time - two bands are two samples, and one cells/mL
   *  averaged over both describes neither. Absent means the run was ungrouped,
   *  or nobody put this capture anywhere. */
  group?: string
}
