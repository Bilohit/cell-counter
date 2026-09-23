// The seam predicate (task-Z3), shared between the regression guard
// (hairline.test.ts) and the orchestrator's final verification pass, so the
// two never drift apart.
//
// WHY THIS EXISTS: Gecko/WebRender rasterises a rounded border as four corner
// tiles plus four edge runs and double-blends the anti-aliased edges where
// they meet, producing a 1px seam (see docs/plans/2026-09-19-zen-ui-artifacts.md). The
// fix used throughout this branch is `border-transparent` + `inset-ring-*` in
// place of a coloured border. This module flags source that still pairs a
// live border EDGE with a ROUNDED CORNER on the SAME edge of the same box -
// the condition WebRender actually seams on, not just "border + rounded
// anywhere in the file".
//
// THE UNIT OF ANALYSIS IS ONE ELEMENT, NOT ONE LINE. A per-line scan is
// defeated by every real case on this branch: `rounded-md` on one line and
// the (exempt) `border-amber` seven lines later in the same `cn()` call
// (ConcentrationDock.tsx), `rounded`/`border` on adjacent-but-different lines
// (GalleryGrid.tsx), and `cva()` where the radius lives in the base string
// and the border in a variant string that only composes at render
// (ui/badge.tsx). So we gather the whole class EXPRESSION - the balanced
// span following `className={` or `cva(` - and test that as one unit.
//
// WHAT THIS PREDICATE CANNOT CATCH (do not read a green run as proving more
// than this):
//   (a) Consumer-supplied classes. A primitive like `ui/card.tsx`'s
//       CardHeader/CardFooter reacts to `[.border-b]:pb-6` keyed on a class
//       the CALLER passes via `className`; that class never appears in the
//       primitive's own source text, so no source-text predicate can see it.
//   (b) The cascade-order trap. Plain string concatenation (not `cn()`/
//       `twMerge`) can leave `border-transparent` AND `border-<color>` both
//       present in the emitted class string; the winner is whichever rule
//       lands later in the built stylesheet, not whichever token is "last" in
//       the source. This branch hit it once in Sidebar.tsx (a dashed border
//       rendered invisible). Class-name text alone can't see cascade order.
//   (c) Stray overrides through a primitive's `className` prop. Handing a
//       primitive a literal `border-line` (colour) alongside its own `border`
//       (width) utility doubles the line, because tailwind-merge treats
//       width and colour as different class groups and keeps both
//       (SettingsDialog.tsx -> DialogContent). The override lives in a
//       different source span than the primitive's own border, so gathering
//       "one span" doesn't join them.

export interface Span {
  file: string
  /** 1-based line the span starts on, for reporting. */
  line: number
  text: string
}

export interface Violation {
  file: string
  line: number
  text: string
}

/** True when every `hairline-ok` marker in the span carries a reason. A bare
 * `// hairline-ok:` with nothing after the colon does NOT exempt - it is
 * itself a failure, so a silent exemption can't slip in. */
function hasValidExemption(text: string): { exempt: boolean; bareMarker: boolean } {
  const markers = text.match(/\/\/\s*hairline-ok:.*$/gm) ?? []
  if (markers.length === 0) return { exempt: false, bareMarker: false }
  const bare = markers.some(m => !/hairline-ok:\s*\S/.test(m))
  return { exempt: true, bareMarker: bare }
}

type Corner = "tl" | "tr" | "bl" | "br"
const ALL: Corner[] = ["tl", "tr", "bl", "br"]

function roundedCorners(suffix: string | undefined): Corner[] {
  switch (suffix) {
    case undefined: return ALL
    case "t": return ["tl", "tr"]
    case "b": return ["bl", "br"]
    case "l": return ["tl", "bl"]
    case "r": return ["tr", "br"]
    case "tl": return ["tl"]
    case "tr": return ["tr"]
    case "bl": return ["bl"]
    case "br": return ["br"]
    default: return []
  }
}

function borderCorners(suffix: string | undefined): Corner[] {
  switch (suffix) {
    case undefined: return ALL
    case "t": return ["tl", "tr"]
    case "b": return ["bl", "br"]
    case "l": return ["tl", "bl"]
    case "r": return ["tr", "br"]
    case "x": return ALL
    case "y": return ALL
    default: return []
  }
}

// Negative lookbehind excludes both word chars AND `-`, so `bg-border` (a
// background-colour utility that merely reuses the `border` colour token)
// does not get matched as a border-edge class the way a bare `\b` would.
const ROUNDED_RE = /(?<![\w-])rounded(?:-(tl|tr|bl|br|t|b|l|r)\b)?(?:-[\w.[\]()%/$-]+)?/g
const BORDER_RE = /(?<![\w-])border(?:-(t|b|l|r|x|y)\b)?(-[\w.[\]()%/$-]+)?/g

