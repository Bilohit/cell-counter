"""The release zip must carry the ML weights the default engine loads, and
must not carry training checkpoints."""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _mod():
    spec = importlib.util.spec_from_file_location("build_release", os.path.join(ROOT, "tools", "build_release.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_payload_carries_weights_not_runs(tmp_path):
    m = _mod()
    m.stage_payload(tmp_path)
    assert (tmp_path / "ml" / "weights" / "cellnet.json").exists()
    # Every model the shipped ensemble averages, not just the first: predict()
    # raises on a missing one rather than quietly counting with fewer models
    # than its threshold was tuned for, so a short payload is a broken release.
    cfg = json.loads((tmp_path / "ml" / "weights" / "cellnet.json").read_text())
    for name in cfg["ensemble"]:
        assert (tmp_path / "ml" / "weights" / name).exists(), name
    assert not (tmp_path / "ml" / "runs").exists()
    assert not list((tmp_path / "ml").rglob("*.pt"))


def test_payload_carries_no_annotation_provenance(tmp_path):
    """ml/ ships wholesale, so anything dropped in it reaches every lab machine.
    Annotation audit trails belong with the ground truth, which stays home."""
    m = _mod()
    m.stage_payload(tmp_path)
    stray = [p.name for p in (tmp_path / "ml").glob("*.json")]
    assert stray == [], stray


@pytest.mark.skipif(not os.path.isdir(os.path.join(ROOT, "static")),
                    reason="static/ is a build output; run `cd web && npm run build`")
def test_staged_payload_imports_app(tmp_path):
    """The zip carries PAYLOAD and nothing else from the repo, so a module app.py
    imports that PAYLOAD leaves out kills the app on the lab machine's first
    launch (v1.0 shipped without imaging.py). Import app from the staged payload
    alone, with the repo off sys.path."""
    m = _mod()
    m.stage_payload(tmp_path)
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    r = subprocess.run([sys.executable, "-c", "import app"], cwd=tmp_path, env=env,
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def _add_member(tf, name, *, linkname=None, symlink=False, hardlink=False, content=b"x"):
    ti = tarfile.TarInfo(name=name)
    if symlink:
        ti.type = tarfile.SYMTYPE
        ti.linkname = linkname
        tf.addfile(ti)
    elif hardlink:
        ti.type = tarfile.LNKTYPE
        ti.linkname = linkname
        tf.addfile(ti)
    else:
        ti.size = len(content)
        tf.addfile(ti, io.BytesIO(content))


def test_untar_rejects_dotdot_traversal(tmp_path):
    """A member named python/../../evil resolves outside dest: must raise
    rather than write there (classic tar-slip)."""
    m = _mod()
    tgz = tmp_path / "eviltar.tar.gz"
    with tarfile.open(tgz, "w:gz") as tf:
        _add_member(tf, "python/../../evil", content=b"pwned")
    dest = tmp_path / "dest"
    outside = tmp_path / "evil"
    with pytest.raises(SystemExit):
        m.untar(tgz, dest)
    assert not outside.exists()


def test_untar_rejects_deep_traversal_sibling_escape(tmp_path):
    """A member whose `..` components climb exactly out of dest into a sibling
    directory must be rejected and must not land there."""
    m = _mod()
    tgz = tmp_path / "eviltar2.tar.gz"
    with tarfile.open(tgz, "w:gz") as tf:
        # dest = tmp_path/nested/dest2 -> two ".." climbs out of dest2 and out
        # of "nested", landing the write at tmp_path/evil2.
        _add_member(tf, "python/" + "../" * 2 + "evil2", content=b"pwned")
    dest = tmp_path / "nested" / "dest2"
    outside = tmp_path / "evil2"
    with pytest.raises(SystemExit):
        m.untar(tgz, dest)
    assert not outside.exists()


def test_untar_rejects_symlink_target_escaping_root(tmp_path):
    """A recorded symlink target is written verbatim into the release zip as a
    real symlink (zip_stage, external_attr S_IFLNK). A linkname like
    ../../../../etc/passwd never touches the build machine's filesystem, but it
    escapes on the end user's machine the moment they unzip it - the same
    tar-slip threat the member-name guard already covers, just downstream."""
    m = _mod()
    tgz = tmp_path / "eviltar3.tar.gz"
    with tarfile.open(tgz, "w:gz") as tf:
        _add_member(tf, "python/lib/evillink", linkname="../../../../etc/passwd", symlink=True)
    dest = tmp_path / "dest"
    with pytest.raises(SystemExit):
        m.untar(tgz, dest)


def test_untar_rejects_hardlink_target_escaping_root(tmp_path):
    m = _mod()
    tgz = tmp_path / "eviltar4.tar.gz"
    with tarfile.open(tgz, "w:gz") as tf:
        _add_member(tf, "python/lib/evilhard", linkname="../../../outside", hardlink=True)
    dest = tmp_path / "dest"
    with pytest.raises(SystemExit):
        m.untar(tgz, dest)


def test_untar_rejects_absolute_symlink_target(tmp_path):
    m = _mod()
    tgz = tmp_path / "eviltar5.tar.gz"
    with tarfile.open(tgz, "w:gz") as tf:
        _add_member(tf, "python/lib/evilabs", linkname="/etc/passwd", symlink=True)
    dest = tmp_path / "dest"
    with pytest.raises(SystemExit):
        m.untar(tgz, dest)


def test_untar_keeps_legitimate_relative_symlink_inside_tree(tmp_path):
    """The macOS runtime will not launch without its ordinary relative
    symlinks (e.g. python3.11 -> a sibling binary, ../Python from a Frameworks
    subdir). The guard must not reject a link whose target resolves inside the
    extraction root - only ones that escape it."""
    m = _mod()
    tgz = tmp_path / "goodtar.tar.gz"
    with tarfile.open(tgz, "w:gz") as tf:
        _add_member(tf, "python/bin/python3.11", content=b"real")
        _add_member(tf, "python/bin/python3", linkname="python3.11", symlink=True)
        _add_member(tf, "python/lib/foo", content=b"real2")
        _add_member(tf, "python/lib/bar", linkname="../lib/foo", symlink=True)
    dest = tmp_path / "dest"
    meta = m.untar(tgz, dest)
    assert meta["links"]["bin/python3"] == "python3.11"
    assert meta["links"]["lib/bar"] == "../lib/foo"


def test_asset_urls_pagination_fetches_short_first_page(monkeypatch):
    """The bare API call (no per_page) returns GitHub's default page (< 100
    assets) even when the release has more. The old condition
    `len(assets) >= 100*(page-1)` never enters the loop when the first batch
    is already under 100 (30 >= 100 is false), so it silently drops every
    asset past the first page. The loop must always try page 2 and keep
    going until a page comes back with fewer than 100 items."""
    m = _mod()
    page1 = [{"name": f"cpython-{m.PYV}.0+1-x-install_only.tar.gz", "browser_download_url": "u", "digest": None} for _ in range(30)]
    page2 = [{"name": f"cpython-{m.PYV}.0+1-y-install_only.tar.gz", "browser_download_url": "u2", "digest": None} for _ in range(15)]
    calls = {"n": 0}

    def fake_fetch(url):
        calls["n"] += 1
        if url == m.API:
            return {"assets": list(page1), "url": "https://api/rel", "tag_name": "v1"}
        if "page=2" in url:
            return list(page2)
        pytest.fail(f"unexpected extra page fetch: {url}")

    monkeypatch.setattr(m, "fetch_json", fake_fetch)
    urls = m.asset_urls()
    assert set(urls) == {"x", "y"}
    assert calls["n"] == 2


def test_download_verifies_digest_mismatch_raises(tmp_path):
    m = _mod()
    dest = tmp_path / "f.tar.gz"

    def fake_urlopen(req):
        class _R(io.BytesIO):
            def __enter__(self2):
                return self2

            def __exit__(self2, *a):
                return False

        return _R(b"payload-bytes")

    monkeypatch_urlopen = fake_urlopen
    import urllib.request as ur
    orig = ur.urlopen
    ur.urlopen = monkeypatch_urlopen
    try:
        with pytest.raises(SystemExit):
            m.download("http://x/f.tar.gz", dest, digest="sha256:" + "0" * 64)
    finally:
        ur.urlopen = orig


def test_download_verifies_digest_match_ok(tmp_path):
    m = _mod()
    dest = tmp_path / "f2.tar.gz"
    payload = b"payload-bytes"
    good = "sha256:" + hashlib.sha256(payload).hexdigest()

    def fake_urlopen(req):
        class _R(io.BytesIO):
            def __enter__(self2):
                return self2

            def __exit__(self2, *a):
                return False

        return _R(payload)

    import urllib.request as ur
    orig = ur.urlopen
    ur.urlopen = fake_urlopen
    try:
        out = m.download("http://x/f2.tar.gz", dest, digest=good)
        assert out == dest
        assert dest.read_bytes() == payload
    finally:
        ur.urlopen = orig


def test_download_no_digest_field_proceeds(tmp_path):
    """Older API responses may omit `digest`; the build must not break."""
    m = _mod()
    dest = tmp_path / "f3.tar.gz"
    payload = b"payload-bytes"

    def fake_urlopen(req):
        class _R(io.BytesIO):
            def __enter__(self2):
                return self2

            def __exit__(self2, *a):
                return False

        return _R(payload)

    import urllib.request as ur
    orig = ur.urlopen
    ur.urlopen = fake_urlopen
    try:
        out = m.download("http://x/f3.tar.gz", dest, digest=None)
        assert out == dest
    finally:
        ur.urlopen = orig


def test_readme_download_links_match_the_release_zip_names():
    """README.md links straight to releases/latest/download/<zip>; GitHub serves
    only an exact asset name, so a rename in build_release.py that is not made
    in the README too leaves lab users a dead download link."""
    readme = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
    for name in _mod().ZIP_NAME.values():
        assert " " not in name, name
        assert f"releases/latest/download/{name}" in readme, name


def test_read_me_first_explains_the_sample_naming_rule():
    """Name groups only fire when captures of one sample share a first word, and
    a lab user learns that from the zip's READ ME FIRST.txt, not the app."""
    m = _mod()
    for text in (m.MAC_README + m.USING, m.WIN_README + m.USING):
        assert "Name groups" in text and "followed by a" in text


def test_zip_refuses_paths_explorer_would_drop(tmp_path):
    """Explorer's Extract All silently skips files whose full path passes 260
    chars, so a deep entry is a file missing on some lab machines, not an error."""
    m = _mod()
    stage = tmp_path / "stage"
    deep = stage / ("d" * (m.MAX_ZIP_PATH + 10)) / "f.py"
    deep.parent.mkdir(parents=True)
    deep.write_text("")
    with pytest.raises(SystemExit):
        m.zip_stage(stage, {}, tmp_path / "out.zip", set())
