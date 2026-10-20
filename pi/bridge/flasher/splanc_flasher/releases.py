"""Find, download, verify and unpack the Splanc bridge SD image.

Adapted from td-deploy Studio (app/deploy_engine/{download,releases}.py, MIT).

The image is built and published by CI (.github/workflows/pi-bridge-image.yml) on
its own release track: tags ``pi-bridge-v<X.Y.Z>`` in fughilli/splanc, each with
``splanc-bridge-<board>-<X.Y.Z>.img.zst`` + ``.img.zst.sha256`` per board. The
repo's other releases (firmware-v*, app-v*, pi-v*) are ignored, so GitHub's
"latest release" can't be used: we list releases and pick the newest
pi-bridge-v* by version.

Before anything is written to a card the download must match BOTH the published
``.sha256`` file and, when GitHub reports one, the asset's own sha256 digest.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import sys
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

REPO = os.environ.get("SPLANC_FLASHER_REPO", "fughilli/splanc")
TAG_PREFIX = "pi-bridge-v"
API = "https://api.github.com/repos/{repo}/releases?per_page=100"
USER_AGENT = "splanc-bridge-flasher"

BOARDS = {
    "pi5": "Raspberry Pi 5",
    "pi4": "Raspberry Pi 4 / 400",
    "pi3": "Raspberry Pi 3 (B, B+, A+)",
    "zero2w": "Raspberry Pi Zero 2 W",
}

OnProgress = Callable[[float, str], None]


def _noop(_f: float, _m: str) -> None:
    pass


def _ssl_context() -> ssl.SSLContext:
    """Verifying TLS that works in the frozen app (no OpenSSL CA store there):
    use certifi's roots when bundled; SSL_CERT_FILE overrides."""
    if not os.environ.get("SSL_CERT_FILE"):
        try:
            import certifi

            return ssl.create_default_context(cafile=certifi.where())
        except Exception:  # noqa: BLE001 - dev checkout without certifi
            pass
    return ssl.create_default_context()


def _open(url: str, accept: str = "application/octet-stream", timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok and url.startswith("https://api.github.com/"):
        req.add_header("Authorization", f"Bearer {tok}")
    return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context())  # noqa: S310


def _get(url: str, accept: str = "application/octet-stream") -> bytes:
    with _open(url, accept, timeout=30) as r:
        return r.read()


@dataclass
class Asset:
    name: str
    url: str
    size: int
    digest: Optional[str] = None  # "sha256:<hex>" when GitHub reports one


@dataclass
class Image:
    board: str
    version: str
    tag: str
    image: Asset
    checksum: Optional[Asset]

    def to_dict(self) -> dict:
        return {
            "board": self.board,
            "board_name": BOARDS.get(self.board, self.board),
            "version": self.version,
            "tag": self.tag,
            "name": self.image.name,
            "size": self.image.size,
        }


@dataclass
class Release:
    tag: str
    version: str
    published_at: str
    images: dict  # board -> Image
    url: str = ""

    def to_dict(self) -> dict:
        return {
            "tag": self.tag,
            "version": self.version,
            "published_at": self.published_at,
            "url": self.url,
            "boards": [self.images[b].to_dict() for b in BOARDS if b in self.images],
        }


def _version_key(v: str):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(.*)$", v)
    if not m:
        return (-1, -1, -1, 0, v)
    # A final release sorts after its pre-releases (1.0.0 > 1.0.0-rc1).
    return (int(m[1]), int(m[2]), int(m[3]), 0 if m[4] else 1, m[4])


def parse_releases(data, repo: str = REPO) -> list:
    """GitHub's releases JSON -> pi-bridge Releases that carry images, newest first."""
    if isinstance(data, (str, bytes, bytearray)):
        data = json.loads(data)
    out = []
    for r in data if isinstance(data, list) else []:
        tag = r.get("tag_name") or ""
        if r.get("draft") or not tag.startswith(TAG_PREFIX):
            continue
        version = tag[len(TAG_PREFIX) :]
        assets = {
            a["name"]: Asset(
                name=a["name"],
                url=a["browser_download_url"],
                size=int(a.get("size") or 0),
                digest=a.get("digest"),
            )
            for a in r.get("assets", [])
            if a.get("name") and a.get("browser_download_url")
        }
        images = {}
        for board in BOARDS:
            name = f"splanc-bridge-{board}-{version}.img.zst"
            if name in assets:
                images[board] = Image(
                    board, version, tag, assets[name], assets.get(name + ".sha256")
                )
        if images:
            out.append(
                Release(
                    tag=tag,
                    version=version,
                    published_at=r.get("published_at") or "",
                    images=images,
                    url=r.get("html_url") or "",
                )
            )
    out.sort(key=lambda rel: _version_key(rel.version), reverse=True)
    return out


def latest_release(repo: str = REPO, include_prerelease: bool = False) -> Optional[Release]:
    data = json.loads(_get(API.format(repo=repo), accept="application/vnd.github+json"))
    if not include_prerelease:
        data = [r for r in data if not r.get("prerelease")]
    rels = parse_releases(data, repo)
    return rels[0] if rels else None


