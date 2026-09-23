import { describe, expect, it } from "vitest"
import { ICON_BUTTON, TILE, TILE_HOVER, TILE_HOVER_GROUP, TILE_MEDIA } from "./styles"

/** Tailwind v4 writes the STANDALONE CSS properties for these utilities, not
 *  `transform`. A transition list naming `transform` therefore does not animate
 *  them, and the movement jumps to its end value on the first frame while
 *  whatever else is in the list eases - which is invisible in review and reads
 *  as "it snaps" in use. Measured in the real app 2026-09-21: the tile's
 *  computed `translate` went 0 -> -3px between two samples 40 ms apart.
 *
 *  So: any class string that MOVES something must name the property it really
 *  animates in its own transition list. */
const STANDALONE: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|:)-?translate-[xy]-/, "translate"],
  [/(?:^|:)scale-/, "scale"],
  [/(?:^|:)rotate-/, "rotate"],
]

/** What `transition-[a,b]` in a class string promises to animate. */
function transitioned(cls: string): string[] {
  const m = /transition-\[([^\]]+)\]/.exec(cls)
  if (m) return m[1].split(",").map(s => s.trim())
  if (/\btransition-opacity\b/.test(cls)) return ["opacity"]
  if (/\btransition-colors\b/.test(cls)) return ["color", "background-color"]
  if (/\btransition\b(?![-[])/.test(cls)) return ["all"]
  return []
}

describe("moving utilities are actually in their transition list", () => {
  // The tile's movement lives in the HOVER strings and its transition list in
  // the BASE string, which is exactly how the two drifted apart.
  const cases: ReadonlyArray<[string, string, string]> = [
    ["tile (hovered directly)", TILE, TILE_HOVER],
    ["tile (hovered via group)", TILE, TILE_HOVER_GROUP],
    ["icon button", ICON_BUTTON, ICON_BUTTON],
    ["tile media", TILE_MEDIA, TILE_MEDIA],
  ]

  for (const [name, base, movement] of cases) {
    it(name, () => {
      const list = transitioned(base)
      for (const [pattern, property] of STANDALONE) {
        if (!pattern.test(movement)) continue
        expect(
          list.includes(property) || list.includes("all"),
          `${name} moves with a \`${property}\` utility, but its transition list is `
          + `[${list.join(", ")}] - so the movement will snap. Add \`${property}\`.`,
        ).toBe(true)
      }
    })
  }
})

describe("the tile recipe is variant C: a small lift, and the picture stays still", () => {
  it("lifts 2px and grows a shadow", () => {
    for (const hover of [TILE_HOVER, TILE_HOVER_GROUP]) {
      expect(hover).toMatch(/-translate-y-\[2px\]/)
      expect(hover).toMatch(/shadow-\[0_12px_26px_-18px_var\(--shadow\)\]/)
    }
  })

  it("never moves the image inside", () => {
    expect(TILE_MEDIA).not.toMatch(/scale-/)
    expect(TILE_MEDIA).not.toMatch(/brightness-/)
    expect(TILE_MEDIA).not.toMatch(/translate-/)
  })

  it("keeps the lift behind motion-safe, and kills the transition under motion-reduce", () => {
    expect(TILE).toMatch(/motion-reduce:transition-none/)
    for (const hover of [TILE_HOVER, TILE_HOVER_GROUP]) {
      expect(hover).toMatch(/motion-safe:(group-)?hover:-translate-y/)
    }
  })
})
