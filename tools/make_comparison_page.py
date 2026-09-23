"""Render ml/runs/comparison.json into a standalone page.

    python tools/build_comparison.py && python tools/make_comparison_page.py

Writes ml/runs/comparison.html, which embeds its own data and needs no server -
open it from disk like ml/runs/dashboard.html. The CSV beside it is the same
numbers, one row per tile per build.

A generator rather than a hand-written page: the builds get re-scored whenever
the ground truth changes, and a page with numbers typed into it goes stale
silently.
"""
import json
import os

R = "ml/runs"
d = json.load(open(f"{R}/comparison.json"))
csv_text = open(f"{R}/comparison.csv", encoding="utf-8").read()

HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build Accuracy Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --bg:#F6F8F8; --surface:#FFFFFF; --ink:#101819; --muted:#5D6B6E; --faint:#8A9699;
  --line:#DCE4E5; --line-soft:#EBF0F1;
  --accent:#0B6E77; --accent-soft:#D6EBED;
  --up:#0B6E77; --down:#A8501C;
  --shadow:0 1px 2px rgba(16,24,25,.05);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0C1214; --surface:#131C1E; --ink:#E7EDED; --muted:#93A2A5; --faint:#6E7E81;
    --line:#222E31; --line-soft:#1A2427;
    --accent:#52C2C9; --accent-soft:#12383C;
    --up:#52C2C9; --down:#DC9058;
    --shadow:none;
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#0C1214; --surface:#131C1E; --ink:#E7EDED; --muted:#93A2A5; --faint:#6E7E81;
  --line:#222E31; --line-soft:#1A2427;
  --accent:#52C2C9; --accent-soft:#12383C;
  --up:#52C2C9; --down:#DC9058;
  --shadow:none;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:400 15px/1.55 "IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1080px; margin:0 auto; padding-block:48px 72px; padding-left:20px; padding-right:20px;}
h1{font-size:23px; font-weight:600; letter-spacing:-.015em; margin:0; text-wrap:balance}
.sub{color:var(--muted); font-size:13.5px; margin:6px 0 0}
header{display:flex; justify-content:space-between; align-items:flex-start; gap:24px; flex-wrap:wrap}
.theme{
  border:1px solid var(--line); background:var(--surface); color:var(--muted);
  border-radius:7px; padding:7px 11px; font:500 12px "IBM Plex Sans",sans-serif; cursor:pointer;
}
.theme:hover{color:var(--ink); border-color:var(--accent)}
.theme:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

section{margin-top:44px}
h2{
  font-size:11.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase;
  color:var(--faint); margin:0 0 16px; padding-bottom:9px; border-bottom:1px solid var(--line-soft);
}

.hero{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px;
  background:var(--line-soft); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-top:28px}
.cell{background:var(--surface); padding:18px 20px}
.k{font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint)}
.v{font:600 27px/1.1 "IBM Plex Mono",monospace; margin-top:7px; font-variant-numeric:tabular-nums}
.v small{font-size:14px; font-weight:500; color:var(--muted)}
.delta{font:500 12px "IBM Plex Mono",monospace; margin-top:5px}
.pos{color:var(--up)} .neg{color:var(--down)}
/* Diff is counted minus truth: over-counting is the project's standing
   problem, so it reads in the warning colour and under-counting stays
   neutral-cool. Zero is left unstyled - an exact tile should look calm. */
.over{color:var(--down)} .under{color:var(--accent)}

.rows{display:flex; flex-direction:column; gap:11px}
.row{display:grid; grid-template-columns:76px 1fr 96px; align-items:center; gap:14px}
.row .nm{font:500 12.5px "IBM Plex Mono",monospace; color:var(--muted); font-variant-numeric:tabular-nums}
.track{position:relative; height:26px; background:var(--line-soft); border-radius:4px; overflow:hidden}
.bar{position:absolute; inset:0 auto 0 0; background:var(--accent); border-radius:4px; width:0;
  transition:width .85s cubic-bezier(.22,.7,.3,1)}
.row.dim .bar{background:var(--faint)}
.row .val{font:500 13px "IBM Plex Mono",monospace; text-align:right; font-variant-numeric:tabular-nums}
.axis{display:flex; justify-content:space-between; margin:10px 0 0 90px; color:var(--faint);
  font:400 10.5px "IBM Plex Mono",monospace}
