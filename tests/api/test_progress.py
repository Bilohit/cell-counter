"""GET /api/progress/{token}: the count says where it has got to, truthfully.

The ring used to be a timer easing toward a 0.95 cap - a guess dressed as a
measurement. Progress is now reported by the pipeline itself, and it travels on
its own GET rather than down the count's response, because that response is the
single path every refusal takes and streaming it would mean re-encoding all of
them as in-band events (council, 2026-09-21, unanimous).
"""
import threading

import pytest
from fastapi.testclient import TestClient

import app as app_module
import pipeline

client = TestClient(app_module.app)

TIF = "data/tif/10x tile picture 3; first three rows.tif"


def test_unknown_token_is_404_with_a_sentence():
    """404 means "no such token" and nothing else. The client draws an
    indeterminate sweep for it - never 0 %, which would be a lie about a count
    that may be nearly done."""
    r = client.get("/api/progress/never-issued")
    assert r.status_code == 404
    assert isinstance(r.json()["error"], str) and r.json()["error"]


@pytest.mark.data
def test_progress_rises_to_done_and_stays_readable():
    """The whole contract in one run: every reading is a real step, the fraction
    never goes backwards, and the finished token reports `done` rather than
    vanishing - a 404 on a SUCCESSFUL count would have the UI say it was lost."""
    seen = []
    stop = threading.Event()

    def poll():
        while not stop.is_set():
            r = client.get("/api/progress/tok-rise")
            if r.status_code == 200:
                seen.append(r.json())
            stop.wait(0.02)

    t = threading.Thread(target=poll, daemon=True)
    t.start()
    try:
        with open(TIF, "rb") as fh:
            r = client.post(
                "/api/count",
                files=[("images", (TIF.split("/")[-1], fh, "image/tiff"))],
                data={"params": '{"level": 1}', "token": "tok-rise"})
        assert r.status_code == 200, r.text
    finally:
        stop.set()
        t.join(timeout=2)

    assert seen, "the count finished without ever being observed"

    # Never backwards: a bar that retreats is worse than one that stands still.
    fracs = [s.get("frac", 0.0) for s in seen if s["state"] == "running"]
    assert fracs == sorted(fracs), fracs
    assert all(0.0 <= f <= 1.0 for f in fracs)

    # Every reading names a real step of the ten, with the label for that step.
    labels = dict(pipeline.PROGRESS_STEPS)
    for s in seen:
        assert s["total"] == pipeline.PROGRESS_TOTAL
        if s["state"] == "running":
            assert 1 <= s["step"] <= pipeline.PROGRESS_TOTAL
            assert s["label"] == labels[s["step"]]

    # The run was actually watched working, not just seen queued and done.
    assert any(s["state"] == "running" for s in seen)

    # Terminal state, not a 404.
    end = client.get("/api/progress/tok-rise")
    assert end.status_code == 200
    assert end.json()["state"] == "done"
    assert end.json()["frac"] == 1.0


def test_a_refused_count_reports_failed_not_done():
    """A capture with no grid in it is a refusal, and the token has to say so -
    a UI polling `done` would show a finished ring over an error."""
    import cv2
    import numpy as np
    ok, buf = cv2.imencode(".png", np.zeros((40, 40), np.uint8))
    assert ok
    r = client.post("/api/count",
                    files=[("images", ("tiny.png", buf.tobytes(), "image/png"))],
                    data={"params": '{"level": 1}', "token": "tok-fail"})
    assert r.status_code == 400

    at = client.get("/api/progress/tok-fail")
    assert at.status_code == 200
    assert at.json()["state"] == "failed"


@pytest.mark.data
def test_a_count_without_a_token_reports_nothing_and_still_counts():
    """The token is optional. A client that does not want progress - or an old
    one that does not know about it - must count exactly as before."""
    with open(TIF, "rb") as fh:
        r = client.post("/api/count",
                        files=[("images", (TIF.split("/")[-1], fh, "image/tiff"))],
                        data={"params": '{"level": 1}'})
    assert r.status_code == 200
    assert r.json()["fields"][0]["count"] > 0
    assert client.get("/api/progress/").status_code in (404, 405)


def test_the_token_map_is_bounded():
    """A client that navigates away mid-count leaves an entry behind, so the map
    must not grow without limit."""
    keep = app_module._Progress._KEEP
    for i in range(keep + 5):
        app_module._PROGRESS.queued(f"flood-{i}", 1)
    assert app_module._PROGRESS.get("flood-0") is None
    assert app_module._PROGRESS.get(f"flood-{keep + 4}") is not None
    # Oldest out first, newest kept.
    assert len(app_module._PROGRESS._at) == keep


def test_reset_forgets_progress_too():
    app_module._PROGRESS.queued("tok-reset", 1)
    client.post("/api/reset")
    assert app_module._PROGRESS.get("tok-reset") is None


@pytest.mark.parametrize("level", sorted(pipeline.LEVELS))
def test_every_rung_has_measured_weights_that_sum_to_one(level):
    """The ring fills on these, so a missing or unnormalised rung would make it
    lie. Measured by tools/measure_stages.py, not guessed."""
    w = pipeline.PROGRESS_WEIGHTS[level]
    assert len(w) == pipeline.PROGRESS_TOTAL
    assert abs(sum(w) - 1.0) < 1e-3, sum(w)
    # The detector dominates every rung - the reason the bar is weighted at all
    # and the reason step 7 emits a sub-tick per model pass.
    assert w[6] == max(w)


def test_progress_fraction_is_monotonic_across_the_whole_run():
    for level in pipeline.LEVELS:
        last = -1.0
        for step, _ in pipeline.PROGRESS_STEPS:
            for frac in (0.0, 0.5, 1.0):
                f = pipeline.progress_fraction(level, step, frac)
                assert f >= last - 1e-9, (level, step, frac, f, last)
                last = f
        assert abs(last - 1.0) < 1e-6
