"""Fold every build's per-tile scores into one CSV + one summary JSON for the page.

    python tools/build_comparison.py

Reads ml/runs/{old_build,sept5_l3,compare_l3,compare_l4}.json (+ timing.json when
present) and writes
ml/runs/comparison.csv (one row per tile per build) and ml/runs/comparison.json.

Localisation is the mean distance of Hungarian-matched pairs. It is only
meaningful beside recall: a detector that finds fewer, easier cells scores a
better localisation for the wrong reason, which is exactly what the 2026-09-05
build does (0.48 px at F1 0.940).
"""
import csv, json, os
import numpy as np

R = "ml/runs"
BUILDS = []

def add(key, label, date, detector, rows):
    BUILDS.append({"key": key, "label": label, "date": date, "detector": detector, "rows": rows})

old = json.load(open(f"{R}/old_build.json"))["tiles"]
add("sept3", "Sept 3", "2026-09-03", "classical only (no ML)", old)

s5 = json.load(open(f"{R}/sept5_l3.json"))["tiles"]
add("sept5", "Sept 5", "2026-09-05", "ML base 16, 3000 it, thr 0.60, no crowding", s5)

c3n = json.load(open(f"{R}/compare_l3_new.json"))["tiles"]
add("sept18", "Sept 18", "2026-09-18",
    "ML base 24, 8000 it, RETRAINED on the corrected GT, thr 0.58, crowd 0.020 (unchanged)",
    [dict(r["new"], tile=r["tile"], group=r["group"]) for r in c3n])

# The 2026-09-21 release. Its detector files - the three ONNX models,
# cellnet.json, pipeline.py, ml/peaks.py - are byte-identical to Sept 18's
# inside the shipped zip (sha256 checked against release/Cell Counter
# (win).zip), so this row is a re-run of the ruler on the artifact users
# actually download, not a new detector. It reproduces Sept 18 tile for tile.
# That is the point of the row: the 2026-09-19/20 upgrade pass touched the API,
# the web app and the Zen seam fix, and the ledger records that it moved the
# counts by nothing.
c3s = json.load(open(f"{R}/compare_l3_sept21.json"))["tiles"]
add("sept21", "Sept 21", "2026-09-21",
    "shipped release; detector byte-identical to Sept 18 (upgrade pass touched API/web only)",
    [dict(r["new"], tile=r["tile"], group=r["group"]) for r in c3s])


# Level 4 (TTA) is measured but not charted: it is not the shipped default, and
# charting it beside the builds would read as extra builds when it is the same
# weights decoded through a different inference path. The rows go into the CSV
# so the measurement is not lost, and one line on the page reports how it
# compares - derived from these numbers, not asserted, because which way it goes
# has changed between builds.
c4n = json.load(open(f"{R}/compare_l4_new.json"))["tiles"]
c4s = json.load(open(f"{R}/compare_l4_sept21.json"))["tiles"]
L4 = [("sept18", "Sept 18", "2026-09-18", [dict(r["new"], tile=r["tile"]) for r in c4n]),
      ("sept21", "Sept 21", "2026-09-21", [dict(r["new"], tile=r["tile"]) for r in c4s])]


# Speed, from ml/runs/timing.json (raw interleaved repeats, see its "meta"). Each
# CSV row carries the timing of the rung that row was scored at, so a build's
# accuracy and its cost sit on the same line; every rung's repeats go to the page.
T = json.load(open(f"{R}/timing.json")) if os.path.exists(f"{R}/timing.json") else None
TB = {b["key"]: b for b in T["builds"]} if T else {}
SCORED = {"sept3": "Classical", "sept5": "Normal", "sept18": "Normal", "sept21": "Normal"}


def timing_cells(key, rung):
    b = TB.get(key)
    if not b or rung not in b["img"]:
        return ["", "", "", "", ""]
    v, s = b["img"][rung], b["batch"].get(rung, [])
    return [rung, f"{np.median(v):.3f}", f"{min(v):.3f}", f"{max(v):.3f}",
            f"{np.median(s):.1f}" if s else ""]


def rate(r, key, num, den):
    # sept5_l3.json rows carry tp/fp/fn but no precision/recall keys, which wrote
    # a literal 0.0000 into those CSV columns. Derive them when they are absent.
    v = r.get(key)
    return float(v) if v is not None else num / max(1, num + den)


def fam(t):
    return "10x" if t.startswith("10x") else "hemo1"


def _gt_all():
    """Every annotated point on the scored tiles, inside the frame or not."""
    return sum(len(json.load(open(f"data/gt/{t['tile']}.json"))["points"])
               for t in BUILDS[0]["rows"])


def summarise(rows):
    e = np.array([abs(r["err_pct"]) for r in rows], float)
    s = np.array([r["err_pct"] for r in rows], float)
    L = np.array([r["loc_mean"] for r in rows if r.get("loc_mean") is not None], float)
    sub = np.array([r["loc_sub2px"] for r in rows if r.get("loc_sub2px") is not None], float)
    tp = sum(r["tp"] for r in rows); fp = sum(r["fp"] for r in rows); fn = sum(r["fn"] for r in rows)
    return {
        "n": len(rows),
        "mean_err": float(e.mean()), "median_err": float(np.median(e)),
        "signed": float(s.mean()), "worst": float(e.max()),
        "within2": float(100 * (e <= 2).mean()),
        "f1": 2 * tp / max(1, 2 * tp + fp + fn),
        "precision": tp / max(1, tp + fp), "recall": tp / max(1, tp + fn),
        "tp": tp, "fp": fp, "fn": fn,
        "loc_mean": float(L.mean()) if len(L) else None,
        "loc_sub2px": float(sub.mean()) if len(sub) else None,
    }


