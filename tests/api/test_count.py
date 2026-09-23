import base64
import os
import socket
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import app as app_module
from ml.infer import WeightsMissing

client = TestClient(app_module.app)

# static/dist is a build output (gitignored); a fresh checkout has none until
# `npm run build`, and the routes that serve it answer 503 until then.
needs_web_build = pytest.mark.skipif(
    not (app_module.DIST / "index.html").exists(),
    reason="web build absent: cd web && npm install && npm run build")

TIF = "data/tif/10x tile picture 3; first three rows.tif"


def _decode(data_url):
    """Decode a data:image/jpeg;base64,... URL. Thumbs still use this shape
    (audit-backend.md #11 was scoped to base_image/overlay_image/stages/pair
    previews only - thumbs are already small)."""
    raw = base64.b64decode(data_url.split(",", 1)[1])
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)


def _fetch_image(image_ref):
    """Follow an `/api/image/<id>` reference and decode the JPEG bytes.

    Field images (audit-backend.md #11) are no longer inlined as
    `data:image/jpeg;base64,...` - they are fetched by id, the same way the
    browser will."""
    assert image_ref.startswith("/api/image/")
    r = client.get(image_ref)
    assert r.status_code == 200
    return cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)


@pytest.mark.data
def test_api_count_reports_the_displayed_field_size():
    """width/height must be base_image's own pixel size.

    The browser counts a hand-added point only while it is inside the field
    being displayed, so the gallery card (which draws no image and cannot
    measure one) and the edit view have to agree on these two numbers or a
    cropped capture reads with two different totals.
    """
    with open(TIF, "rb") as fh:
        files = [("images", (TIF.split("/")[-1], fh, "image/tiff"))]
        r = client.post("/api/count", files=files, data={"params": "{}"})
    assert r.status_code == 200
    field = r.json()["fields"][0]

    img = _fetch_image(field["base_image"])
    assert (field["width"], field["height"]) == (img.shape[1], img.shape[0])
    # Every detected cell lies inside the field it was detected in.
    assert all(0 <= x < field["width"] and 0 <= y < field["height"]
               for x, y in field["centers"])


@pytest.mark.data
def test_api_count_serves_the_capture_by_id_and_nothing_else():
    """base_image is an /api/image/<id> path, not an inlined base64 data URL
    (audit-backend.md #11: unbounded response size on a batch).

    It is also the ONLY image a counted field carries. `overlay_image` - a
    second full-size JPEG of the capture - was removed 2026-09-21 with the
    sidebar opacity slider that faded it: the cells are marked by the dot
    canvas the user can click, and the second image added a second encode, a
    second store entry and a second fetch per count to say the same thing."""
    with open(TIF, "rb") as fh:
        files = [("images", (TIF.split("/")[-1], fh, "image/tiff"))]
        r = client.post("/api/count", files=files, data={"params": "{}"})
    assert r.status_code == 200
    field = r.json()["fields"][0]
    assert field["base_image"].startswith("/api/image/")
    assert "overlay_image" not in field
    _fetch_image(field["base_image"])


def test_api_image_unknown_id_returns_404_plain_sentence():
    """An id nobody ever issued: a plain sentence, not a bare 404."""
    r = client.get("/api/image/no-such-id")
    assert r.status_code == 404
    assert "never counted" in r.json()["error"].lower()


def test_api_image_evicted_id_tells_the_user_to_recount():
    """An id that WAS issued but was pushed out by byte pressure must say to
    re-run the count - that is a different failure than an id that never
    existed, and a user who left a tab open overnight needs the actionable
    one."""
    store = app_module._IMAGE_STORE
    image_id = store.put(b"not-really-a-jpeg")
    # Push it out on size alone, the only way the store evicts now.
    store.put(b"x" * (store._max_bytes + 1))
    r = client.get(f"/api/image/{image_id}")
    assert r.status_code == 404
    msg = r.json()["error"].lower()
    assert "expired" in msg or "re-run" in msg or "again" in msg


def test_api_image_survives_a_long_idle_tab():
    """No clock-based expiry: an id issued long ago must still resolve, so a
    lab researcher who counts a batch, writes up notes, and exports well over
    30 minutes later still gets their images back (the old TTL broke this -
    export re-fetches base_image at export time, not count time)."""
    store = app_module._IMAGE_STORE
    image_id = store.put(b"still-here")
    # Simulate a long idle period; nothing should key off the clock.
    real_monotonic = time.monotonic
    try:
        time.monotonic = lambda: real_monotonic() + 60 * 60 * 24
        r = client.get(f"/api/image/{image_id}")
    finally:
        time.monotonic = real_monotonic
    assert r.status_code == 200
    assert r.content == b"still-here"




