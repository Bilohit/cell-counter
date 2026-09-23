import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { csvSummary, centersJson, exportZip, stampName, uniqueNames } from "./exporters"
import type { ExportItem } from "./exporters"
import type { CountedField, Dot } from "./types"

const field = (over: Partial<CountedField> = {}): CountedField => ({
  names: ["t"], count: 0, centers: [], grid_x: [], grid_y: [],
  diameter: 20, level: 2, grid_cols: 0, grid_rows: 0, squares: [], frame: null,
  base_image: "", stages: [], stitch: null,
  width: 100, height: 100, ...over,
})

const item = (name: string, dots: Dot[], over: Partial<CountedField> = {}): ExportItem =>
  ({ name, field: field(over), dots, total: dots.length })

const text = (b: Blob) => b.text()

describe("csvSummary", () => {
  it("writes a header and one CRLF row per capture", async () => {
    const csv = await text(csvSummary([item("a.tif", []), item("b.tif", [[1, 1, "auto"]])]))
    expect(csv).toBe("filename,count\r\na.tif,0\r\nb.tif,1\r\n")
  })

  it("quotes a filename holding a comma, and doubles an embedded quote", async () => {
    const csv = await text(csvSummary([
      item("well A1, rep 2.tif", []),
      item('say "hi".tif', []),
      item("two\nlines.tif", []),
    ]))
    expect(csv).toBe(
      "filename,count\r\n" +
      '"well A1, rep 2.tif",0\r\n' +
      '"say ""hi"".tif",0\r\n' +
      '"two\nlines.tif",0\r\n',
    )
  })

  it("leaves an ordinary filename unquoted", async () => {
    expect(await text(csvSummary([item("plain.tif", [])]))).toContain("\r\nplain.tif,0\r\n")
  })

  it("defuses a filename a spreadsheet would run as a formula", async () => {
    // Excel and Sheets execute a cell starting with = + - @; the leading single
    // quote is the standard "this is text" guard and is not displayed.
    const csv = await text(csvSummary([
      item("=cmd()", []), item("+1", []), item("-x", []), item("@ref", []),
    ]))
    expect(csv).toBe(
      "filename,count\r\n\"'=cmd()\",0\r\n\"'+1\",0\r\n\"'-x\",0\r\n\"'@ref\",0\r\n")
  })
})

describe("centersJson", () => {
  it("reports the count and the points of every capture", async () => {
    const json = JSON.parse(await text(centersJson([
      item("a.tif", [[10, 20, "auto"], [30, 40, "added"]]),
    ])))
    expect(json).toEqual([{ image: "a.tif", count: 2, points: [[10, 20], [30, 40]] }])
  })

  it("maps points back to ORIGINAL px through the field transform", async () => {
    // Crop of 20 px left / 30 px top: displayed (80, 70) is original (100, 100).
    const cropped = { transform: [[1, 0, -20], [0, 1, -30], [0, 0, 1]] }
    const json = JSON.parse(await text(centersJson([
      item("c.tif", [[80, 70, "auto"]], cropped),
    ])))
    expect(json[0].points).toEqual([[100, 100]])
  })

  it("rounds to whole pixels, the shape tools/annotate.html writes", async () => {
    const scaled = { transform: [[2, 0, 0], [0, 2, 0], [0, 0, 1]] }
    const json = JSON.parse(await text(centersJson([item("s.tif", [[7, 9, "auto"]], scaled)])))
    expect(json[0].points).toEqual([[4, 5]])
  })
})

describe("uniqueNames", () => {
  it("keeps distinct names and de-duplicates repeats", () => {
    expect(uniqueNames(["a.png", "b.png", "a.png", "a.png"]))
      .toEqual(["a.png", "b.png", "a-2.png", "a-3.png"])
  })

  it("does not rename onto a name that already exists", () => {
    // A capture genuinely called "a-2.png" owns that name: the rename of the
    // second "a.png" has to step past it, or the zip loses one of the two.
    const out = uniqueNames(["a.png", "a-2.png", "a.png"])
    expect(out).toEqual(["a.png", "a-2.png", "a-3.png"])
    expect(new Set(out).size).toBe(3)
  })

  it("treats a case-only difference as a collision, as a Windows zip does", () => {
    expect(uniqueNames(["A.png", "a.png"])).toEqual(["A.png", "a-2.png"])
  })
})

describe("stampName", () => {
  it("stamps to the minute in local time", () => {
    expect(stampName("zip", new Date(2026, 8, 2, 9, 5))).toBe("cellcounts-20260902-0905.zip")
  })
})

describe("exportZip", () => {
  const items = [item("a.tif", [[1, 1, "auto"]]), item("b.tif", [])]
  const when = new Date(2026, 8, 2, 9, 5)

  it("downloads a lone CSV bare, with no zip around it", async () => {
    const out = await exportZip(items, { zip: false, csv: true, pdf: false, json: false }, false, when)
    expect(out.filename).toBe("cellcounts-20260902-0905.csv")
    expect(await text(out.blob)).toContain("filename,count")
  })

  it("downloads a lone JSON bare", async () => {
    const out = await exportZip(items, { zip: false, csv: false, pdf: false, json: true }, false, when)
    expect(out.filename).toBe("cellcounts-20260902-0905.json")
    expect(JSON.parse(await text(out.blob))).toHaveLength(2)
  })

  it("bundles any combination into one zip", async () => {
    const out = await exportZip(items, { zip: false, csv: true, pdf: false, json: true }, false, when)
    expect(out.filename).toBe("cellcounts-20260902-0905.zip")
    const zip = await JSZip.loadAsync(await out.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(["counts.csv", "centers.json"].sort())
  })

  it("refuses an empty selection of formats", async () => {
    await expect(exportZip(items, { zip: false, csv: false, pdf: false, json: false }, false))
      .rejects.toThrow(/format/i)
  })
})