@media (prefers-reduced-motion:reduce){ .bar{transition:none} }

.grid2{display:grid; grid-template-columns:1fr 1fr; gap:34px}
@media(max-width:760px){ .grid2{grid-template-columns:1fr} .row{grid-template-columns:64px 1fr 76px} }

table{width:100%; border-collapse:collapse; font-size:13.5px}
th,td{padding:9px 10px; text-align:right; border-bottom:1px solid var(--line-soft)}
th:first-child,td:first-child{text-align:left}
th{font:600 10.5px "IBM Plex Sans",sans-serif; letter-spacing:.07em; text-transform:uppercase;
  color:var(--faint); border-bottom:1px solid var(--line)}
td{font-family:"IBM Plex Mono",monospace; font-variant-numeric:tabular-nums}
td:first-child{font-family:"IBM Plex Sans",sans-serif}
tbody tr:hover{background:var(--line-soft)}
.best{color:var(--accent); font-weight:600}
/* the level-4 rows: same weights, a decode the product does not ship - recessive
   so they read as an appendix to the build rows, not as two more builds */
tr.alt td{color:var(--faint)}
tr.alt:first-of-type td{border-top:1px solid var(--line)}
.tablewrap{overflow-x:auto}

.note{color:var(--muted); font-size:13px; margin:14px 0 0; max-width:66ch}
.note b{color:var(--ink); font-weight:600}

.bar-legend{display:flex; gap:16px; align-items:center; color:var(--faint);
  font:400 11.5px "IBM Plex Mono",monospace; margin-bottom:14px}
.sw{display:inline-block; width:9px; height:9px; border-radius:2px; vertical-align:middle; margin-right:6px}

.ctl{display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px}
.ctl button{border:1px solid var(--line); background:var(--surface); color:var(--muted);
  border-radius:6px; padding:6px 11px; font:500 12px "IBM Plex Mono",monospace; cursor:pointer}
.ctl button[aria-pressed="true"]{border-color:var(--accent); color:var(--accent); background:var(--accent-soft)}
.ctl button:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

#copy{border:1px solid var(--line); background:var(--surface); color:var(--muted);
  border-radius:6px; padding:7px 12px; font:500 12px "IBM Plex Sans",sans-serif; cursor:pointer}
#copy:hover{color:var(--ink); border-color:var(--accent)}
#copy:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

/* speed: bar = median of the interleaved repeats, whisker = their min..max */
.whisk{position:absolute; top:50%; height:10px; margin-top:-5px; border-left:1.5px solid var(--ink);
  border-right:1.5px solid var(--ink); opacity:.55}
.whisk::after{content:""; position:absolute; left:0; right:0; top:50%; border-top:1.5px solid var(--ink)}
.speedk{font:500 12px "IBM Plex Mono",monospace; color:var(--muted); margin:18px 0 8px}
#speedTable td{white-space:nowrap}
#speedTable small{display:block; font-size:11px}
.scat{width:100%; height:auto; display:block}
.scat text{font:400 10.5px "IBM Plex Mono",monospace; fill:var(--faint)}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <h1>Build Accuracy Ledger</h1>
    <p class="sub" id="sub"></p>
  </div>
  <button class="theme" id="theme" type="button">Theme</button>
</header>

<div class="hero" id="hero"></div>

<section>
  <p class="note" id="caveat"></p>
</section>

<section>
  <h2>Mean per-tile count error</h2>
  <div class="rows" id="errRows"></div>
  <div class="axis"><span>0&#8239;%</span><span>log scale</span><span>50&#8239;%</span></div>
</section>

<section class="grid2">
  <div>
    <h2>Marker placement</h2>
    <div class="rows" id="locRows"></div>
    <p class="note">Distance from each marker to its matched cell. Measured on matched pairs only, so a
    build that finds fewer, easier cells scores well here for the wrong reason &mdash; read it beside recall.</p>
  </div>
  <div>
    <h2>Tiles within 2&#8239;% of truth</h2>
    <div class="rows" id="hitRows"></div>
    <p class="note">The share of tiles a lab would call correct.</p>
  </div>
</section>

<section>
  <h2>Every metric</h2>
  <div class="tablewrap"><table id="summary"></table></div>
  <p class="note" id="split"></p>
  <p class="note" id="l4"></p>