def test_oversized_image_is_refused_in_plain_words():
    """A 6000x6000 PNG ran over 30 minutes with no way to stop it. Refuse it up
    front, in a JSON body the browser can actually show, instead of hanging
    the only server there is."""
    side = int((app_module.MAX_PIXELS * 2) ** 0.5)
    big = np.zeros((side, side), np.uint8)
    ok, buf = cv2.imencode(".png", big)
    assert ok
    r = client.post("/api/count", files=[("images", ("huge.png", buf.tobytes(), "image/png"))],
                    data={"params": "{}"})
    assert r.status_code == 400
    msg = r.json()["error"]
    assert "too large" in msg and "megapixels" in msg and str(side) in msg


@pytest.mark.data
def test_stitched_field_over_the_cap_is_refused_not_counted():
    """MAX_PIXELS was checked only per upload (_decode_raw): two captures each
    comfortably under the cap stitch into a field about twice as tall, and that
    field was then counted with no check at all. These two real captures are
    1,392,640 px each; stitched they are 1,950,384 px, so a cap set between the
    two catches the stitched field and nothing else."""
    keep = app_module.MAX_PIXELS
    app_module.MAX_PIXELS = 1_600_000
    try:
        with open(TIF, "rb") as fa, \
             open("data/tif/10x tile picture 3; last three rows.tif", "rb") as fb:
            files = [("images", ("a.tif", fa, "image/tiff")),
                     ("images", ("b.tif", fb, "image/tiff"))]
            r = client.post("/api/count", files=files, data={"params": "{}"})
    finally:
        app_module.MAX_PIXELS = keep
    assert r.status_code == 400
    msg = r.json()["error"]
    assert "too large" in msg and "megapixels" in msg
    assert "a.tif" in msg and "b.tif" in msg


@pytest.mark.data
def test_16_bit_tif_is_stretched_not_truncated():
    """IMREAD_COLOR keeps only the high byte, so 12-bit EVOS data (0-4095)
    arrived almost black and counted 0 with a cheerful HTTP 200. Read it
    unchanged and stretch the real range to 8 bits: the same capture must count
    the same whether it is saved as 8-bit or as 12-bit-in-16."""
    g = cv2.imread(TIF, cv2.IMREAD_GRAYSCALE)
    deep = (g.astype(np.uint16) * 16)          # 8-bit content living in 12 bits
    ok8, b8 = cv2.imencode(".png", g)
    ok16, b16 = cv2.imencode(".png", deep)
    assert ok8 and ok16

    def count(name, buf):
        r = client.post("/api/count", files=[("images", (name, buf.tobytes(), "image/png"))],
                        data={"params": '{"level": 1}'})
        assert r.status_code == 200, r.text
        return r.json()["fields"][0]["count"]

    deep_count = count("deep.png", b16)
    assert deep_count > 0
    assert abs(deep_count - count("flat.png", b8)) <= 2


@pytest.mark.data
def test_pipeline_failure_returns_a_json_error_body():
    """api.ts reads {"error": ...} and shows the useless "Count failed" for
    anything else, so an unexpected pipeline exception must not become a
    text/plain 500 traceback."""
    def boom(*a, **k):
        raise RuntimeError("synthetic pipeline failure")

    keep = app_module.pipeline.count_cells
    app_module.pipeline.count_cells = boom
    try:
        with open(TIF, "rb") as fh:
            r = client.post("/api/count",
                            files=[("images", ("t.tif", fh, "image/tiff"))],
                            data={"params": "{}"})
    finally:
        app_module.pipeline.count_cells = keep
    assert r.status_code == 500
    assert r.headers["content-type"].startswith("application/json")
    assert "synthetic pipeline failure" in r.json()["error"]


def test_handlers_are_sync_so_the_event_loop_stays_free():
    """/api/params took 5.5 s during a count because the CPU-bound handlers were
    `async def` and ran on the event loop. Plain `def` sends them to the
    threadpool; a lock keeps two counts from thrashing instead."""
    import inspect
    assert not inspect.iscoroutinefunction(app_module.api_count)
    assert not inspect.iscoroutinefunction(app_module.api_pairs)
    assert not inspect.iscoroutinefunction(app_module.api_params)


class _Up:
    """The two attributes _decode_all uses from an UploadFile."""

    def __init__(self, name, buf):
        import io
        self.filename = name
        self.file = io.BytesIO(bytes(buf))


def _u16_png(arr):
    ok, buf = cv2.imencode(".png", arr.astype(np.uint16))
    assert ok
    return buf.tobytes()


