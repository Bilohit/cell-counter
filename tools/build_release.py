"""Cross-build the double-click zips from Windows. No Mac, no compiler needed.

    python tools/build_release.py            # both zips into release/
    python tools/build_release.py mac        # just one

Each zip carries its own CPython (python-build-standalone) with every wheel
already installed, so the user unzips and double-clicks. No Python on their
machine, no internet, no pip at run time.

Run `cd web && npm run build` first: static/dist must exist.
"""
import hashlib
import json
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

PYV = "3.12"
ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
OUT = ROOT / "release"
API = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"

# mac wheels are tagged against several minimum-OS versions (opencv uses
# macosx_10_16, numpy macosx_10_9); pip takes --platform repeatedly and matches any.
# The pinned opencv publishes macosx_13_0_arm64 / macosx_14_0_x86_64 only, and
# onnxruntime 1.27.0 macosx_14_0_arm64 only (its dylib's LC_BUILD_VERSION minos
# is 14.0; checked 2026-09-23), so the real floor is macOS 14+ on both.
MAC_ARM = ["macosx_11_0_arm64", "macosx_12_0_arm64", "macosx_13_0_arm64",
           "macosx_14_0_arm64", "macosx_15_0_arm64", "macosx_10_9_universal2"]
MAC_X86 = ["macosx_10_9_x86_64", "macosx_10_16_x86_64", "macosx_12_0_x86_64",
           "macosx_13_0_x86_64", "macosx_14_0_x86_64", "macosx_15_0_x86_64",
           "macosx_10_9_universal2"]

# name -> [(runtime dir, pbs triple, wheel platform tags)]
TARGETS = {
    "mac": [("runtime-arm64", "aarch64-apple-darwin", MAC_ARM),
            ("runtime-x86_64", "x86_64-apple-darwin", MAC_X86)],
    "win": [("runtime", "x86_64-pc-windows-msvc", ["win_amd64"])],
}

# Release asset names. README.md links to releases/latest/download/<name>, so a
# rename here must change those two links too.
ZIP_NAME = {"win": "CellCounter-Windows.zip", "mac": "CellCounter-macOS.zip"}

# What the app actually needs at run time, and nothing else: the ml/ modules
# app.py and pipeline.py import plus the ONNX weights. Training and review
# tools (train.py imports torch, which the release does not carry), runs/,
# samples/, tests/ and score.py stay home.
# A module app.py imports that is missing here kills the app on first launch
# (v1.0 shipped without imaging.py); tests/tools pins the import closure.
PAYLOAD = ["app.py", "pipeline.py", "imaging.py", "static",
           "ml/__init__.py", "ml/infer.py", "ml/peaks.py", "ml/weights"]
PAYLOAD_IGNORE = shutil.ignore_patterns("runs", "__pycache__", "*.pt")

# Dead weight in a runtime nobody will ever develop against.
PRUNE = ["idlelib", "tkinter", "turtledemo", "lib2to3", "test", "ensurepip",
         "pip", "pip-*.dist-info", "setuptools", "config-*", "*.a", "*.pdb", "tcl",
         # Tk, CPython's own test modules, headers, man pages
         "tcl*", "tk*", "libtcl*", "libtk*", "_tkinter*", "_test*", "_ctypes_test*", "include", "share",
         # stdlib nothing imports (traced 2026-09-23): venv carries its own launcher
         # .exe files; sqlite3, msilib and curses carry native modules
         "venv", "sqlite3", "_sqlite3*", "sqlite3.dll", "msilib", "_msi*", "pydoc_data",
         "curses", "_curses*", "dbm", "_dbm*", "_gdbm*", "xmlrpc", "wsgiref", "__phello__",
         "winsound*"]
# Only in bin/: the same names in the stdlib (pydoc.py) are imported.
BIN_PRUNE = ["pip*", "idle*", "pydoc*", "2to3*", "python*-config"]

