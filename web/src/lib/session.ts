import JSZip from "jszip"
import type { DockState } from "./concentration"
import { stampName } from "./exporters"
import type { ExportFile } from "./exporters"
import { fingerprintOf } from "./geom"
import { MAX_LEVEL, MIN_LEVEL } from "./levels"
import type { FieldEdits } from "./geom"
import type { CountedField, GalleryItem, Pt } from "./types"

/** A saved session is one self-contained zip: `session.json` plus every capture
 *  it names, under `files/`. Counts are NOT saved — they are recomputed on load
 *  from the same files with the same parameters, so a session can never carry a
 *  number the current engine would not produce. What cannot be recomputed is
 *  what the user decided: the overlap merges, and the hand corrections.
 *
 *  KNOWN LIMITATION. Hand corrections travel keyed by field fingerprint, which
 *  is `[field.names, stitch dx/dy/seam_y]` (see `fingerprintOf`). Filenames are
 *  stable, but the stitch geometry is whatever `stitch_pair` computes today: a
 *  change to the stitcher — a retune, a different seam rule — shifts those
 *  numbers, and a merged field then comes back under a fingerprint no saved edit
 *  set matches. The corrections are not lost from the file, they simply attach
 *  to nothing, and silently. That is why `engineVersion` is stamped on save and
 *  the restore diffs the restored keys against the fingerprints the recount
 *  actually produced, so an orphaned edit set is reported instead of vanishing.
 *  Single captures are unaffected; only merged fields carry stitch geometry. */

const STATE = "session.json"

export interface SessionItemV1 {
  id: string
  name: string
  fileKeys: string[]
  mergedFrom?: [string, string]
  /** The band the capture was counted under. Additive like `crop`: a session
   *  written before bands existed has no key and restores ungrouped. */
  group?: string
  /** The crop quad the card's count was made through, in ORIGINAL-image pixels
   *  (four corners, the same shape `useCounter.quad` holds). Additive: a
   *  session written before crops were saved simply has no key, and restores
   *  uncropped, which is why that addition needed no version bump. */
  crop?: Pt[]
  /** The quality rung this capture's count was made at.
   *
   *  Without it, a session saved with every card at Finest came back counted at
   *  whatever rung the gallery happened to open on - the user's deliberate
   *  accuracy choice discarded in silence (flow audit 2026-09-21, row 2). It is
   *  the per-ITEM level, not one for the file, because a card can be pinned
   *  above the gallery's rung. Absent means "count it at the gallery's level",
   *  which is what every session did before this key existed. */
  level?: number
}

/** Bumped to 2 on 2026-09-21, when the quality rungs were renumbered from four
 *  to three (Draft removed). A version-1 file records a level this app no longer
 *  has, so it is refused outright rather than misread - the app is offline, local
 *  and has no installed base to carry (user ruling 2026-09-21). */
export const SESSION_VERSION = 2

export interface SessionStateV1 {
  version: typeof SESSION_VERSION
  savedAt: string
  /** The counting engine that produced this session (pipeline.VERSION). Not a
   *  compatibility gate — it names the engine in the warning when a restored
   *  correction set finds no field to attach to. */
  engineVersion?: string
  boundary: boolean
  /** zip entry path -> the capture's ORIGINAL filename. The entry path is
   *  sanitised so the zip opens on any OS, but a field's fingerprint is built
   *  from the filenames the server echoes back, so a restored File has to carry
   *  the exact original name or not one hand edit would reattach. */
  files: Record<string, string>
  items: SessionItemV1[]
  editsByFingerprint: Record<string, FieldEdits>
  /** What the user typed into the concentration dock — the dilution above all,
   *  which is a bench fact no recount can rediscover. Raw strings, the same
   *  shape sessionStorage holds (see `concentration.ts`). Additive like `crop`:
   *  a session written before this key existed simply has none and restores an
   *  untouched dock, which is why the version stays 1. */
  concentration?: DockState
}

/** What a restored item needs before it is recounted. Ids are deliberately not
 *  part of it: the gallery mints its own (see `importSession`). */
export interface SessionSeed {
  files: File[]
  name: string
  mergedFrom?: [string, string]
  crop?: Pt[]
  group?: string
  /** The rung this capture was counted at when the session was saved, when the
   *  file recorded one this app still has. */
  level?: number
}

/** Zip entry names travel between operating systems; a path separator or a
 *  Windows-reserved character in a capture name would make the archive
 *  unreadable somewhere. The real name is preserved in `state.files`. */
const zipSafe = (n: string) => n.replace(/[^\w.-]+/g, "_") || "capture"

const MIME: Record<string, string> = {
  tif: "image/tiff", tiff: "image/tiff", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg",
}
const mimeOf = (name: string) => MIME[(name.split(".").pop() ?? "").toLowerCase()] ?? ""

// ------------------------------------------------------- reading a file back

