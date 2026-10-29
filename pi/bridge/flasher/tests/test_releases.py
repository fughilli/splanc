"""Finding the image on its own release track, downloading and verifying it."""

import hashlib
import io
import json
import os

import pytest
from splanc_flasher import releases as rl


def asset(name, data=b"", digest=None):
    a = {"name": name, "browser_download_url": f"https://dl.example/{name}", "size": len(data)}
    if digest:
        a["digest"] = digest
    return a


def release(tag, assets, **kw):
    r = {
        "tag_name": tag,
        "draft": False,
        "prerelease": False,
        "published_at": "2026-10-20T00:00:00Z",
    }
    r.update(kw)
    r["assets"] = assets
    return r


def test_only_the_pi_bridge_track_counts_and_newest_wins():
    data = [
        release("firmware-v9.0.0", [asset("splanc-bridge-pi5-9.0.0.img.zst")]),
        release("pi-v3.0.0", [asset("ledmapper-pi3-3.0.0.img.zst")]),
        release(
            "pi-bridge-v1.10.0",
            [
                asset("splanc-bridge-pi5-1.10.0.img.zst"),
                asset("splanc-bridge-pi5-1.10.0.img.zst.sha256"),
            ],
        ),
        release("pi-bridge-v1.9.0", [asset("splanc-bridge-pi4-1.9.0.img.zst")]),
        release("pi-bridge-v1.11.0", [asset("splanc-bridge-pi5-1.11.0.img.zst")], draft=True),
        release("pi-bridge-v1.10.1", [asset("notes.txt")]),  # no images: skipped
        release("pi-bridge-v1.10.0-rc1", [asset("splanc-bridge-pi5-1.10.0-rc1.img.zst")]),
    ]
    rels = rl.parse_releases(data)
    assert [r.tag for r in rels] == [
        "pi-bridge-v1.10.0",
        "pi-bridge-v1.10.0-rc1",
        "pi-bridge-v1.9.0",
    ]
    top = rels[0]
    assert list(top.images) == ["pi5"]
    assert top.images["pi5"].checksum.name.endswith(".sha256")
    d = top.to_dict()
    assert d["version"] == "1.10.0" and d["boards"][0]["board_name"] == "Raspberry Pi 5"


def test_latest_release_skips_prereleases(monkeypatch):
    data = [
        release("pi-bridge-v2.0.0", [asset("splanc-bridge-pi4-2.0.0.img.zst")], prerelease=True),
        release("pi-bridge-v1.0.0", [asset("splanc-bridge-pi4-1.0.0.img.zst")]),
    ]
    monkeypatch.setattr(rl, "_get", lambda url, accept=None: json.dumps(data).encode())
    assert rl.latest_release().version == "1.0.0"
    assert rl.latest_release(include_prerelease=True).version == "2.0.0"


def test_list_releases_offers_every_version_with_the_final_one_as_default(monkeypatch):
    data = [
        release("pi-bridge-v1.0.0", [asset("splanc-bridge-pi4-1.0.0.img.zst")]),
        release("pi-bridge-v2.0.0", [asset("splanc-bridge-pi4-2.0.0.img.zst")], prerelease=True),
        release("pi-bridge-v1.1.0", [asset("splanc-bridge-pi4-1.1.0.img.zst")]),
    ]
    monkeypatch.setattr(rl, "_get", lambda url, accept=None: json.dumps(data).encode())
    rels = rl.list_releases()
    assert [r.version for r in rels] == ["2.0.0", "1.1.0", "1.0.0"]
    assert [r.to_dict()["prerelease"] for r in rels] == [True, False, False]
    assert rl.default_release(rels).version == "1.1.0"
    assert rl.default_release(rels[:1]).version == "2.0.0"  # only pre-releases
    assert rl.default_release([]) is None


def image(data, sha_text=None, digest=None):
    name = "splanc-bridge-pi4-1.0.0.img.zst"
    img = rl.Asset(name, f"https://dl.example/{name}", len(data), digest)
    chk = (
        rl.Asset(name + ".sha256", f"https://dl.example/{name}.sha256", 0)
        if sha_text is not None
        else None
    )
    return rl.Image("pi4", "1.0.0", "pi-bridge-v1.0.0", img, chk)


def test_expected_sha_prefers_file_and_cross_checks_digest():
    good = hashlib.sha256(b"x").hexdigest()
    files = {
        "https://dl.example/splanc-bridge-pi4-1.0.0.img.zst.sha256": f"{good}  name\n".encode()
    }
    fetch = files.__getitem__
    assert rl.expected_sha256(image(b"x", "y"), fetch) == good
    assert rl.expected_sha256(image(b"x", "y", digest=f"sha256:{good}"), fetch) == good
    with pytest.raises(ValueError, match="disagree"):
        rl.expected_sha256(image(b"x", "y", digest="sha256:" + "0" * 64), fetch)
    assert rl.expected_sha256(image(b"x", None, digest=f"sha256:{good}"), fetch) == good
    with pytest.raises(ValueError, match="no usable sha256"):
        rl.expected_sha256(image(b"x", None), fetch)


class FakeResponse(io.BytesIO):
    def __init__(self, data):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def serve(monkeypatch, files):
    monkeypatch.setattr(rl, "_open", lambda url, accept=None, timeout=60: FakeResponse(files[url]))


def _zstd_compress():
    try:
        from compression import zstd

        return zstd.compress
    except ImportError:
        pass
    try:
        import zstandard

        return zstandard.ZstdCompressor().compress
    except ImportError:
        return None


def test_damaged_download_is_refused_and_removed(monkeypatch, tmp_path):
    payload = b"\x28\xb5\x2f\xfd" + os.urandom(3000)
    img = image(payload, "y")
    sha_url = img.checksum.url
    files = {
        img.image.url: payload[:-1] + b"!",
        sha_url: (hashlib.sha256(payload).hexdigest() + "\n").encode(),
    }
    serve(monkeypatch, files)
    with pytest.raises(ValueError, match="damaged"):
        rl.fetch_image(img, cache_dir=str(tmp_path), fetch=files.__getitem__)
    assert os.listdir(tmp_path) == []


def test_download_verify_unpack_and_cache(monkeypatch, tmp_path):
    compress = _zstd_compress()
    if compress is None:
        pytest.skip("no zstd implementation (Python < 3.14 without zstandard)")
    raw = os.urandom(1 << 20) + b"\0" * (1 << 20)
    zst = compress(raw)
    img = image(zst, "y")
    files = {img.image.url: zst, img.checksum.url: hashlib.sha256(zst).hexdigest().encode()}
    serve(monkeypatch, files)
    stages = []
    out = rl.fetch_image(
        img,
        cache_dir=str(tmp_path),
        fetch=files.__getitem__,
        on_progress=lambda s, f, m: stages.append(s),
    )
    assert open(out, "rb").read() == raw
    assert {"download", "verify", "unpack"} <= set(stages)
    # Second run: reuses the unpacked image without downloading.
    monkeypatch.setattr(rl, "_open", lambda *a, **k: pytest.fail("downloaded again"))
    assert rl.fetch_image(img, cache_dir=str(tmp_path), fetch=files.__getitem__) == out


def test_cancel_during_download(monkeypatch, tmp_path):
    payload = os.urandom(3 << 20)
    img = image(payload, "y")
    files = {img.image.url: payload, img.checksum.url: hashlib.sha256(payload).hexdigest().encode()}
    serve(monkeypatch, files)
    with pytest.raises(InterruptedError):
        rl.fetch_image(
            img, cache_dir=str(tmp_path), fetch=files.__getitem__, cancelled=lambda: True
        )