</section>

<section id="speed" hidden>
  <h2>Speed</h2>
  <p class="note" id="speedNote" style="margin:0 0 18px"></p>
  <div class="grid2" id="speedCharts"></div>
  <div class="tablewrap" style="margin-top:26px"><table id="speedTable"></table></div>
  <p class="note" id="speedVerdict"></p>
</section>

<section>
  <h2 id="scatTitle">Per-tile change</h2>
  <svg class="scat" id="scatter" viewBox="0 0 700 330" role="img" aria-label="Per-tile count error before and after"></svg>
  <div class="bar-legend" style="margin-top:10px">
    <span><i class="sw" style="background:var(--up)"></i>improved</span>
    <span><i class="sw" style="background:var(--down)"></i>regressed</span>
    <span><i class="sw" style="background:var(--faint)"></i>unchanged</span>
    <span id="scatCount"></span>
  </div>
</section>

<section>
  <h2>Per tile</h2>
  <div class="ctl" id="filters"></div>
  <div class="tablewrap"><table id="tiles"></table></div>
</section>

<section>
  <h2>Data</h2>
  <button id="copy" type="button">Copy CSV</button>
  <p class="note"><span id="csvRows"></span>, one per tile per build. The same file is on disk at
  <code>ml/runs/comparison.csv</code>.</p>
</section>

</div>
<script id="data" type="application/json">__DATA__</script>
<script id="csv" type="text/plain">__CSV__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const B = D.builds, cur = B[B.length - 1];
/* prev is the newest EARLIER build whose numbers actually differ from cur, not
   simply B[length - 2]: a release that ships an unchanged detector reproduces
   the previous build tile for tile, and a delta against it is zero on every
   metric - which would empty the hero and the scatter and read as "nothing was
   ever gained" rather than "this release changed nothing". */
const prev = B.slice(0, -1).reverse().find(b => b.all.mean_err !== cur.all.mean_err)
          || B[B.length - 2];

/* What this ledger is NOT. Every build is scored over all 69 tiles, which are
   the tiles the ML builds were TRAINED on, so none of these figures is an
   accuracy estimate - ml/loo.py is the only accuracy ruler, and its own per-fold
   spread is +-1.01 pp. Worse, the newest build has an advantage the others do
   not: its weights were trained on exactly the current labels, while the earlier
   ML builds never saw the latest corrections. This table cannot separate "better
   detector" from "fitted to these labels", so the honest reading of the newest
   row is NOT WORSE ON BETTER LABELS, not a measured gain. The one comparison
   that does survive is the SIGN of the signed column: fitting to your own labels
   pulls error toward zero from both sides, it does not remove a one-sided
   over-count. */
document.getElementById('caveat').innerHTML =
  `<b>Read this as a ledger, not an accuracy table.</b> Every build is scored ` +
  `over all ${D.meta ? D.meta.tiles : 69} ground-truth tiles &mdash; the same ` +
  `tiles the ML builds were trained on &mdash; so these are training-set ` +
  `numbers, never accuracy. The newest build also has an edge the older ones ` +
  `lack: it was trained on exactly the current labels, which the earlier builds ` +
  `never saw. Treat the newest row as <i>not worse, on better labels</i>. The ` +
  `column that does survive that objection is <b>signed</b> error: training on ` +
  `your own labels pulls error toward zero from both directions, it does not ` +
  `flip a systematic over-count.`;

/* Read from the data, never typed in: the old literal subtitle survived a build
   being added AND the ground truth being corrected without anyone noticing. */
(function () {
  const m = D.meta; if (!m) return;
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  const n = words[m.builds] || m.builds;
  const thin = v => v.toLocaleString('en-US').replace(/,/g, '&#8239;');
  document.getElementById('sub').innerHTML =
    `${n} builds, one ruler &mdash; ${m.tiles} tiles, ` +
    `${thin(m.gt_all || m.gt_points)} annotated cells, ` +
    `${thin(m.gt_points)} of them inside the triple frame where counting ` +
    `happens, Hungarian match at ${m.radius}&#8239;px. ` +
    `Every build re-scored against the CURRENT ground truth.`;
})();
const f1 = n => n.toFixed(1), f2 = n => n.toFixed(2);