# Inside site-packages. Nothing here is imported at run time: pip and its
# console-script stubs (pip writes Windows .exe stubs even for a mac --platform),
# the libraries' own test suites, OpenCV's face cascades and its video plugin
# (loaded only to open video), onnxruntime's model-conversion tooling (the
# deepest paths in the zip: Explorer's Extract All silently drops files past
# 260 chars), and pyreadline3, which pip pulls in for mac only
# because it evaluates `sys_platform == "win32"` markers on the build machine.
SITE_PRUNE = ["pip", "pip-*.dist-info", "bin", "cv2/data", "cv2/opencv_videoio_ffmpeg*",
              "onnxruntime/quantization", "onnxruntime/tools", "onnxruntime/transformers",
              "onnxruntime/backend", "onnxruntime/datasets", "numpy/doc", "numpy/_pyinstaller",
              # Declared dependencies of scikit-image and onnxruntime that a count never
              # imports: the app reads images with OpenCV and uses only
              # skimage.feature.peak_local_max and scipy.spatial.cKDTree.
              "PIL", "pillow-*", "imageio", "imageio-*", "tifffile", "tifffile-*",
              "networkx", "networkx-*", "packaging", "packaging-*", "idna", "idna-*",
              "flatbuffers", "flatbuffers-*", "google", "protobuf-*", "multipart",
              # Subpackages a count never loads (sys.modules after a traced run,
              # 2026-09-23: skimage _shared feature measure; scipy _lib constants
              # linalg ndimage sparse spatial special). An import-statement trace is
              # not enough: lazy_loader goes through importlib.import_module, and
              # missing skimage.measure that way killed the launch. Using a new
              # skimage/scipy function? Re-trace from sys.modules.
              *[f"skimage/{d}" for d in ("color", "data", "draw", "exposure", "filters",
                "future", "graph", "io", "metrics", "morphology", "registration",
                "restoration", "segmentation", "transform", "util", "_vendored")],
              *[f"scipy/{d}" for d in ("cluster", "datasets", "differentiate", "fft",
                "fftpack", "integrate", "interpolate", "io", "misc", "odr", "optimize",
                "signal", "stats")]]
MAC_SITE_PRUNE = ["pyreadline3", "pyreadline3-*.dist-info", "readline.py",
                  # onnxruntime 1.23 (the last Intel-mac build) declares its tooling's
                  # deps; the runtime never imports them. coloredlogs.pth would run at
                  # every interpreter start.
                  "sympy", "sympy-*", "isympy.py", "mpmath", "mpmath-*", "coloredlogs*",
                  "humanfriendly", "humanfriendly-*", "share"]
# Build-time-only files anywhere in site-packages: C/Cython sources and headers,
# MSVC and MinGW (.dll.a) import libraries. The interpreter never opens them. NOT .pyi: scikit-image
# reads its stubs at import time (lazy_loader.attach_stub), and pruning them
# killed the launch in the 2026-09-23 new-user run.
SITE_PRUNE_SUFFIXES = (".pxd", ".pyx", ".c", ".cpp", ".h", ".lib", ".a")

MAC_LAUNCHER = """#!/bin/bash
# Double-click to start Cell Counter. Everything it needs is in this folder.
cd "$(dirname "$0")"

# macOS quarantines everything unzipped from a download; clear it once so the
# bundled Python is allowed to run.
xattr -dr com.apple.quarantine . 2>/dev/null

if [ "$(uname -m)" = "arm64" ]; then RT=runtime-arm64; else RT=runtime-x86_64; fi

echo "Starting Cell Counter - your browser will open shortly."
echo "Keep this window open while using the app. Close it to quit."
"./$RT/bin/python3" app.py
status=$?

# Hold the window open on a failure. Without this a first-run failure - the
# folder still inside the .zip, a blocked runtime, a port already in use -
# flashes past in under a second and the user sees nothing at all. 130 is a
# normal Ctrl-C quit, not something to report.
if [ $status -ne 0 ] && [ $status -ne 130 ]; then
  echo
  echo "Cell Counter stopped with an error. The message above says why."
  echo "If this is the first run, make sure you unzipped this folder to your"
  echo "Desktop instead of opening it inside the .zip."
  echo
  read -r -p "Press Return to close this window."
fi
"""

