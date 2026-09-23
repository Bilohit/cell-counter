"""Build the boundary re-annotation pages, one per capture group.

The GT was annotated with no dots on the triple boundary line, so a cell lying
on that line is a positive nowhere: the loss trains it as background and the
ruler scores any detection there as a false positive. Measured 2026-09-16 on
the 16 KNT/KGN tiles: dropping a 10 px band around the frame edge takes the
signed count error from +3.48 % to +1.95 % while removing 101 detections
against only 61 GT points - that 40-point asymmetry is the unannotated cells.

The rule (user ruling 2026-09-16): a cell counts when at least half of it lies
inside the boundary, i.e. when its CENTRE is inside. `triple_frame` returns the
centre line of the boundary run, and `score.inside_frame` already tests the
centre against it, so nothing in the counting code changes - only the data.

The pages deliberately do NOT show the model's detections. Annotating against
them would make the GT agree with the model by construction and destroy the
only independent ruler the project has.

    python tools/make_boundary_review.py            # every group
    python tools/make_boundary_review.py KNT KGN    # just these
"""
import base64
import collections
import html
import json
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pipeline  # noqa: E402
import ml.data as data  # noqa: E402

OUT = "ml/runs"
BAND = 14          # half-width of the highlighted strip, ~ the 20-24 px rules


