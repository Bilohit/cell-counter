"""Build ONE self-contained review page holding every tile, one JSON out per tile.

    python -m ml.dump_candidates --glob "hemo1*"
    python -m ml.make_review                 # -> ml/runs/annotate.html  (~65 MB)
    # annotate; each tile downloads itself when marked done. Then:
    python tools/merge_gt.py ~/Downloads/*.json

Nothing to set up: the images are embedded, so the page is opened and used. That
costs size - 64 lossless PNGs base64 to ~65 MB and the tab takes a few seconds to
open. Lossless on purpose: JPEG q95 would cut it to 27 MB but moves single pixels
by up to 8 grey levels, and this page is where the ground truth for pale cells is
decided.

Per tile it loads, in priority order:
  1. localStorage         - annotated this session or an earlier one, in this browser
  2. data/gt/<stem>.json  - baked in at build time if already merged
  3. ml/runs/<stem>.ml.json - the model's preseed: confident detections as solid
                            dots, lowered-threshold peaks as hollow hints
Every edit goes to localStorage immediately, so a closed tab loses nothing.
Marking a tile done downloads that one tile as <stem>.json, already in the
data/gt format; tools/merge_gt.py validates it in. There is no batch export -
per-tile means a finished tile is out of the browser the moment it is finished.

Saved format per tile: {"image", "points", "pale", "whole_image": true}. The flag
is the contract with ml/data.py - annotated edge to edge, so the training loss
mask is the whole tile rather than the triple frame. The 5 original tiles carry no
flag, but they are whole-image annotated too (measured 2026-09-12: 11-45 % of
each one's points sit outside the frame, complete on all four sides).
"""
import argparse
import base64
import glob
import json
import os

from ml import data


def tile_entry(ml_path):
    stem = os.path.basename(ml_path)[:-8]
    png = os.path.join("data/png", stem + ".png")
    if not os.path.exists(png):
        print("no png for", stem)
        return None
    with open(ml_path) as f:
        ml = json.load(f)
    gp = os.path.join("data/gt", stem + ".json")
    gt = None
    if os.path.exists(gp):
        with open(gp) as f:
            g = json.load(f)
        gt = {"points": g.get("points", []), "pale": g.get("pale", [])}
    with open(png, "rb") as f:
        src = "data:image/png;base64," + base64.b64encode(f.read()).decode()
    return {"stem": stem, "bundle": data.group_of(stem), "src": src,
            "det": ml.get("points", []), "hint": ml.get("pale", []), "gt": gt,
            "grid_x": ml.get("grid_x", []), "grid_y": ml.get("grid_y", []),
            "frame": ml.get("frame", {})}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glob", default="hemo1*", help="stem glob inside ml/runs/*.ml.json")
    ap.add_argument("--out", default="ml/runs/annotate.html")
    a = ap.parse_args()

    paths = sorted(glob.glob(os.path.join("ml/runs", a.glob + ".ml.json")))
    if not paths:
        raise SystemExit(f"no candidates match ml/runs/{a.glob}.ml.json - run ml.dump_candidates first")
    tiles = [t for t in (tile_entry(p) for p in paths) if t]

    html = TEMPLATE.replace("__TILES__", json.dumps(tiles))
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    mb = os.path.getsize(a.out) / 1e6
    bundles = sorted({t["bundle"] for t in tiles})
    print(f"-> {a.out}  {mb:.0f} MB  ({len(tiles)} tiles, bundles {', '.join(bundles)}, "
          f"{sum(bool(t['gt']) for t in tiles)} already merged)")


TEMPLATE = r"""<!doctype html><meta charset="utf-8"><title>Annotate cells</title>
<style>
body{margin:0;font:13px system-ui;background:#0d1117;color:#c9d1d9}
.bar{padding:7px 10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;
     border-bottom:1px solid #21262d}
#wrap{overflow:auto;height:calc(100vh - 78px);background:#000}
/* The native `crosshair` is a 1 px black cross and these captures average grey
   129, so it vanished. Lime core: the images are 8-bit grayscale, so nothing in
   a cell can ever be that colour. Dark halo under it survives a pale background,
   and the 6 px centre gap means the cursor never covers the cell being aimed at.
   Hotspot is the exact centre (16 16), so the click lands where the gap is.
   32 px is the largest cursor every platform honours; the long arms are what
   make it possible to aim in a dense field. */
canvas{display:block;image-rendering:pixelated;
  cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cg fill='none' stroke-linecap='round'%3E%3Cpath stroke='%23000' stroke-width='4' stroke-opacity='.8' d='M16 0.5v12M16 19.5v12M0.5 16h12M19.5 16h12'/%3E%3Cpath stroke='%2339ff14' stroke-width='1.6' d='M16 0.5v12M16 19.5v12M0.5 16h12M19.5 16h12'/%3E%3C/g%3E%3C/svg%3E") 16 16, crosshair}
button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:4px 10px;
       border-radius:5px;cursor:pointer;font:inherit}
