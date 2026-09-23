"""Cell Counter - local web app. Run: python app.py (opens browser)."""
import base64
import contextlib
import ctypes
import hashlib
import json
import os
import pathlib
import socket
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from imaging import stretch as _stretch
import pipeline

app = FastAPI(title="Cell Counter")

# Counts run in a small fixed number of SLOTS, decided once per machine.
# Measured 2026-09-22 on all 69 data/tif tiles (docs/speed-report-2026-09-21.md):
# two concurrent counts are bit-identical and finish sooner - Quick 0.73 -> 0.53,
# Normal 1.62 -> 1.29, Finest 11.97 -> 9.66 s/img - while three are no better
# than two. This replaces the 2026-09-05 claim that concurrent runs "do not
# finish sooner", which was never measured and is contradicted above. Two slots
# roughly double peak memory, so a machine below TWO_SLOT_MIN_RAM_GB of TOTAL
# RAM gets one. The decision is made on first launch and remembered (owner
# ruling): total RAM does not change between runs. Delete the file to re-decide.
TWO_SLOT_MIN_RAM_GB = 7           # ceil(peak(level 3, x2) + 4) = ceil(2.19 + 4), measured
                                   # 2026-09-22 on this machine via tools/measure_memory.py:
                                   # L1 x1 0.98, x2 1.75; L2 x1 1.01, x2 1.84; L3 x1 1.16, x2 2.19 GB.
_MACHINE_FILE = os.path.join(os.path.expanduser("~"), ".cell-counter", "machine.json")


def _total_ram_gb():
    if os.name == "nt":
        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MS(); m.dwLength = ctypes.sizeof(m)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullTotalPhys / 1e9
    return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9


def _machine_slots():
    try:
        with open(_MACHINE_FILE) as f:
            return int(json.load(f)["count_slots"])
    except (OSError, ValueError, KeyError):
        pass
    ram, cpus = _total_ram_gb(), os.cpu_count() or 1
    slots = 2 if ram >= TWO_SLOT_MIN_RAM_GB and cpus >= 4 else 1
    try:
        os.makedirs(os.path.dirname(_MACHINE_FILE), exist_ok=True)
        with open(_MACHINE_FILE, "w") as f:
            json.dump({"count_slots": slots, "ram_gb": round(ram, 1), "cpus": cpus,
                       "decided": time.strftime("%Y-%m-%d")}, f)
    except OSError:
        pass                      # read-only home: decide again next launch, same answer
    return slots


COUNT_SLOTS = _machine_slots()
_SLOTS = threading.BoundedSemaphore(COUNT_SLOTS)
_DRAIN_LOCK = threading.Lock()    # serialises whole-budget takers, so two sweeps cannot each hold half
_running = 0
_RUNNING_LOCK = threading.Lock()


@contextlib.contextmanager
def _count_slot():
    """One count's slot. Plain `def` handlers run in FastAPI's threadpool, so a
    count past the budget waits here, not on the event loop."""
    global _running
    _SLOTS.acquire()
    with _RUNNING_LOCK:
        _running += 1
    try:
        yield
    finally:
        with _RUNNING_LOCK:
            _running -= 1
        _SLOTS.release()


@contextlib.contextmanager
def _all_slots():
    """Every slot - the pairing sweep runs alone, as it always has."""
    with _DRAIN_LOCK:
        for _ in range(COUNT_SLOTS):
            _SLOTS.acquire()
        try:
            yield
        finally:
            for _ in range(COUNT_SLOTS):
                _SLOTS.release()


def _slots_free():
    return _SLOTS._value

# How far a running overlap sweep has got. /api/pairs answers once, at the end,
# and a cold comparison costs ~64 ms (pipeline.group_captures) - so a drop of
# twenty captures is 12 s in which the browser has nothing to show but a
# spinner, and no way to tell a working sweep from a hung one. The client names
# its run with a `job` id, group_captures reports into here as it goes, and
# GET /api/sweep/{job} reads it back. This is deliberately NOT behind any
# count slot: answering while a sweep holds every slot is the entire point.
_SWEEP_LOCK = threading.Lock()
_SWEEP = OrderedDict()          # job -> [done, total, updated_at]
# An abandoned tab never collects its own entry, so the registry is bounded
# both ways: oldest out past 32 live sweeps, and nothing kept past a quarter of
# an hour. Each entry is three numbers, so the cap is about memory discipline
# rather than memory.
_SWEEP_MAX = 32
_SWEEP_TTL = 15 * 60

# A capture larger than this is refused rather than run: a 6000x6000 PNG ran
# over 30 minutes with no way to stop it. An EVOS 10x tile is 1.4 MP and a
# stitched pair 2.8 MP, so this is 8x the biggest thing the app is for.
MAX_PIXELS = 12_000_000

# An upload larger than this is refused before it is ever decoded. Checked
# against UploadFile.size, which starlette's multipart parser has already
# filled in by the time the handler runs (it streams each part into a
# SpooledTemporaryFile as it arrives), so this costs no extra read. Without
# it, a 2 GB file or a 200 MP PNG reaches cv2.imdecode - and OOMs the process -
# before MAX_PIXELS is ever consulted. 64 MiB comfortably covers an EVOS TIF
# (1.4 MP x 16-bit is under 3 MB) with headroom for a very large PNG export.
MAX_BYTES = 64 * 1024 * 1024

# Uploads per request. /api/pairs runs group_captures, which is O(n^2) and
# calls the whole of stitch_pair per candidate under every count slot
# (`_all_slots`) - 60 dropped files is 1770 stitches with the server
# unresponsive to everything else for minutes. /api/count's request is always
# one field: a
# lone capture, or exactly a pair to stitch - a third upload can only be a
# mistake.
MAX_IMAGES = {"count": 2, "pairs": 64, "thumbs": 64}


# The confirm screen draws these at about 120 css px; 256 covers a 2x display
# and keeps a whole batch of previews to a few hundred KB.
THUMB_PX = 256