/* theme: cycles system -> light -> dark */
const tb = document.getElementById('theme');
tb.onclick = () => {
  const r = document.documentElement, t = r.getAttribute('data-theme');
  if (!t) r.setAttribute('data-theme', 'light');
  else if (t === 'light') r.setAttribute('data-theme', 'dark');
  else r.removeAttribute('data-theme');
};

/* hero */
const drop = (a, b) => ((a - b) / a * 100);
document.getElementById('hero').innerHTML = [
  ['Count error', f2(cur.all.mean_err) + '<small> %</small>',
   `<span class="${cur.all.mean_err <= prev.all.mean_err ? 'pos' : 'neg'}">${cur.all.mean_err <= prev.all.mean_err ? '&minus;' : '+'}${f1(Math.abs(drop(prev.all.mean_err, cur.all.mean_err)))} % vs ${prev.label}</span>`],
  ['Placement', f2(cur.all.loc_mean) + '<small> px</small>',
   `<span class="${cur.all.loc_mean <= prev.all.loc_mean ? 'pos' : 'neg'}">${cur.all.loc_mean <= prev.all.loc_mean ? '&minus;' : '+'}${f2(Math.abs(cur.all.loc_mean - prev.all.loc_mean))} px</span>`],
  ['Tiles ≤ 2 %', f1(cur.all.within2) + '<small> %</small>',
   `<span class="${cur.all.within2 >= prev.all.within2 ? 'pos' : 'neg'}">${cur.all.within2 >= prev.all.within2 ? '+' : '&minus;'}${f1(Math.abs(cur.all.within2 - prev.all.within2))} pts</span>`],
  ['F1', cur.all.f1.toFixed(3),
   `<span class="${cur.all.f1 >= prev.all.f1 ? 'pos' : 'neg'}">${cur.all.f1 >= prev.all.f1 ? '+' : '&minus;'}${Math.abs(cur.all.f1 - prev.all.f1).toFixed(3)}</span>`],
].map(([k, v, d]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div><div class="delta">${d}</div></div>`).join('');

/* bars. log for error (43.8 to 1.4 spans two decades), linear elsewhere */
function bars(el, vals, fmt, opts = {}) {
  const max = opts.max || Math.max(...vals.map(v => v.v));
  const scale = v => opts.log
    ? Math.max(0, Math.log10(Math.max(v, .3) / .3) / Math.log10(max / .3)) * 100
    : (v / max) * 100;
  document.getElementById(el).innerHTML = vals.map(v =>
    `<div class="row${v.dim ? ' dim' : ''}"><span class="nm">${v.k}</span>
     <span class="track"><span class="bar" data-w="${scale(v.v).toFixed(1)}"></span></span>
     <span class="val">${fmt(v.v)}</span></div>`).join('');
}
bars('errRows', B.map(b => ({k: b.label, v: b.all.mean_err, dim: b.key !== cur.key})), v => f2(v) + ' %', {log: true, max: 50});
bars('locRows', B.map(b => ({k: b.label, v: b.all.loc_mean, dim: b.key !== cur.key})), v => f2(v) + ' px');
bars('hitRows', B.map(b => ({k: b.label, v: b.all.within2, dim: b.key !== cur.key})), v => f1(v) + ' %', {max: 100});

requestAnimationFrame(() => document.querySelectorAll('.bar').forEach((b, i) => {
  setTimeout(() => b.style.width = b.dataset.w + '%', 40 * i);
}));

/* summary table */
/* level-4 rows sit apart from the build rows: same weights, different decode. */
const cols = [
  ['Build', b => b.label], ['Detector', b => b.detector],
  ['Mean |err|', b => f2(b.all.mean_err) + ' %', 'min', b => b.all.mean_err],
  ['Median', b => f2(b.all.median_err) + ' %'],
  ['Signed', b => (b.all.signed >= 0 ? '+' : '') + f2(b.all.signed) + ' %'],
  ['≤ 2 %', b => f1(b.all.within2) + ' %', 'max', b => b.all.within2],
  ['F1', b => b.all.f1.toFixed(4), 'max', b => b.all.f1],
  ['Recall', b => b.all.recall.toFixed(4)],
  ['Placement', b => f2(b.all.loc_mean) + ' px', 'min', b => b.all.loc_mean],
  ['FP', b => b.all.fp], ['FN', b => b.all.fn],
];
const bestOf = {};
cols.forEach((c, i) => {
  if (!c[2]) return;
  const vs = B.map(c[3]);
  bestOf[i] = c[2] === 'min' ? Math.min(...vs) : Math.max(...vs);
});
/* Level 4 joins this table as its own rows rather than the charts: it is not the
   shipped level, and it is the SAME weights decoded differently, so charting it
   beside the four builds would read as a fifth and sixth build. It is excluded
   from bestOf, which is computed over B alone. */
const rows = B.concat(Object.entries(D.level4 || {}).map(([k, v]) => ({
  key: k + '_l4', label: v.label + ' · level 4', l4: true,
  detector: '3-model ensemble + 8-way TTA (not the shipped level)', all: v,
})));
/* Both of these were literal text with the old GT's numbers baked in. */
(function () {
  const s = B[0]; if (!s || !s['10x'] || !s.hemo1) return;
  document.getElementById('split').innerHTML =
    `<b>${s.label} is split</b> because its grid detector predates the ` +
    `12&nbsp;Sept hemocytometer fix: it reads ` +
    `${s['10x'].mean_err.toFixed(1)}&#8239;% on the ${s['10x'].n} 10x tiles and ` +
    `${s.hemo1.mean_err.toFixed(1)}&#8239;% on the ${s.hemo1.n} hemo1 captures, ` +
    `where it mis-finds the counting area rather than miscounting cells.`;
})();
document.getElementById('scatTitle').textContent =
  `Per-tile change, ${prev.label} → ${cur.label}`;
