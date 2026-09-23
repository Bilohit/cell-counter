import JSZip from "jszip"
import { DOT_ADDED, DOT_AUTO } from "./dotColors"
import { toOrig } from "./geom"
import type { CountedField, Dot, Pt } from "./types"

/** One capture as it leaves the app: the name the gallery shows, the counted
 *  field, the dots that make up its total (DISPLAYED px, the space
 *  `field.base_image` is drawn in), and that total itself. Callers build
 *  `dots`/`total` with `countedDots`/`effectiveTotal` so an export can never
 *  disagree with the number on the card. Only ever a CountedField: the
 *  gallery items an export draws from never hold a per-field refusal (see
 *  GalleryItem.field in types.ts). */
export interface ExportItem {
  name: string
  field: CountedField
  dots: Dot[]
  total: number
}

export interface Formats { zip: boolean; csv: boolean; pdf: boolean; json: boolean }

/** The workbench's own dot colours, from the one module both the canvas and
 *  this file read, so a burned-in image is the screen the user approved. */
const AUTO = DOT_AUTO
const ADDED = DOT_ADDED

// ---------------------------------------------------------------- names

const pad = (n: number) => String(n).padStart(2, "0")

/** `cellcounts-YYYYMMDD-HHMM.<ext>`, local time: the stamp names the run, and a
 *  researcher reads it against the clock on the bench, not against UTC. The
 *  prefix names what the file IS — a saved session is not an export, and the
 *  two must not land in a downloads folder under the same name. */
export function stampName(ext: string, d = new Date(), prefix = "cellcounts"): string {
  const s = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${prefix}-${s}.${ext}`
}

const stripExt = (n: string) => n.replace(/\.(tiff?|png|jpe?g)$/i, "")

/** A capture name as a file name: a merged field carries both originals, and
 *  the separator characters have to survive a zip on any OS. */
export const safeBase = (name: string) =>
  stripExt(name).replace(/[\\/:*?"<>|]+/g, "_").trim() || "capture"

/** Two captures can genuinely carry the same filename, so a zip that silently
 *  overwrote one of them would report a count the user cannot find again.
 *  Every EMITTED name is registered, not only the originals: a capture really
 *  called "a-2.png" must not be collided into by the rename of a second "a.png".
 *  Case-insensitive, because a Windows or macOS zip collides on case. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map(n => {
    const at = n.lastIndexOf(".")
    const [base, ext] = at > 0 ? [n.slice(0, at), n.slice(at)] : [n, ""]
    let out = n
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${base}-${i}${ext}`
    seen.add(out.toLowerCase())
    return out
  })
}

// ---------------------------------------------------------------- text formats

/** RFC 4180: quote only when the value would otherwise break a row, and double
 *  any quote inside it. Filenames really do contain commas.
 *
 *  A leading = + - @ (or tab/CR) makes Excel and Sheets treat the cell as a
 *  FORMULA, so a capture named "=cmd()" would run on open. A single quote in
 *  front is the standard guard: spreadsheets read it as "this is text" and do
 *  not show it, and it forces the quoting branch so the guard cannot itself be
 *  mistaken for part of an unquoted value. */
const csvCell = (v: string) => {
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(guarded) || guarded !== v
    ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function csvText(items: ExportItem[]): string {
  const rows = ["filename,count", ...items.map(i => `${csvCell(i.name)},${i.total}`)]
  // Trailing CRLF: Excel and every CSV reader treat it as end-of-row, not as an
  // empty record.
  return rows.join("\r\n") + "\r\n"
}

export const csvSummary = (items: ExportItem[]): Blob =>
  new Blob([csvText(items)], { type: "text/csv;charset=utf-8" })

/** Points in ORIGINAL-image px, the shape `tools/annotate.html` writes, so a
 *  corrected field can be saved straight into data/gt. A crop must not
 *  change what a point exports as. */
export function centersText(items: ExportItem[]): string {
  const out = items.map(i => ({
    image: i.name,
    count: i.total,
    points: i.dots.map(d => toOrig(i.field, [d[0], d[1]]).map(Math.round) as Pt),
  }))
  return JSON.stringify(out, null, 1)
}

export const centersJson = (items: ExportItem[]): Blob =>
  new Blob([centersText(items)], { type: "application/json" })

// ---------------------------------------------------------------- images

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error("The counted image is no longer on the server. Re-run the count and export again."))
    img.src = src
  })
}

/** The counted capture with its cells drawn on, the same marks the workbench
 *  shows, rendered once at the field's own pixel size. */
async function renderAnnotated(it: ExportItem, burnCount: boolean): Promise<HTMLCanvasElement> {
  const img = await loadImage(it.field.base_image)
  const w = it.field.width || img.naturalWidth
  const h = it.field.height || img.naturalHeight
  const cv = document.createElement("canvas")
  cv.width = w
  cv.height = h
  const g = cv.getContext("2d")
  if (!g) throw new Error("This browser would not give the exporter a canvas.")
  g.drawImage(img, 0, 0, w, h)

  // `it.dots` is countedDots: dots in excluded squares are deliberately absent,
  // so the burned-in total always equals the number of dots drawn. (The screen
  // still shows them, greyed — the export is the record, not the workbench.)
  it.dots.forEach(([x, y, kind]) => {
    g.beginPath()
    g.arc(x, y, 3, 0, Math.PI * 2)
    g.fillStyle = kind === "added" ? ADDED : AUTO
    g.fill()
  })

  if (burnCount) {
    // Sized off the image so the caption reads the same on a stitched field as
    // on a single capture, with a floor for a small crop.
    const size = Math.max(13, Math.round(h / 42))
    const label = `${it.total} cells`
    g.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    g.textBaseline = "alphabetic"
    const padX = Math.round(size * 0.6), padY = Math.round(size * 0.42)
    const tw = g.measureText(label).width
    const bx = size * 0.7, by = h - size * 0.7
    // A dark plate: the capture underneath is a microscope field, and white
    // text alone disappears over a pale square.
    g.fillStyle = "rgba(0,0,0,.72)"
    g.fillRect(bx, by - size - padY, tw + padX * 2, size + padY * 2)
    g.fillStyle = "#ffffff"
    g.fillText(label, bx + padX, by - padY * 0.2)
  }
  return cv
}

