import time

import pytest
from fastapi.testclient import TestClient

import app as app_module

client = TestClient(app_module.app)

TIF = "data/tif/"
PAIR = (TIF + "10x tile picture 3; first three rows.tif",
        TIF + "10x tile picture 3; last three rows.tif")


def _read(p):
    with open(p, "rb") as fh:
        return fh.read()


@pytest.mark.data
def test_api_pairs_finds_the_real_pair():
    files = [("images", (p.split("/")[-1], _read(p), "image/tiff")) for p in PAIR]
    r = client.post("/api/pairs", files=files)
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert len(body["pairs"]) == 1
    pair = body["pairs"][0]
    assert {pair["i"], pair["j"]} == {0, 1}
    assert isinstance(pair["dx"], int) and isinstance(pair["dy"], int)
    assert isinstance(pair["seam_y"], int)
    assert pair["ncc"] > 0.2
    # "first three rows" is genuinely the upper capture and is uploaded first,
    # so stitch_pair had no reason to swap its inputs: dx/dy place j under i.
    # The review screen lays the cross-fade out from this flag, so a silent
    # change of convention here would mis-register the two images on screen.
    assert pair["swapped"] is False
    # Previews are fetched by id, not inlined base64 (audit-backend.md #11).
    assert pair["a_image"].startswith("/api/image/")
    assert pair["b_image"].startswith("/api/image/")
    assert pair["a_image"] != pair["b_image"]
    assert client.get(pair["a_image"]).status_code == 200
    # A real pair leaves nothing to explain.
    assert body["skipped"] == []
    # stitch_pair may rotate the lower capture back to square before cutting
    # the seam; the review screen rotates its cross-fade preview by the same
    # angle so the preview matches the merge. The angle has to reach the client.
    assert isinstance(pair["rotation_deg"], float)
    assert abs(pair["rotation_deg"]) < 2.0


@pytest.mark.data
def test_api_pairs_single_image_has_no_pairs():
    p = PAIR[0]
    files = [("images", (p.split("/")[-1], _read(p), "image/tiff"))]
    r = client.post("/api/pairs", files=files)
    assert r.status_code == 200
    # `skipped` names why a candidate pair was rejected; one file makes no
    # candidate at all, so there is nothing to explain.
    assert r.json() == {"pairs": [], "count": 1, "skipped": []}


