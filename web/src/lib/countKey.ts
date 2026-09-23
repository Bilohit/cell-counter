import type { Pt } from "@/lib/types"

/** Every input `POST /api/count` is given, as one comparable string.
 *
 *  The counting effect skips a run when the field on screen was already
 *  produced from these exact inputs. That check used to record only four of
 *  them (files, stages, level, seq) and paper over the rest with
 *  `!quad && !autocrop`, which was wrong in both directions: removing a crop
 *  (Reset, or Auto-crop back to off) left every recorded input unchanged, so
 *  the cropped field stayed on screen forever, and the triple-line switch was
 *  a no-op for the same reason. Anything the request carries belongs here.
 *
 *  `files` is deliberately NOT in the key: an array of File objects has no
 *  value identity, and provenance is the array reference the caller handed to
 *  openFiles. The caller compares that reference alongside this key.
 *
 *  `stages` is deliberately NOT here, since 2026-09-21. "Show pipeline steps"
 *  is a DISPLAY setting, and while it sat in this key, flipping it made the
 *  effect below fire a full recount - up to ~7 s, behind the settings dialog,
 *  with no confirmation and the result written back over the card. That is the
 *  same rule the quality slider is held to: only Reprocess counts. The request
 *  still SENDS the current `showStages`, read from a ref, so the next count
 *  the user actually asks for brings the stage images back with it.
 *
 *  `pair` joined them later, for the same reason as the others: it changes
 *  what the request asks the server to do (stitch-or-refuse vs. re-derive the
 *  grouping), so a toggle that flips it - there is none today, but openFiles
 *  sets it once per capture - must not be papered over by a stale `satisfied`.
 */
export function countKey(i: {
  level: number
  seq: number
  quad: Pt[] | null
  autocrop: string
  boundary: boolean
  pair: boolean
}): string {
  return JSON.stringify([
    i.level, i.seq, i.quad,
    // the request sends "" whenever a hand-drawn quad is present
    i.quad ? "" : i.autocrop,
    i.boundary, i.pair,
  ])
}