def test_deep_images_of_one_request_share_one_scaling():
    """Each image used to be stretched by its OWN min/max, so the two halves of a
    stitched 16-bit pair were scaled differently: a brightness step at the seam,
    two differently contrasted images handed to _overlap_ncc /
    _estimate_rotation_deg, and a different effective gain for the ML `norm`
    channel on each side of the field."""
    bright = np.full((40, 40), 4095)
    bright[0, 0] = 0
    dim = np.full((40, 40), 2047)
    dim[0, 0] = 0
    decoded, err = app_module._decode_all([_Up("a.png", _u16_png(bright)),
                                           _Up("b.png", _u16_png(dim))])
    assert err is None
    a, b = (im for _, im in decoded)
    # Shared lo/hi = (0, 4095): the dim capture stays dim instead of being
    # stretched to full white the way its own range would have stretched it.
    assert a.max() == 255
    assert 120 <= int(b.max()) <= 134
    # Alone, it does read as full white - that is exactly the bug.
    solo, err = app_module._decode_all([_Up("b.png", _u16_png(dim))])
    assert err is None and solo[0][1].max() == 255


@pytest.mark.data
def test_uint8_uploads_are_untouched_by_the_shared_range():
    """Only deep input is scaled. An 8-bit upload must come through byte for
    byte, alone or beside a 16-bit one."""
    g = cv2.imread(TIF, cv2.IMREAD_GRAYSCALE)[:64, :64]
    ok, flat = cv2.imencode(".png", g)
    assert ok
    want = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
    for ups in ([_Up("f.png", flat.tobytes())],
                [_Up("f.png", flat.tobytes()), _Up("d.png", _u16_png(g.astype(np.uint16) * 16))]):
        decoded, err = app_module._decode_all(ups)
        assert err is None
        assert np.array_equal(decoded[0][1], want)


@pytest.mark.data
def test_an_aborted_request_never_starts_the_count():
    """A client abort used to run the whole count anyway, holding a count slot
    while nobody was listening."""
    calls = []

    def boom(*a, **k):
        calls.append(1)
        raise AssertionError("counted an abandoned request")

    keep_count, keep_disc = app_module.pipeline.count_cells, app_module._disconnected
    app_module.pipeline.count_cells = boom
    app_module._disconnected = lambda request: True
    try:
        with open(TIF, "rb") as fh:
            r = client.post("/api/count", files=[("images", ("t.tif", fh, "image/tiff"))],
                            data={"params": "{}"})
    finally:
        app_module.pipeline.count_cells = keep_count
        app_module._disconnected = keep_disc
    assert r.status_code == 499
    assert not calls
    assert app_module._slots_free() == app_module.COUNT_SLOTS


@pytest.mark.data
def test_broken_onnxruntime_is_a_readable_error_not_a_bare_500():
    """`from ml.infer import WeightsMissing` runs unconditionally on every
    count. If onnxruntime cannot be imported, that statement must not raise an
    ImportError out of the handler: the browser can only show what api.ts can
    parse, so the answer has to be JSON with an `error` key either way.

    This used to assert that the CLASSICAL rung still counted with onnxruntime
    broken. There is no classical rung any more (2026-09-21: the three
    remaining rungs are all ML), so what is left to guarantee is the shape of
    the failure, not a working count."""
    import sys
    keep = sys.modules.get("ml.infer", "absent")
    sys.modules["ml.infer"] = None  # forces ImportError on the deferred import
    try:
        with open(TIF, "rb") as fh:
            r = client.post("/api/count", files=[("images", (TIF.split("/")[-1], fh, "image/tiff"))],
                            data={"params": '{"level": 1}'})
    finally:
        if keep == "absent":
            del sys.modules["ml.infer"]
        else:
            sys.modules["ml.infer"] = keep
    # Whatever happens, it is parseable JSON the user can be shown - never a
    # text/plain framework 500.
    body = r.json()
    if r.status_code == 200:
        assert body["fields"][0]["count"] >= 0
    else:
        assert isinstance(body.get("error"), str) and body["error"]


def test_an_image_with_no_grid_is_refused_not_counted():
    """A thumbnail-sized or non-slide upload used to answer HTTP 200 with a
    zero-area frame and grid_cols/rows 0, which reads as "0 cells in this
    slide" rather than "this is not a slide"."""
    ok, buf = cv2.imencode(".png", np.zeros((40, 40), np.uint8))
    assert ok
    r = client.post("/api/count", files=[("images", ("tiny.png", buf.tobytes(), "image/png"))],
                    data={"params": '{"level": 1}'})
    assert r.status_code == 400
    assert "grid" in r.json()["error"].lower()