WIN_LAUNCHER = """@echo off
rem Double-click to start Cell Counter. Everything it needs is in this folder.
cd /d "%~dp0"

echo Starting Cell Counter - your browser will open shortly.
echo Keep this window open while using the app. Close it to quit.
runtime\\python.exe app.py
if errorlevel 1 (
  rem Hold the window open on a failure. Without this a first-run failure -
  rem the folder still inside the .zip, a blocked runtime, a port already in
  rem use - flashes past in under a second and the user sees nothing at all.
  echo.
  echo Cell Counter stopped with an error. The message above says why.
  echo If this is the first run, make sure you unzipped this folder to your
  echo Desktop instead of opening it inside the .zip.
  pause
)
"""


MAC_README = """Cell Counter - first run on a Mac
====================================

1. Unzip this folder anywhere (Desktop is fine). Keep it together - everything
   the app needs lives inside it, including its own copy of Python. You do not
   need to install anything.

2. THE FIRST TIME ONLY: right-click (or Control-click) "Start Cell Counter.command"
   and choose Open, then click Open in the dialog that appears. macOS shows that
   dialog for anything downloaded from the internet.

   On macOS 15 (Sequoia) and newer the dialog sometimes offers only Done. If it
   does: click Done, open System Settings > Privacy & Security, scroll down to
   Security, and click "Open Anyway" next to the line about
   "Start Cell Counter.command". Confirm with your password or Touch ID, then
   double-click the file again.

   After that first time, a normal double-click works.

3. A black Terminal window opens and your browser goes to the app. Keep the
   Terminal window open while you work; closing it quits the app.

4. To start it in one click from the Desktop: right-click "Start Cell
   Counter.command", choose Make Alias, drag the alias to your Desktop and
   rename it "Cell Counter". Double-click that from then on.

Needs macOS 14 (Sonoma) or newer.
Nothing is uploaded anywhere - the app runs entirely on your own machine.
"""


WIN_README = """Cell Counter - first run on Windows
======================================

1. Right-click the zip you downloaded and choose "Extract All". Start the app from
   the extracted folder - running it from inside the zip will not work.

2. Keep the folder together - everything the app needs lives inside it, including
   its own copy of Python. You do not need to install anything.

3. Double-click "Start Cell Counter.bat". A black window opens and your browser
   goes to the app. The very first start can take a minute while Windows checks
   the new files; later starts are quick.

   If a blue "Windows protected your PC" box appears, click "More info" and then
   "Run anyway". Windows shows that for anything downloaded from the internet.

4. Keep the black window open while you work; closing it quits the app.

5. To start it in one click from the Desktop: right-click "Start Cell Counter.bat",
   choose "Show more options" > "Send to" > "Desktop (create shortcut)", then
   rename the shortcut "Cell Counter". Double-click that from then on.

Needs 64-bit Windows 10 or newer.
Nothing is uploaded anywhere - the app runs entirely on your own machine.
"""