// A bare `border`/`border-t`/... (or one with a purely numeric/pixel width
// modifier: `-0`, `-2`, `-[3px]`) sets WIDTH on that edge - it is what
// actually makes an edge visible. A colour-name modifier (`-line`,
// `-amber`, `-transparent`, ...) sets colour only and, on its own, adds no
// width anywhere: `border-t border-line` gives the top edge a coloured 1px
// line (from `border-t`) while every other edge stays width-0 (invisible)
// regardless of `border-line`'s colour - it never grows a global border.
// Getting this wrong is exactly what produces the two required non-flag
// cases: `border-t`/`border-b` (a width edge with no rounding on that side)
// paired with a same-line, edge-UNSCOPED colour utility.
function isWidthModifier(modifier: string | undefined): boolean {
  if (modifier === undefined) return true
  return /^-(\d+|px|\[[^\]]*\])$/.test(modifier)
}
const ZERO_WIDTH = new Set(["-0", "-none"])
const TRANSPARENT = "-transparent"

/** Applies the seam predicate to one gathered element span. Returns true if
 * the span has a live (nonzero-width, non-transparent) border edge adjacent
 * to a rounded corner on the same box, and no valid exemption covers it. */
export function isHairlineRisk(text: string): boolean {
  const { exempt, bareMarker } = hasValidExemption(text)
  // A bare `// hairline-ok:` (no reason after the colon) is itself a
  // violation - it must NOT exempt anything, so this span is flagged
  // outright regardless of whether it also has a real border+radius pairing.
  if (bareMarker) return true
  if (exempt) return false

  // Comments (including the ones explaining WHY a border/rounding choice was
  // made) are prose, not classnames - "a border here would shift the layout"
  // must not be read as a live `border` utility. Exemption detection above
  // ran on the untouched text; only the class-token scan strips comments.
  const scanText = text.replace(/\/\/.*$/gm, "")

  const rounded = new Set<Corner>()
  for (const m of scanText.matchAll(ROUNDED_RE)) {
    for (const c of roundedCorners(m[1] as Corner | "t" | "b" | "l" | "r" | undefined)) rounded.add(c)
  }
  if (rounded.size === 0) return false

  const widthCorners = new Set<Corner>()
  const suppressedCorners = new Set<Corner>()
  ROUNDED_RE.lastIndex = 0
  BORDER_RE.lastIndex = 0
  for (const m of scanText.matchAll(BORDER_RE)) {
    const edge = m[1] as "t" | "b" | "l" | "r" | "x" | "y" | undefined
    const modifier = m[2]
    const corners = borderCorners(edge)
    if (modifier && (ZERO_WIDTH.has(modifier) || modifier === TRANSPARENT)) {
      for (const c of corners) suppressedCorners.add(c)
      continue
    }
    if (isWidthModifier(modifier)) {
      for (const c of corners) widthCorners.add(c)
    }
    // else: a colour-only modifier (e.g. `-line`, `-amber`) - contributes no
    // width by itself.
  }

  for (const c of widthCorners) {
    if (!suppressedCorners.has(c) && rounded.has(c)) return true
  }
  return false
}

/** True when the span carries a `// hairline-ok:` marker with no reason
 * after the colon - which must itself fail the guard. */
export function hasBareExemption(text: string): boolean {
  return hasValidExemption(text).bareMarker
}

/** Walks `source` (one file's text) and returns every balanced span that
 * follows `className={` or `cva(`. Text-based, not a real parser: it tracks
 * string/template/comment state only well enough to find the matching close
 * bracket without getting fooled by a `{` or `(` inside a string. */
export function gatherSpans(source: string, file: string): Span[] {
  const spans: Span[] = []
  const starts: { at: number; open: string; close: string }[] = []

  const classNameRe = /className=\{/g
  for (const m of source.matchAll(classNameRe)) {
    starts.push({ at: m.index! + m[0].length, open: "{", close: "}" })
  }
  const cvaRe = /\bcva\(/g
  for (const m of source.matchAll(cvaRe)) {
    starts.push({ at: m.index! + m[0].length, open: "(", close: ")" })
  }
  // Plain `className="..."` (no expression) still needs to be checked, on
  // its own single line - it can't span lines by construction.
  const plainRe = /className="([^"]*)"/g
  for (const m of source.matchAll(plainRe)) {
    const line = source.slice(0, m.index!).split("\n").length
    spans.push({ file, line, text: m[1] })
  }

  for (const { at, open, close } of starts) {
    const end = findMatchingClose(source, at, open, close)
    if (end === -1) continue
    const text = source.slice(at, end)
    const line = source.slice(0, at).split("\n").length
    spans.push({ file, line, text })
  }

  return spans
}

/** Finds the index just past the bracket that closes the one opened right
 * before `from`, skipping over string/template literals and `//` comments so
 * a bracket inside either doesn't miscount. */
function findMatchingClose(source: string, from: number, open: string, close: string): number {
  let depth = 1
  let i = from
  let quote: string | null = null
  while (i < source.length) {
    const c = source[i]
    if (quote) {
      if (c === "\\") { i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; i++; continue }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i)
      i = nl === -1 ? source.length : nl + 1
      continue
    }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return i }
    i++
  }
  return -1
}