@pytest.mark.data
def test_encode_failure_is_a_plain_error_not_a_broken_image():
    """cv2.imencode's `ok` flag was discarded (audit-backend.md #15), so an
    encode failure used to produce a `/api/image/<id>` pointing at an empty or
    garbage JPEG instead of a plain error the user can act on."""
    keep = app_module.cv2.imencode

    def fake_imencode(*a, **k):
        return False, None

    app_module.cv2.imencode = fake_imencode
    try:
        with open(TIF, "rb") as fh:
            r = client.post("/api/count", files=[("images", ("t.tif", fh, "image/tiff"))],
                            data={"params": "{}"})
    finally:
        app_module.cv2.imencode = keep
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/json")
    assert "encode" in r.json()["error"].lower()


@pytest.mark.data
def test_thumbs_are_small_and_in_upload_order():
    """The confirm screen cannot decode a TIF, so it drew a grey glyph per file.
    /api/thumbs must be cheap enough to call on staging."""
    with open(TIF, "rb") as fh:
        data = fh.read()
    files = [("images", ("one.tif", data, "image/tiff")),
             ("images", ("two.tif", data, "image/tiff"))]
    r = client.post("/api/thumbs", files=files)
    assert r.status_code == 200
    thumbs = r.json()["thumbs"]
    assert [t["name"] for t in thumbs] == ["one.tif", "two.tif"]
    for t in thumbs:
        img = _decode(t["image"])
        assert max(img.shape[:2]) == app_module.THUMB_PX
        assert len(t["image"]) < 60_000
    assert app_module._slots_free() == app_module.COUNT_SLOTS


@pytest.mark.data
def test_thumbs_use_the_same_scaling_as_a_solo_count():
    """/api/thumbs decodes a whole BATCH in one request and used to share one
    lo/hi across it (app.py's old _decode_all default), while api_count's
    request is always a single field: a lone capture, or exactly a pair. A
    batch thumbnail was normalised against the batch's own range while the
    eventual count normalises the same capture against its own - reproduced
    here with an extreme decoy upload that blows the shared range wide open
    if the batch's images still shared one."""
    g = cv2.imread(TIF, cv2.IMREAD_GRAYSCALE)
    a_deep = g.astype(np.uint16) * 16           # this capture's own real range
    decoy = np.full((8, 8), 65535, np.uint16)   # another upload in the SAME
                                                 # batch, far outside a's range
    ok, a_buf = cv2.imencode(".png", a_deep)
    ok2, d_buf = cv2.imencode(".png", decoy)
    assert ok and ok2

    r = client.post("/api/thumbs", files=[
        ("images", ("a.png", a_buf.tobytes(), "image/png")),
        ("images", ("decoy.png", d_buf.tobytes(), "image/png"))])
    assert r.status_code == 200
    thumb_a = _decode(r.json()["thumbs"][0]["image"])

    r2 = client.post("/api/count", files=[("images", ("a.png", a_buf.tobytes(), "image/png"))],
                      data={"params": '{"level": 1}'})
    assert r2.status_code == 200, r2.text
    count_a = _fetch_image(r2.json()["fields"][0]["base_image"])

    # Same capture, same intended stretch: the two means should land close
    # together. Sharing the decoy's range into the thumbnail squashes it to
    # roughly a sixteenth of its proper brightness - nowhere near this.
    assert abs(float(thumb_a.mean()) - float(count_a.mean())) < 20


def test_thumbs_refuse_an_oversized_upload_like_the_count_does():
    side = int((app_module.MAX_PIXELS * 2) ** 0.5)
    ok, buf = cv2.imencode(".png", np.zeros((side, side), np.uint8))
    assert ok
    r = client.post("/api/thumbs",
                    files=[("images", ("huge.png", buf.tobytes(), "image/png"))])
    assert r.status_code == 400
    assert "too large" in r.json()["error"]


# ---------------------------------------------------------- quality level

def _count_with_level(level_json):
    with open(TIF, "rb") as fh:
        files = [("images", (TIF.split("/")[-1], fh, "image/tiff"))]
        return client.post("/api/count", files=files,
                           data={"params": '{"level": %s}' % level_json})


@pytest.mark.data
def test_level_0_is_refused_over_http():
    """Level 0 is a harness-only value and unreachable from the UI: over HTTP it
    would silently select a different detector engine than any rung."""
    r = _count_with_level("0")
    assert r.status_code == 422
    assert r.json()["error"] == "Quality level must be 1 to 3."


@pytest.mark.data
def test_level_above_the_top_rung_is_refused():
    """A restored session file used to be clamped to the top rung in silence."""
    r = _count_with_level("9")
    assert r.status_code == 422
    assert r.json()["error"] == "Quality level must be 1 to 3."


@pytest.mark.data
def test_non_numeric_level_is_refused_in_plain_words():
    """int("abc") raised ValueError deep in the pipeline and the user was shown
    the raw Python text. Say it in words a lab researcher can act on."""
    r = _count_with_level('"abc"')
    assert r.status_code == 422
    assert r.json()["error"] == "Quality level must be 1 to 3."
    assert "invalid literal" not in r.json()["error"]