out = {"builds": [], "tiles": {}}
with open(f"{R}/comparison.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["build", "build_date", "detector", "tile", "family", "gt", "detected",
                "tp", "fp", "fn", "err_pct", "abs_err_pct", "precision", "recall", "f1",
                "loc_mean_px", "loc_median_px", "loc_p90_px", "loc_within_2px_pct",
                "timed_rung", "s_per_img_median", "s_per_img_min", "s_per_img_max",
                "batch32_s_median"])
    for b in BUILDS:
        for r in b["rows"]:
            w.writerow([b["label"], b["date"], b["detector"], r["tile"], fam(r["tile"]),
                        r["gt"], r["det"], r["tp"], r["fp"], r["fn"],
                        f'{r["err_pct"]:.3f}', f'{abs(r["err_pct"]):.3f}',
                        f'{rate(r, "prec", r["tp"], r["fp"]):.4f}',
                        f'{rate(r, "rec", r["tp"], r["fn"]):.4f}', f'{r["f1"]:.4f}',
                        "" if r.get("loc_mean") is None else f'{r["loc_mean"]:.3f}',
                        "" if r.get("loc_median") is None else f'{r["loc_median"]:.3f}',
                        "" if r.get("loc_p90") is None else f'{r["loc_p90"]:.3f}',
                        "" if r.get("loc_sub2px") is None else f'{r["loc_sub2px"]:.2f}']
                       + timing_cells(b["key"], SCORED.get(b["key"])))
        entry = {k: b[k] for k in ("key", "label", "date", "detector")}
        entry["all"] = summarise(b["rows"])
        for name in ("10x", "hemo1"):
            sel = [r for r in b["rows"] if fam(r["tile"]) == name]
            entry[name] = summarise(sel) if sel else None
        entry["tiles"] = [{"tile": r["tile"], "family": fam(r["tile"]),
                           "gt": r["gt"], "det": r["det"],
                           "err": round(r["err_pct"], 2),
                           "loc": None if r.get("loc_mean") is None else round(r["loc_mean"], 2),
                           "f1": round(r["f1"], 4)} for r in b["rows"]]
        out["builds"].append(entry)

    for key, label, date, rows in L4:
        for r in rows:
            w.writerow([f"{label} (level 4)", date, "level 4: 3-model ensemble + 8-way TTA",
                        r["tile"], fam(r["tile"]), r["gt"], r["det"], r["tp"], r["fp"], r["fn"],
                        f'{r["err_pct"]:.3f}', f'{abs(r["err_pct"]):.3f}',
                        f'{rate(r, "prec", r["tp"], r["fp"]):.4f}',
                        f'{rate(r, "rec", r["tp"], r["fn"]):.4f}', f'{r["f1"]:.4f}',
                        "" if r.get("loc_mean") is None else f'{r["loc_mean"]:.3f}',
                        "" if r.get("loc_median") is None else f'{r["loc_median"]:.3f}',
                        "" if r.get("loc_p90") is None else f'{r["loc_p90"]:.3f}',
                        "" if r.get("loc_sub2px") is None else f'{r["loc_sub2px"]:.2f}']
                       + timing_cells(key, "Finest"))

out["level4"] = {key: dict(summarise(rows), label=label) for key, label, date, rows in L4}

# The page used to carry "Four builds ... 22 164 annotated cells" as literal
# text, which went stale silently the moment a build was added and again when the
# GT was corrected - exactly the failure this generator exists to prevent. The
# header now reads these.
out["meta"] = {
    "builds": len(BUILDS),
    "tiles": len(BUILDS[0]["rows"]),
    # Two different totals, and the page used to show the larger one while the
    # ruler scored the smaller: score.py counts only GT inside the triple frame,
    # because the pipeline does not count outside it either.
    "gt_points": sum(r["gt"] for r in BUILDS[0]["rows"]),
    "gt_all": _gt_all(),
    "radius": 13.2,
}
out["csvRows"] = (sum(len(b["rows"]) for b in BUILDS)
                  + sum(len(r) for _, _, _, r in L4))

n_rows = sum(len(b["rows"]) for b in BUILDS) + sum(len(r) for _, _, _, r in L4)
out["timing"] = T

json.dump(out, open(f"{R}/comparison.json", "w"), indent=1)
print(f"-> {R}/comparison.csv   {n_rows} rows")
print(f"-> {R}/comparison.json\n")
print(f"{'build':9} {'n':>3} {'mean|err|':>9} {'median':>7} {'<=2%':>6} {'F1':>7} {'loc px':>7} {'signed':>7}")
for b in out["builds"]:
    a = b["all"]
    print(f"{b['label']:9} {a['n']:3d} {a['mean_err']:8.2f} % {a['median_err']:6.2f} % "
          f"{a['within2']:5.0f} % {a['f1']:7.4f} {a['loc_mean']:7.2f} {a['signed']:+6.2f} %")