/** Everything below rebuilds a session from JSON that a user could have hand
 *  edited, an older build could have written, or a partial write could have
 *  truncated. A malformed corner is dropped, never trusted: a stray value that
 *  reached `dotsNow` as a point would take the workbench down with it. */

const isPt = (v: unknown): v is Pt =>
  Array.isArray(v) && v.length === 2 && v.every(n => typeof n === "number" && Number.isFinite(n))

const cleanPts = (v: unknown): Pt[] => (Array.isArray(v) ? v.filter(isPt) : [])
const cleanStrs = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** A correction set, coerced to the full shape the app reads. An entry that is
 *  not an object at all is dropped; one that is merely incomplete is filled in,
 *  because an empty correction set is exactly what an untouched field has.
 *  Any other key is dropped rather than refused, so data from a retired
 *  feature (painted `regions`, removed 2026-09-04) cannot break a restore. */
function cleanEdits(v: unknown): FieldEdits | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as { edits?: unknown; off?: unknown }
  const e = (o.edits && typeof o.edits === "object" ? o.edits : {}) as
    { added?: unknown; removed?: unknown }
  return {
    edits: { added: cleanPts(e.added), removed: cleanPts(e.removed) },
    off: cleanStrs(o.off),
  }
}

/** A crop is four corners or it is nothing: a partial quad would be a crop the
 *  edit view cannot draw or undo, so it is dropped and the capture restores
 *  whole. */
function cleanCrop(v: unknown): Pt[] | null {
  const pts = cleanPts(v)
  return Array.isArray(v) && v.length === 4 && pts.length === 4 ? pts : null
}

function cleanItem(v: unknown): SessionItemV1 | null {
  if (!v || typeof v !== "object") return null
  const o = v as Partial<SessionItemV1>
  if (typeof o.name !== "string") return null
  if (!Array.isArray(o.fileKeys) || !o.fileKeys.every(k => typeof k === "string")) return null
  const m = o.mergedFrom
  const crop = cleanCrop(o.crop)
  return {
    id: typeof o.id === "string" ? o.id : "",
    name: o.name,
    fileKeys: o.fileKeys,
    ...(Array.isArray(m) && m.length === 2 && m.every(x => typeof x === "string")
      ? { mergedFrom: [m[0], m[1]] as [string, string] } : {}),
    ...(crop ? { crop } : {}),
    ...(typeof o.group === "string" && o.group ? { group: o.group } : {}),
    // A rung this app does not have is not restored at all - the card is then
    // counted at the gallery's level, which is honest, rather than clamped onto
    // a neighbouring rung and reported as if the user had chosen it.
    ...(typeof o.level === "number" && Number.isInteger(o.level)
      && o.level >= MIN_LEVEL && o.level <= MAX_LEVEL ? { level: o.level } : {}),
  }
}

const cleanRecord = <T>(v: unknown, f: (x: unknown) => T | null): Record<string, T> =>
  Object.fromEntries(
    Object.entries((v && typeof v === "object" ? v : {}) as Record<string, unknown>)
      .map(([k, x]) => [k, f(x)])
      .filter((e): e is [string, T] => e[1] !== null))

const cleanName = (v: unknown) => (typeof v === "string" && v ? v : null)

/** The dock's typed entries. Every slot is optional and every value is the raw
 *  string the user typed, so nothing is parsed here — parsing it on the way in
 *  would turn "1." back into "1" and lose the decimal point mid-entry, which is
 *  the whole reason the dock stores strings. An absent or damaged block reads
 *  as an untouched dock. */
function cleanDock(v: unknown): DockState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {}
  const o = v as Record<string, unknown>
  const pick = (k: keyof DockState) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {})
  return { ...pick("cells"), ...pick("squares"), ...pick("dilution") }
}

// ---------------------------------------------------------------- save


