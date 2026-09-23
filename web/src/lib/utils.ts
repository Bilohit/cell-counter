import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { GalleryItem } from "./types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Is this dropped/picked file something the counter can even try? Every entry
 *  point filters with the same rule, so the file picker and the drop zone
 *  cannot disagree about what counts as a capture. TIF is named explicitly:
 *  browsers report no MIME type for it. */
export function isCapture(f: File): boolean {
  return f.type.startsWith("image/") || /\.tiff?$/i.test(f.name)
}

/** Shorten a filename from the MIDDLE, keeping head and tail. EVOS captures
 *  share a long prefix ("10x tile picture 3; first three rows…" vs "…last…"),
 *  so a head-anchored `truncate` renders every tile identical: the part that
 *  tells two captures apart is the tail. Pure, so it is unit-tested. */
export function midTruncate(name: string, max = 28): string {
  if (max <= 1 || name.length <= max) return name
  const keep = max - 1                 // one char goes to the ellipsis
  // Tail-biased split: the EVOS pair differs at "first"/"last" just before the
  // shared "three rows.tif" tail, so an even split can swallow exactly the
  // differing word ("10x tile pict…three rows.tif" twice). A short head is
  // enough to recognise the series; the tail carries the identity.
  const head = Math.max(3, Math.floor(keep / 4))
  const tail = keep - head
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

/** Can this capture still be offered a partner to stitch with? It has to be
 *  counted, and it has to be a single capture: an item that is already the
 *  merge of two has no lone file to stitch a third onto. */
export const pairable = (i: GalleryItem) => i.status === "ready" && i.files.length === 1