@pytest.mark.data
def test_differently_sized_captures_are_reported_not_silently_dropped():
    """`if grays[i].shape != grays[j].shape: continue` dropped the candidate with
    no diagnostic, so /api/pairs just reported no pair and the user was never
    told why. The reason has to reach the client - without inventing a pair."""
    import cv2
    import numpy as np

    a = _read(PAIR[0])
    full = cv2.imdecode(np.frombuffer(a, np.uint8), cv2.IMREAD_UNCHANGED)
    small = cv2.resize(full, (0, 0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".png", small)
    assert ok
    r = client.post("/api/pairs", files=[
        ("images", ("full.tif", a, "image/tiff")),
        ("images", ("half.png", buf.tobytes(), "image/png"))])
    assert r.status_code == 200
    body = r.json()
    assert body["pairs"] == []          # no pair invented
    assert body["skipped"], body
    s = body["skipped"][0]
    assert {s["i"], s["j"]} == {0, 1}
    assert "different sizes" in s["reason"]
    assert set(s["names"]) == {"full.tif", "half.png"}


def test_too_many_uploads_message_is_the_plain_sentence_the_client_shows():
    """group_captures is O(n^2) and runs the whole of stitch_pair per candidate
    under every count slot; a batch far past what a lab researcher would ever
    drag in at once must be refused before any of that runs, not after minutes
    of an unresponsive server. web/src/lib/api.ts reads `error` first (app.py's
    own dialect) - pin the exact server sentence so a future refactor cannot
    silently change what the client displays."""
    files = [("images", (f"f{i}.tif", b"x", "image/tiff")) for i in range(70)]
    r = client.post("/api/pairs", files=files)
    assert r.status_code == 422
    assert r.json()["error"] == (
        "70 files were uploaded, which is too many to compare at once "
        "(the limit is 64). Send fewer files at a time.")


@pytest.mark.data
def test_three_captures_to_api_pairs_is_a_bounded_sweep_not_refused():
    """audit-backend.md #24: unlike /api/count (capped at 2), /api/pairs
    accepts a whole batch and sweeps every candidate pair (O(n^2), bounded by
    MAX_IMAGES["pairs"] = 64) - 3 real captures (the real pair plus a lone
    third file) must succeed, not be refused, and must still find the pair."""
    files = [("images", (p.split("/")[-1], _read(p), "image/tiff")) for p in PAIR]
    files.append(("images", (PAIR[0].split("/")[-1] + ".dup", _read(PAIR[0]),
                              "image/tiff")))
    r = client.post("/api/pairs", files=files)
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 3
    assert len(body["pairs"]) == 1


@pytest.mark.parametrize("data", [b"not an image", b"", b"II*\x00" + b"\x00" * 8])
def test_corrupt_upload_is_refused_in_plain_words_pairs(data):
    """audit-backend.md #25: `im is None` (garbage bytes, empty file, or a
    truncated TIF header) must answer "Could not read <filename>.", not a
    500 or a silently empty pairs list."""
    r = client.post("/api/pairs", files=[("images", ("bad.tif", data, "image/tiff"))])
    assert r.status_code == 400
    assert r.json()["error"] == "Could not read bad.tif."


@pytest.mark.parametrize("data", [b"not an image", b"", b"II*\x00" + b"\x00" * 8])
def test_corrupt_upload_is_refused_in_plain_words_thumbs(data):
    """audit-backend.md #25, /api/thumbs side."""
    r = client.post("/api/thumbs", files=[("images", ("bad.tif", data, "image/tiff"))])
    assert r.status_code == 400
    assert r.json()["error"] == "Could not read bad.tif."


@pytest.mark.data
def test_pairs_encode_failure_is_a_plain_error_not_a_bare_500(monkeypatch):
    """B7j: /api/pairs had no try/except at all, so an unexpected exception -
    an encode failure being the concrete case B7a made cv2.imencode raise on -
    used to escape as a bare framework 500 with no JSON body. Same convention
    as /api/count's test_encode_failure_is_a_plain_error_not_a_broken_image:
    a ValueError becomes a 400 carrying the `error` key."""
    monkeypatch.setattr(app_module.cv2, "imencode", lambda *a, **k: (False, None))
    files = [("images", (p.split("/")[-1], _read(p), "image/tiff")) for p in PAIR]
    r = client.post("/api/pairs", files=files)
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/json")
    assert "encode" in r.json()["error"].lower()


@pytest.mark.data
def test_thumbs_encode_failure_is_a_plain_error_not_a_bare_500(monkeypatch):
    """B7j, /api/thumbs side - see test_pairs_encode_failure_... above."""
    monkeypatch.setattr(app_module.cv2, "imencode", lambda *a, **k: (False, None))
    files = [("images", (PAIR[0].split("/")[-1], _read(PAIR[0]), "image/tiff"))]
    r = client.post("/api/thumbs", files=files)
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/json")
    assert "encode" in r.json()["error"].lower()


@pytest.mark.data
def test_decode_cache_is_shared_across_thumbs_and_pairs(monkeypatch):
    """/api/thumbs, /api/pairs and /api/count each used to re-decode the same
    upload bytes from scratch (audit-backend.md #10). A content-hash-keyed
    cache must make the second request against the same bytes decode nothing,
    while a genuinely new batch (different bytes) still gets decoded."""
    calls = []
    real_imdecode = app_module.cv2.imdecode

    def counting_imdecode(*a, **kw):
        calls.append(1)
        return real_imdecode(*a, **kw)

    monkeypatch.setattr(app_module.cv2, "imdecode", counting_imdecode)
    app_module._DECODE_CACHE.clear()

    files = [("images", (p.split("/")[-1], _read(p), "image/tiff")) for p in PAIR]
    r1 = client.post("/api/thumbs", files=files)
    assert r1.status_code == 200
    after_thumbs = len(calls)
    assert after_thumbs == 2          # both uploads genuinely decoded once

    files2 = [("images", (p.split("/")[-1], _read(p), "image/tiff")) for p in PAIR]
    r2 = client.post("/api/pairs", files=files2)
    assert r2.status_code == 200
    assert len(calls) == after_thumbs   # same bytes: nothing new decoded

    other = TIF + "10x tile picture 1; last three rows.tif"
    files3 = [("images", (other.split("/")[-1], _read(other), "image/tiff"))]
    r3 = client.post("/api/thumbs", files=files3)
    assert r3.status_code == 200
    assert len(calls) == after_thumbs + 1   # a new batch's bytes are a genuine miss


# --- sweep progress -------------------------------------------------------
#
# /api/pairs answers once, at the end. A cold comparison costs ~64 ms (measured
# 2026-09-21 on data/png with the stitch cache cleared: 45 comparisons 2.91 s,
# 78 comparisons 5.22 s, 120 comparisons 7.47 s), so a drop big enough to
# matter is a wait the browser has to be able to draw. These cover the channel
# that makes that possible: group_captures reporting as it goes, and the
# registry /api/sweep reads it back out of.


@pytest.mark.data
def test_group_captures_reports_every_comparison_including_rejected_ones():
    import cv2
    import numpy as np
    import pipeline

    # Two same-sized captures and one odd one out: the odd pairs are rejected on
    # shape alone and never reach stitch_pair. A bar that only counted the
    # expensive comparisons would stall on exactly those.
    a = cv2.cvtColor(cv2.imread(PAIR[0], cv2.IMREAD_COLOR), cv2.COLOR_BGR2GRAY)
    b = cv2.cvtColor(cv2.imread(PAIR[1], cv2.IMREAD_COLOR), cv2.COLOR_BGR2GRAY)
    odd = np.zeros((40, 40), np.uint8)

    seen = []
    pipeline.group_captures([a, b, odd], skipped=[], progress=lambda d, t: seen.append((d, t)))

    assert seen[0] == (0, 3), "the total is known before any work is done"
    assert seen[-1] == (3, 3), "every comparison is accounted for at the end"
    assert [d for d, _ in seen] == [0, 1, 2, 3], "one report per comparison, in order"


@pytest.mark.data
def test_sweep_progress_is_readable_while_the_sweep_runs():
    """The whole point: an answer WHILE /api/pairs holds the count lock."""
    import threading

    files = [("images", (p.split("/")[-1], _read(p), "image/tiff")) for p in PAIR]
    seen = []

    def watch():
        for _ in range(60):
            seen.append(client.get("/api/sweep/watch-me").json())
            time.sleep(0.02)

    t = threading.Thread(target=watch)
    t.start()
    r = client.post("/api/pairs", files=files, data={"job": "watch-me"})
    t.join()

    assert r.status_code == 200
    # One pair is one comparison, so the only figures possible are 0 of 0
    # (before it registered or after it was collected) and the sweep's own.
    assert {"done": 1, "total": 1} in seen or {"done": 0, "total": 1} in seen


def test_unknown_sweep_job_is_no_news_not_an_error():
    """The browser polls from the moment it starts uploading, so "not
    registered yet" is the normal first answer and must not read as a failure -
    a 404 would snap a bar that has not started back to an error state."""
    r = client.get("/api/sweep/nobody-by-that-name")
    assert r.status_code == 200
    assert r.json() == {"done": 0, "total": 0}


@pytest.mark.parametrize("job", ["../etc", "a b", "x" * 65, "", "a/b"])
def test_a_job_name_the_server_will_not_hold_is_simply_not_held(job):
    """The id becomes a dictionary key on a process that runs for days. One that
    is unbounded or not a plain name is ignored rather than stored - and the
    sweep itself still runs, because progress is never what a count depends on."""
    assert app_module._sweep_job(job) is None


def test_the_sweep_registry_does_not_grow_without_bound():
    """An abandoned tab never comes back for its entry."""
    for i in range(app_module._SWEEP_MAX + 20):
        app_module._sweep_set(f"job-{i}", 1, 10)
    assert len(app_module._SWEEP) <= app_module._SWEEP_MAX
    # The newest survive: the oldest are the ones nobody is still watching.
    assert f"job-{app_module._SWEEP_MAX + 19}" in app_module._SWEEP