export async function annotatedPng(it: ExportItem, burnCount: boolean): Promise<Blob> {
  const cv = await renderAnnotated(it, burnCount)
  return new Promise((res, rej) => {
    cv.toBlob(b => (b ? res(b) : rej(new Error("The annotated image could not be encoded."))),
              "image/png")
  })
}

// ---------------------------------------------------------------- pdf

/** A plain report: what was counted, when, and each capture at a glance. */
export async function pdfReport(
  items: ExportItem[], burnCount: boolean, now = new Date(),
): Promise<Blob> {
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48

  doc.setFont("helvetica", "bold").setFontSize(18)
  doc.text("Cell Counter report", M, M + 6)
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(110)
  // The same instant the filename is stamped with, so the report and the file
  // it arrives in never name two different runs.
  doc.text(now.toLocaleString(), M, M + 24)
  doc.setTextColor(0)

  let y = M + 58
  doc.setFont("helvetica", "bold").setFontSize(10)
  doc.text("Capture", M, y)
  doc.text("Cells", W - M, y, { align: "right" })
  doc.setDrawColor(190).line(M, y + 6, W - M, y + 6)
  doc.setFont("helvetica", "normal")
  y += 20

  items.forEach(it => {
    if (y > H - M) { doc.addPage(); y = M }
    // The name column stops short of the number, so a long capture name is cut
    // rather than printed through the count.
    doc.text(String(doc.splitTextToSize(it.name, W - M * 2 - 60)[0]), M, y)
    doc.text(String(it.total), W - M, y, { align: "right" })
    y += 16
  })

  const total = items.reduce((n, i) => n + i.total, 0)
  // The totals line is two lines tall with its rule: a long table must not push
  // it off the bottom of the page any more than a row.
  if (y + 4 > H - M) { doc.addPage(); y = M }
  doc.setDrawColor(190).line(M, y - 10, W - M, y - 10)
  doc.setFont("helvetica", "bold")
  doc.text(`${items.length} ${items.length === 1 ? "capture" : "captures"}`, M, y + 4)
  doc.text(String(total), W - M, y + 4, { align: "right" })

  for (const it of items) {
    const cv = await renderAnnotated(it, burnCount)
    doc.addPage()
    const cap = 26
    const s = Math.min((W - M * 2) / cv.width, (H - M * 2 - cap) / cv.height)
    const w = cv.width * s, h = cv.height * s
    doc.addImage(cv.toDataURL("image/png"), "PNG", (W - w) / 2, M, w, h)
    doc.setFont("helvetica", "normal").setFontSize(10)
    doc.text(`${it.name} — ${it.total} cells`, W / 2, M + h + 18, { align: "center" })
  }

  return doc.output("blob")
}

// ---------------------------------------------------------------- bundle

export interface ExportFile { blob: Blob; filename: string }

/** Everything the dialog asked for, as the one file the browser will save.
 *  A lone CSV, JSON or PDF downloads bare — zipping a single small file only
 *  puts an unzip step between the user and their numbers. Anything else,
 *  annotated images included, is one zip. */
export async function exportZip(
  items: ExportItem[], fmts: Formats, burnCount: boolean, now = new Date(),
): Promise<ExportFile> {
  const picked = [fmts.zip, fmts.csv, fmts.pdf, fmts.json].filter(Boolean).length
  if (!picked) throw new Error("Pick at least one format to export.")
  if (!items.length) throw new Error("There is nothing counted to export.")

  if (picked === 1 && !fmts.zip) {
    if (fmts.csv) return { blob: csvSummary(items), filename: stampName("csv", now) }
    if (fmts.json) return { blob: centersJson(items), filename: stampName("json", now) }
    return { blob: await pdfReport(items, burnCount, now), filename: stampName("pdf", now) }
  }

  const zip = new JSZip()
  // Strings and ArrayBuffers, not Blobs: JSZip only reads a Blob through a
  // FileReader that not every environment gives it.
  if (fmts.csv) zip.file("counts.csv", csvText(items))
  if (fmts.json) zip.file("centers.json", centersText(items))
  if (fmts.pdf) {
    zip.file("report.pdf", await (await pdfReport(items, burnCount, now)).arrayBuffer())
  }
  if (fmts.zip) {
    const names = uniqueNames(items.map(i => `${safeBase(i.name)}.png`))
    for (let i = 0; i < items.length; i++) {
      zip.file(`images/${names[i]}`, await (await annotatedPng(items[i], burnCount)).arrayBuffer())
    }
  }
  return { blob: await zip.generateAsync({ type: "blob" }), filename: stampName("zip", now) }
}

/** Hand the finished bundle to the browser. */
export function saveFile({ blob, filename }: ExportFile): void {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  // Revoke on a later task: Firefox can abort the download if the blob URL
  // dies in the same task as the click.
  const url = a.href
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