class _BytesLRU:
    """Content-hash-keyed cache bounded by total value size in bytes, not entry
    count. `functools.lru_cache` cannot do this job: it bounds by call count,
    which gives no memory guarantee when one entry (a 16-bit stitched pair) can
    be 20x the size of another (an 8-bit thumbnail-sized decode), and it would
    have to be keyed on the raw upload bytes themselves - holding every upload
    alive as its own cache key. This holds only a hash of the bytes as the key
    and evicts the least-recently-used entry until a new one fits, so a batch
    that has scrolled out of use is reclaimed regardless of how many requests
    came between.

    Not safe for concurrent writers *between* processes (it is plain in-process
    memory), but is safe under concurrent requests within this one: every
    method takes `_lock` for its whole body, so a get/put from one thread
    cannot interleave with another's. It takes no other lock and is never held
    across a call into pipeline.py, so it cannot deadlock against a count
    slot (`_count_slot`/`_all_slots`) in either acquisition order.
    """

    def __init__(self, max_bytes, size_fn):
        self._max_bytes = max_bytes
        self._size_fn = size_fn
        self._data = OrderedDict()   # hash -> value, oldest-used first
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            if key not in self._data:
                return None, False
            self._data.move_to_end(key)
            return self._data[key], True

    def put(self, key, value):
        with self._lock:
            if key in self._data:
                self._bytes -= self._size_fn(self._data[key])
                del self._data[key]
            self._data[key] = value
            self._bytes += self._size_fn(value)
            while self._bytes > self._max_bytes and self._data:
                _, old = self._data.popitem(last=False)
                self._bytes -= self._size_fn(old)

    def clear(self):
        with self._lock:
            self._data.clear()
            self._bytes = 0


class _ImageStore:
    """Short-lived, byte-bounded store for field images served by id from
    GET /api/image/{id} (audit-backend.md #11): the old shape inlined every
    base_image/stage image/pair preview as
    data:image/jpeg;base64,... in the JSON response, so a 20-file batch was
    hundreds of MB of base64 held in memory and in the browser at once. This
    holds only the encoded JPEG bytes, keyed by an id, and the response now
    carries a short path instead.

    Ids are a per-process monotonic counter taken under `_lock` - never
    reused while the server runs, so they cannot collide with each other, and
    meaningless (and never reused) after a restart. This app is offline and
    single-user on 127.0.0.1, so the ids need not be unguessable for secrecy,
    only collision-free, which a counter already guarantees more simply than
    a random id would.

    Bounded one way: `max_bytes` evicts the least-recently-issued payload
    once the encoded JPEGs exceed it - the same LRU-by-size shape as
    _BytesLRU above, but keyed on an issued id, not a content hash: two
    identical-looking previews from two different fields are two different
    ids on purpose, one per response. There is no time-based expiry - a tab
    left open past any particular duration must still be able to export, so
    only memory pressure ever removes an id (a wall-clock TTL here broke
    export, which re-fetches base_image at export time, not count time).

    `_issued` (id -> None, no payload) is kept separately from `_payload`
    (id -> bytes) and is never swept - only `put` ever removes from
    `_payload`, under size pressure, so an id whose bytes were evicted early
    for space is still told "expired" rather than the wrong "unknown" - see
    `get`. Both dicts are insertion-ordered by id.
    """

    def __init__(self, max_bytes):
        self._max_bytes = max_bytes
        self._payload = OrderedDict()   # id -> jpeg bytes, oldest-issued first
        self._issued = OrderedDict()    # id -> None, oldest-issued first
        self._bytes = 0
        self._next_id = 0
        self._lock = threading.Lock()

    def put(self, data):
        with self._lock:
            image_id = str(self._next_id)
            self._next_id += 1
            self._issued[image_id] = None
            self._payload[image_id] = data
            self._bytes += len(data)
            while self._bytes > self._max_bytes and self._payload:
                _, old = self._payload.popitem(last=False)
                self._bytes -= len(old)
            return image_id

    def get(self, image_id):
        """Returns the JPEG bytes, or "unknown"/"expired" for the two 404s."""
        with self._lock:
            if image_id not in self._issued:
                return "unknown"
            data = self._payload.get(image_id)
            return data if data is not None else "expired"

    def clear(self):
        """Forget every image, issued ids included.

        Called by POST /api/reset when a page load begins or a tab goes away:
        the browser has just thrown away every count these images belonged to,
        so holding their bytes is holding a previous session's work in memory.
        `_issued` is cleared too - an id from before the reset is not "expired"
        (which tells the user to re-run a count that no longer exists), it is
        unknown, because the session that issued it is gone.
        """
        with self._lock:
            self._payload.clear()
            self._issued.clear()
            self._bytes = 0


# 128 MiB comfortably holds a full MAX_IMAGES["pairs"] batch's worth of
# preview JPGs, or a MAX_IMAGES["count"]-sized field's base + 9 stage
# JPGs many times over, with headroom for a slower browser lagging behind a
# fast batch. No TTL: a tab left open for hours must still be able to
# export the count it made (export re-fetches these images), so only the
# byte bound below ever reclaims memory.
#
# One of three independent byte-bounded caches (see _DECODE_CACHE below and
# pipeline._STITCH_CACHE): this 128 MiB plus the other two's 256 MiB each sum
# to 640 MiB of steady-state cache at once, on top of live request data. Each
# bound is justified in isolation; raising any one of the three should
# reconsider the total.
_IMAGE_STORE = _ImageStore(128 * 1024 * 1024)


def _hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _decode_cache_size(entry):
    tag = entry[0]
    return entry[1].nbytes if tag == "ok" else 0


# Bounds the decoded-raw-image cache (pre-stretch, the expensive cv2.imdecode
# result), keyed by a sha256 of the exact upload bytes - never the filename,
# size or upload order, so a renamed or reordered file still hits and a
# genuinely different file never collides. 256 MiB comfortably holds a full
# MAX_IMAGES["pairs"] batch of EVOS 10x tiles (1360x1024, up to 16-bit ->
# under 2.8 MB decoded each, 64 of them ~ 180 MB) with headroom, while still
# bounding memory the way an entry-count cache cannot.
#
# One of three independent byte-bounded caches (see _IMAGE_STORE above and
# pipeline._STITCH_CACHE): this 256 MiB plus the other two (128 MiB + 256 MiB)
# sum to 640 MiB of steady-state cache at once, on top of live request data.
# Each bound is justified in isolation; raising any one of the three should
# reconsider the total.
_DECODE_CACHE = _BytesLRU(256 * 1024 * 1024, _decode_cache_size)


def _error(msg, status=400):
    return JSONResponse({"error": msg}, status_code=status)


def _check_pixels(w, h, label):
    """None if (w, h) is within MAX_PIXELS, else a message a non-programmer can
    read. One rule, shared by _decode_raw (per upload) and api_count (on the
    stitched field a pair of uploads becomes - two captures each just under
    the cap stitch into a field about twice as tall, which was never checked)."""
    if h * w > MAX_PIXELS:
        return (f"{label} is {w} x {h} pixels, which is too large to count "
                f"(the limit is {MAX_PIXELS // 1_000_000} megapixels). Crop it to "
                "the ruled area of the slide, or save it at a smaller size.")
    return None


_ENDPOINT_LABEL = {"count": "count", "pairs": "compare at once", "thumbs": "preview at once"}


