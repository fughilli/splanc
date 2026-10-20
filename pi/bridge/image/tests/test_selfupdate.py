"""splanc_image.selfupdate: latest.json parsing, sha256 + tarball safety, the
symlink switch and pruning — against an in-memory fake of splanc.io."""

import hashlib
import io
import json
import os
import tarfile

import pytest
from splanc_image import selfupdate as su

LATEST = "https://splanc.io/agent/latest.json"


def make_tgz(version, extra=None, top=None, mjs=b"// bridge-ctl\n", bundle_version=None):
    top = top or f"splanc-agent-{version}"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:

        def add(name, data, **kw):
            ti = tarfile.TarInfo(name)
            for k, v in kw.items():
                setattr(ti, k, v)
            if ti.type == tarfile.REGTYPE:
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
            else:
                t.addfile(ti)

        add(top, b"", type=tarfile.DIRTYPE, mode=0o755)
        bj = {"schema": "splanc-agent-bundle/1", "version": bundle_version or version}
        add(f"{top}/bundle.json", json.dumps(bj).encode(), mode=0o644)
        if mjs is not None:
            add(f"{top}/mcp/splanc-agent.mjs", mjs, mode=0o755)
        for args in extra or []:
            add(*args[:2], **(args[2] if len(args) > 2 else {}))
    return buf.getvalue()


class FakeSite:
    def __init__(self):
        self.files = {}
        self.calls = []

    def publish(self, version, tgz, sha=None):
        url = f"https://splanc.io/agent/splanc-agent-{version}.tgz"
        self.files[url] = tgz
        doc = {"version": version, "url": url, "sha256": sha or hashlib.sha256(tgz).hexdigest()}
        self.files[LATEST] = json.dumps(doc).encode()

    def fetch(self, url, limit):
        self.calls.append(url)
        data = self.files[url]
        if len(data) > limit:
            raise su.UpdateError("too big")
        return data


@pytest.fixture
def site():
    return FakeSite()


def baked_dir(tmp_path, version="1.7.1"):
    d = tmp_path / "baked"
    (d / "mcp").mkdir(parents=True)
    (d / "mcp" / "splanc-agent.mjs").write_text("// old\n")
    (d / "bundle.json").write_text(json.dumps({"version": version}))
    return str(d)


def test_installs_newer_bundle_and_marks_restart(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("1.8.0", make_tgz("1.8.0"))
    r = su.update(str(state), baked=baked_dir(tmp_path), fetch=site.fetch)
    assert r.updated and r.version == "1.8.0"
    assert os.readlink(state / "current") == "agent/1.8.0"
    assert (state / "current" / "mcp" / "splanc-agent.mjs").read_bytes() == b"// bridge-ctl\n"
    assert (state / ".updated").read_text().strip() == "1.8.0"
    # mode bits are normalized, not taken from the tarball
    assert oct(os.stat(state / "current" / "bundle.json").st_mode & 0o777) == "0o644"


def test_up_to_date_is_a_noop(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("1.7.1", make_tgz("1.7.1"))
    r = su.update(str(state), baked=baked_dir(tmp_path, "1.7.1"), fetch=site.fetch)
    assert not r.updated and "up to date" in r.message
    assert site.calls == [LATEST]  # never downloaded the bundle
    assert not (state / "current").exists()


def test_force_reinstalls(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("1.7.1", make_tgz("1.7.1"))
    r = su.update(str(state), baked=baked_dir(tmp_path, "1.7.1"), fetch=site.fetch, force=True)
    assert r.updated


def test_rollback_to_an_older_published_version(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("2.0.0", make_tgz("2.0.0"))
    su.update(str(state), fetch=site.fetch)
    site.publish("1.9.0", make_tgz("1.9.0"))
    r = su.update(str(state), fetch=site.fetch)
    assert r.updated and os.readlink(state / "current") == "agent/1.9.0"


def test_keeps_current_and_previous_only(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    for v in ("1.8.0", "1.9.0", "2.0.0"):
        site.publish(v, make_tgz(v))
        su.update(str(state), fetch=site.fetch)
    assert sorted(os.listdir(state / "agent")) == ["1.9.0", "2.0.0"]
    assert not [n for n in os.listdir(state) if n.startswith(".staging")]


def test_sha256_mismatch_changes_nothing(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("1.8.0", make_tgz("1.8.0"), sha="0" * 64)
    with pytest.raises(su.UpdateError, match="sha256"):
        su.update(str(state), fetch=site.fetch)
    assert not (state / "current").exists()
    assert not (state / ".updated").exists()


@pytest.mark.parametrize(
    "extra,match",
    [
        ([("../evil", b"x")], "outside"),
        ([("/etc/passwd", b"x")], "outside"),
        ([("splanc-agent-1.8.0/../../x", b"x")], "outside"),
        (
            [("splanc-agent-1.8.0/link", b"", {"type": tarfile.SYMTYPE, "linkname": "/etc"})],
            "plain",
        ),
        ([("splanc-agent-1.8.0/dev", b"", {"type": tarfile.CHRTYPE})], "plain"),
        ([("other-top/x", b"x")], "outside"),
    ],
)
def test_hostile_tarballs_are_rejected(tmp_path, site, extra, match):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("1.8.0", make_tgz("1.8.0", extra=extra))
    with pytest.raises(su.UpdateError, match=match):
        su.update(str(state), fetch=site.fetch)
    assert not (state / "current").exists()
    assert not (tmp_path / "evil").exists() and not (tmp_path / "x").exists()


def test_bundle_must_match_and_contain_the_agent(tmp_path, site):
    state = tmp_path / "state"
    state.mkdir()
    site.publish("1.8.0", make_tgz("1.8.0", bundle_version="1.7.0"))
    with pytest.raises(su.UpdateError, match="bundle.json"):
        su.update(str(state), fetch=site.fetch)
    site.publish("1.8.0", make_tgz("1.8.0", mjs=None))
    with pytest.raises(su.UpdateError, match="splanc-agent.mjs"):
        su.update(str(state), fetch=site.fetch)


@pytest.mark.parametrize(
    "doc,match",
    [
        ({"version": "1.8.0", "url": "http://splanc.io/a.tgz", "sha256": "a" * 64}, "non-https"),
        ({"version": "1.8.0; rm -rf /", "url": "https://x/a.tgz", "sha256": "a" * 64}, "version"),
        ({"version": "../1.8.0", "url": "https://x/a.tgz", "sha256": "a" * 64}, "version"),
        ({"version": "1.8.0", "url": "https://x/a.tgz", "sha256": "zz"}, "sha256"),
        ({"version": "1.8.0", "sha256": "a" * 64}, "url"),
    ],
)
def test_latest_json_is_strict(doc, match):
    with pytest.raises(su.UpdateError, match=match):
        su.parse_latest(json.dumps(doc).encode())


def test_live_latest_json_shape_parses():
    # The shape splanc.io serves today (extra fields are fine).
    doc = {
        "version": "1.7.1",
        "sha256": "bdd9fc71b2177f648755245ba040c51fc3e8a693bfe428bdd50b09d5dd46a402",
        "url": "https://splanc.io/agent/splanc-agent.tgz",
        "source": {"repository": "fughilli/splanc", "release": "firmware-v1.7.1"},
    }
    assert su.parse_latest(json.dumps(doc).encode()).version == "1.7.1"


def test_main_honours_auto_update_off(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SPLANC_AUTO_UPDATE", "0")
    assert su.main(["--dir", str(tmp_path), "--auto"]) == 0
    assert "off" in capsys.readouterr().out
