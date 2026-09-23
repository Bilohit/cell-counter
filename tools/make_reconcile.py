"""Build tools/reconcile_clumps.html: a self-contained click-review page that
lets the user reconcile two disagreeing hand-annotation passes over dense
clumps: the zoomed-chunk pass (data/gt/cluster_gt.json) and the
whole-tile pass (data/gt/<tif stem>.json).

Inputs:
  data/gt/cluster_gt.json
    {"chunks": [{"id", "source", "box": [x, y, w, h], "points": [[x, y], ...]}]}
    source is a tif basename; points are chunk-local pixels (add box x/y for
    image pixels). 100 chunks.
  data/gt/<tif stem>.json
    {"points": [[x, y], ...]} in full-image pixels, one file per source tif.

For each chunk this script crops the source tif to `box` (no extra padding,
the box is already padded) and computes `tile_points`: the whole-tile points
that fall inside the box, converted to chunk-local coordinates. Chunks are
then ordered by descending |len(points) - len(tile_points)| so the biggest
disagreements surface first. The page draws `points` as editable solid dots
and `tile_points` as a read-only reference overlay.

Run from the repo root:  python tools/make_reconcile.py
Output JSON schema (what the Download button saves):
  {"chunks": [{"id", "source", "box": [x, y, w, h], "points": [[x, y], ...]}]}
with points in chunk-local pixel coordinates, rounded to integers -- the same
shape as cluster_gt.json so the result can be merged back into it.
"""
import base64
import json
import os