document.getElementById('csvRows').textContent =
  `${(D.csvRows || 0).toLocaleString('en-US')} rows`;

if (D.level4) {
  /* Which way level 4 goes is DERIVED, not asserted: it counted worse than
     level 3 on the Sept 16/17 weights and the sentence here said so as a fact,
     which would have quietly become false the moment a retrain changed it. */
  const keys = Object.keys(D.level4), k = keys[keys.length - 1];
  const l4 = D.level4[k], l3 = B.find(x => x.key === k);
  let verdict = 'is measured but not shipped';
  if (l3) {
    const dc = l4.mean_err - l3.all.mean_err, df = l4.f1 - l3.all.f1;
    verdict = `on the current build it counts ` +
      (Math.abs(dc) < 0.05 ? 'the same' :
        `${Math.abs(dc).toFixed(2)}&#8239;pp ${dc < 0 ? 'better' : 'worse'}`) +
      ` and matches ${df >= 0 ? 'better' : 'worse'} (F1 ${l4.f1.toFixed(4)} ` +
      `against ${l3.all.f1.toFixed(4)})`;
  }
  document.getElementById('l4').innerHTML =
    `<b>The shaded rows are level 4</b> (test-time augmentation) on the same ` +
    `weights as the build above each of them &mdash; ${verdict}. Level 3 stays ` +
    `the shipped default: level 4 costs ~4.6&times; the runtime per capture, ` +
    `which is not worth this margin.`;
}
document.getElementById('summary').innerHTML =
  '<thead><tr>' + cols.map(c => `<th>${c[0]}</th>`).join('') + '</tr></thead><tbody>' +
  rows.map(b => `<tr${b.l4 ? ' class="alt"' : ''}>` + cols.map((c, i) =>
    `<td${!b.l4 && bestOf[i] !== undefined && c[3](b) === bestOf[i] ? ' class="best"' : ''}>${c[1](b)}</td>`
  ).join('') + '</tr>').join('') + '</tbody>';

