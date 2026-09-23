import json, urllib.request, sys, time, os, ctypes, ctypes.wintypes
from PIL import ImageGrab
label, transparent, dpp = sys.argv[1], sys.argv[2] == "on", sys.argv[3]
extra = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
CSSFILE = sys.argv[5] if len(sys.argv) > 5 else ""
THEME = sys.argv[6] if len(sys.argv) > 6 else None  # theme id from web/src/state/useTheme.ts; None = arg absent
G = "http://127.0.0.1:4446"
def http(m, p, b=None):
    r = urllib.request.Request(G + p, data=json.dumps(b).encode() if b is not None else None, method=m, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=180) as f: return json.load(f)["value"]
    except urllib.error.HTTPError as e: return "ERR " + e.read().decode()[:200]
prefs = {"browser.tabs.allow_transparent_browser": transparent, "layout.css.devPixelsPerPx": dpp, "zen.view.compact.enable-at-startup": False, "zen.welcome-screen.seen": True, "browser.aboutwelcome.enabled": False, "zen.workspaces.continue-where-left-off": False, **extra}
v = http("POST", "/session", {"capabilities": {"alwaysMatch": {"moz:firefoxOptions": {"prefs": prefs}}}}); sid = v["sessionId"]; pid = v["capabilities"]["moz:processID"]
S = f"/session/{sid}"
def cmd(m, p, b=None): return http(m, S + p, b)
def js(s, *a): return cmd("POST", "/execute/sync", {"script": s, "args": list(a)})
cmd("POST", "/window/rect", {"x": 0, "y": 0, "width": 1400, "height": 900}); time.sleep(1)
cmd("POST", "/url", {"url": "http://127.0.0.1:8477/"}); time.sleep(3)
if THEME is not None:
    # fresh profile -> empty localStorage every run, so set the theme the app itself writes, then
    # reload so useTheme's mount effect applies the data-theme attribute before we screenshot.
    js("localStorage.setItem('cellcounter-theme', arguments[0])", THEME)
    cmd("POST", "/url", {"url": "http://127.0.0.1:8477/"}); time.sleep(3)
    got = js("return document.documentElement.getAttribute('data-theme')")
    if (got or "") != THEME:
        print("THEME MISMATCH: wanted", repr(THEME), "got", repr(got))
    else:
        print("theme set:", THEME or "(default)")
    label = f"{label}-{THEME or 'default'}"
el = cmd("POST", "/element", {"using": "css selector", "value": "input[type=file]"}); eid = list(el.values())[0]
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "tif", "hemo1 ha1 ")
cmd("POST", f"/element/{eid}/value", {"text": "\n".join([T + "sq2.1.tif", T + "sq2.2.tif", T + "sq1.1.tif"])})
for _ in range(60):
    if "Count 3" in (js("return document.body.innerText") or ""): break
    time.sleep(1)
time.sleep(2)
rect = cmd("GET", "/window/rect"); print("rect", rect, "dpr", js("return devicePixelRatio"))
vx, vy = ctypes.windll.user32.GetSystemMetrics(76), ctypes.windll.user32.GetSystemMetrics(77)
os.makedirs("out_zen", exist_ok=True)
def find_hwnd():
    u = ctypes.windll.user32; out = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        p = ctypes.c_ulong(); u.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid and u.IsWindowVisible(h):
            n = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, n, 256)
            if n.value: out.append((h, n.value))
        return True
    u.EnumWindows(cb, 0); return out
wins = find_hwnd(); print("windows", wins); hwnd = wins[0][0]
from PIL import Image
def printwindow(h):
    u, g = ctypes.windll.user32, ctypes.windll.gdi32
    r = ctypes.wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r)); w, hh = r.right - r.left, r.bottom - r.top
    hdc = u.GetWindowDC(h); mdc = g.CreateCompatibleDC(hdc); bmp = g.CreateCompatibleBitmap(hdc, w, hh); g.SelectObject(mdc, bmp)
    ok = u.PrintWindow(h, mdc, 2)  # PW_RENDERFULLCONTENT
    class BMI(ctypes.Structure): _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32), ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16), ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32), ("biSizeImage", ctypes.c_uint32), ("x", ctypes.c_int32 * 2), ("y", ctypes.c_uint32 * 2)]
    bi = BMI(); bi.biSize = ctypes.sizeof(BMI); bi.biWidth = w; bi.biHeight = -hh; bi.biPlanes = 1; bi.biBitCount = 32
    buf = ctypes.create_string_buffer(w * hh * 4); g.GetDIBits(mdc, bmp, 0, hh, buf, ctypes.byref(bi), 0)
    g.DeleteObject(bmp); g.DeleteDC(mdc); u.ReleaseDC(h, hdc)
    return ok, Image.frombuffer("RGBA", (w, hh), buf.raw, "raw", "BGRA", 0, 1).convert("RGB")