# Appended to both READMEs: the platform part gets the app open, this part
# gets a first count out of it.
USING = """

Using Cell Counter
==================

NAME YOUR FILES BY SAMPLE (this makes everything faster)
   Start every file name with the name of its sample, then a space:

       ha1 sq1.1.tif    ha1 sq1.2.tif    ha1 sq2.1.tif    ...
       KNT sq1.1.tif    KNT sq1.2.tif    ...

   Any word works as the sample name - "ha1", "KNT", "abc" - as long as all
   captures of one sample start with the same word and it is followed by a
   space. Capital letters do not matter. The app then only looks for
   overlapping captures inside each sample, which is much faster on a big
   folder, and the concentration calculator can work one sample at a time.

1. LOAD CAPTURES
   Drag your TIF files onto the window, or click to browse. You can load a
   whole folder at once. A confirm screen shows what will be counted.

2. OVERLAPPING CAPTURES ARE HANDLED FOR YOU
   One 10x capture shows three of the four rows of a large square, so a
   square is usually captured twice. The app finds the two captures that
   overlap, joins them, and counts the square once - you never count the
   overlap twice.
   On the confirm screen, turn on "Name groups" to use your sample names
   (it offers itself when your names follow the pattern above). Files named
   any other way can be grouped by hand: select them and choose "New group".

3. CHOOSE THE QUALITY
   One slider: Quick, Normal (the default) or Finest. Finest is slowest and
   most careful - use it for final numbers and crowded slides. Moving the
   slider does nothing on its own; press Reprocess to count again.

4. CHECK AND CORRECT
   Every counted cell has a dot. Only cells inside the triple boundary line
   are counted. Click a dot to remove it; click a cell to add one. Your
   corrections survive cropping, but Reprocess counts from scratch and
   replaces them.

5. CONCENTRATION
   The calculator turns counted squares into cells/mL. Type your dilution.
   It uses complete squares only and tells you which squares it left out
   and why.

6. SAVE YOUR WORK
   Export annotated images, a CSV, a PDF report or the cell positions, or
   save the session to open later. Closing or reloading the browser tab
   clears the counts, so export or save first.

Good captures: focus on the cells, keep the triple line in frame, keep the
lighting even, and use the TIF straight from the microscope.
"""


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cell-counter-build"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def asset_urls():
    """Map pbs triple -> install_only tarball URL from the latest release."""
    rel = fetch_json(API)
    assets = rel["assets"]
    page = 2
    while True:  # release has ~800 assets; page through until a short page
        more = fetch_json(f"{rel['url']}/assets?per_page=100&page={page}")
        if not more:
            break
        assets += more
        if len(more) < 100:
            break
        page += 1
    pat = re.compile(rf"^cpython-{re.escape(PYV)}\.\d+\+\d+-(.+)-install_only\.tar\.gz$")
    urls = {}
    for a in assets:
        m = pat.match(a["name"])
        if m:
            urls[m.group(1)] = {"url": a["browser_download_url"], "digest": a.get("digest")}
    if not urls:
        sys.exit(f"no CPython {PYV} install_only assets in {rel['tag_name']}")
    print(f"python-build-standalone {rel['tag_name']}")
    return urls


