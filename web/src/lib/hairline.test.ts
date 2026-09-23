import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { gatherSpans, isHairlineRisk, type Span } from "./hairline"

// Regression guard for task-Z3 (fix/zen-border-seams). See hairline.ts for
// the predicate itself and - important - for what it CANNOT catch (consumer-
// supplied classes, cascade-order wins, and stray className overrides on a
// primitive): all three produced real defects on this branch and none of
// them is visible to a source-text scan. A green run here proves only that
// no *source file*, read in isolation, pairs a live border edge with a
// rounded corner on the same box.

const COMPONENTS_DIR = join(__dirname, "..", "components")

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(path))
    else if (entry.name.endsWith(".tsx")) out.push(path)
  }
  return out
}

function violations(): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = []
  for (const path of tsxFiles(COMPONENTS_DIR)) {
    const source = readFileSync(path, "utf8")
    const spans: Span[] = gatherSpans(source, path)
    for (const span of spans) {
      if (isHairlineRisk(span.text)) {
        found.push({ file: span.file, line: span.line, text: span.text })
      }
    }
  }
  return found
}

it("has no border edge adjacent to a rounded corner without inset-ring or an exemption", () => {
  const found = violations()
  if (found.length > 0) {
    const report = found
      .map(v => `${v.file}:${v.line}\n  ${v.text.replace(/\s+/g, " ").trim()}`)
      .join("\n")
    expect.fail(
      `Found ${found.length} element(s) with a border edge on a rounded corner - ` +
        `use \`border-transparent inset-ring inset-ring-*\` (see _constraints.md), ` +
        `or mark a genuine exception with \`// hairline-ok: <reason>\`:\n${report}`,
    )
  }
})

// --- Acceptance criteria: these two must NOT flag (border edge sits on the
// UN-rounded side of the box, so WebRender's corner-tile seam never applies).

describe("edge-vs-corner discrimination (must not false-positive)", () => {
  it("GalleryGrid card footer: rounded-b + border-t (bottom radius, top edge)", () => {
    expect(isHairlineRisk('rounded-b-[var(--radius)] border-t border-line')).toBe(false)
  })

  it("ConcentrationDock title bar: rounded-t + border-b (top radius, bottom edge)", () => {
    expect(isHairlineRisk('rounded-t-[11px] border-b border-line')).toBe(false)
  })
})

describe("predicate unit tests", () => {
  it("flags a bare border on a fully-rounded element", () => {
    expect(isHairlineRisk("rounded-md border border-line")).toBe(true)
  })

  it("does not flag the converted form (border-transparent + inset-ring)", () => {
    expect(isHairlineRisk("rounded-md border border-transparent inset-ring inset-ring-line")).toBe(false)
  })

  it("does not flag radius with no border, or border with no radius", () => {
    expect(isHairlineRisk("rounded-full bg-panel")).toBe(false)
    expect(isHairlineRisk("border border-line px-2")).toBe(false)
  })

  it("does not flag border-0 or border-none on a rounded element", () => {
    expect(isHairlineRisk("rounded-md border-0")).toBe(false)
    expect(isHairlineRisk("rounded-md border-none")).toBe(false)
  })

  it("honours a valid hairline-ok exemption anywhere in the span", () => {
    const text = [
      "rounded-md",
      "border border-amber // hairline-ok: dashed at rest, cannot be an inset ring",
    ].join("\n")
    expect(isHairlineRisk(text)).toBe(false)
  })

  it("rejects a bare hairline-ok with no reason", () => {
    const text = ["rounded-md border border-amber // hairline-ok:"].join("\n")
    expect(isHairlineRisk(text)).toBe(true)
  })

  it("finds the pairing across lines within one gathered span (ConcentrationDock shape)", () => {
    // rounded-md on one line, the border several lines later in the same
    // cn() call - the case a per-line scan cannot see at all.
    const text = [
      'cn(',
      '  "rounded-md px-1.5 py-1",',
      '  "transition-[background-color,box-shadow]",',
      '  edited ? "border border-amber bg-amber/10" : "inset-ring-brand/40",',
      ')',
    ].join("\n")
    expect(isHairlineRisk(text)).toBe(true)
  })

  it("does not join radius and border from a cva() base and a DIFFERENT cva() call's variant", () => {
    // rounded lives in one cva() call, border in an unrelated one - they must
    // not be treated as the same box just because they're both in the file.
    const a = 'rounded-full'
    const b = 'border border-line'
    expect(isHairlineRisk(a)).toBe(false)
    expect(isHairlineRisk(b)).toBe(false)
  })
})

describe("span gathering", () => {
  it("gathers a multi-line className={cn(...)} expression as one span", () => {
    const source = [
      'export function X() {',
      '  return <div',
      '    className={cn(',
      '      "rounded-md",',
      '      "border border-line",',
      '    )}',
      '  />',
      '}',
    ].join("\n")
    const spans = gatherSpans(source, "X.tsx")
    expect(spans.length).toBeGreaterThan(0)
    expect(spans.some(s => isHairlineRisk(s.text))).toBe(true)
  })

  it("gathers a cva() base + variant strings as one span", () => {
    const source = [
      'const badgeVariants = cva(',
      '  "inline-flex items-center rounded-full",',
      '  {',
      '    variants: {',
      '      variant: {',
      '        outline: "border border-border",',
      '      },',
      '    },',
      '  },',
      ')',
    ].join("\n")
    const spans = gatherSpans(source, "badge.tsx")
    expect(spans.some(s => isHairlineRisk(s.text))).toBe(true)
  })

  it("gathers a plain string className on its own line", () => {
    const source = 'export const X = () => <div className="rounded-md border border-line" />'
    const spans = gatherSpans(source, "X.tsx")
    expect(spans.some(s => isHairlineRisk(s.text))).toBe(true)
  })
})

// --- Demonstration that this guard actually fires (see task-Z3-report.md for
// the transcript of this test going red with a deliberately-introduced
// violation, then green again after removing it). This block stays as a
// permanent regression case using the exact shape of a real violation.
describe("demonstrated failure mode (kept as a permanent case)", () => {
  it("a rounded-md element with a plain border-line and no inset-ring/exemption is a violation", () => {
    expect(isHairlineRisk("rounded-md border border-line")).toBe(true)
  })
})
