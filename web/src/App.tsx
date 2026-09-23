import { useCallback, useEffect, useState } from "react"
import { PanelLeftOpen } from "lucide-react"
import { Toaster, toast } from "sonner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { DropZone } from "@/components/DropZone"
import { BatchConfirm } from "@/components/BatchConfirm"
import { ScanScreen } from "@/components/ScanScreen"
import { ProcessingScreen } from "@/components/ProcessingScreen"
import { OverlapBoard } from "@/components/OverlapBoard"
import { GalleryGrid } from "@/components/GalleryGrid"
import { EditNav } from "@/components/EditNav"
import { Sidebar } from "@/components/Sidebar"
import { Viewer } from "@/components/Viewer"
import { StageStrip } from "@/components/StageStrip"
import { ImageToolbar } from "@/components/ImageToolbar"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ExportDialog } from "@/components/ExportDialog"
import { LoadSessionButton } from "@/components/SessionControls"
import type { ExportScope } from "@/components/ExportDialog"
import { CountBadge } from "@/components/CountBadge"
import { beaconReset, resetServer } from "@/lib/api"
import { cn } from "@/lib/utils"
import { CounterProvider, useCounter } from "@/state/useCounter"
import { useSettings } from "@/state/useSettings"
import { GalleryProvider, useGallery } from "@/state/useGallery"
import { useTheme } from "@/state/useTheme"

/** Below this the panel would leave the photo less room than it takes itself,
 *  so it folds away on its own. Physical viewport px: the app is drawn through
 *  a body transform, so this is the window the user actually has. */
const NARROW = "(max-width: 1100px)"

function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return narrow
}

/** The single-field workbench, unchanged: it is what the "edit" view shows.
 *  The settings dialog it used to own now lives once in `Views`, so the gear in
 *  this sidebar and the one in the gallery header drive the same theme state
 *  instead of two copies that drift apart (the M-9 desync, again). */
export function Shell({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { sidebarOpen, setSidebarOpen } = useSettings()
  const { intakeDrop } = useGallery()
  const narrow = useNarrow()
  // The auto-collapse is a suggestion, never a new preference: it is held here,
  // for this window, and the stored `sidebarOpen` is left exactly as the user
  // set it. Opening the panel by hand clears the suggestion, so an explicit
  // choice outlives it until the window crosses the breakpoint again.
  const [autoHidden, setAutoHidden] = useState(narrow)
  // Adjusted during render, not in an effect: crossing the breakpoint has to
  // change the panel in the same paint the resize does, and an effect would
  // render the wide layout once at 900px before folding it away.
  const [wasNarrow, setWasNarrow] = useState(narrow)
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow)
    setAutoHidden(narrow)
  }
  const open = sidebarOpen && !autoHidden
  const show = useCallback((v: boolean) => {
    setAutoHidden(false)
    setSidebarOpen(v)
  }, [setSidebarOpen])

  return (
    <div className="flex h-full">
      {/* Width, not unmounting: the panel keeps its scroll position and its
          open sections, so folding it away is a look at the photo rather than
          losing the place you were working in. `inert` keeps the hidden
          controls out of the tab order while it is closed. */}
      <div
        inert={!open}
        className={cn(
          "h-full flex-none overflow-hidden transition-[width] duration-200 ease-out",
          "motion-reduce:transition-none",
          open ? "w-[308px]" : "w-0",
        )}
      >
        <Sidebar onCollapse={() => show(false)} />
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Viewer onIntake={intakeDrop} />
          {!open && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => show(true)}
                    aria-label="Show the panel"
                    className={
                      "absolute top-4 left-4 z-20 flex size-9 cursor-pointer items-center " +
                      // An INSET ring, never a coloured border: Zen/WebRender seams a
                      // real border at a rounded corner (measured 2026-09-19, see
                      // _constraints.md).
                      "justify-center rounded-[var(--radius)] border border-transparent " +
                      "inset-ring inset-ring-line bg-panel/90 " +
                      "text-dim shadow-[0_18px_50px_-24px_var(--shadow)] backdrop-blur-md " +
                      "transition-[color,box-shadow] duration-150 ease-out hover:inset-ring-line-hi " +
                      "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                      "focus-visible:outline-none"
                    }
                  >
                    <PanelLeftOpen className="size-[19px]" strokeWidth={1.8} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Show the panel</TooltipContent>
              </Tooltip>
              <CountBadge />
            </>
          )}
        </div>
        <StageStrip />
        {/* One bar, directly under the picture: the control that changes the
            count and the button that commits it at the left end, the app's own
            properties and settings at the right. */}
        <ImageToolbar onOpenSettings={onOpenSettings} />
      </main>
    </div>
  )
}

/** The workbench with the gallery's own chrome above it: Shell itself stays
 *  exactly what the single-capture build shipped. */
function EditView({ onExport, onOpenSettings }: {
  onExport: () => void
  onOpenSettings: () => void
}) {
  return (
    <div className="flex h-full flex-col">
      <EditNav onExport={onExport} />
      <div className="min-h-0 flex-1">
        <Shell onOpenSettings={onOpenSettings} />
      </div>
    </div>
  )
}