def download(url, dest, digest=None):
    """Download url to dest. When digest (the GitHub release asset's
    "sha256:<hex>" digest field) is given, verify it and fail loudly on a
    mismatch — a corrupted or substituted python-build-standalone tarball
    must not be silently unpacked onto the build machine. Older API
    responses that omit the field are not treated as an error."""
    if dest.exists():
        if digest:
            _verify_digest(dest, digest)
        return dest
    print(f"  downloading {dest.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "cell-counter-build"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    if digest:
        _verify_digest(dest, digest)
    return dest


def _verify_digest(path, digest):
    algo, _, want = digest.partition(":")
    if algo != "sha256" or not want:
        sys.exit(f"{path.name}: unrecognized digest format {digest!r}")
    got = hashlib.sha256(path.read_bytes()).hexdigest()
    if got != want:
        path.unlink(missing_ok=True)
        sys.exit(f"{path.name}: sha256 mismatch (expected {want}, got {got}) "
                  f"- download is corrupted or was tampered with, refusing to extract it")


def untar(tgz, dest):
    """Extract, recording modes and symlinks instead of creating them.

    Windows cannot make the runtime's symlinks without developer mode, and
    materialising them as copies would double the size, so they are carried in
    a manifest and written straight into the zip later.
    """
    meta = {"modes": {}, "links": {}}
    if dest.exists():
        shutil.rmtree(dest)
    dest_root = dest.resolve()
    with tarfile.open(tgz) as tf:
        for m in tf:
            if not m.name.startswith("python/"):
                continue
            rel = m.name[len("python/"):]
            if not rel:
                continue
            out = dest / rel
            # Tar-slip guard: a member name with ".." components (or an
            # absolute path) can resolve outside dest even though it looked
            # like a relative path under "python/". Reject before any write.
            resolved = (dest / rel).resolve()
            if resolved != dest_root and dest_root not in resolved.parents:
                sys.exit(f"{tgz.name}: member {m.name!r} resolves outside "
                          f"the extraction directory ({resolved}) - refusing to extract it")
            if m.issym() or m.islnk():
                # zip_stage later writes this linkname verbatim into the
                # release zip as a real symlink (S_IFLNK external_attr), which
                # the lab user's OS materialises on unzip. A target that
                # escapes the extraction root is therefore the same tar-slip
                # threat as a bad member name, just realised on the end user's
                # machine instead of the build machine. Resolve relative to
                # the link's own directory (out.parent), not dest_root, so
                # ordinary in-tree relative links (python3.11, ../Python) stay
                # legal.
                if pathlib.PurePosixPath(m.linkname).is_absolute():
                    sys.exit(f"{tgz.name}: member {m.name!r} links to absolute "
                              f"path {m.linkname!r} - refusing to extract it")
                link_target = (out.parent / m.linkname).resolve()
                if link_target != dest_root and dest_root not in link_target.parents:
                    sys.exit(f"{tgz.name}: member {m.name!r} links to {m.linkname!r} "
                              f"which resolves outside the extraction directory "
                              f"({link_target}) - refusing to extract it")
                meta["links"][rel] = m.linkname
            elif m.isdir():
                out.mkdir(parents=True, exist_ok=True)
            elif m.isfile():
                out.parent.mkdir(parents=True, exist_ok=True)
                with tf.extractfile(m) as src, open(out, "wb") as f:
                    shutil.copyfileobj(src, f)
                meta["modes"][rel] = m.mode
    return meta


# onnxruntime dropped Intel-mac wheels after 1.23.2 (checked on PyPI 2026-09-05:
# 1.24.0 onwards publish macosx arm64 only). The shipped weights are opset 17 /
# IR 8, which 1.23.2 runs, so the Intel-mac runtime alone gets that older pin.
INTEL_MAC_ORT = "onnxruntime==1.23.2"


def requirements_for(platforms):
    """The pinned requirements file, with the Intel-mac onnxruntime swap applied."""
    req = ROOT / "requirements.txt"
    if "macosx_13_0_x86_64" not in platforms:
        return req
    text = re.sub(r"^onnxruntime==\S+", INTEL_MAC_ORT, req.read_text(), flags=re.M)
    out = BUILD / "requirements-mac-x86_64.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    return out


def pip_install(sitepkgs, platforms):
    cmd = [sys.executable, "-m", "pip", "install",
           "-r", str(requirements_for(platforms)),
           "--target", str(sitepkgs), "--upgrade",
           "--only-binary=:all:", "--python-version", PYV,
           # pip would byte-compile with the *building* interpreter, and that
           # bytecode is unloadable in the bundled 3.12 (123 MB of it, measured).
           "--no-compile"]
    for p in platforms:
        cmd += ["--platform", p]
    print(f"  pip -> {sitepkgs.relative_to(BUILD)}")
    subprocess.run(cmd, check=True)


def build_runtime(name, triple, platforms, stage, urls, cache):
    if triple not in urls:
        sys.exit(f"no pbs build for {triple}")
    asset = urls[triple]
    tgz = download(asset["url"], cache / f"{triple}.tar.gz", digest=asset.get("digest"))
    rt = stage / name
    meta = untar(tgz, rt)
    win = "windows" in triple
    sitepkgs = rt / ("Lib/site-packages" if win else f"lib/python{PYV}/site-packages")
    pip_install(sitepkgs, platforms)
    prune(rt, meta, sitepkgs, SITE_PRUNE + ([] if win else MAC_SITE_PRUNE))
    return meta


def prune(rt, meta, sitepkgs, site_pats):
    """Drop what a shipped runtime never uses, then drop the manifest entries
    for files that are now gone and the symlinks left dangling."""
    def rm(hit):
        shutil.rmtree(hit) if hit.is_dir() else hit.unlink()
    for pat in PRUNE:
        for base in (rt, rt / "lib", rt / f"lib/python{PYV}",
                     rt / f"lib/python{PYV}/lib-dynload", rt / "Lib", rt / "DLLs"):
            for hit in (base.glob(pat) if base.exists() else []):
                rm(hit)
    for pat in BIN_PRUNE:
        for hit in (rt / "bin").glob(pat):
            rm(hit)
    for pat in site_pats:
        for hit in sitepkgs.glob(pat):
            rm(hit)
    for f in [f for f in sitepkgs.rglob("*") if f.is_file() and f.suffix in SITE_PRUNE_SUFFIXES]:
        f.unlink()
    for hit in [d for d in sitepkgs.rglob("*") if d.is_dir() and d.name in ("tests", "test")]:
        if hit.exists():
            rm(hit)
    meta["modes"] = {k: v for k, v in meta["modes"].items() if (rt / k).exists()}
    meta["links"] = {k: v for k, v in meta["links"].items()
                     if ((rt / k).parent / v).exists()}


# Explorer's Extract All silently drops files whose full path passes 260 chars.
# 150 inside the zip leaves 110 for the folder a user extracts into (a long
# OneDrive or network path). Longest entry at v1.1: 132 (mac), 118 (Windows).
MAX_ZIP_PATH = 150


def zip_stage(stage, metas, zip_path, exec_names, top="Cell Counter"):
    """Write the zip by hand: Python's shutil.make_archive drops the unix exec
    bit and symlinks, and without those the mac bundle will not launch.
    `top` is the folder the user sees after unzipping; the zip's own name is
    kept space-free so the README can link straight to it."""
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rtname, meta in metas.items():
            for rel, target in meta["links"].items():
                zi = zipfile.ZipInfo(f"{top}/{rtname}/{rel}")
                zi.create_system = 3  # unix
                zi.external_attr = (stat.S_IFLNK | 0o777) << 16
                z.writestr(zi, target)
        for path in sorted(stage.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(stage).as_posix()
            if len(f"{top}/{rel}") > MAX_ZIP_PATH:
                sys.exit(f"zip path over {MAX_ZIP_PATH} chars, Explorer may drop it: {top}/{rel}")
            rtname = rel.split("/", 1)[0]
            mode = metas.get(rtname, {}).get("modes", {}).get(
                rel.split("/", 1)[1] if "/" in rel else "", None)
            if mode is None:
                mode = 0o755 if path.name in exec_names else 0o644
            zi = zipfile.ZipInfo(f"{top}/{rel}", date_time=(2026, 1, 1, 0, 0, 0))
            zi.create_system = 3
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = ((stat.S_IFREG | mode) & 0xFFFF) << 16
            z.writestr(zi, path.read_bytes())
    return zip_path


def stage_payload(stage):
    for item in PAYLOAD:
        src = ROOT / item
        dst = stage / item
        if src.is_dir():
            shutil.copytree(src, dst, ignore=PAYLOAD_IGNORE)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def build(which, urls, cache):
    stage = BUILD / f"stage-{which}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    stage_payload(stage)

    metas = {}
    for name, triple, platforms in TARGETS[which]:
        metas[name] = build_runtime(name, triple, platforms, stage, urls, cache)

    if which == "mac":
        (stage / "Start Cell Counter.command").write_text(MAC_LAUNCHER, newline="\n")
        (stage / "READ ME FIRST.txt").write_text(MAC_README + USING, newline="\n")
        exec_names = {"Start Cell Counter.command"}
    else:
        (stage / "Start Cell Counter.bat").write_text(WIN_LAUNCHER, newline="\r\n")
        (stage / "READ ME FIRST.txt").write_text(WIN_README + USING, newline="\r\n")
        exec_names = set()

    out = zip_stage(stage, metas, OUT / ZIP_NAME[which], exec_names)
    print(f"  {out}  {out.stat().st_size / 1e6:.0f} MB\n")


def main():
    if not (ROOT / "static" / "dist" / "index.html").exists():
        sys.exit("static/dist is missing - run `cd web && npm run build` first")
    wanted = sys.argv[1:] or list(TARGETS)
    urls = asset_urls()
    cache = BUILD / "cpython"
    for which in wanted:
        if which not in TARGETS:
            sys.exit(f"unknown target {which}; pick from {list(TARGETS)}")
        print(f"{which}:")
        build(which, urls, cache)


if __name__ == "__main__":
    main()