@pytest.mark.data
def test_valid_level_is_not_rejected():
    r = _count_with_level("3")
    assert r.status_code == 200, r.text


# --------------------------------------------------------- autocrop value

def _count_with_autocrop(autocrop_value):
    with open(TIF, "rb") as fh:
        files = [("images", (TIF.split("/")[-1], fh, "image/tiff"))]
        return client.post("/api/count", files=files,
                           data={"autocrop": autocrop_value})


@pytest.mark.data
def test_unknown_autocrop_value_is_refused():
    """An older client's "auto" used to be silently treated as no crop, with
    no sign anything was ignored."""
    r = _count_with_autocrop("auto")
    assert r.status_code == 422
    assert "auto" in r.json()["error"]
    assert "frame" in r.json()["error"]


@pytest.mark.data
def test_typo_autocrop_value_is_refused():
    r = _count_with_autocrop("fram")
    assert r.status_code == 422
    assert "fram" in r.json()["error"]


@pytest.mark.data
def test_empty_autocrop_is_accepted():
    r = _count_with_autocrop("")
    assert r.status_code != 422


@pytest.mark.data
def test_frame_autocrop_is_accepted():
    r = _count_with_autocrop("frame")
    assert r.status_code != 422


def test_a_third_image_is_refused_before_any_decode(monkeypatch):
    """MAX_IMAGES["count"] = 2: /api/count's request is always one field (a
    lone capture, or exactly a pair to stitch), so a third upload can only be
    a mistake. This is the constant a later task depends on, so it must be
    proven enforced, not merely coded - a future refactor could drop the
    "count" cap and the suite would stay green."""
    called = []
    monkeypatch.setattr(app_module.cv2, "imdecode",
                         lambda *a, **k: called.append(1) or None)
    ok, buf = cv2.imencode(".png", np.zeros((8, 8), np.uint8))
    assert ok
    data = buf.tobytes()
    files = [("images", (f"{n}.png", data, "image/png")) for n in ("a", "b", "c")]
    r = client.post("/api/count", files=files, data={"params": "{}"})
    assert r.status_code == 422
    assert r.json()["error"] == ("3 files were uploaded, which is too many to "
                                  "count (the limit is 2). Send fewer files at "
                                  "a time.")
    assert called == []


def test_confirmed_pair_that_wont_stitch_is_refused_not_split():
    """A hand-made or review-confirmed group is a claim the run must answer,
    never something the server may quietly overrule (project rule, gallery
    bands memory). Without `pair=1`, api_count re-derives grouping with
    group_captures and, if stitch_pair refuses the seam, silently returns two
    fields instead of one - doubling the field count with no message. With
    `pair=1` the refusal must surface as a single 400 carrying stitch_pair's
    own ValueError text."""
    a = np.zeros((40, 40), np.uint8)
    b = np.zeros((41, 41), np.uint8)     # different shape: stitch_pair's very
                                          # first gate ("must be the same size")
    ok_a, buf_a = cv2.imencode(".png", a)
    ok_b, buf_b = cv2.imencode(".png", b)
    assert ok_a and ok_b
    files = [("images", ("a.png", buf_a.tobytes(), "image/png")),
             ("images", ("b.png", buf_b.tobytes(), "image/png"))]
    r = client.post("/api/count", files=files,
                    data={"params": "{}", "pair": "true"})
    assert r.status_code == 400
    msg = r.json()["error"]
    assert "same size" in msg
    assert "fields" not in r.json()


@pytest.mark.data
def test_confirmed_pair_that_does_stitch_returns_one_field():
    """The success path of the new branch (app.py's `if pair:` block) - stitch,
    check pixels, count as one field - was exercised by no test: both existing
    `pair` tests exit through a refusal. These are the same two real captures
    `test_stitched_field_over_the_cap_is_refused_not_counted` uses, at the
    real MAX_PIXELS cap, where they actually stitch."""
    with open(TIF, "rb") as fa, \
         open("data/tif/10x tile picture 3; last three rows.tif", "rb") as fb:
        files = [("images", ("a.tif", fa, "image/tiff")),
                 ("images", ("b.tif", fb, "image/tiff"))]
        r = client.post("/api/count", files=files,
                        data={"params": "{}", "pair": "true"})
    assert r.status_code == 200, r.text
    fields = r.json()["fields"]
    assert len(fields) == 1
    field = fields[0]
    assert field["stitch"]  # proof the stitch wasn't dropped

    # The stitched height: taller than either single capture, and equal to
    # what stitch_pair itself produces from the same two grays - proof the
    # branch actually stitched rather than, say, counting one capture alone.
    a_gray = cv2.imread(TIF, cv2.IMREAD_GRAYSCALE)
    b_gray = cv2.imread("data/tif/10x tile picture 3; last three rows.tif",
                        cv2.IMREAD_GRAYSCALE)
    stitched, _ = app_module.pipeline.stitch_pair(a_gray, b_gray)
    assert field["height"] == stitched.shape[0]
    assert field["width"] == stitched.shape[1]
    assert field["height"] > a_gray.shape[0]