def expected_sha256(img: Image, fetch: Callable[[str], bytes] = _get) -> str:
    """The sha256 the download must have: the .sha256 file, cross-checked against
    GitHub's asset digest when present. Raises if there is none or they disagree."""
    published = None
    if img.checksum is not None:
        text = fetch(img.checksum.url).decode("utf-8", "replace").strip()
        published = text.split()[0].lower() if text else None
    digest = None
    if img.image.digest and img.image.digest.startswith("sha256:"):
        digest = img.image.digest.split(":", 1)[1].strip().lower()
    if published and digest and published != digest:
        raise ValueError(f"{img.image.name}: the published checksum and GitHub's digest disagree")
    want = published or digest
    if not want or not re.fullmatch(r"[0-9a-f]{64}", want):
        raise ValueError(f"{img.image.name} has no usable sha256 checksum; refusing to flash it")
    return want


def sha256_file(path: str, on_progress: OnProgress = _noop) -> str:
    h = hashlib.sha256()
    total = os.path.getsize(path) or 1
    done = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4 << 20), b""):
            h.update(chunk)
            done += len(chunk)
            on_progress(done / total, "Checking the download")
    return h.hexdigest()


def _download(url: str, dest: str, size_hint: int, on_progress: OnProgress, cancelled) -> None:
    tmp = dest + ".part"
    with _open(url) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or size_hint or 0)
        done = 0
        while True:
            if cancelled():
                raise InterruptedError("cancelled")
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            on_progress(done / total if total else 0.0, f"{done >> 20} of {total >> 20} MB")
    os.replace(tmp, dest)


def _zstd_decompressor():
    """A stream decompressor: Python 3.14's compression.zstd, else `zstandard`."""
    try:
        from compression import zstd  # Python >= 3.14

        return lambda f: zstd.ZstdFile(f, "rb")
    except ImportError:
        pass
    try:
        import zstandard

        return lambda f: zstandard.ZstdDecompressor().stream_reader(f)
    except ImportError as e:
        raise RuntimeError("no zstd decompressor (needs Python 3.14+ or `zstandard`)") from e


def decompress_zst(
    src: str, dest: str, on_progress: OnProgress = _noop, cancelled=lambda: False
) -> None:
    opener = _zstd_decompressor()
    tmp = dest + ".part"
    total = os.path.getsize(src) or 1
    with open(src, "rb") as fi, open(tmp, "wb") as fo:
        reader = opener(fi)
        while True:
            if cancelled():
                raise InterruptedError("cancelled")
            chunk = reader.read(4 << 20)
            if not chunk:
                break
            fo.write(chunk)
            on_progress(min(fi.tell() / total, 1.0), "Unpacking the image")
    os.replace(tmp, dest)


def default_cache_dir() -> str:
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Caches")
    elif sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "Splanc Bridge Flasher", "images")


def fetch_image(
    img: Image,
    *,
    cache_dir: Optional[str] = None,
    on_progress: Callable[[str, float, str], None] = lambda stage, f, m: None,
    cancelled=lambda: False,
    fetch: Callable[[str], bytes] = _get,
) -> str:
    """Download (or reuse), verify and unpack ``img``; return the raw .img path.

    Stages reported: "download", "verify", "unpack". Only the newest image is
    kept in the cache (each is a GB or more unpacked)."""
    cache = cache_dir or default_cache_dir()
    os.makedirs(cache, exist_ok=True)
    want = expected_sha256(img, fetch)
    zst = os.path.join(cache, img.image.name)
    raw = zst[: -len(".zst")]
    marker = raw + ".sha256-of-zst"

    for name in os.listdir(cache):  # drop other versions/boards' files
        if not name.startswith(img.image.name[: -len(".zst")]):
            try:
                os.remove(os.path.join(cache, name))
            except OSError:
                pass

    def unpacked_ok() -> bool:
        try:
            with open(marker) as f:
                return f.read().strip() == want and os.path.exists(raw)
        except OSError:
            return False

    if unpacked_ok():
        on_progress("unpack", 1.0, "Using the image downloaded earlier")
        return raw

    have = (
        os.path.exists(zst) and sha256_file(zst, lambda f, m: on_progress("verify", f, m)) == want
    )
    if not have:
        on_progress("download", 0.0, f"Downloading {img.image.name}")
        _download(
            img.image.url,
            zst,
            img.image.size,
            lambda f, m: on_progress("download", f, m),
            cancelled,
        )
        got = sha256_file(zst, lambda f, m: on_progress("verify", f, m))
        if got != want:
            os.remove(zst)
            raise ValueError(
                f"The download is damaged (sha256 {got[:12]}..., expected {want[:12]}...). "
                "Check your connection and try again."
            )
    decompress_zst(zst, raw, lambda f, m: on_progress("unpack", f, m), cancelled)
    with open(marker, "w") as f:
        f.write(want + "\n")
    try:
        os.remove(zst)  # keep only the unpacked image (the marker remembers its hash)
    except OSError:
        pass
    return raw


def local_image(
    path: str, on_progress: Callable[[str, float, str], None] = lambda s, f, m: None
) -> str:
    """A user-picked .img / .img.zst (offline or test builds): unpack if needed."""
    if path.endswith(".zst"):
        raw = os.path.join(default_cache_dir(), os.path.basename(path)[: -len(".zst")])
        os.makedirs(os.path.dirname(raw), exist_ok=True)
        decompress_zst(path, raw, lambda f, m: on_progress("unpack", f, m))
        return raw
    return path