/* speed: every number read from D.timing (ml/runs/timing.json), never typed in */
(function () {
  const T = D.timing; if (!T) return;
  document.getElementById('speed').hidden = false;
  const med = v => [...v].sort((a, b) => a - b)[(v.length - 1) >> 1];
  const lo = v => Math.min(...v), hi = v => Math.max(...v);
  const RUNGS = ['Classical', 'Quick', 'Normal', 'Finest'].filter(r => T.builds.some(b => b.img[r]));
  const m = T.meta;
  document.getElementById('speedNote').innerHTML =
    `${m.files.length} captures (whole name groups ${m.groups.join(', ')}), ` +
    `${m.rounds} interleaved rounds (${T.builds.map(b => b.label).join(' → ')}, then again) ` +
    `after a warm-up, one timing at a time, all builds on one interpreter (Python ${m.python}). ` +
    `<b>Bar = median of the rounds, whisker = min&ndash;max.</b> ${m.rung_map} ` +
    `Per image is one lone count in-process, the way each build's app.py calls it; the batch is ` +
    `${m.files.length} captures over HTTP (${m.batch_desc}), from dispatch to the last response.`;
  const block = (title, sel, fmt) => RUNGS.map(r => {
    const bs = T.builds.filter(b => sel(b)[r]);
    if (!bs.length) return '';
    const max = Math.max(...bs.map(b => hi(sel(b)[r])));
    return `<div class="speedk">${title} · ${r}</div><div class="rows">` + bs.map(b => {
      const v = sel(b)[r], p = x => (x / max * 100).toFixed(1);
      return `<div class="row${b.key === T.builds[T.builds.length - 1].key ? '' : ' dim'}" ` +
        `title="${b.label} ${r}: ${v.map(fmt).join(' / ')}"><span class="nm">${b.label}</span>` +
        `<span class="track"><span class="bar" style="width:${p(med(v))}%"></span>` +
        `<span class="whisk" style="left:${p(lo(v))}%;width:${(p(hi(v)) - p(lo(v))).toFixed(1)}%"></span></span>` +
        `<span class="val">${fmt(med(v))}</span></div>`;
    }).join('') + '</div>';
  }).join('');
  const sec = x => x.toFixed(2) + ' s';
  const mins = x => (x < 120 ? x.toFixed(1) + ' s' : (x / 60).toFixed(1) + ' min');
  document.getElementById('speedCharts').innerHTML =
    `<div>${block('Seconds per image', b => b.img, sec)}</div>` +
    `<div>${block(m.files.length + '-image batch', b => b.batch, mins)}</div>`;
  const cell = (v, f) => v ? `${f(med(v))} <small style="color:var(--faint)">${f(lo(v))}&ndash;${f(hi(v))}</small>` : '&mdash;';
  document.getElementById('speedTable').innerHTML =
    '<thead><tr><th>Build</th><th>Counts at once</th>' +
    RUNGS.map(r => `<th>${r} s/img</th>`).join('') + RUNGS.map(r => `<th>${r} batch</th>`).join('') +
    '</tr></thead><tbody>' + T.builds.map(b =>
      `<tr><td title="${b.ref}">${b.label}</td><td>${b.slots}</td>` +
      RUNGS.map(r => `<td>${cell(b.img[r], sec)}</td>`).join('') +
      RUNGS.map(r => `<td>${cell(b.batch[r], mins)}</td>`).join('') + '</tr>').join('') + '</tbody>';
  /* A change is a result only when the two builds' ranges do not overlap: a gap
     smaller than the spread of its own repeats is noise (docs/speed-report). */
  const said = [];
  for (const [kind, sel, f] of [['per image', b => b.img, sec], ['batch', b => b.batch, mins]]) {
    for (const r of RUNGS) {
      const bs = T.builds.filter(b => sel(b)[r]);
      for (let i = 1; i < bs.length; i++) {
        const a = sel(bs[i - 1])[r], c = sel(bs[i])[r];
        const real = lo(c) > hi(a) || hi(c) < lo(a);
        said.push(`${r} ${kind}, ${bs[i - 1].label} → ${bs[i].label}: ${f(med(a))} → ${f(med(c))} ` +
          (real ? `<b>(${med(c) < med(a) ? '' : '+'}${((med(c) / med(a) - 1) * 100).toFixed(0)} %, real: ranges do not overlap)</b>`
                : `(ranges overlap: not a result)`));
      }
    }
  }
  document.getElementById('speedVerdict').innerHTML = said.join('<br>');
})();