@pytest.mark.data
def test_pair_flag_with_one_image_is_refused_not_silently_ignored():
    """>2 uploads is already 422 (MAX_IMAGES) and 0 already returns "No image
    was sent.", so a single capture with `pair=true` was the one case that
    used to fall through to group_captures and count it alone - a client bug
    that must be diagnosable from the response, since a later work stream
    codes against this interface."""
    with open(TIF, "rb") as fh:
        files = [("images", (TIF.split("/")[-1], fh, "image/tiff"))]
        r = client.post("/api/count", files=files,
                        data={"params": "{}", "pair": "true"})
    assert r.status_code == 400
    assert "pair needs two captures" in r.json()["error"]


def test_pair_flag_absent_leaves_todays_behaviour_untouched():
    """The flag is optional: two captures that do not stitch, sent without
    `pair`, keep today's behaviour (group_captures decides, unstitchable pairs
    fall back to two separate fields) rather than being refused outright."""
    a = np.zeros((40, 40), np.uint8)
    b = np.zeros((41, 41), np.uint8)
    ok_a, buf_a = cv2.imencode(".png", a)
    ok_b, buf_b = cv2.imencode(".png", b)
    assert ok_a and ok_b
    files = [("images", ("a.png", buf_a.tobytes(), "image/png")),
             ("images", ("b.png", buf_b.tobytes(), "image/png"))]
    r = client.post("/api/count", files=files, data={"params": "{}"})
    # Neither capture has a grid, so today's behaviour refuses each on its own
    # merits (not the stitch) - the point here is only that `pair` absent takes
    # the old group_captures path rather than the new direct-stitch one, so the
    # error is the "no grid" refusal, never the "same size" one.
    assert r.status_code == 400
    assert "same size" not in r.json()["error"]


@pytest.mark.data
def test_one_bad_field_does_not_discard_the_rest():
    """A per-field refusal (no grid) used to raise inside the group loop and
    discard every already-counted field in the same batch. Two groups here -
    a real slide and a 40x40 blank that never groups with it - so the failure
    must land as fields[i].error while the good field stays intact at 200."""
    ok, buf = cv2.imencode(".png", np.zeros((40, 40), np.uint8))
    assert ok
    with open(TIF, "rb") as fh:
        files = [("images", (TIF.split("/")[-1], fh, "image/tiff")),
                 ("images", ("tiny.png", buf.tobytes(), "image/png"))]
        r = client.post("/api/count", files=files, data={"params": '{"level": 1}'})
    assert r.status_code == 200, r.text
    fields = r.json()["fields"]
    assert len(fields) == 2
    good = [f for f in fields if "error" not in f]
    bad = [f for f in fields if "error" in f]
    assert len(good) == 1 and len(bad) == 1
    assert good[0]["count"] >= 0 and "base_image" in good[0]
    assert bad[0]["names"] == ["tiny.png"]
    assert "grid" in bad[0]["error"].lower()


def test_all_fields_failing_is_a_400_with_every_reason_not_silently_field_0():
    """The all-fail fallback (app.py: every group in the batch ends up an
    error entry) is the fix for a finding that it discarded N-1 of N reasons
    by re-raising fields[0]['error'] alone - but nothing exercised the
    multi-field branch itself, only the n == 1 case
    (test_an_image_with_no_grid_is_refused_not_counted). Two differently
    sized blank images here never group into one field (group_captures) and
    neither has a grid, so both end up error entries -> the whole request
    refuses as one 400 naming the field count and field 0's own reason,
    instead of 200'ing a fields list that is nothing but errors."""
    ok_a, buf_a = cv2.imencode(".png", np.zeros((40, 40), np.uint8))
    ok_b, buf_b = cv2.imencode(".png", np.zeros((50, 50), np.uint8))
    assert ok_a and ok_b
    files = [("images", ("a.png", buf_a.tobytes(), "image/png")),
             ("images", ("b.png", buf_b.tobytes(), "image/png"))]
    r = client.post("/api/count", files=files, data={"params": '{"level": 1}'})
    assert r.status_code == 400
    assert "fields" not in r.json()
    assert r.json()["error"] == (
        "None of the 2 fields could be counted. The first one: "
        "No hemocytometer grid was found in this image, so there is nothing "
        "to count in. Send the microscope capture of the ruled slide at the "
        "size it came off the microscope - a thumbnail, a photo of "
        "something else, or a crop with no ruled line in it cannot be "
        "counted.")