/** The app can only ever fail to reach the server at startup in one place
 *  (see useCounter's retry loop). This is what tells the user, since
 *  `ready` staying false otherwise looks like nothing happened. The toast
 *  is persistent (no auto-dismiss) because the condition does not resolve
 *  itself; its own "Retry" action is the only way off it besides a reload. */
function ServerDownToast() {
  const { serverDown, retryServer } = useCounter()
  useEffect(() => {
    if (!serverDown) return
    const id = toast.error(
      "Can't reach the counter. Make sure the app is still running, then try again.",
      { duration: Infinity, action: { label: "Retry", onClick: retryServer } },
    )
    return () => { toast.dismiss(id) }
  }, [serverDown, retryServer])
  return null
}

/** Reload and close wipe the work, server memory included.
 *
 *  Two halves, and only the first is a guarantee. On mount - which a new page
 *  load always reaches - the server is told to drop the image store, the decode
 *  cache and the stitch cache, so a reloaded app never sits on top of the
 *  previous page's bytes. On `pagehide` a beacon says the same thing early, so
 *  a closed tab frees the memory then rather than at the next launch; beacons
 *  are best-effort by design (a crash, a killed process and a pulled plug all
 *  send nothing), which is exactly why the mount call is the one that counts.
 *
 *  `pagehide`, not `beforeunload`: the latter is not delivered reliably on
 *  mobile or on a bfcache restore, and it is already carrying the unsaved-work
 *  confirmation below, where returning a string is what shows the dialog.
 *
 *  What SURVIVES a reload is everything a preference: theme, interface scale,
 *  burn-count, the folded sidebar, and a dismissed hint. Work does not. */
function SessionReset() {
  const { items } = useGallery()
  const hasWork = items.length > 0

  useEffect(() => {
    void resetServer()
    const onHide = () => beaconReset()
    window.addEventListener("pagehide", onHide)
    return () => window.removeEventListener("pagehide", onHide)
  }, [])

  // The browser's own "Leave site?" dialog, and only while there is something
  // to lose. Reload wipes the session by design, but an accidental Ctrl+R used
  // to cost hours of hand corrections in silence - while the far less
  // destructive "New session" button has always asked first. The browser
  // ignores any custom text here and shows its own wording; `preventDefault`
  // plus a non-empty `returnValue` is what asks for the prompt at all.
  useEffect(() => {
    if (!hasWork) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [hasWork])

  return null
}

function Views() {
  const { view, intake, intakeDrop, activeId } = useGallery()
  const [settings, setSettings] = useState(false)
  const { theme, setTheme } = useTheme()
  const openSettings = useCallback(() => setSettings(true), [])
  // One export dialog for the whole app: the gallery selection, the whole
  // gallery and the capture on the workbench all open the same one.
  const [scope, setScope] = useState<ExportScope | null>(null)

  // Drop anywhere on the window. Deliberate change from the single-image page:
  // a drop now always stages into the gallery intake instead of replacing the
  // capture currently open in the edit view. The guards (in-flight block,
  // non-capture filter, refusal message) live in useGallery.intakeDrop, so
  // this path and the workbench's own DropZone (Viewer.tsx) share them and
  // cannot drift apart.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      intakeDrop([...(e.dataTransfer?.files ?? [])])
    }
    document.addEventListener("dragover", stop)
    document.addEventListener("drop", onDrop)
    return () => {
      document.removeEventListener("dragover", stop)
      document.removeEventListener("drop", onDrop)
    }
  }, [intakeDrop])

  const body =
    view === "edit"
      ? (
        <EditView
          onExport={() => activeId && setScope({ ids: [activeId], kind: "one" })}
          onOpenSettings={openSettings}
        />
      )
      : view === "intake"
        ? (
          <div
            data-testid="view-intake"
            className="flex h-full flex-col items-center justify-center gap-4 p-7"
          >
            <DropZone onFiles={intake} />
            {/* A returning user starts here with nothing open, so the way back
                into yesterday's work has to be on this screen too. */}
            <LoadSessionButton variant="ghost" />
          </div>
        )
        : view === "confirm" ? <BatchConfirm />
          : view === "scan" ? <ScanScreen />
            : view === "processing" ? <ProcessingScreen />
              : view === "review" ? <OverlapBoard />
                : (
                  <GalleryGrid
                    onExport={(ids, kind) => setScope({ ids, kind })}
                    onOpenSettings={openSettings}
                  />
                )

  return (
    <>
      {body}
      {/* Mounted only while a scope is set; the dialog resolves those ids
          against the live gallery, so a capture removed meanwhile drops out. */}
      {scope && (
        <ExportDialog open onOpenChange={v => { if (!v) setScope(null) }} scope={scope} />
      )}
      {/* One dialog for the whole app: the workbench gear and the gallery gear
          open this same one. */}
      <SettingsDialog open={settings} onOpenChange={setSettings} theme={theme} setTheme={setTheme} />
    </>
  )
}

export default function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <CounterProvider>
        <GalleryProvider>
          <Views />
          <SessionReset />
          <ServerDownToast />
          <Toaster position="bottom-center" richColors closeButton />
        </GalleryProvider>
      </CounterProvider>
    </TooltipProvider>
  )
}