export async function saveSession(
  items: GalleryItem[],
  byField: Record<string, FieldEdits>,
  boundary: boolean,
  engineVersion = "",
  now = new Date(),
  /** The crop each item was counted through, by item id (`useGallery.cropsById`).
   *  Absent or null means the capture was counted whole. */
  crops: Record<string, Pt[] | null> = {},
  /** The dock's typed entries (`readDock()`), so a saved dilution comes back. */
  concentration: DockState = {},
): Promise<ExportFile> {
  if (!items.length) throw new Error("There is nothing in this session to save.")

  const zip = new JSZip()
  // Keyed by File identity, not by name: two captures can genuinely carry the
  // same filename, and the same File object must be stored only once.
  const keys = new Map<File, string>()
  const files: Record<string, string> = {}
  let idx = 0

  const saved: SessionItemV1[] = items.map(it => ({
    id: it.id,
    name: it.name,
    ...(it.mergedFrom ? { mergedFrom: it.mergedFrom } : {}),
    ...(it.group ? { group: it.group } : {}),
    ...(cleanCrop(crops[it.id]) ? { crop: crops[it.id] as Pt[] } : {}),
    ...(it.field ? { level: it.field.level } : {}),
    fileKeys: it.files.map(f => {
      let k = keys.get(f)
      if (!k) {
        k = `files/${idx++}_${zipSafe(f.name)}`
        keys.set(f, k)
        files[k] = f.name
      }
      return k
    }),
  }))

  for (const [f, k] of keys) {
    // ArrayBuffers, not Blobs: JSZip only reads a Blob through a FileReader
    // that not every environment gives it.
    zip.file(k, await f.arrayBuffer())
  }

  // Only the fingerprints the saved items can still reach. A merge retires the
  // two originals' fields, and their corrections would otherwise ride along in
  // every future save as keys nothing will ever look up again.
  const live = new Set(items.flatMap(i => (i.field ? [fingerprintOf(i.field)] : [])))
  const editsByFingerprint = Object.fromEntries(
    Object.entries(byField).filter(([k]) => live.has(k)))

  const state: SessionStateV1 = {
    version: SESSION_VERSION,
    savedAt: now.toISOString(),
    ...(engineVersion ? { engineVersion } : {}),
    boundary,
    files,
    items: saved,
    editsByFingerprint,
    ...(concentration.cells || concentration.squares || concentration.dilution
      ? { concentration: { ...concentration } } : {}),
  }
  zip.file(STATE, JSON.stringify(state, null, 1))

  return {
    blob: await zip.generateAsync({ type: "blob" }),
    filename: stampName("zip", now, "cellcounter-session"),
  }
}

// ---------------------------------------------------------------- load

export async function loadSession(
  file: File | Blob,
): Promise<{ files: Map<string, File>; state: SessionStateV1 }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    throw new Error("That file could not be opened as a session — it is not a zip.")
  }

  const entry = zip.file(STATE)
  if (!entry) throw new Error("That zip holds no session.json, so it is not a saved session.")

  let raw: Record<string, unknown> & { version?: unknown; items?: unknown[] }
  try {
    raw = JSON.parse(await entry.async("string"))
  } catch {
    throw new Error("This session's session.json is damaged and could not be read.")
  }
  if (raw?.version !== SESSION_VERSION || !Array.isArray(raw.items)) {
    throw new Error("This session was written by a different version of Cell Counter.")
  }

  const items = raw.items.map(cleanItem).filter((i): i is SessionItemV1 => !!i)
  // Every item unreadable while the file claimed to hold some: the list is
  // damaged, and restoring nothing silently would look like an empty session.
  if (raw.items.length && !items.length) {
    throw new Error("This session's capture list is damaged and could not be read.")
  }

  // A session written before this key was retired simply carries a `paramVals`
  // that is read nowhere below: the whole tuning round trip is gone (params
  // travel to the server pre-set, never from a saved file), so the key is
  // silently ignored rather than restored.
  const state: SessionStateV1 = {
    version: SESSION_VERSION,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    ...(typeof raw.engineVersion === "string" ? { engineVersion: raw.engineVersion } : {}),
    // Absent means the app default, which is on; only an explicit false is off.
    boundary: raw.boundary !== false,
    files: cleanRecord(raw.files, cleanName),
    items,
    editsByFingerprint: cleanRecord(raw.editsByFingerprint, cleanEdits),
    concentration: cleanDock(raw.concentration),
  }

  const files = new Map<string, File>()
  for (const [key, name] of Object.entries(state.files)) {
    const f = zip.file(key)
    if (!f) continue                    // reported by sessionSeeds, not thrown here
    files.set(key, new File([await f.async("arraybuffer")], name, { type: mimeOf(name) }))
  }
  return { files, state }
}

/** The items a restore can actually rebuild. An item whose captures are not all
 *  present cannot be recounted at all, so it is dropped rather than restored as
 *  a permanent error; the caller compares the length against `state.items` to
 *  tell the user how many went missing. */
export function sessionSeeds(
  state: SessionStateV1, files: Map<string, File>,
): SessionSeed[] {
  const out: SessionSeed[] = []
  for (const it of state.items) {
    const fs = (it.fileKeys ?? []).map(k => files.get(k)).filter((f): f is File => !!f)
    if (!fs.length || fs.length !== it.fileKeys.length) continue
    out.push({
      files: fs, name: it.name,
      ...(it.mergedFrom ? { mergedFrom: it.mergedFrom } : {}),
      ...(it.group ? { group: it.group } : {}),
      ...(it.crop ? { crop: it.crop } : {}),
      ...(it.level ? { level: it.level } : {}),
    })
  }
  return out
}

/** How many restored correction sets found no field to attach to. A saved set
 *  is keyed by fingerprint, and a merged field's fingerprint carries the stitch
 *  geometry the engine produced at save time — see this file's header. Nothing
 *  is lost from the zip, but the user has to be told, or a session simply comes
 *  back with corrections missing and no reason given. */
export function orphanedEdits(state: SessionStateV1, fields: CountedField[]): number {
  const live = new Set(fields.map(fingerprintOf))
  return Object.keys(state.editsByFingerprint).filter(k => !live.has(k)).length
}
