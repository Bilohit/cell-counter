import app as app_module
from fastapi.testclient import TestClient

client = TestClient(app_module.app)


def test_shutdown_needs_header_and_exits(monkeypatch):
    calls = []
    monkeypatch.setattr(app_module.threading, "Timer",
                        lambda d, f, args: type("T", (), {"start": lambda s: calls.append(args)})())
    assert client.post("/api/shutdown").status_code == 403
    assert calls == []
    r = client.post("/api/shutdown", headers={"X-Cell-Counter": "restart"})
    assert r.status_code == 200 and calls == [(0,)]
