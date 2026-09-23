import type { CountResponse, ParamsResponse, PairsResponse, Pt } from "./types"

/** The server has two error dialects and both carry the only sentence worth
 *  showing. app.py's own failures are `{"error": "..."}` (app.py:37). Anything
 *  FastAPI rejects before the handler runs is a 422 whose message sits in
 *  `detail` - a plain string when it was raised by hand, or the validation list
 *  of `{loc, msg}` objects. `detail` used to be dropped on the floor and the
 *  user was shown "Count failed" instead of "level must be 1-4".
 *
 *  `fallback` is the last resort only: a non-JSON body (a proxy's HTML error
 *  page) has nothing to read. */
async function errorFrom(res: Response, fallback: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => null)
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; detail?: unknown }
    if (typeof b.error === "string" && b.error) return new Error(b.error)
    if (typeof b.detail === "string" && b.detail) return new Error(b.detail)
    if (Array.isArray(b.detail)) {
      // Name the field: "params: field required" tells the user which input the
      // server refused, which the bare message does not.
      const msg = b.detail
        .map((d: unknown) => {
          const e = d as { loc?: unknown; msg?: unknown }
          if (typeof e?.msg !== "string") return ""
          const loc = Array.isArray(e.loc) ? e.loc.filter(p => p !== "body").join(".") : ""
          return loc ? `${loc}: ${e.msg}` : e.msg
        })
        .filter(Boolean)
        .join("; ")
      if (msg) return new Error(msg)
    }
  }
  return new Error(fallback)
}

/** Tell the server the page it was caching for is gone.
 *
 *  Reload and close both wipe the app's work, so the server's image store,
 *  decode cache and stitch cache are a previous session's memory the moment a
 *  page load begins. Called once on mount - a new page load always mounts,
 *  which no unload event can promise - and again from a `pagehide` beacon, so
 *  the common case frees the memory immediately instead of at the next launch.
 *
 *  Never throws: this is housekeeping. A server that refuses it is a server
 *  the very next call will surface properly. */
export async function resetServer(): Promise<void> {
  try {
    await fetch("/api/reset", { method: "POST" })
  } catch { /* the next real request reports an unreachable server */ }
}

export function beaconReset(): void {
  try {
    navigator.sendBeacon?.("/api/reset")
  } catch { /* best effort: the next page load's mount call is the guarantee */ }
}

export async function fetchParams(): Promise<ParamsResponse> {
  const res = await fetch("/api/params")
  if (!res.ok) throw await errorFrom(res, "Could not load the engine parameters.")
  return res.json()
}

export interface CountRequest {
  /** Progress ticket, so the caller can poll GET /api/progress/{token} while
   *  this request is in flight. Optional: a request without one still counts,
   *  and reports nothing. */
  token?: string
  files: File[]
  params: Record<string, number>
  autocrop: string
  quad: Pt[] | null
  stages: boolean
  /** These two captures are a manual or review-confirmed pair: stitch them
   *  directly and refuse (not silently split) if the seam does not hold.
   *  Defaults to false; callers must opt in explicitly, never infer it from
   *  file count. */
  pair?: boolean
  signal?: AbortSignal
}

export async function count(req: CountRequest): Promise<CountResponse> {
  const fd = new FormData()
  req.files.forEach(f => fd.append("images", f))
  fd.append("params", JSON.stringify(req.params))
  fd.append("autocrop", req.autocrop)
  if (req.quad) fd.append("quad", JSON.stringify(req.quad))
  fd.append("stages", String(req.stages))
  if (req.pair) fd.append("pair", String(req.pair))
  // The progress ticket, minted by the caller. Optional on both sides: without
  // it the count behaves exactly as it always has and reports nothing.
  if (req.token) fd.append("token", req.token)

  const res = await fetch("/api/count", { method: "POST", body: fd, signal: req.signal })
  if (!res.ok) throw await errorFrom(res, "Count failed")
  return res.json()
}

export async function fetchPairs(
  files: File[], signal?: AbortSignal,
  /** Names this sweep so `fetchSweepProgress` can follow it while it runs. */
  job?: string,
): Promise<PairsResponse> {
  const fd = new FormData()
  files.forEach(f => fd.append("images", f))
  if (job) fd.append("job", job)

  const res = await fetch("/api/pairs", { method: "POST", body: fd, signal })
  if (!res.ok) throw await errorFrom(res, "Pairing failed")
  return res.json()
}

/** Where the count running under `token` has got to, or null when the server
 *  has no such token - never issued, or pushed out of its bounded map.
 *
 *  Advisory, like the sweep poll below: it runs beside the count it reports on,
 *  and a failed poll answers null rather than throwing, so the progress ring
 *  can never be the thing that fails a count. The caller renders null as an
 *  indeterminate sweep, never as 0 %. */
export async function fetchCountProgress(
  token: string, signal?: AbortSignal,
): Promise<{ state: "queued" | "running" | "done" | "failed"; frac?: number
             label: string; position?: number; field?: number; fields?: number } | null> {
  try {
    const res = await fetch(`/api/progress/${encodeURIComponent(token)}`, { signal })
    if (!res.ok) return null
    const b = await res.json() as Record<string, unknown>
    const state = b.state
    if (state !== "queued" && state !== "running" && state !== "done" && state !== "failed") {
      return null
    }
    return {
      state,
      ...(typeof b.frac === "number" ? { frac: b.frac } : {}),
      label: typeof b.label === "string" ? b.label : "",
      ...(typeof b.position === "number" ? { position: b.position } : {}),
      ...(typeof b.field === "number" ? { field: b.field } : {}),
      ...(typeof b.fields === "number" ? { fields: b.fields } : {}),
    }
  } catch {
    return null
  }
}

/** How many of a running sweep's comparisons are done.
 *
 *  A poll is advisory: it runs beside the upload it is reporting on, and a
 *  failed or not-yet-registered one answers 0 of 0 rather than throwing, so a
 *  progress bar can never be the thing that fails a count. */
export async function fetchSweepProgress(
  job: string, signal?: AbortSignal,
): Promise<{ done: number; total: number }> {
  try {
    const res = await fetch(`/api/sweep/${encodeURIComponent(job)}`, { signal })
    if (!res.ok) return { done: 0, total: 0 }
    const body: unknown = await res.json()
    const b = body as { done?: unknown; total?: unknown }
    return typeof b?.done === "number" && typeof b?.total === "number"
      ? { done: b.done, total: b.total }
      : { done: 0, total: 0 }
  } catch {
    return { done: 0, total: 0 }
  }
}

/** Small JPEGs for files the browser cannot decode itself, in upload order.
 *  EVOS captures are TIF and no browser renders one, so without this the
 *  confirm screen is a grid of grey boxes in the product's normal case. */
export async function fetchThumbs(
  files: File[], signal?: AbortSignal,
): Promise<{ thumbs: { name: string; image: string }[] }> {
  const fd = new FormData()
  files.forEach(f => fd.append("images", f))

  const res = await fetch("/api/thumbs", { method: "POST", body: fd, signal })
  if (!res.ok) throw await errorFrom(res, "Preview failed")
  return res.json()
}