def grab(name):
    ok, im = printwindow(hwnd); print("pw", ok)
    im.save(f"out_zen/{label}-{name}.png"); print("saved", name, im.size)
CSS = {"base": "", "htmlbg": "html{background:var(--bg)}", "noBodyScale": "body{transform:none!important;width:auto!important;height:auto!important}",
       "shadowBorder": "button,[role=group]{border-color:transparent!important;box-shadow:0 0 0 1px var(--line)!important}",
       "noRadius": "button,[role=group]{border-radius:0!important}", "isolate": "button,[role=group]{isolation:isolate;will-change:transform}"}
if CSSFILE: CSS = json.load(open(CSSFILE))
for n, c in CSS.items():
    js("let s=document.getElementById('__t');if(s)s.remove();s=document.createElement('style');s.id='__t';s.textContent=arguments[0];document.head.appendChild(s);", c); time.sleep(0.8); grab(n)
js("document.getElementById('__t')?.remove()")
btn = js("const b=[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith('Count 3')); b&&b.click(); return !!b"); print("clicked", btn)
# The three captures overlap (sq2.1/sq2.2/sq1.1), so "Count 3" never starts
# counting directly - it opens the overlap board (OverlapBoard.tsx) and
# counting only begins once every pair is resolved there. Poll for the board,
# not the processing screen, right after this click.
for _ in range(60):
    if js("return !!document.querySelector('[role=group][aria-label]')"): break
    time.sleep(1)
time.sleep(1.5)
for n, c in CSS.items():
    js("let s=document.getElementById('__t');if(s)s.remove();s=document.createElement('style');s.id='__t';s.textContent=arguments[0];document.head.appendChild(s);", c); time.sleep(0.8); grab("ov-" + n)
js("document.getElementById('__t')?.remove()")
# Resolve the board and start the count. Every pair already defaults to
# "merge" (OverlapBoard.tsx: `picked[keyOf(c)] ?? "merge"`), so "Merge all"
# (labels={["Merge all","Keep all"]} on the header PairSwitch) is a no-op click
# that just makes the choice explicit; it's the more interesting path since a
# merge also renders the "merged" badge pill. The actual trigger is "Overlap"
# (<Button onClick={run}>, whose run() calls decideAll - "settling the last
# pair starts the count", per OverlapBoard.tsx's own comment on that call).
mall = js("const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Merge all'); b&&b.click(); return !!b"); print("clicked merge all", mall)
time.sleep(0.3)
ovb = js("const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Overlap'); b&&b.click(); return !!b"); print("clicked overlap", ovb)
# Transient screen (the confirm screen estimates ~6s for three captures): poll
# fast rather than sleep a guess.
proc = False
for _ in range(60):
    if js("return !!document.querySelector('[data-testid=\"view-processing\"]')"): proc = True; break
    time.sleep(0.1)
if proc:
    for n, c in CSS.items():
        js("let s=document.getElementById('__t');if(s)s.remove();s=document.createElement('style');s.id='__t';s.textContent=arguments[0];document.head.appendChild(s);", c); time.sleep(0.8); grab("proc-" + n)
        if not js("return !!document.querySelector('[data-testid=\"view-processing\"]')"):
            print("processing screen cleared mid-variant-loop (~0.8s/variant vs a ~6s count) - stopping early, got", n); break
    js("document.getElementById('__t')?.remove()")
else:
    print("processing screen not reached: the count finished (or never started) before the 0.1s poll caught it - check the Overlap click actually routed to counting, not that the count was 'fast'")
if label.endswith("support"):
    cmd("POST", "/url", {"url": "about:support"}); time.sleep(3)
    t = js("return document.body.innerText"); open("out_zen/about-support.txt", "w", encoding="utf-8").write(str(t)); print("support", len(str(t)))
cmd("DELETE", "")
