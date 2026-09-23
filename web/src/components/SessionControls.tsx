import { useCallback, useRef, useState } from "react"
import { FolderOpen, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { readDock, writeDock } from "@/lib/concentration"
import { saveFile } from "@/lib/exporters"
import { loadSession, orphanedEdits, saveSession, sessionSeeds } from "@/lib/session"
import type { SessionStateV1 } from "@/lib/session"
import type { GalleryItem } from "@/lib/types"
import { useCounterActions, useCounterByField, useCounterSession } from "@/state/useCounter"
import { useGallery } from "@/state/useGallery"

const err = (e: unknown, fallback: string) => (e as Error)?.message || fallback

/** Say so when restored corrections found no field to attach to. */
function warnOrphans(state: SessionStateV1, counted: GalleryItem[], engineVersion: string) {
  const lost = orphanedEdits(state, counted.flatMap(i => (i.field ? [i.field] : [])))
  if (!lost) return
  const was = state.engineVersion
  const sets = `${lost} saved correction ${lost === 1 ? "set" : "sets"}`
  toast.warning(
    was && engineVersion && was !== engineVersion
      ? `${sets} no longer match (engine version changed ${was} → ${engineVersion}).`
      : `${sets} no longer match any counted capture.`)
}

/** Write the whole session — captures, overlap decisions, parameters and hand
 *  corrections — to one zip the user can reopen tomorrow. Gallery toolbar only,
 *  deliberately: a session is the batch, not the one capture on the workbench. */
export function SaveSessionButton() {
  const { items, cropsById } = useGallery()
  const { byField } = useCounterByField()
  const { boundary, version } = useCounterSession()
  const [busy, setBusy] = useState(false)

  const save = useCallback(async () => {
    setBusy(true)
    try {
      // The engine version rides along so a later restore can name it when a
      // correction set no longer matches any field (see session.ts's header).
      saveFile(await saveSession(
        items, byField, boundary, version, undefined, cropsById(),
        // The typed dilution is a bench fact — no recount can rediscover it, so
        // it rides in the file rather than only in the tab's sessionStorage.
        readDock()))
      toast.success("Session saved.")
    } catch (e) {
      toast.error(err(e, "The session could not be saved."))
    } finally {
      setBusy(false)
    }
  }, [items, byField, boundary, version, cropsById])

  return (
    <Button type="button" size="sm" variant="outline" disabled={!items.length || busy} onClick={save}>
      <Save /> Save session
    </Button>
  )
}

/** Reopen a saved session. Offered on the intake screen as well as in the
 *  gallery, because a returning user starts at intake with nothing to come
 *  back to otherwise. */
export function LoadSessionButton({ size = "sm", variant = "outline" }: {
  size?: "sm" | "default"
  variant?: "outline" | "ghost" | "default"
}) {
  const { items, importSession } = useGallery()
  const { setBoundary, setByField } = useCounterActions()
  const { version } = useCounterSession()
  const input = useRef<HTMLInputElement>(null)
  const [zip, setZip] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const { files, state } = await loadSession(file)
      const seeds = sessionSeeds(state, files)
      if (!seeds.length) throw new Error("That session holds no captures to restore.")
      const lost = state.items.length - seeds.length
      if (lost > 0) {
        toast.warning(`${lost} ${lost === 1 ? "capture is" : "captures are"} missing from the zip and were skipped.`)
      }

      setBoundary(state.boundary)
      // Restored wholesale: these are keyed by field fingerprint, and the
      // recount below reproduces the same fingerprints, so each field picks its
      // own corrections back up without anything having to rewire them.
      setByField(state.editsByFingerprint ?? {})
      // Absent in an older session file: that restores an untouched dock, which
      // is what such a session in fact carried.
      writeDock(state.concentration ?? {})

      const counted = await importSession(
        seeds, { params: { boundary: state.boundary ? 1 : 0 } })
      // A correction set is keyed by field fingerprint, and a fingerprint holds
      // the stitch geometry of a merged field. If the stitcher has moved since
      // the session was written, the recount produces a different key and those
      // corrections attach to nothing — quietly, unless it is said out loud.
      if (counted) warnOrphans(state, counted, version)
    } catch (e) {
      toast.error(err(e, "That session could not be opened."))
    } finally {
      setBusy(false)
      setZip(null)
    }
  }, [setBoundary, setByField, importSession, version])

  const pick = useCallback((file: File) => {
    // Loading replaces everything, and nothing in this session is on disk yet.
    if (items.length) setZip(file)
    else void run(file)
  }, [items.length, run])

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = ""          // re-picking the same file must still fire
          if (f) pick(f)
        }}
      />
      <Button
        type="button" size={size} variant={variant} disabled={busy}
        onClick={() => input.current?.click()}
      >
        <FolderOpen /> Load session
      </Button>

      <Dialog open={!!zip} onOpenChange={v => { if (!v) setZip(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Replace current session?</DialogTitle>
            <DialogDescription>
              The {items.length} {items.length === 1 ? "capture" : "captures"} open now, with their
              counts and hand corrections, are closed and the saved session takes their place. Save
              this one first if you want to come back to it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setZip(null)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => { const f = zip; setZip(null); if (f) void run(f) }}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