@pytest.mark.data
def test_missing_ml_weights_is_a_400_not_a_500():
    """WeightsMissing from ml/infer.py ("this quality level averages 3
    models, but only 1 is installed") is the realistic failure on a
    hand-pruned release. It is a whole-request refusal the user can act on
    (reinstall/repair the release), not a per-field discard and not a 500.

    The monkeypatch below raises the real ml/infer.py class (not a bare
    FileNotFoundError) so this test proves the handler catches what
    ml/infer.py actually raises, not a stand-in that happens to share a
    message."""
    def boom(*a, **k):
        raise WeightsMissing("ML weights not found: ml/weights/cellnet_0.onnx")

    keep = app_module.pipeline.count_cells
    app_module.pipeline.count_cells = boom
    try:
        with open(TIF, "rb") as fh:
            r = client.post("/api/count", files=[("images", ("t.tif", fh, "image/tiff"))],
                            data={"params": "{}"})
    finally:
        app_module.pipeline.count_cells = keep
    assert r.status_code == 400
    assert r.json()["error"] == "ML weights not found: ml/weights/cellnet_0.onnx"
    assert "fields" not in r.json()


def test_ml_infer_missing_weights_raises_the_pinned_class():
    """Pins the class the test above stands in for: ml/infer.py's own
    missing-weights raise sites (_session and predict) must actually raise
    WeightsMissing, or app.py's narrowed `except WeightsMissing` (added so an
    unrelated missing file no longer masquerades as a 400) would silently stop
    catching the real thing."""
    from ml import infer
    with pytest.raises(WeightsMissing):
        infer.predict(np.zeros((4, 4), np.uint8), np.zeros((4, 4), np.uint8),
                      np.zeros((4, 4), np.float32), 0.0,
                      weights="ml/weights/does_not_exist.onnx")


def test_oversized_upload_is_refused_before_any_decode(monkeypatch):
    """A 2 GB file must not OOM the process by being decoded before its size is
    even looked at. 70 MB clears app.py's MAX_BYTES (64 MiB) while staying
    small enough to actually allocate in a test; the assertion that matters is
    that cv2.imdecode is never reached, not the exact byte count."""
    called = []
    monkeypatch.setattr(app_module.cv2, "imdecode",
                         lambda *a, **k: called.append(1) or None)
    data = os.urandom(70 * 1024 * 1024)
    r = client.post("/api/count", files=[("images", ("huge.tif", data, "image/tiff"))],
                     data={"params": "{}"})
    assert r.status_code == 422
    assert "too large" in r.json()["error"].lower()
    assert called == []


def test_port_state_free_when_bind_succeeds(monkeypatch):
    """A port nothing is listening on is "free" - no HTTP probe needed."""
    monkeypatch.setattr(app_module, "_port_free", lambda port: True)
    assert app_module.port_state(12345) == "free"


def test_port_state_ours_when_params_answers_with_version(monkeypatch):
    """"ours" must never bind a real port - both the bind failure and the
    /api/params answer are stubbed."""
    monkeypatch.setattr(app_module, "_port_free", lambda port: False)
    monkeypatch.setattr(app_module, "_probe_params", lambda port: {"version": "1.2.3"})
    assert app_module.port_state(8477) == "ours"


def test_port_state_other_when_something_else_holds_the_port(monkeypatch):
    """Anything answering without a `version` field - or nothing at all - must
    read as "other", never "already running", or the user gets sent to a
    stranger's server."""
    monkeypatch.setattr(app_module, "_port_free", lambda port: False)
    monkeypatch.setattr(app_module, "_probe_params", lambda port: None)
    assert app_module.port_state(8477) == "other"


def _listener():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # as uvicorn binds
    srv.bind((app_module.HOST, 0))
    srv.listen()
    return srv, srv.getsockname()[1]


def test_port_free_false_while_something_listens():
    """On Windows SO_REUSEADDR lets a bind steal a port another socket is
    actively listening on, so the probe must never set it there."""
    srv, port = _listener()
    try:
        assert not app_module._port_free(port)
    finally:
        srv.close()


@pytest.mark.skipif(os.name == "nt", reason="Windows binds through TIME_WAIT anyway")
def test_port_free_true_through_time_wait():
    """A server that closed its own connections leaves them in TIME_WAIT (~30 s
    on macOS). uvicorn binds with SO_REUSEADDR and would take the port, so the
    probe must too: without it a relaunch after "closing it first", or within
    30 s of closing the Terminal window, refused to start (macOS CI 2026-09-23)."""
    srv, port = _listener()
    cli = socket.create_connection((app_module.HOST, port))
    conn, _ = srv.accept()
    conn.close()                 # server side closes first -> TIME_WAIT on `port`
    time.sleep(0.2)
    cli.close()
    srv.close()
    time.sleep(0.2)
    assert app_module._port_free(port)