button:hover{background:#30363d}
button.go{background:#1f6f3f;border-color:#2f8f52;color:#e9fff0}
select{background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:3px;font:inherit;
       max-width:300px}
#prog{height:7px;background:#21262d;border-radius:4px;overflow:hidden;width:150px}
#prog div{height:100%;background:#2f8f52;width:0;transition:width .2s}
b{color:#ff4a1a}i{color:#4ad2ff;font-style:normal}u{color:#8b949e;text-decoration:none}
small{color:#6e7681}
#msg{color:#7ee787}
</style>
<div class="bar">
  <select id="tile"></select>
  <button id="prev">&larr; p</button><button id="next">n &rarr;</button>
  <div id="prog"><div></div></div><span id="count"></span>
  <label>zoom <input type="range" id="zoom" min="1" max="6" step="0.5" value="2"></label>
  <label><input type="checkbox" id="grid" checked> grid (g)</label>
  <button id="mark" class="go">done + download + next (d)</button>
  <button id="reset">reset this tile</button>
  <span id="msg"></span>
</div>
<div class="bar" style="font-size:12px">
  <span id="n"></span>
  <small>click: add <b>solid</b> exactly where you click &middot; shift-click:
  <i>pale</i>/out-of-plane &middot; <u>hollow</u> = model guess, unconfirmed: click the
  cell to mark it yourself &middot; right-click: remove nearest
  &middot; <kbd>u</kbd> undo &middot; annotate the WHOLE image, edge to edge; a cell
  clipped by the border counts if its centre is visible</small>
</div>
<div id="wrap"><canvas id="c"></canvas></div>
<script>
const TILES=__TILES__;
const LS='cellcounter.gt.';       // one localStorage entry per tile, written on every edit
const c=document.getElementById('c'),ctx=c.getContext('2d');
const sel=document.getElementById('tile'),msg=document.getElementById('msg');
let img=null,cur=-1,z=2,pts=[],pale=[],hint=[],hist=[];

function key(i){return LS+TILES[i].stem;}
function save(){    // no prompt, no file: just never lose a click
  try{localStorage.setItem(key(cur),
    JSON.stringify({points:pts,pale:pale,hint:hint,done:TILES[cur].done}));}catch(e){}
}
function leftover(t,solid,palish){   // hints not already covered by a kept dot
  const known=solid.concat(palish);
  return t.hint.filter(h=>!known.some(k=>(k[0]-h[0])**2+(k[1]-h[1])**2<174));
}
function load(i){
  if(cur>=0)save();
  cur=i;const t=TILES[i];
  const mem=localStorage.getItem(key(i));
  if(mem){const m=JSON.parse(mem);
    pts=m.points||[];pale=m.pale||[];hint=m.hint||[];t.done=!!m.done;}
  else if(t.gt){
    pts=t.gt.points.map(p=>[+p[0],+p[1]]);pale=t.gt.pale.map(p=>[+p[0],+p[1]]);
    hint=leftover(t,pts,pale);t.done=true;}
  else{pts=t.det.map(p=>[+p[0],+p[1]]);pale=[];hint=t.hint.map(p=>[+p[0],+p[1]]);}
  hist=[];refresh();
  img=new Image();img.onload=draw;img.src=t.src;
}
function draw(){
  if(!img)return;
  c.width=img.width*z;c.height=img.height*z;
  ctx.imageSmoothingEnabled=false;ctx.drawImage(img,0,0,c.width,c.height);
  const t=TILES[cur];
  if(document.getElementById('grid').checked){
    ctx.strokeStyle='rgba(120,160,255,.30)';ctx.lineWidth=1;
    for(const x of t.grid_x){ctx.beginPath();ctx.moveTo(x*z,0);ctx.lineTo(x*z,c.height);ctx.stroke();}
    for(const y of t.grid_y){ctx.beginPath();ctx.moveTo(0,y*z);ctx.lineTo(c.width,y*z);ctx.stroke();}
    const f=t.frame;
    if(f&&f.x1>f.x0){ctx.strokeStyle='rgba(255,200,60,.75)';ctx.lineWidth=2;
      ctx.strokeRect(f.x0*z,f.y0*z,(f.x1-f.x0)*z,(f.y1-f.y0)*z);}
  }
  ctx.fillStyle='#ff4a1a';
  for(const [x,y] of pts){ctx.beginPath();ctx.arc(x*z,y*z,3,0,7);ctx.fill();}
  ctx.strokeStyle='#4ad2ff';ctx.lineWidth=2;
  for(const [x,y] of pale){ctx.beginPath();ctx.arc(x*z,y*z,4,0,7);ctx.stroke();}
  ctx.strokeStyle='#8b949e';ctx.lineWidth=1;
  for(const [x,y] of hint){ctx.beginPath();ctx.arc(x*z,y*z,5,0,7);ctx.stroke();}
}
function refresh(){
  sel.innerHTML='';
  let last='';
  TILES.forEach((t,i)=>{
    if(t.bundle!==last){last=t.bundle;
      const g=document.createElement('option');g.disabled=true;
      g.textContent='--- '+t.bundle+' ---';sel.appendChild(g);}
    const o=document.createElement('option');o.value=i;
    o.textContent=(t.done?'✓ ':'· ')+t.stem;sel.appendChild(o);});
  sel.value=cur;
  const d=TILES.filter(t=>t.done).length;
  document.getElementById('prog').firstElementChild.style.width=(100*d/TILES.length)+'%';
  document.getElementById('count').textContent=d+' / '+TILES.length+' done';
  document.getElementById('n').innerHTML=
    `<b>${pts.length}</b> solid + <i>${pale.length}</i> pale, ${hint.length} hints left`;
}
function say(s){msg.textContent=s;clearTimeout(say.t);say.t=setTimeout(()=>msg.textContent='',5000);}

function nearest(arr,x,y,lim){let best=lim,k=-1;
  arr.forEach((p,i)=>{const d=(p[0]-x)**2+(p[1]-y)**2;if(d<best){best=d;k=i;}});return k;}
c.onclick=e=>{const r=c.getBoundingClientRect();
  const x=(e.clientX-r.left)/z,y=(e.clientY-r.top)/z;
  // The dot lands exactly where the cursor is - never snapped to a model hint.
  // A hint under the click is only a guess about where a cell might be; the
  // click is the answer, so the hint is cleared as answered rather than used
  // as the coordinate.
  (e.shiftKey?pale:pts).push([x,y]);
  const k=nearest(hint,x,y,64);
  hist.push([e.shiftKey?'pale':'pts', k>=0?hint.splice(k,1)[0]:null]);
  save();refresh();draw();};
c.oncontextmenu=e=>{e.preventDefault();
  const r=c.getBoundingClientRect(),x=(e.clientX-r.left)/z,y=(e.clientY-r.top)/z;
  let best=400,arr=null,k=-1;
  [pts,pale].forEach(a=>{a.forEach((p,i)=>{
    const d=(p[0]-x)**2+(p[1]-y)**2;if(d<best){best=d;arr=a;k=i;}});});
  if(arr){hist.push(['rm',arr,k,arr[k]]);arr.splice(k,1);save();refresh();draw();}};

sel.onchange=e=>load(+e.target.value);
document.getElementById('prev').onclick=()=>load((cur-1+TILES.length)%TILES.length);
document.getElementById('next').onclick=()=>load((cur+1)%TILES.length);
document.getElementById('zoom').oninput=e=>{z=+e.target.value;draw();};
document.getElementById('grid').onchange=draw;
// "done" both exports the tile and advances: a tile whose preseed needed no
// correction has no edits to detect, so marking is the only signal it is
// finished. One file per tile, in the data/gt format, so it needs no unpacking.
function done(){
  const t=TILES[cur];t.done=true;save();
  const R=a=>(a||[]).map(p=>[Math.round(p[0]),Math.round(p[1])]);
  const body=JSON.stringify(
    {image:t.stem+'.tif',points:R(pts),pale:R(pale),whole_image:true});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([body],{type:'application/json'}));
  a.download=t.stem+'.json';a.click();
  say('downloaded '+t.stem+'.json');
  load((cur+1)%TILES.length);
}
document.getElementById('mark').onclick=done;
document.getElementById('reset').onclick=()=>{
  localStorage.removeItem(key(cur));TILES[cur].done=false;TILES[cur].gt=null;load(cur);
  say('reset to the model preseed');};
window.onkeydown=e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(e.key==='u'&&hist.length){const w=hist.pop();
    if(w[0]==='pts'||w[0]==='pale'){
      (w[0]==='pts'?pts:pale).pop();
      if(w[1])hint.push(w[1]);      // the hint that click cleared comes back
    }
    else w[1].splice(w[2],0,w[3]);  // ['rm', array, index, point]
    save();refresh();draw();return;}
  if(e.key==='n')return load((cur+1)%TILES.length);
  if(e.key==='p')return load((cur-1+TILES.length)%TILES.length);
  if(e.key==='d')return done();
  if(e.key==='g'){const g=document.getElementById('grid');g.checked=!g.checked;return draw();}
};
load(0);
</script>
"""

if __name__ == "__main__":
    main()
