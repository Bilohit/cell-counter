import ctypes, ctypes.wintypes, time, sys
from PIL import Image
def find(title_sub):
    u = ctypes.windll.user32; out = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        if u.IsWindowVisible(h):
            n = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, n, 256)
            if title_sub in n.value: out.append((h, n.value))
        return True
    u.EnumWindows(cb, 0); return out
def printwindow(h):
    u, g = ctypes.windll.user32, ctypes.windll.gdi32
    r = ctypes.wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r)); w, hh = r.right - r.left, r.bottom - r.top
    hdc = u.GetWindowDC(h); mdc = g.CreateCompatibleDC(hdc); bmp = g.CreateCompatibleBitmap(hdc, w, hh); g.SelectObject(mdc, bmp)
    ok = u.PrintWindow(h, mdc, 2)
    class BMI(ctypes.Structure): _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32), ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16), ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32), ("biSizeImage", ctypes.c_uint32), ("x", ctypes.c_int32 * 2), ("y", ctypes.c_uint32 * 2)]
    bi = BMI(); bi.biSize = ctypes.sizeof(BMI); bi.biWidth = w; bi.biHeight = -hh; bi.biPlanes = 1; bi.biBitCount = 32
    buf = ctypes.create_string_buffer(w * hh * 4); g.GetDIBits(mdc, bmp, 0, hh, buf, ctypes.byref(bi), 0)
    g.DeleteObject(bmp); g.DeleteDC(mdc); u.ReleaseDC(h, hdc)
    return ok, Image.frombuffer("RGBA", (w, hh), buf.raw, "raw", "BGRA", 0, 1).convert("RGB")
for stage, marker in [("confirm", "confirm-ready"), ("overlap", "overlap-ready")]:
    for _ in range(150):
        if marker in open("pw/ffhold.log").read(): break
        time.sleep(1)
    time.sleep(3)
    wins = [w for w in find("Cell Counter") if "Zen" not in w[1]]; print(stage, wins)
    if wins:
        ok, im = printwindow(wins[0][0]); im.save(f"out_zen/ff155-{stage}.png"); print("saved", ok, im.size)
