import { afterEach, expect, it, vi } from "vitest"
import { count, fetchPairs, fetchParams } from "./api"

// The server speaks two error dialects and the UI has to read both: app.py's
// own failures arrive as {"error": "..."} (app.py:37), while anything FastAPI
// rejects before the handler runs is a 422 whose message sits in `detail` -
// either a plain string or the validation list of {loc, msg} objects. Ignoring
// `detail` showed the user "Count failed" and threw away the only sentence that
// said what was wrong.

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  })

const stub = (res: Response) => vi.stubGlobal("fetch", vi.fn(async () => res))

const files = [new File(["x"], "a.tif")]
const req = { files, params: {}, autocrop: "", quad: null, stages: false }

afterEach(() => vi.unstubAllGlobals())

it("reports the {error: ...} body app.py sends for a pipeline failure", async () => {
  stub(json({ error: "The count failed: ValueError: bad diameter" }, 500))
  await expect(count(req)).rejects.toThrow(/bad diameter/)
})

it("reports a 422 detail string", async () => {
  stub(json({ detail: "level must be 1-4" }, 422))
  await expect(count(req)).rejects.toThrow("level must be 1-4")
})

it("reports a 422 validation list, naming the field", async () => {
  stub(json({ detail: [{ loc: ["body", "params"], msg: "field required" }] }, 422))
  await expect(count(req)).rejects.toThrow(/params: field required/)
})

it("joins more than one validation problem", async () => {
  stub(json({
    detail: [
      { loc: ["body", "params"], msg: "field required" },
      { loc: ["body", "quad"], msg: "not a list" },
    ],
  }, 422))
  await expect(count(req)).rejects.toThrow(/params: field required.*quad: not a list/)
})

it("falls back to the generic sentence when the body says nothing", async () => {
  stub(new Response("<html>gateway</html>", { status: 502 }))
  await expect(count(req)).rejects.toThrow("Count failed")
})

it("uses the same reader for pairing and for the parameters", async () => {
  stub(json({ detail: "too many files" }, 422))
  await expect(fetchPairs(files)).rejects.toThrow("too many files")
  stub(json({ error: "no engine" }, 500))
  await expect(fetchParams()).rejects.toThrow("no engine")
})