/* scatter: old error vs new error, per tile */
(function () {
  /* the two most recent builds, not a hardcoded pair: this scatter is "what did
     the newest change do to each tile", and it was still pointing at Sept 16 vs
     Sept 17 after Sept 18 landed. */
  const a = prev, b = cur;
  const m = new Map(a.tiles.map(t => [t.tile, t]));
  const pts = b.tiles.map(t => ({ n: t.tile, o: Math.abs(m.get(t.tile).err), w: Math.abs(t.err) }))
                     .filter(p => isFinite(p.o));
  const W = 700, H = 330, P = 42, hi = 10;
  const x = v => P + Math.min(v, hi) / hi * (W - P - 16);
  const y = v => H - P - Math.min(v, hi) / hi * (H - P - 18);
  let s = '', better = 0, worse = 0, same = 0;
  for (let t = 0; t <= hi; t += 2) {
    s += `<line x1="${x(t)}" y1="${18}" x2="${x(t)}" y2="${H - P}" stroke="var(--line-soft)" stroke-width="1"/>`;
    s += `<line x1="${P}" y1="${y(t)}" x2="${W - 16}" y2="${y(t)}" stroke="var(--line-soft)" stroke-width="1"/>`;
    s += `<text x="${x(t)}" y="${H - P + 16}" text-anchor="middle">${t}</text>`;
    s += `<text x="${P - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  }
  s += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(hi)}" y2="${y(hi)}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 4"/>`;
  pts.forEach(p => {
    const d = p.w - p.o;
    const c = d < -0.05 ? 'var(--up)' : d > 0.05 ? 'var(--down)' : 'var(--faint)';
    if (d < -0.05) better++; else if (d > 0.05) worse++; else same++;
    s += `<circle cx="${x(p.o).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="4" fill="${c}" fill-opacity=".8" stroke="var(--surface)" stroke-width="1.5"><title>${p.n}\\n${f2(p.o)} % → ${f2(p.w)} %</title></circle>`;
  });
  /* named from the builds actually plotted; these read "Sept 16"/"Sept 17" for
     two builds after that pair stopped being the one on screen. */
  s += `<text x="${W / 2}" y="${H - 8}" text-anchor="middle">${a.label} error %</text>`;
  s += `<text transform="translate(13,${H / 2}) rotate(-90)" text-anchor="middle">${b.label} error %</text>`;
  document.getElementById('scatter').innerHTML = s;
  document.getElementById('scatCount').textContent = `${better} better · ${worse} worse · ${same} unchanged`;
})();

/* per-tile table */
let sel = cur.key;
const fl = document.getElementById('filters');
fl.innerHTML = B.map(b => `<button type="button" data-k="${b.key}" aria-pressed="${b.key === sel}">${b.label}</button>`).join('');
fl.onclick = e => {
  const k = e.target.dataset && e.target.dataset.k;
  if (!k) return;
  sel = k;
  [...fl.children].forEach(c => c.setAttribute('aria-pressed', c.dataset.k === sel));
  drawTiles();
};
function drawTiles() {
  const b = B.find(x => x.key === sel);
  const rows = [...b.tiles].sort((p, q) => Math.abs(q.err) - Math.abs(p.err));
  document.getElementById('tiles').innerHTML =
    '<thead><tr><th>Tile</th><th>Truth</th><th>Counted</th><th>Diff</th><th>Error</th><th>Placement</th><th>F1</th></tr></thead><tbody>' +
    rows.map(t => `<tr><td>${t.tile}</td><td>${t.gt}</td><td>${t.det}</td>
      <td class="${t.det - t.gt > 0 ? 'over' : t.det - t.gt < 0 ? 'under' : ''}">${t.det - t.gt > 0 ? '+' : ''}${t.det - t.gt}</td>
      <td class="${Math.abs(t.err) <= 2 ? 'pos' : ''}">${t.err >= 0 ? '+' : ''}${f2(t.err)} %</td>
      <td>${t.loc === null ? '—' : f2(t.loc) + ' px'}</td><td>${t.f1.toFixed(3)}</td></tr>`).join('') +
    '</tbody>';
}
drawTiles();

/* csv */
document.getElementById('copy').onclick = async e => {
  try {
    await navigator.clipboard.writeText(document.getElementById('csv').textContent);
    e.target.textContent = 'Copied';
  } catch { e.target.textContent = 'Select the file on disk'; }
  setTimeout(() => e.target.textContent = 'Copy CSV', 1800);
};
</script>
</body>
</html>
"""

html = HTML.replace("__DATA__", json.dumps(d)).replace("__CSV__", csv_text)
out = os.path.join(R, "comparison.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)
print(f"-> {out}  ({len(html) // 1024} KB)")