import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def tile_points_for(source):
    """Full-image GT points for a source tif basename, or [] if missing."""
    stem = os.path.splitext(source)[0]
    path = os.path.join(ROOT, "data/gt", stem + ".json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)["points"]


def build_chunk(chunk, tif_cache):
    source = chunk["source"]
    x, y, w, h = chunk["box"]
    if source not in tif_cache:
        path = os.path.join(ROOT, "data/tif", source)
        tif_cache[source] = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    gray = tif_cache[source]
    crop = gray[y:y + h, x:x + w]
    ok, png = cv2.imencode(".png", crop)
    if not ok:
        raise RuntimeError(f"encode failed for chunk {chunk['id']} of {source}")

    all_tile_pts = tile_points_for(source)
    local_tile_pts = [
        [px - x, py - y] for px, py in all_tile_pts
        if x <= px < x + w and y <= py < y + h
    ]

    return {
        "id": chunk["id"],
        "source": source,
        "box": [x, y, w, h],
        "png": base64.b64encode(png.tobytes()).decode("ascii"),
        "points": [[p[0], p[1]] for p in chunk["points"]],
        "tile_points": local_tile_pts,
    }


def main():
    with open(os.path.join(ROOT, "data/gt", "cluster_gt.json"), encoding="utf-8") as f:
        cluster_gt = json.load(f)["chunks"]

    tif_cache = {}
    chunks = [build_chunk(c, tif_cache) for c in cluster_gt]

    # Biggest zoomed-vs-whole-tile disagreements first.
    chunks.sort(key=lambda c: abs(len(c["points"]) - len(c["tile_points"])), reverse=True)

    by_source = {}
    for c in chunks:
        by_source.setdefault(c["source"], 0)
        by_source[c["source"]] += 1
    for source, n in by_source.items():
        print(f"{source}: {n} chunks")

    html = TEMPLATE.replace("__CHUNKS__", json.dumps(chunks))
    out = os.path.join(ROOT, "tools", "reconcile_clumps.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"{len(chunks)} chunks -> {out}")


TEMPLATE = """<!doctype html><meta charset="utf-8"><title>Reconcile clumps</title>
<style>
body{margin:0;font:14px system-ui;background:#111;color:#ddd}
#bar{padding:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
#wrap{overflow:auto;height:calc(100vh - 44px);display:flex;align-items:flex-start;justify-content:center;padding-top:16px}
canvas{display:block;image-rendering:pixelated;cursor:crosshair}
b{color:#ff4a1a}
r{color:#3ad1ff}
button{background:#222;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 10px;cursor:pointer}
.done{color:#5c5}
</style>
<div id="bar">
  <button id="prev">&larr; prev</button>
  <span id="which"></span>
  <button id="next">next &rarr;</button>
  <label>zoom <input type="range" id="zoom" min="2" max="12" step="1" value="6"></label>
  <label><input type="checkbox" id="showTile" checked> show whole-tile GT</label>
  <span id="n"></span>
  <span>left-click: add <b>mark</b> &middot; right-click: remove nearest &middot; u: undo &middot; arrows: prev/next &middot; d: next diff</span>
  <button id="save">Download JSON</button>
  <label>load JSON <input type="file" id="load" accept=".json" style="width:180px"></label>
</div>
<div id="wrap"><canvas id="c"></canvas></div>
<script>
const CH=__CHUNKS__;
const marks=CH.map(ch=>ch.points.map(p=>[p[0],p[1]]));  // per-chunk [x,y] chunk-local px, editable
const visited=new Set();
let cur=0,z=6,hist=[];
const c=document.getElementById('c'),ctx=c.getContext('2d');
const imgs=CH.map(ch=>{const im=new Image();im.src='data:image/png;base64,'+ch.png;return im;});
function draw(){
  visited.add(cur);
  const im=imgs[cur];if(!im.complete){im.onload=draw;return;}
  c.width=im.width*z;c.height=im.height*z;
  ctx.imageSmoothingEnabled=false;ctx.drawImage(im,0,0,c.width,c.height);
  if(document.getElementById('showTile').checked){
    ctx.strokeStyle='#3ad1ff';ctx.lineWidth=2;
    for(const [x,y] of CH[cur].tile_points){
      ctx.beginPath();ctx.arc(x*z,y*z,7,0,7);ctx.stroke();}
  }
  ctx.fillStyle='#ff4a1a';
  for(const [x,y] of marks[cur]){ctx.beginPath();ctx.arc(x*z,y*z,4,0,7);ctx.fill();}
  const zoomed=marks[cur].length, tile=CH[cur].tile_points.length, diff=zoomed-tile;
  const sign=diff>=0?'+':'';
  document.getElementById('which').innerHTML=
    `chunk ${cur+1}/${CH.length} &middot; ${CH[cur].source} &middot; `+
    `zoomed ${zoomed} &middot; whole-tile ${tile} &middot; diff ${sign}${diff} &middot; `+
    `<span class="done">${visited.size} visited</span>`;
  document.getElementById('n').textContent=zoomed+' marks';
}
function go(d){cur=(cur+d+CH.length)%CH.length;hist=[];draw();}
document.getElementById('prev').onclick=()=>go(-1);
document.getElementById('next').onclick=()=>go(1);
document.getElementById('zoom').oninput=e=>{z=+e.target.value;draw();};
document.getElementById('showTile').onchange=draw;
c.onclick=e=>{const r=c.getBoundingClientRect();
  marks[cur].push([(e.clientX-r.left)/z,(e.clientY-r.top)/z]);hist.push(1);draw();};
c.oncontextmenu=e=>{e.preventDefault();
  const r=c.getBoundingClientRect(),x=(e.clientX-r.left)/z,y=(e.clientY-r.top)/z;
  // Screen-space radius, not the sibling page's fixed 20 chunk-local px: cells in
  // these clumps sit ~22 px apart, so a local-px radius grabs the wrong neighbour.
  let best=(14/z)**2,k=-1;
  marks[cur].forEach((p,i)=>{const d=(p[0]-x)**2+(p[1]-y)**2;if(d<best){best=d;k=i;}});
  if(k>=0)marks[cur].splice(k,1);draw();};
function nextDiff(){
  for(let i=1;i<=CH.length;i++){
    const j=(cur+i)%CH.length;
    if(marks[j].length!==CH[j].tile_points.length){cur=j;hist=[];draw();return;}}
}
window.onkeydown=e=>{
  if(e.key==='u'&&hist.length){hist.pop();marks[cur].pop();draw();}
  if(e.key==='ArrowLeft')go(-1);
  if(e.key==='ArrowRight')go(1);
  if(e.key==='d')nextDiff();};
document.getElementById('load').onchange=e=>{
  const r=new FileReader();
  r.onload=()=>{const d=JSON.parse(r.result);
    for(const ch of (d.chunks||[])){
      const i=CH.findIndex(x=>x.id===ch.id);
      if(i>=0)marks[i]=(ch.points||[]).map(p=>[+p[0],+p[1]]);}
    draw();};
  r.readAsText(e.target.files[0]);};
document.getElementById('save').onclick=()=>{
  const chunks=CH.map((ch,i)=>({id:ch.id,source:ch.source,box:ch.box,
    points:marks[i].map(p=>[Math.round(p[0]),Math.round(p[1])])}));
  const blob=new Blob([JSON.stringify({chunks},null,1)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  // Save this somewhere outside the repo (the browser's downloads folder is
  // fine) and pass that path to merge_reconciled.py. A copy dropped at the
  // repo root reads like a second, stale ground truth beside the tracked
  // data/gt/reconciled_clumps.json.
  a.download='reconciled_clumps.json';a.click();};
draw();
</script>
"""

if __name__ == "__main__":
    main()
