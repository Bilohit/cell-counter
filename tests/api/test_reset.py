"""POST /api/reset: a page load starts from nothing, server memory included.

Reload and close wipe the app's work (user ruling 2026-09-21) - the captures,
the counts, the hand corrections and the calculator all live in React state and
go with the page. The three server caches did not: they outlived the page that
filled them, so a reloaded app sat on top of a previous session's images and
decoded uploads until memory pressure got around to them.
"""
import pytest
import cv2
import numpy as np
from fastapi.testclient import TestClient

import app as app_module
import pipeline

client = TestClient(app_module.app)

TIF = "data/tif/10x tile picture 3; first three rows.tif"


def _count_once():
    with open(TIF, "rb") as fh:
        r = client.post("/api/count",
                        files=[("images", (TIF.split("/")[-1], fh, "image/tiff"))],
                        data={"params": "{}"})
    assert r.status_code == 200, r.text
    return r.json()["fields"][0]


@pytest.mark.data
def test_reset_makes_a_counted_image_unfetchable():
    """The image ids a page was handed must not outlive that page."""
    field = _count_once()
    ref = field["base_image"]
    assert client.get(ref).status_code == 200

    assert client.post("/api/reset").status_code == 200

    r = client.get(ref)
    assert r.status_code == 404
    # "unknown", not "expired": an id from before the reset does not belong to a
    # count the user can re-run, it belongs to a session that is gone. Telling
    # them to re-run a count that no longer exists is the wrong sentence.
    assert "never counted" in r.json()["error"].lower()


@pytest.mark.data
def test_reset_empties_all_three_caches():
    """The image store is the visible one; the decode and stitch caches hold
    far more bytes (256 MiB each) and are just as much a previous page's."""
    _count_once()
    assert app_module._IMAGE_STORE._bytes > 0
    assert app_module._DECODE_CACHE._bytes > 0

    client.post("/api/reset")

    assert app_module._IMAGE_STORE._bytes == 0
    assert app_module._DECODE_CACHE._bytes == 0
    assert pipeline._STITCH_CACHE._bytes == 0


def test_reset_is_safe_to_call_when_nothing_is_cached():
    """It runs on every page load, including the first one of a fresh server."""
    client.post("/api/reset")
    r = client.post("/api/reset")
    assert r.status_code == 200 and r.json() == {"ok": True}


@pytest.mark.data
def test_counting_still_works_after_a_reset():
    """A reset discards caches, never capability: the next count must answer
    exactly as before, with a fresh id."""
    first = _count_once()
    client.post("/api/reset")
    second = _count_once()

    assert second["count"] == first["count"]
    assert second["base_image"] != first["base_image"]
    r = client.get(second["base_image"])
    assert r.status_code == 200
    assert cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR) is not None