def tile_payload(stem):
    gt_path = os.path.join("data/gt", stem + ".json")
    if not os.path.exists(gt_path):
        return None
    png = os.path.join("data/png", stem + ".png")
    if not os.path.exists(png):
        return None
    gray = cv2.imread(os.path.join("data/tif", stem + ".tif"), cv2.IMREAD_UNCHANGED)
    if gray is None:
        return None
    frame = pipeline.triple_frame(gray, pipeline.DEFAULTS)
    gt = json.load(open(gt_path))
    with open(png, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return {"stem": stem, "image": gt.get("image", stem + ".tif"),
            "points": [[round(float(x), 1), round(float(y), 1)] for x, y in gt.get("points", [])],
            "pale": [[round(float(x), 1), round(float(y), 1)] for x, y in gt.get("pale", [])],
            "frame": {k: frame[k] for k in ("x0", "x1", "y0", "y1")},
            "sides": frame["sides"], "png": b64}


PAGE = """<!doctype html><meta charset="utf-8"><title>Boundary annotation &mdash; {group}</title>
<style>
body{{margin:0;font:13px system-ui;background:#0d1117;color:#c9d1d9}}
#bar{{padding:8px 12px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;
     background:#161b22;border-bottom:1px solid #30363d;position:sticky;top:0;z-index:5}}
#wrap{{overflow:auto;height:calc(100vh - 92px)}}
canvas{{display:block;image-rendering:pixelated;cursor:crosshair}}
button{{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;
       padding:5px 11px;font:13px system-ui;cursor:pointer}}
button:hover{{background:#30363d}}
button.go{{background:#1f6feb;border-color:#1f6feb;color:#fff}}
#tiles{{display:flex;gap:4px;flex-wrap:wrap;padding:6px 12px;background:#0d1117;
       border-bottom:1px solid #30363d}}
.t{{padding:3px 8px;border-radius:5px;background:#21262d;cursor:pointer;font-size:12px}}
.t.on{{background:#1f6feb;color:#fff}}
.t.done{{outline:1px solid #3fb950}}
kbd{{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:1px 5px;font-size:11px}}
.hint{{color:#8b949e}}
b{{color:#ff4a1a}} i{{color:#4ad2ff;font-style:normal}}
</style>
<div id="bar">
  <strong>{group}</strong>
  <span id="which"></span>
  <span id="n"></span>
  <label>zoom <input type="range" id="zoom" min="1" max="6" step="0.5" value="2"></label>
  <button id="prev">&larr; prev</button><button id="next">next &rarr;</button>
  <button id="fit">jump to boundary</button>
  <button class="go" id="save">Download {group}.json</button>
  <span class="hint">left-click add <b>solid</b> &middot; shift-click add <i>pale</i> &middot;
    right-click remove nearest &middot; <kbd>u</kbd> undo &middot;
    <kbd>n</kbd>/<kbd>p</kbd> tile &middot; <kbd>d</kbd> mark reviewed</span>
</div>
<div id="tiles"></div>
<div id="wrap"><canvas id="c"></canvas></div>
<script>
const TILES = {payload};
const BAND = {band};
const c = document.getElementById('c'), ctx = c.getContext('2d');
let i = 0, z = 2, img = null, hist = [];
const done = new Set(JSON.parse(localStorage.getItem('bdone_{group}') || '[]'));

function tabs() {{
  const d = document.getElementById('tiles');
  d.innerHTML = '';
  TILES.forEach((t, k) => {{
    const s = document.createElement('span');
    s.className = 't' + (k === i ? ' on' : '') + (done.has(t.stem) ? ' done' : '');
    s.textContent = t.stem.replace(/^hemo1 /, '').replace(/^10x tile /, '');
    s.onclick = () => {{ i = k; load(); }};
    d.appendChild(s);
  }});
}}

function draw() {{
  const t = TILES[i];
  if (!img) return;
  c.width = img.width * z; c.height = img.height * z;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const f = t.frame;
  // the counting boundary: triple_frame returns the centre line of the rule,
  // and a cell counts when its centre is on the inside of it.
  ctx.save();
  ctx.fillStyle = 'rgba(255,196,0,0.13)';
  ctx.fillRect(f.x0 * z - BAND * z, 0, 2 * BAND * z, c.height);
  ctx.fillRect(f.x1 * z - BAND * z, 0, 2 * BAND * z, c.height);
  ctx.fillRect(0, f.y0 * z - BAND * z, c.width, 2 * BAND * z);
  ctx.fillRect(0, f.y1 * z - BAND * z, c.width, 2 * BAND * z);
  ctx.strokeStyle = '#ffc400'; ctx.lineWidth = 1.5;
  ctx.setLineDash([7, 5]);
  [[f.x0, 1], [f.x1, 1]].forEach(([x]) => {{
    ctx.beginPath(); ctx.moveTo(x * z, 0); ctx.lineTo(x * z, c.height); ctx.stroke();
  }});
  [[f.y0, 1], [f.y1, 1]].forEach(([y]) => {{
    ctx.beginPath(); ctx.moveTo(0, y * z); ctx.lineTo(c.width, y * z); ctx.stroke();
  }});
  ctx.restore();
  ctx.fillStyle = '#ff4a1a';
  for (const [x, y] of t.points) {{ ctx.beginPath(); ctx.arc(x * z, y * z, 3, 0, 7); ctx.fill(); }}
  ctx.strokeStyle = '#4ad2ff'; ctx.lineWidth = 2;
  for (const [x, y] of t.pale) {{ ctx.beginPath(); ctx.arc(x * z, y * z, 4, 0, 7); ctx.stroke(); }}
  const miss = Object.entries(t.sides).filter(([, v]) => !v).map(([k]) => k);
  document.getElementById('n').textContent =
    t.points.length + ' solid + ' + t.pale.length + ' pale' +
    (miss.length ? '   \\u2022 no triple detected: ' + miss.join(', ') +
     ' (dashed line there is the outermost grid line, not a boundary)' : '');
}}

function load() {{
  const t = TILES[i];
  document.getElementById('which').textContent = (i + 1) + '/' + TILES.length + '  ' + t.stem;
  hist = [];
  img = new Image();
  img.onload = () => {{ draw(); tabs(); }};
  img.src = 'data:image/png;base64,' + t.png;
}}

function toXY(e) {{
  const r = c.getBoundingClientRect();
  return [(e.clientX - r.left) / z, (e.clientY - r.top) / z];
}}
c.onclick = e => {{
  const p = toXY(e), t = TILES[i];
  if (e.shiftKey) {{ t.pale.push(p); hist.push('pale'); }} else {{ t.points.push(p); hist.push('points'); }}
  draw();
}};
c.oncontextmenu = e => {{
  e.preventDefault();
  const [x, y] = toXY(e), t = TILES[i];
  let best = 400, arr = null, k = -1;
  [t.points, t.pale].forEach(a => a.forEach((p, j) => {{
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < best) {{ best = d; arr = a; k = j; }}
  }}));
  if (arr) arr.splice(k, 1);
  draw();
}};
window.onkeydown = e => {{
  if (e.target.tagName === 'INPUT') return;
  const t = TILES[i];
  if (e.key === 'u' && hist.length) {{ t[hist.pop()].pop(); draw(); }}
  if (e.key === 'n') {{ i = Math.min(TILES.length - 1, i + 1); load(); }}
  if (e.key === 'p') {{ i = Math.max(0, i - 1); load(); }}
  if (e.key === 'd') {{
    done.has(t.stem) ? done.delete(t.stem) : done.add(t.stem);
    localStorage.setItem('bdone_{group}', JSON.stringify([...done]));
    tabs();
  }}
}};
document.getElementById('zoom').oninput = e => {{ z = +e.target.value; draw(); }};
document.getElementById('next').onclick = () => {{ i = Math.min(TILES.length - 1, i + 1); load(); }};
document.getElementById('prev').onclick = () => {{ i = Math.max(0, i - 1); load(); }};
document.getElementById('fit').onclick = () => {{
  const f = TILES[i].frame, w = document.getElementById('wrap');
  w.scrollTo({{left: f.x0 * z - 80, top: f.y0 * z - 80, behavior: 'smooth'}});
}};
document.getElementById('save').onclick = () => {{
  const R = a => a.map(p => [Math.round(p[0]), Math.round(p[1])]);
  const out = {{group: '{group}', rule: 'cell counts when its centre is inside the boundary centre line',
    tiles: TILES.map(t => ({{image: t.image, stem: t.stem,
      points: R(t.points), pale: R(t.pale), reviewed: done.has(t.stem)}}))}};
  const b = new Blob([JSON.stringify(out, null, 1)], {{type: 'application/json'}});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'boundary_{group}.json'; a.click();
}};
load();
</script>
"""


def main():
    want = sys.argv[1:]
    groups = collections.defaultdict(list)
    for stem in data.TILES:
        groups[data.group_of(stem)].append(stem)

    os.makedirs(OUT, exist_ok=True)
    index = []
    for g in sorted(groups):
        if want and g not in want:
            continue
        payload = [p for p in (tile_payload(s) for s in sorted(groups[g])) if p]
        if not payload:
            print(f"{g}: no tiles with both a GT and a PNG, skipped")
            continue
        safe = g.replace(" ", "_")
        page = PAGE.format(group=safe, payload=json.dumps(payload), band=BAND)
        path = os.path.join(OUT, f"boundary_{safe}.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(page)
        mb = os.path.getsize(path) / 1e6
        n = sum(len(p["points"]) for p in payload)
        print(f"{g:12s} {len(payload):3d} tiles  {n:5d} existing dots  {mb:6.1f} MB  -> {path}")
        index.append((g, f"boundary_{safe}.html", len(payload), n, mb))

    if index:
        rows = "".join(
            f'<tr><td><a href="{html.escape(h)}">{html.escape(g)}</a></td>'
            f'<td>{n}</td><td>{d}</td><td>{m:.1f} MB</td></tr>'
            for g, h, n, d, m in index)
        with open(os.path.join(OUT, "boundary_index.html"), "w", encoding="utf-8") as f:
            f.write("<!doctype html><meta charset=utf-8><title>Boundary annotation</title>"
                    "<style>body{margin:40px;font:14px system-ui;background:#0d1117;color:#c9d1d9}"
                    "a{color:#58a6ff}td{padding:4px 14px 4px 0}"
                    "th{text-align:left;padding-right:14px;color:#8b949e;font-weight:500}</style>"
                    "<h2>Boundary re-annotation</h2>"
                    "<p>One page per capture group. In each: mark every cell whose <b>centre</b> "
                    "falls inside the dashed yellow line, including cells lying on the rule "
                    "itself. The shaded strip is where the missing dots are. Existing dots are "
                    "already loaded &mdash; do not re-place them.</p>"
                    "<table><tr><th>group<th>tiles<th>existing dots<th>page size</tr>"
                    + rows + "</table>")
        print(f"\nindex -> {os.path.join(OUT, 'boundary_index.html')}")


if __name__ == "__main__":
    main()