def test_resolve_port_unset_gives_default(monkeypatch):
    """When CELL_COUNTER_PORT is not set, use DEFAULT_PORT."""
    monkeypatch.delenv("CELL_COUNTER_PORT", raising=False)
    assert app_module._resolve_port() == 8477


def test_resolve_port_valid_value_honored(monkeypatch):
    """A valid port number is accepted."""
    monkeypatch.setenv("CELL_COUNTER_PORT", "9000")
    assert app_module._resolve_port() == 9000


def test_resolve_port_zero_raises_system_exit(monkeypatch):
    """A port of 0 is outside the usable range and raises SystemExit."""
    monkeypatch.setenv("CELL_COUNTER_PORT", "0")
    with pytest.raises(SystemExit):
        app_module._resolve_port()


def test_resolve_port_negative_raises_system_exit(monkeypatch):
    """A negative port raises SystemExit."""
    monkeypatch.setenv("CELL_COUNTER_PORT", "-5")
    with pytest.raises(SystemExit):
        app_module._resolve_port()


def test_resolve_port_too_high_raises_system_exit(monkeypatch):
    """A port above 65535 is outside the usable range and raises SystemExit."""
    monkeypatch.setenv("CELL_COUNTER_PORT", "99999")
    with pytest.raises(SystemExit):
        app_module._resolve_port()


def test_resolve_port_non_numeric_raises_system_exit(monkeypatch):
    """A non-numeric value raises SystemExit with a helpful message."""
    monkeypatch.setenv("CELL_COUNTER_PORT", "not-a-number")
    with pytest.raises(SystemExit):
        app_module._resolve_port()


@needs_web_build
def test_app_route_carries_no_store_like_root():
    """/app/ is the vite base -- the URL any bookmark or deep link uses -- so it
    must carry the same no-store header as / or a server upgrade can leave a
    researcher looking at a cached, stale page (the exact failure no-store on
    / exists to prevent)."""
    r_root = client.get("/")
    r_app = client.get("/app/")
    assert r_app.status_code == 200
    assert r_app.headers["cache-control"] == r_root.headers["cache-control"] == "no-store"


@needs_web_build
def test_app_hashed_asset_keeps_default_caching():
    """The hashed, content-addressed files under /app/assets/ are safe to
    cache -- only the HTML entry point must be no-store."""
    assets_dir = app_module.DIST / "assets"
    asset_name = next(p.name for p in assets_dir.iterdir() if p.suffix == ".js")
    r = client.get(f"/app/assets/{asset_name}")
    assert r.status_code == 200
    assert r.headers.get("cache-control") != "no-store"


# --- audit-backend.md #24-#27 -------------------------------------------

@pytest.mark.parametrize("data", [b"not an image", b"", b"II*\x00" + b"\x00" * 8])
def test_corrupt_upload_is_refused_in_plain_words_count(data):
    """`im is None` from cv2.imdecode (garbage bytes, an empty file, or a
    truncated TIF header) must answer "Could not read <filename>.", not a
    500 or a silent empty result."""
    r = client.post("/api/count", files=[("images", ("bad.tif", data, "image/tiff"))],
                     data={"params": "{}"})
    assert r.status_code == 400
    assert r.json()["error"] == "Could not read bad.tif."


def test_index_returns_503_when_dist_is_missing(monkeypatch, tmp_path):
    """A source checkout that has not run `npm run build` yet must tell the
    researcher what to do, not serve a 404 or crash. index() re-checks
    (DIST / "index.html").exists() on every request, so patching DIST to an
    empty directory reaches the 503 branch without touching the real build."""
    monkeypatch.setattr(app_module, "DIST", tmp_path)
    r = client.get("/")
    assert r.status_code == 503
    assert r.json()["error"] == (
        "The interface is not built. Run: cd web && npm install && npm run build")


def test_disconnected_answers_connected_when_anyio_raises(monkeypatch):
    """If anyio.from_thread.run raises (no portal, an older starlette, or any
    other surprise), _disconnected must answer "still connected" (False) - a
    false abort would throw away a good count."""
    import anyio.from_thread

    def boom(*a, **k):
        raise RuntimeError("no portal")

    monkeypatch.setattr(anyio.from_thread, "run", boom)

    class FakeRequest:
        def is_disconnected(self):
            raise AssertionError("should never be awaited if run() raises first")

    assert app_module._disconnected(FakeRequest()) is False