def _check_uploads(images, kind):
    """None if the batch is within MAX_IMAGES/MAX_BYTES for `kind`, else a
    message a non-programmer can read. Runs before _decode_all, so an
    oversized or over-numerous batch never reaches cv2.imdecode. Same sentence
    style as _check_pixels."""
    limit = MAX_IMAGES[kind]
    if len(images) > limit:
        return (f"{len(images)} files were uploaded, which is too many to "
                f"{_ENDPOINT_LABEL[kind]} (the limit is {limit}). Send fewer "
                "files at a time.")
    for up in images:
        size = up.size
        if size is None:
            # Older/other ASGI servers may not fill this in; fall back to a
            # read, which _decode_all would have done anyway.
            data = up.file.read()
            size = len(data)
            up.file.seek(0)
        if size > MAX_BYTES:
            return (f"{up.filename} is {size / (1024 * 1024):.0f} MB, which is "
                    f"too large to count (the limit is {MAX_BYTES // (1024 * 1024)} "
                    "MB). Save it at a smaller size.")
    return None


def _decode_raw(data, filename):
    """Decode an upload as it was stored. Returns (image, error message or None).

    IMREAD_UNCHANGED, not IMREAD_COLOR: a 16-bit TIF read as COLOR keeps only
    the high byte, so 12-bit EVOS data (values 0-4095, i.e. high byte 0-15)
    arrives almost black and counts 0 with a cheerful HTTP 200. Read it as it
    is and stretch the real range down to 8 bits instead (see _stretch).

    Cached by a sha256 of `data` itself (_DECODE_CACHE): /api/thumbs,
    /api/pairs and /api/count each used to run this - including
    _check_pixels - from scratch for the same upload bytes, up to three times
    per batch (audit-backend.md #10). The cached entry is tagged ("ok", im),
    ("unreadable",) or ("too_big", w, h) rather than a ready-made message,
    because the message names `filename` - two uploads with identical bytes
    but different names (a duplicate drag, or the same file restaged under a
    new name) must each get their own name in their own error, not whichever
    name decoded first.

    The ("ok", im) entry hands out the same numpy array object to every
    caller that hits the cache for this key - it is never copied on the way
    out. That is safe only because every current reader treats it as
    read-only: _stretch returns it unchanged for 8-bit 3-channel input,
    count_cells never writes through `img` (only reads it, and returns it by
    identity as "image", and _count_field no longer copies it because it no
    longer draws anything on it). Any future code that draws onto this array
    would corrupt it for every other request that shares the same upload
    bytes - so treat the returned array as shared and immutable: copy it
    before writing.
    """
    key = _hash_bytes(data)
    cached, hit = _DECODE_CACHE.get(key)
    if not hit:
        # An empty upload (a 0-byte file, or a drag that failed mid-transfer)
        # makes cv2.imdecode raise cv2.error rather than return None like every
        # other unreadable buffer - so it must be caught before imdecode, not
        # treated as "just another garbage byte string" (audit-backend.md #25).
        im = None if len(data) == 0 else cv2.imdecode(
            np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
        if im is None:
            cached = ("unreadable",)
        else:
            if im.ndim == 3 and im.shape[2] == 4:
                im = cv2.cvtColor(im, cv2.COLOR_BGRA2BGR)
            h, w = im.shape[:2]
            cached = ("too_big", w, h) if h * w > MAX_PIXELS else ("ok", im)
        _DECODE_CACHE.put(key, cached)

    tag = cached[0]
    if tag == "unreadable":
        return None, f"Could not read {filename}."
    if tag == "too_big":
        return None, _check_pixels(cached[1], cached[2], filename)
    return cached[1], None


def _decode_all(images, share=True):
    """Decode every upload of one request. Returns ([(name, bgr)], error or None).

    RULE: the deep-input stretch is per image everywhere, shared only within
    the two halves of one stitched pair. MAX_IMAGES["count"] = 2 makes that
    guarantee structural, not incidental: api_count's request already IS one
    field - a lone capture, or exactly a pair, never more - so `share=True`
    (the default) can never end up spanning a whole batch. That cap is
    enforced, and proven, at the API boundary in `_check_uploads` before
    `_decode_all` ever runs (see test_a_third_image_is_refused_before_any_decode).
    `share=True` gives a lone capture its own range for free and, for a
    pair, shares it: per image there, the two halves of a stitched 16-bit
    pair would get different
    scalings, which puts a brightness step at the seam, hands _overlap_ncc /
    _estimate_rotation_deg two differently contrasted images to line up, and
    gives the ML `norm` channel a different effective gain on each side of the
    field. /api/thumbs and /api/pairs instead decode a whole BATCH in one
    request - not one field - so they pass `share=False`: sharing the batch's
    range would normalise a thumbnail, or a merge preview, differently than the
    single image (or single pair) api_count will actually stretch once the
    user presses Count. uint8 input has no stretch to share either way, so it
    is untouched.
    """
    # Uploads are read here, in order, on the request thread; only the decode
    # goes to the pool (cv2.imdecode releases the GIL). 2026-09-22: 69 captures
    # 0.509 -> 0.129 s, arrays identical. ex.map yields in upload order, so the
    # error returned is still the FIRST bad upload's, exactly as the serial loop.
    datas = [(up.filename, up.file.read()) for up in images]
    raw = []
    with ThreadPoolExecutor(max(1, min(8, len(datas)))) as ex:
        for (name, _), (im, err) in zip(datas, ex.map(lambda nd: _decode_raw(nd[1], nd[0]), datas)):
            if err:
                return None, err
            raw.append((name, im))
    if not share:
        return [(n, _stretch(im)) for n, im in raw], None
    deep = [im for _, im in raw if im.dtype != np.uint8]
    rng = None
    if deep:
        rng = (min(float(im.min()) for im in deep), max(float(im.max()) for im in deep))
    return [(n, _stretch(im, rng)) for n, im in raw], None


def _disconnected(request):
    """True if the browser has already gone away.

    request.is_disconnected() is a coroutine and these handlers are plain `def`
    running in the threadpool, so it is called back on the event loop through
    the anyio portal that put us there. Anything unexpected (no portal, an
    older starlette) answers "still connected": a false abort would throw away
    a good count, while a missed one only costs what the old code always cost.
    """
    try:
        import anyio.from_thread
        return bool(anyio.from_thread.run(request.is_disconnected))
    except Exception:      # noqa: BLE001
        return False


def _aborted():
    # 499 is nginx's "client closed request". Nobody is listening for this body;
    # it exists so the console and the tests can tell an abort from a refusal.
    return JSONResponse({"error": "The count was cancelled."}, status_code=499)


def _stitched_bgr(gray, names):
    """BGR image for an already-stitched field, or raise ValueError if it now
    exceeds the pixel cap - two captures each just under the cap stitch into a
    field about twice as tall, which _decode_raw (checked per upload) never
    saw. Shared by api_count's confirmed-pair branch and its group_captures
    branch so the check-then-convert sequence, and the message naming the two
    captures, cannot drift between them."""
    sh, sw = gray.shape[:2]
    px_err = _check_pixels(sw, sh, f"The field stitched from {names[0]} and {names[1]}")
    if px_err:
        raise ValueError(px_err)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def _b64_jpg(bgr, quality=88):
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Could not encode the image.")
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode()


def _store_jpg(bgr, quality=88):
    """Encode to JPEG, put it in `_IMAGE_STORE`, and return the path the
    browser fetches it from - `/api/image/<id>`, not an inlined data URL. Used
    for base_image, stage images and pair previews
    (audit-backend.md #11); `/api/thumbs` is already small and keeps
    `_b64_jpg` inline."""
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Could not encode the image.")
    image_id = _IMAGE_STORE.put(buf.tobytes())
    return f"/api/image/{image_id}"


@app.get("/api/params")
def api_params():
    # The UI shows none of PARAMS/GROUPS since the tuning sliders were deleted
    # (2026-09-04) and never maps them back; `version` is the only thing a
    # client reads, to know a stale server from a fresh one. `count_slots` is
    # this machine's decision (see COUNT_SLOTS), read by the client to decide
    # whether to run counts within a batch concurrently.
    return {"version": pipeline.VERSION, "count_slots": COUNT_SLOTS}


def _count_field(bgr, params, autocrop, want_stages, names, stitch, pre_M=None,
                 on_progress=None, on_encode=None):
    """Count one field - a discovered overlapping pair, or a lone capture.

    pre_M: 3x3 perspective matrix already applied to `bgr` (a user quad crop),
    composed with any autocrop offset into the returned `transform` so the
    browser can map original-image coordinates onto the displayed image.
    """
    stage_imgs = {} if want_stages else None
    # Models side by side only where it measured faster (2026-09-22): Finest
    # always, other levels only when this is the one count running - at Normal
    # with two counts in flight it measured slower (1.42 -> 1.48 s/img).
    with _RUNNING_LOCK:
        solo = _running == 1
    ml_parallel = int(params.get("level") or 0) == 3 or solo
    # require_grid: a capture with no ruled line in it is refused by the engine
    # rather than answered with a zero-area frame, grid_cols/rows 0 and a count.
    r = pipeline.count_cells(bgr, params, autocrop=autocrop, stages=stage_imgs,
                             require_grid=True, on_progress=on_progress,
                             ml_parallel=ml_parallel)
    # Step 10 of ten, and the handler's own: everything below this line encodes
    # JPEGs, which is real time the user is waiting through.
    if on_encode is not None:
        on_encode()
    ox, oy = r["offset"]
    T = np.array([[1.0, 0.0, -ox], [0.0, 1.0, -oy], [0.0, 0.0, 1.0]])
    M = T if pre_M is None else T @ np.asarray(pre_M, dtype=float)

    # Nothing is drawn on the capture here. The cells are returned as `centers`
    # and drawn by the browser, which is what lets the user click one to remove
    # it or click empty space to add one; grid lines and the triple frame are
    # drawn on the same canvas from grid_x/grid_y/frame, so they stay crisp and
    # follow the theme.
    base = r["image"]

    squares = [{"col": c, "row": rw, "count": n}
               for (c, rw), n in sorted(r["squares"].items())]
    stage_list = []
    for key in sorted(stage_imgs or {}):
        num, group, name = key.split("|")
        im = stage_imgs[key]
        if im.shape[1] > 1400:  # keep the tuning loop snappy
            s = 1400 / im.shape[1]
            im = cv2.resize(im, (0, 0), fx=s, fy=s, interpolation=cv2.INTER_AREA)
        stage_list.append({"n": num, "group": group, "name": name,
                           "image": _store_jpg(im, quality=78)})
    return {
        "names": names,
        "count": r["count"],
        # The displayed field's own pixel size. The browser needs it to know
        # which hand-edited points are still on screen without waiting for
        # base_image to decode - the gallery draws no image at all, and its
        # count badge must agree with the edit view's total to the cell.
        "width": base.shape[1],
        "height": base.shape[0],
        "centers": r["centers"],
        "grid_x": r["grid_x"],
        "grid_y": r["grid_y"],
        "diameter": r["params"]["diameter"],
        # The quality level this field was actually counted at, so the gallery
        # can mark which images a Reprocess would pick up without recomputing
        # anything client-side. 0 means the caller sent raw engine params.
        "level": int(r["params"]["level"]),
        "grid_cols": max(0, len(r["grid_x"]) - 1),
        "grid_rows": max(0, len(r["grid_y"]) - 1),
        "squares": squares,
        "frame": r["frame"],
        "transform": [[round(v, 8) for v in row] for row in M.tolist()],
        "base_image": _store_jpg(base),
        "stages": stage_list,
        "stitch": stitch,
    }


@app.post("/api/count")
def api_count(
    request: Request,
    images: list[UploadFile] = File(...),
    params: str = Form("{}"),
    autocrop: str = Form(""),
    quad: str = Form(""),
    stages: bool = Form(False),
    # Set when the client already knows these two captures are one field - a
    # manual pair or an overlap the review screen's board confirmed. A hand-made
    # group is a claim the run must answer (project rule): re-deriving grouping
    # from the pixels here, as the plain path below does, would silently split
    # the pair into two fields the moment stitch_pair's own gates refuse the
    # seam, with no message at all. Optional: absent, today's group_captures
    # behaviour is untouched.
    pair: bool = Form(False),
    # A progress ticket the CLIENT mints, so it can poll GET /api/progress/{token}
    # while this request is in flight. Optional: a request without one counts
    # exactly as before and reports nothing.
    token: str = Form(""),
):
    # Deferred like pipeline.py's own `import ml.infer` (see its comment at the
    # ML branch): module scope would pull onnxruntime in at server startup, so
    # a broken onnxruntime install would fail the launch instead of the count.
    # This import itself must never raise, even though every UI rung is now an
    # ML rung: a level-0 in-process caller never touches ml.infer. If onnxruntime
    # cannot be imported, fall back to a plain exception class so the name is
    # always bound and the `except (ValueError, WeightsMissing)` below stays
    # inside the try block that owns the JSON error handling, instead of
    # letting an ImportError escape as a bare framework 500.
    try:
        from ml.infer import WeightsMissing
    except ImportError:                      # onnxruntime absent: nothing can raise it
        class WeightsMissing(FileNotFoundError):
            pass

    err = _check_uploads(images, "count")
    if err:
        return _error(err, status=422)
    raw, err = _decode_all(images)
    if err:
        return _error(err)
    if not raw:
        return _error("No image was sent.")

    quad_M = None
    if quad:
        if len(raw) > 1:
            return _error("A skewed crop applies to a single capture.")
        try:
            quad_val = json.loads(quad)
        except ValueError:
            return _error("Malformed quad.")
        try:
            raw = [(raw[0][0], pipeline.warp_quad(raw[0][1], quad_val))]
            quad_M, _ = pipeline.quad_matrix(quad_val)
        except ValueError as e:
            return _error(str(e))
        autocrop = ""          # the user has already chosen the area

    try:
        p = json.loads(params)
    except ValueError:
        return _error("Malformed params.")
    if not isinstance(p, dict):
        return _error("Malformed params.")

    # Quality level is checked HERE, at the API boundary, and never inside
    # pipeline.py: the offline harness (score.py, ml/loo.py) calls count_cells
    # in-process and depends on level 0, the "use the raw engine params exactly
    # as passed" contract, which is a different detector engine than any UI
    # rung. Over HTTP level 0 is unreachable by design, and a hand-edited or
    # cross-version saved session can send any integer at all, so a request
    # outside 1..3 is refused rather than silently clamped onto some other rung.
    if "level" in p:
        lv = p["level"]
        ok = isinstance(lv, int) and not isinstance(lv, bool)
        if not ok and isinstance(lv, float) and lv.is_integer():
            lv, ok = int(lv), True
        if not ok or not 1 <= lv <= 3:
            return _error("Quality level must be 1 to 3.", status=422)

    # Only "frame" means anything to the pipeline (pipeline.py's autocrop
    # handling); any other value, including an older client's "auto" or a
    # typo, used to be silently treated as "no crop" with no sign anything
    # was ignored. Refused the same way an out-of-range level is.
    if autocrop not in ("", "frame"):
        return _error(
            'Autocrop value "%s" is not recognized. Use "frame" or leave it '
            "blank." % autocrop, status=422)

    # An abandoned tab must not queue behind, and then burn, a whole count.
    # Checked before the wait for the lock (where an aborted request used to sit
    # holding a place) and again inside it, before each expensive call.
    if _disconnected(request):
        return _aborted()

    global _WAITING
    level = int(p.get("level") or 0)
    if token:
        # Say WAITING, not 0 %, while this sits behind another count: a batch
        # runs COUNT_SLOTS at a time, so any field past that many is queued,
        # and a bar drawn for a queued card is indistinguishable from a hang.
        with _WAITING_LOCK:
            _WAITING += 1
            position = _WAITING
        _PROGRESS.queued(token, position)

    # Waits for a free count slot; see COUNT_SLOTS/_count_slot.
    with _count_slot():
        if token:
            with _WAITING_LOCK:
                _WAITING -= 1
        if _disconnected(request):
            if token:
                _PROGRESS.done(token, "failed")
            return _aborted()
        try:
            # Step 1 of ten: the capture is in hand and being prepared. The
            # remaining nine are reported from inside count_cells, except the
            # last, which is this handler's own encode (see `report`).
            if token:
                _PROGRESS.running(token, level, 1, 0.0)
            grays = [cv2.cvtColor(b, cv2.COLOR_BGR2GRAY) for _, b in raw]
            if pair:
                if len(grays) != 2:
                    # >2 is already 422 (MAX_IMAGES) and 0 is already "No image
                    # was sent." above, so the only way to land here is one
                    # capture with pair set - a client bug this interface must
                    # let a later work stream diagnose from the response.
                    return _error("A pair needs two captures. Uncheck pairing, "
                                  "or add the second capture.")
                # The client already confirmed this pair; stitch it directly and
                # let stitch_pair's own ValueError (the message already written
                # for a non-programmer) surface as the one refusal for the whole
                # request, instead of group_captures quietly turning a refused
                # seam into two separate fields.
                names = [raw[0][0], raw[1][0]]
                gray, stitch = pipeline.stitch_pair(grays[0], grays[1])
                bgr = _stitched_bgr(gray, names)
                if _disconnected(request):
                    return _aborted()
                # crop="": a stitched field is already the field (see the other
                # branch, where a lone capture still owes the autocrop/quad crop).
                fields = [_count_field(
                    bgr, p, "", stages, names, stitch, pre_M=quad_M,
                    on_progress=(lambda st, fr: _PROGRESS.running(token, level, st, fr))
                    if token else None,
                    on_encode=(lambda: _PROGRESS.running(token, level, 10, 0.0))
                    if token else None)]
            else:
                groups, stitched = pipeline.group_captures(grays)
                fields = []
                for g in groups:
                    names = [raw[i][0] for i in g]
                    stitch = None
                    crop = autocrop
                    if len(g) == 2:
                        gray, stitch = stitched[tuple(g)]
                        bgr = _stitched_bgr(gray, names)
                        crop = ""          # a stitched field is already the field
                    else:
                        bgr = raw[g[0]][1]
                    if _disconnected(request):
                        return _aborted()
                    try:
                        # `groups` is the batch: a field reports its own
                        # fraction placed inside the run, so card 2 of 3 half
                        # done reads as half of the middle third rather than as
                        # the whole run half done.
                        idx = len(fields) + 1
                        n_fields = len(groups)
                        fields.append(_count_field(
                            bgr, p, crop, stages, names, stitch, pre_M=quad_M,
                            on_progress=(lambda st, fr, i=idx, n=n_fields:
                                         _PROGRESS.running(token, level, st, fr, i, n))
                            if token else None,
                            on_encode=(lambda i=idx, n=n_fields:
                                       _PROGRESS.running(token, level, 10, 0.0, i, n))
                            if token else None))
                    except ValueError as e:
                        # A per-field refusal (no grid, bad crop) must not throw
                        # away the other fields already counted in this batch -
                        # it used to raise here and discard the whole request.
                        fields.append({"names": names, "error": str(e)})
                if fields and all("error" in f for f in fields):
                    # Every field in the batch refused: keep behaving like a
                    # single bad capture always has (a whole-request 400)
                    # rather than answering 200 with nothing but error entries.
                    # The body still has to say more than field 0's reason, or
                    # the other N-1 fields' failures (and even their names)
                    # vanish with no trace. `n` counts FIELDS, not captures - a
                    # batch of stitched pairs has fewer fields than uploads, and
                    # "None of the 3 captures" for 3 fields made of 6 uploads
                    # would be wrong.
                    n = len(fields)
                    if n == 1:
                        raise ValueError(fields[0]["error"])
                    raise ValueError(
                        f"None of the {n} fields could be counted. "
                        f"The first one: {fields[0]['error']}")
        except (ValueError, WeightsMissing) as e:
            if token:
                _PROGRESS.done(token, "failed")
            # A refusal the user can act on: bad crop, unstitchable pair, every
            # field in the batch refused, or (WeightsMissing) ML weights the
            # release is missing - "this quality level averages 3 models, but
            # only 1 is installed" is the realistic failure on a hand-pruned
            # release, and its message is already written for a non-programmer.
            # An unrelated missing file is NOT caught here (it is not this
            # class) and falls through to the generic 500 handler below, with
            # its traceback on the console, instead of masquerading as a 400.
            return _error(str(e))
        except Exception as e:      # noqa: BLE001
            if token:
                _PROGRESS.done(token, "failed")
            # Never let a pipeline bug become a text/plain 500: the browser can
            # only show what it can parse, and api.ts reads {"error": ...} -
            # anything else surfaces as the useless "Count failed". The
            # traceback still goes to the console the user has open.
            traceback.print_exc()
            return _error(f"The count failed: {type(e).__name__}: {e}", status=500)
    if token:
        _PROGRESS.done(token)
    return {"fields": fields}


def _preview(gray):
    """Path to a JPG of a raw capture, for a screen that has no counted image
    yet. Kept at full resolution on purpose: the review screen places the two
    captures with dx/dy measured in original pixels, so a rescaled preview
    would misalign them. Fetched by id (audit-backend.md #11), not inlined."""
    return _store_jpg(gray, quality=78)


def _sweep_job(raw):
    """The client's name for a sweep, or None if it is not one we will store.

    Bounded and alphanumeric-ish, because this string becomes a dictionary key
    on a long-lived server process: an unbounded one is a slow leak and an
    arbitrary one is a key nobody can reason about. The client sends a UUID.
    """
    raw = (raw or "").strip()
    if not raw or len(raw) > 64:
        return None
    return raw if raw.replace("-", "").replace("_", "").isalnum() else None


def _sweep_set(job, done, total):
    """Record a sweep's progress, and evict what nobody is coming back for."""
    now = time.time()
    with _SWEEP_LOCK:
        _SWEEP[job] = [done, total, now]
        _SWEEP.move_to_end(job)
        while len(_SWEEP) > _SWEEP_MAX:
            _SWEEP.popitem(last=False)
        while _SWEEP and now - next(iter(_SWEEP.values()))[2] > _SWEEP_TTL:
            _SWEEP.popitem(last=False)


@app.get("/api/sweep/{job}")
def api_sweep(job: str):
    """How far the overlap sweep named `job` has got.

    An unknown job answers 0 of 0 rather than 404: the browser starts polling
    the moment it sends the upload, so "not registered yet" is the normal first
    answer, not an error - and the same reply serves a sweep that has already
    finished and cleaned up. Either way the client keeps the last figure it saw
    instead of flinching back to zero.
    """
    key = _sweep_job(job)
    with _SWEEP_LOCK:
        v = _SWEEP.get(key) if key else None
        return {"done": v[0], "total": v[1]} if v else {"done": 0, "total": 0}


@app.post("/api/pairs")
def api_pairs(request: Request, images: list[UploadFile] = File(...),
              job: str = Form("")):
    """Which uploads are two views of one field. Detection only - no counting."""
    err = _check_uploads(images, "pairs")
    if err:
        return _error(err, status=422)
    try:
        return _api_pairs(request, images, _sweep_job(job))
    except ValueError as e:
        # Same convention as /api/count (B3): a refusal the user can act on -
        # here, concretely, an encode failure (B7a made cv2.imencode's ok flag
        # raise instead of silently producing a broken preview JPEG).
        return _error(str(e))
    except Exception as e:      # noqa: BLE001
        # Never let a bug here become a bare, bodyless 500 - api.ts reads
        # {"error": ...} and shows nothing useful for anything else.
        traceback.print_exc()
        return _error(f"Comparing captures failed: {type(e).__name__}: {e}", status=500)


def _api_pairs(request, images, job=None):
    # Per-image, not batch-shared - see the RULE in _decode_all: this request
    # is a whole batch, not one field, and its previews must match what
    # api_count will normalise the same capture (or a decided pair) to.
    decoded, err = _decode_all(images, share=False)
    if err:
        raise ValueError(err)
    names = [n for n, _ in decoded]
    grays = [cv2.cvtColor(b, cv2.COLOR_BGR2GRAY) for _, b in decoded]

    # An abandoned tab must not queue behind, and then burn, a whole pairs
    # scan. Checked before the wait for the lock (where an aborted request used
    # to sit holding a place) and again inside it, before the expensive sweep.
    if _disconnected(request):
        return _aborted()

    # The candidate sweep is O(n^2) in batch size (154 ms for 5 tiles on this
    # machine) and runs the whole of stitch_pair per candidate; it takes every
    # count slot so it runs alone, as it always has (see _all_slots).
    with _all_slots():
        if _disconnected(request):
            return _aborted()
        # Why a candidate pair was rejected, so the screen can say "these two are
        # different sizes" instead of quietly reporting no pair at all.
        dropped = []
        pairs = []
        # Reported from inside the lock, so what the browser reads is this
        # sweep's own progress and not a queued one's. The entry is left in
        # place at the end rather than deleted: the client's last poll is in
        # flight while the response is being built, and an entry that vanished
        # first would answer 0 of 0 and snap a finished bar back to empty.
        # _SWEEP_MAX and _SWEEP_TTL collect it.
        groups, stitched = pipeline.group_captures(
            grays, skipped=dropped,
            progress=(lambda d, t: _sweep_set(job, d, t)) if job else None)
        for g in groups:
            if len(g) != 2:
                continue
            _, info = stitched[tuple(g)]
            # "swapped" says the SECOND capture is the upper one, so dx/dy - which
            # stitch_pair always reports as the lower image's origin in the upper
            # one's frame - place i under j rather than j under i. The review
            # screen needs it to lay the two captures out the way they overlap.
            # Preview JPGs of the two raw captures. The review screen runs BEFORE
            # counting now, so it has no base_image to fall back on - and no browser
            # renders the EVOS TIF the user actually dropped.
            pairs.append({"i": g[0], "j": g[1], "dx": info["dx"], "dy": info["dy"],
                          "seam_y": info["seam_y"], "ncc": info["ncc"],
                          "swapped": bool(info["swapped"]),
                          # The tilt stitch_pair corrected before cutting the seam.
                          # The review screen rotates its cross-fade preview by it,
                          # so without this field the preview is translation-only
                          # and disagrees with the merge it is previewing.
                          "rotation_deg": float(info.get("rotation_deg", 0.0)),
                          "a_image": _preview(grays[g[0]]), "b_image": _preview(grays[g[1]])})
    # Only report a reason for captures that ended up in no pair at all: a file
    # that did pair with someone else needs no explanation, and listing every
    # rejected combination of a big batch would bury the one that matters.
    paired = {i for p in pairs for i in (p["i"], p["j"])}
    skipped = [dict(d, names=[names[d["i"]], names[d["j"]]]) for d in dropped
               if d["i"] not in paired and d["j"] not in paired]
    return {"pairs": pairs, "count": len(grays), "skipped": skipped}


@app.post("/api/thumbs")
def api_thumbs(images: list[UploadFile] = File(...)):
    """Small JPGs of the staged uploads, in the order they were sent.

    The confirm screen showed a grey file glyph for every capture, because no
    browser decodes the EVOS TIF this app is mainly fed. Decoding goes through
    the same path as counting (so the size guard and the shared 16-bit stretch
    apply), but no pipeline stage runs and no count slot is ever taken: this is
    called on staging, before the user has pressed Count.
    """
    err = _check_uploads(images, "thumbs")
    if err:
        return _error(err, status=422)
    try:
        return _api_thumbs(images)
    except ValueError as e:
        # Same convention as /api/count (B3) and /api/pairs (B7j): a refusal
        # the user can act on - here, concretely, an encode failure (B7a made
        # cv2.imencode's ok flag raise instead of silently producing a broken
        # thumbnail).
        return _error(str(e))
    except Exception as e:      # noqa: BLE001
        # Never let a bug here become a bare, bodyless 500 - api.ts reads
        # {"error": ...} and shows nothing useful for anything else.
        traceback.print_exc()
        return _error(f"Making thumbnails failed: {type(e).__name__}: {e}", status=500)


def _api_thumbs(images):
    # Per-image, not batch-shared - see the RULE in _decode_all: this request
    # is a whole batch, not one field, and each thumbnail must match what
    # api_count will normalise that same capture to on its own.
    decoded, err = _decode_all(images, share=False)
    if err:
        raise ValueError(err)
    thumbs = []
    for name, bgr in decoded:
        long_edge = max(bgr.shape[:2])
        if long_edge > THUMB_PX:
            f = THUMB_PX / long_edge
            bgr = cv2.resize(bgr, (0, 0), fx=f, fy=f, interpolation=cv2.INTER_AREA)
        thumbs.append({"name": name, "image": _b64_jpg(bgr, quality=62)})
    return {"thumbs": thumbs}


class _Progress:
    """What each in-flight count is doing, by the token its client minted.

    Progress is telemetry ABOUT a count, never part of its result, so it travels
    on its own GET instead of down the response the count already uses. That
    response is the single path every refusal takes - bad crop, unstitchable
    pair, per-field error, the whole-batch 400, the disconnect abort - and
    streaming the result would have meant re-encoding all of them as in-band
    events and re-branching them in the client (council, 2026-09-21, unanimous).
    If this endpoint dies, the count still completes correctly.

    Bounded to `_KEEP` tokens, newest last, so a client that navigates away
    mid-count leaves at most one stale entry and the map cannot grow.

    A finished token reports its terminal state rather than disappearing: a 404
    on a count that SUCCEEDED would have the UI say the run was lost.
    """
    _KEEP = 16

    def __init__(self):
        self._at = OrderedDict()        # token -> state dict
        self._lock = threading.Lock()

    def _put(self, token, state):
        with self._lock:
            self._at.pop(token, None)
            self._at[token] = state
            while len(self._at) > self._KEEP:
                self._at.popitem(last=False)

    def queued(self, token, position):
        """Accepted, but waiting on a free count slot. A batch runs COUNT_SLOTS
        at a time, so any field past that many is WAITING, not working - and a
        bar drawn for a waiting card looks like a hang."""
        self._put(token, {"state": "queued", "position": position,
                          "total": pipeline.PROGRESS_TOTAL, "at": time.time()})

    def running(self, token, level, step, frac, field=1, fields=1):
        label = dict(pipeline.PROGRESS_STEPS).get(step, "Working")
        # One field's own fraction, placed inside the batch: field 2 of 3 half
        # done is 50 % of the middle third.
        own = pipeline.progress_fraction(level, step, frac)
        overall = ((field - 1) + own) / max(1, fields)
        self._put(token, {
            "state": "running", "step": step, "total": pipeline.PROGRESS_TOTAL,
            "frac": round(overall, 4), "label": label,
            "field": field, "fields": fields, "at": time.time(),
        })

    def done(self, token, state="done"):
        self._put(token, {"state": state, "step": pipeline.PROGRESS_TOTAL,
                          "total": pipeline.PROGRESS_TOTAL, "frac": 1.0,
                          "label": "Done", "at": time.time()})

    def get(self, token):
        with self._lock:
            return self._at.get(token)

    def clear(self):
        with self._lock:
            self._at.clear()


_PROGRESS = _Progress()

# How many counts are waiting on a free count slot right now, so a queued
# token can say where it sits. Incremented before the wait and decremented
# once a slot is held, under its own lock - never inside _count_slot, or it
# could not be read while a count is running.
_WAITING = 0
_WAITING_LOCK = threading.Lock()


@app.get("/api/progress/{token}")
def api_progress(token: str):
    """Where the count this client asked for has got to.

    404 means only "no such token": never issued, or pushed out of the bounded
    map. The client draws an indeterminate sweep for that - never 0 %, and never
    "lost", because a token whose run FINISHED reports `done` instead.
    """
    at = _PROGRESS.get(token)
    if at is None:
        return _error("No count is running under that token.", status=404)
    return at


@app.post("/api/reset")
def api_reset():
    """Drop every byte cached for the previous page.

    Reload and close both wipe the app's work (user ruling 2026-09-21): the
    captures, the counts, the hand corrections and the calculator all live in
    React state and go with the page. The server's three caches did not - they
    outlived the page that filled them, so a reloaded app sat on top of a
    previous session's images and decoded uploads until memory pressure got
    around to them.

    The client calls this on mount, which is the reliable signal: a new page
    load always mounts, whereas unload detection does not survive a crash, a
    killed tab or a lost machine. A `pagehide` beacon calls it too, so the
    common case frees memory immediately rather than at the next launch.

    Safe to call at any time: it only discards caches. A count in flight holds
    its own decoded arrays as locals, and any id it is about to hand out is
    issued after this returns.
    """
    _IMAGE_STORE.clear()
    _DECODE_CACHE.clear()
    pipeline._STITCH_CACHE.clear()
    from ml import infer          # local import, as count_cells does: torch must never load
    infer.clear_heat_cache()
    _PROGRESS.clear()
    return {"ok": True}


@app.post("/api/shutdown")
def api_shutdown(request: Request):
    """Exit this server so a fresh launch can take the port.

    A second launch used to refuse with "already running", which strands a
    non-technical user whose first server has no visible window (2026-09-21).
    Now the new launch asks the old one to leave. The custom header is the
    guard: a browser cannot send it cross-origin without a CORS preflight,
    which this app never answers, so no web page can kill the server.
    """
    if request.headers.get("X-Cell-Counter") != "restart":
        return JSONResponse({"error": "missing header"}, status_code=403)
    threading.Timer(0.2, os._exit, args=(0,)).start()
    return {"ok": True}


@app.get("/api/image/{image_id}")
def api_image(image_id: str):
    """Serve one field image by the id `_store_jpg` handed out (audit-
    backend.md #11). Two distinct 404s, on purpose: an id nobody ever issued
    is a different mistake than one that aged out of `_IMAGE_STORE`, and only
    the second can be fixed by the user - re-running the count."""
    result = _IMAGE_STORE.get(image_id)
    if result == "unknown":
        return _error("That image was never counted. Reload the page and try again.",
                      status=404)
    if result == "expired":
        return _error("This image has expired. Re-run the count to see it again.",
                      status=404)
    return Response(content=result, media_type="image/jpeg")


DIST = pathlib.Path(__file__).parent / "static" / "dist"
NO_STORE = {"Cache-Control": "no-store"}


@app.get("/")
@app.get("/app")
@app.get("/app/")
@app.get("/app/index.html")
def index():
    # no-store on the entry document: the browser must never serve a stale copy
    # of the app after the server code changes (a cached page once produced
    # week-old results). /app is the vite build's base, so it is the URL any
    # bookmark or deep link uses -- it must get the same no-store guarantee.
    # The hashed asset files under /app/assets and /app/fonts are safe to cache.
    if (DIST / "index.html").exists():
        return FileResponse(DIST / "index.html", headers=NO_STORE)
    return JSONResponse(
        {"error": "The interface is not built. Run: cd web && npm install && npm run build"},
        status_code=503, headers=NO_STORE)


if DIST.exists():
    app.mount("/app/assets", StaticFiles(directory=DIST / "assets"), name="app-assets")
    app.mount("/app/fonts", StaticFiles(directory=DIST / "fonts"), name="app-fonts")


HOST = "127.0.0.1"
DEFAULT_PORT = 8477


def _resolve_port() -> int:
    """DEFAULT_PORT, or CELL_COUNTER_PORT when it is set to a whole number."""
    raw = os.environ.get("CELL_COUNTER_PORT")
    if not raw:
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(
            f"CELL_COUNTER_PORT is set to '{raw}', which is not a whole "
            "number. Unset it, or set it to a port number like 8477, then "
            "try again.")
    if not (1024 <= port <= 65535):
        raise SystemExit(
            f"CELL_COUNTER_PORT is set to {port}, which is outside the "
            "usable range 1024-65535. Set it to a port number like 8477, "
            "then try again.")
    return port


PORT = DEFAULT_PORT


def _port_free(port: int) -> bool:
    """True if `port` accepts a bind right now (released immediately after)."""
    probe = socket.socket()
    # Bind the way uvicorn will. On macOS/Linux a port whose last server closed
    # its connections sits in TIME_WAIT (~30 s on macOS) and refuses a plain
    # bind, so a relaunch read "would not close" on 3/3 macOS CI runners
    # (2026-09-23). Never on Windows: there it lets a bind steal a live port.
    if os.name != "nt":
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((HOST, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def _probe_params(port: int, timeout: float = 0.5) -> dict | None:
    """GET /api/params on `port`; None if nothing answered with JSON."""
    try:
        with urllib.request.urlopen(
                f"http://{HOST}:{port}/api/params", timeout=timeout) as resp:
            return json.loads(resp.read())
    except (OSError, urllib.error.URLError, ValueError):
        return None


def port_state(port: int) -> Literal["free", "ours", "other"]:
    """Whether `port` is free, already held by our own server, or held by
    something else entirely.

    Binding is tried first - that is the cheap, unambiguous "free" case. A
    bind failure only means something is listening, not what it is: an
    unrelated program on that port must never be reported as "already
    running", which would send the user to a stranger's server. So on a bind
    failure this GETs /api/params and only calls it "ours" when the answer
    carries a `version` field - anything else (a different app, a proxy, no
    answer at all) is "other".
    """
    if _port_free(port):
        return "free"
    data = _probe_params(port)
    if isinstance(data, dict) and "version" in data:
        return "ours"
    return "other"


def _open_when_listening(host, port, timeout=30.0):
    """Open the browser only once something actually accepts on the port.

    The old code opened it on a 1.2 s timer. On a second launch the bind fails
    and that window dies - but the browser cheerfully shows the FIRST server, so
    the user works in a stale app and never sees the error. Waiting for a real
    connection means the tab that opens is this process's server.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), 0.25):
                webbrowser.open(f"http://{host}:{port}")
                return
        except OSError:
            time.sleep(0.15)
    print(f"Could not reach http://{host}:{port} - open it yourself once the server is up.")


if __name__ == "__main__":
    PORT = _resolve_port()

    # Refuse early, in plain words, rather than letting uvicorn die with a
    # traceback after a browser has already been pointed at the old server.
    # There is still a TOCTOU gap here: _port_free's own bind is released
    # before uvicorn binds again a moment later, so a program that grabs the
    # port in that window is not caught. Narrow, and no worse than before -
    # closing it needs uvicorn to bind on our already-open probe socket
    # instead of its own, which is a bigger change than this task makes.
    state = port_state(PORT)
    if state == "ours":
        print("An older Cell Counter was still running - closing it first.")
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"http://{HOST}:{PORT}/api/shutdown", method="POST",
                headers={"X-Cell-Counter": "restart"}), timeout=2).close()
        except (OSError, urllib.error.URLError):
            pass  # a pre-shutdown build, or it died mid-reply; the wait decides
        deadline = time.monotonic() + 10
        while not _port_free(PORT) and time.monotonic() < deadline:
            time.sleep(0.2)
        if not _port_free(PORT):
            raise SystemExit(
                "An older Cell Counter is still running and would not close.\n"
                "Restart the computer, then start Cell Counter again.")
    if state == "other":
        raise SystemExit(
            f"Another program is already using port {PORT}, not Cell Counter.\n"
            "Set the CELL_COUNTER_PORT environment variable to a different "
            "number (for example 8478) and start this again.")

    threading.Thread(target=_open_when_listening, args=(HOST, PORT), daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
