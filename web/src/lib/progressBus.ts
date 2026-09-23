import { useEffect, useState } from "react"
import { fetchCountProgress } from "@/lib/api"

/** What a count is doing right now, as the server reports it.
 *
 *  `frac` is deliberately optional: `undefined` means "running, but nobody can
 *  honestly say how far in" - the state a poll that 404s or fails falls back to.
 *  The ring draws that as a spinning arc, never as 0 %, because a count that is
 *  nearly done must not be shown as barely started (council, 2026-09-21).
 */
export interface CountProgress {
  state: "queued" | "running" | "done" | "failed"
  /** 0..1 across the whole request, or undefined when it cannot be known. */
  frac?: number
  /** The step's own words - "Running the detector". Empty while queued. */
  label: string
  /** Position in the queue behind other counts, when `state` is "queued". */
  position?: number
  /** Which field of how many, for a batch. */
  field?: number
  fields?: number
}

type Fn = (p: CountProgress | null) => void
/** Keyed by tracking key ("workbench" by default, or a gallery item's id), so
 *  two cards counting at once do not stomp each other's progress. */
const subs = new Map<string, Set<Fn>>()
const now = new Map<string, CountProgress | null>()

function emit(key: string, next: CountProgress | null) {
  now.set(key, next)
  subs.get(key)?.forEach(f => f(next))
}

/** Reactive read of the live count progress for `key`, or null when nothing is
 *  counting under it.
 *
 *  Its own bus rather than a field on the counter store: the ring ticks several
 *  times a second, and anything subscribed to the store would re-render with it
 *  - which is the cost the store was split into four contexts to avoid. A
 *  component that wants the ring subscribes here and nothing else does.
 */
export function useCountProgress(key = "workbench"): CountProgress | null {
  const [p, setP] = useState(now.get(key) ?? null)
  useEffect(() => {
    if (!subs.has(key)) subs.set(key, new Set())
    subs.get(key)!.add(setP)
    // oxlint-disable-next-line react/set-state-in-effect
    setP(now.get(key) ?? null)
    return () => { subs.get(key)!.delete(setP) }
  }, [key])
  return p
}

/** How often to ask. 250 ms is invisible against a 0.8-19 s count and costs
 *  four dict reads a second on 127.0.0.1. */
const EVERY_MS = 250

/** Follow `token` until `stop()` is called, publishing to the bus.
 *
 *  Never throws and never blocks the count: this is telemetry, and the count's
 *  own response remains the only thing that decides whether it worked.
 */
export function trackCount(token: string, key = "workbench"): () => void {
  let stopped = false

  // "Running, no number yet" until the first poll lands - not 0 %, which would
  // claim the work has not started when it may be nearly done.
  emit(key, { state: "running", label: "", frac: undefined })

  const tick = async () => {
    const at = await fetchCountProgress(token)
    if (stopped) return
    if (!at) {
      // Unknown or evicted token: keep saying "running" with no fraction, so
      // the ring falls back to an indeterminate sweep rather than a lie or a
      // sudden "lost".
      emit(key, { state: "running", label: "", frac: undefined })
      return
    }
    if (at.state === "done" || at.state === "failed") {
      // The response, not the poll, is what ends a run for the caller; stop
      // reporting and let `stop()` clear the bus.
      emit(key, { ...at, frac: 1 })
      return
    }
    emit(key, at)
  }

  const id = setInterval(() => { void tick() }, EVERY_MS)
  void tick()

  return () => {
    stopped = true
    clearInterval(id)
    emit(key, null)
  }
}

/** A fresh ticket. `crypto.randomUUID` is present in every browser this app
 *  runs in (it ships its own CPython and opens on 127.0.0.1, a secure context),
 *  and the fallback only has to be unique within one page. */
export function newToken(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }
}
