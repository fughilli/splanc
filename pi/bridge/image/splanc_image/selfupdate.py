"""Self-update of the Splanc agent bundle on the bridge image.

The image bakes one agent bundle (agent-pin.json) into the read-only Nix store.
This keeps a newer one, when splanc.io publishes it, in a state directory owned
by a dedicated `splanc-update` user (the bridge itself can only read it):

    <dir>/agent/<version>/      unpacked bundles (the current one + the previous)
    <dir>/current -> agent/<v>  what splanc-bridge.service runs (absent: the baked one)
    <dir>/.updated              marker: the unit restarts the bridge when present
    <dir>/update-status.json    what the screens show: the running version, the
                                one latest.json offers (+ size), progress

Nothing is installed without the user's say-so: `check` (the timer) only reads
latest.json and records what it offers; `install` (confirmed on the bridge's
screen, or `splanc-bridge update` over SSH) installs the version that check
recorded -- the one the screen showed.

Offer rule: whatever version latest.json names unless it is already the one
running -- so publishing an older version there is how a bad release is rolled
back (the user confirms that too). A bundle is only ever switched to after its
sha256 matches latest.json, it unpacks cleanly (regular files and directories
only, all inside one `splanc-agent-<version>/` top directory) and its
bundle.json names that version.

    python3 -m splanc_image.selfupdate check|install --dir /var/lib/splanc-agent \\
        --baked /nix/store/...-splanc-agent-1.7.1 [--auto] [--force]

Exit status: 0 checked / up to date / updated, 1 failure (the timer tries again later).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import ssl
import sys
import tarfile
import tempfile
import time
import urllib.request
from dataclasses import dataclass, replace
from typing import Callable, Optional

DEFAULT_LATEST = "https://splanc.io/agent/latest.json"
MAX_BUNDLE_BYTES = 64 << 20  # today's bundle is ~0.5 MB
MAX_LATEST_BYTES = 64 << 10
MAX_NOTES = 280
KEEP = 2  # current + previous
STATUS_FILE = "update-status.json"

_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$")
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")

Fetch = Callable[[str, int], bytes]
Head = Callable[[str], Optional[int]]  # url -> Content-Length (None: unknown)


class UpdateError(Exception):
    pass


@dataclass(frozen=True)
class Latest:
    version: str
    url: str
    sha256: str
    size: Optional[int] = None  # bytes, when latest.json says
    notes: str = ""  # a short summary, when latest.json has one


@dataclass(frozen=True)
class Result:
    updated: bool
    version: str
    message: str


def _https_only(url: str, allow_http: bool) -> str:
    if url.startswith("https://") or (allow_http and url.startswith("http://")):
        return url
    raise UpdateError(f"refusing non-https URL {url!r}")


def fetch_url(url: str, limit: int) -> bytes:
    """GET ``url`` (at most ``limit`` bytes) with certificate verification."""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "splanc-bridge-image"})
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:  # noqa: S310 - https only
        data = r.read(limit + 1)
    if len(data) > limit:
        raise UpdateError(f"{url} is larger than {limit} bytes")
    return data


def head_size(url: str) -> Optional[int]:
    """The download size (HEAD Content-Length), best effort."""
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            url, method="HEAD", headers={"User-Agent": "splanc-bridge-image"}
        )
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:  # noqa: S310
            n = r.headers.get("Content-Length")
        return int(n) if n and n.isdigit() else None
    except (OSError, ValueError):
        return None


def parse_latest(data: bytes, *, allow_http: bool = False) -> Latest:
    """latest.json -> Latest. Strict: every field present and well formed."""
    try:
        doc = json.loads(data)
    except ValueError as e:
        raise UpdateError(f"latest.json is not JSON: {e}") from e
    if not isinstance(doc, dict):
        raise UpdateError("latest.json is not an object")
    version, url, sha = doc.get("version"), doc.get("url"), doc.get("sha256")
    if not isinstance(version, str) or not _VERSION_RE.match(version):
        raise UpdateError(f"latest.json: bad version {version!r}")
    if not isinstance(url, str):
        raise UpdateError("latest.json: no url")
    if not isinstance(sha, str) or not _SHA_RE.match(sha.lower()):
        raise UpdateError(f"latest.json: bad sha256 {sha!r}")
    size = doc.get("size")
    notes = doc.get("notes")
    return Latest(
        version=version,
        url=_https_only(url, allow_http),
        sha256=sha.lower(),
        size=size if isinstance(size, int) and not isinstance(size, bool) and size > 0 else None,
        notes=" ".join(notes.split())[:MAX_NOTES] if isinstance(notes, str) else "",
    )


def bundle_version(bundle_dir: str) -> Optional[str]:
    """The version a bundle directory's bundle.json names, or None."""
    try:
        with open(os.path.join(bundle_dir, "bundle.json"), encoding="utf-8") as f:
            v = json.load(f).get("version")
    except (OSError, ValueError, AttributeError):
        return None
    return v if isinstance(v, str) else None


def current_version(state_dir: str, baked: Optional[str]) -> Optional[str]:
    cur = os.path.join(state_dir, "current")
    if os.path.isfile(os.path.join(cur, "mcp", "splanc-agent.mjs")):
        return bundle_version(cur)
    return bundle_version(baked) if baked else None


def safe_extract(tgz: bytes, dest: str, version: str) -> str:
    """Unpack the bundle tarball into ``dest``; return the bundle's directory.

    Only regular files and directories under exactly one top directory
    ``splanc-agent-<version>/`` are accepted: no links, devices, absolute paths or
    ``..`` — anything else rejects the whole bundle before a byte is written."""
    top = f"splanc-agent-{version}"
    try:
        tf = tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz")
    except (tarfile.TarError, OSError, EOFError) as e:
        raise UpdateError(f"bundle is not a .tgz: {e}") from e
    with tf:
        members = tf.getmembers()
        if not members:
            raise UpdateError("bundle is empty")
        for m in members:
            name = m.name.rstrip("/")
            parts = name.split("/")
            if name.startswith("/") or ".." in parts or parts[0] != top:
                raise UpdateError(f"bundle entry outside {top}/: {m.name!r}")
            if not (m.isfile() or m.isdir()):
                raise UpdateError(f"bundle entry is not a plain file: {m.name!r}")
        for m in members:
            target = os.path.join(dest, *m.name.rstrip("/").split("/"))
            if m.isdir():
                os.makedirs(target, mode=0o755, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
            src = tf.extractfile(m)
            with open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            os.chmod(target, 0o755 if m.mode & 0o111 else 0o644)
    root = os.path.join(dest, top)
    if not os.path.isfile(os.path.join(root, "mcp", "splanc-agent.mjs")):
        raise UpdateError("bundle has no mcp/splanc-agent.mjs")
    got = bundle_version(root)
    if got != version:
        raise UpdateError(f"bundle.json says {got!r}, latest.json says {version!r}")
    return root


def _swap_current(state_dir: str, version: str) -> None:
    link = os.path.join(state_dir, "current")
    tmp = link + ".new"
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    os.symlink(os.path.join("agent", version), tmp)
    os.replace(tmp, link)  # atomic


def _prune(state_dir: str, keep: list) -> None:
    agents = os.path.join(state_dir, "agent")
    for name in os.listdir(agents):
        if name not in keep:
            shutil.rmtree(os.path.join(agents, name), ignore_errors=True)


def _write_status(state_dir: str, doc: dict) -> None:
    """update-status.json (world-readable: the display runs as another user)."""
    doc = dict(doc, v=1, updated_at=time.time())
    path = os.path.join(state_dir, STATUS_FILE)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError:
        pass


def read_status(state_dir: str) -> dict:
    try:
        with open(os.path.join(state_dir, STATUS_FILE), encoding="utf-8") as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def _offer(latest: Latest) -> dict:
    """The available record: shown on the screen, and what `install` installs."""
    return {
        "version": latest.version,
        "url": latest.url,
        "sha256": latest.sha256,
        "bytes": latest.size,
        "notes": latest.notes,
    }


def check(
    state_dir: str,
    *,
    latest_url: str = DEFAULT_LATEST,
    baked: Optional[str] = None,
    fetch: Fetch = fetch_url,
    head: Head = head_size,
    allow_http: bool = False,
) -> Result:
    """Read latest.json; record what it offers in update-status.json. Installs nothing."""
    running = current_version(state_dir, baked)
    base = {"current_version": running, "checked_at": time.time()}
    try:
        latest = parse_latest(
            fetch(_https_only(latest_url, allow_http), MAX_LATEST_BYTES), allow_http=allow_http
        )
    except (UpdateError, OSError) as e:
        prev = read_status(state_dir)
        _write_status(
            state_dir,
            dict(
                base,
                state="failed",
                message=f"update check failed: {e}",
                available=prev.get("available"),
            ),
        )
        raise
    if latest.version == running:
        _write_status(
            state_dir, dict(base, state="idle", message=f"up to date ({running})", available=None)
        )
        return Result(False, latest.version, f"up to date ({running})")
    if latest.size is None:
        latest = replace(latest, size=head(latest.url))
    _write_status(
        state_dir,
        dict(
            base, state="available", message=f"{latest.version} available", available=_offer(latest)
        ),
    )
    return Result(
        False, latest.version, f"{latest.version} available (running {running or 'none'})"
    )


def install(
    state_dir: str,
    *,
    latest_url: str = DEFAULT_LATEST,
    baked: Optional[str] = None,
    force: bool = False,
    fetch: Fetch = fetch_url,
    head: Head = head_size,
    allow_http: bool = False,
) -> Result:
    """Install the version the last check offered (the one the screen showed);
    with none recorded, check first."""
    av = read_status(state_dir).get("available")
    if force or not isinstance(av, dict):
        check(
            state_dir,
            latest_url=latest_url,
            baked=baked,
            fetch=fetch,
            head=head,
            allow_http=allow_http,
        )
        av = read_status(state_dir).get("available")
    running = current_version(state_dir, baked)
    if not isinstance(av, dict):
        if not force:
            return Result(False, running or "", f"up to date ({running})")
        latest = parse_latest(
            fetch(_https_only(latest_url, allow_http), MAX_LATEST_BYTES), allow_http=allow_http
        )
    else:
        latest = parse_latest(json.dumps(av).encode(), allow_http=allow_http)
        if isinstance(av.get("bytes"), int):
            latest = replace(latest, size=av["bytes"])
    base = {"current_version": running, "available": _offer(latest)}
    _write_status(
        state_dir, dict(base, state="downloading", message=f"downloading {latest.version}")
    )
    try:
        r = _install(state_dir, latest, running, force=force, fetch=fetch)
    except (UpdateError, OSError) as e:
        _write_status(state_dir, dict(base, state="failed", message=f"install failed: {e}"))
        raise
    _write_status(
        state_dir,
        {
            "current_version": latest.version,
            "available": None,
            "state": "idle",
            "message": r.message,
            "checked_at": time.time(),
        },
    )
    return r


def update(
    state_dir: str,
    *,
    latest_url: str = DEFAULT_LATEST,
    baked: Optional[str] = None,
    force: bool = False,
    fetch: Fetch = fetch_url,
    allow_http: bool = False,
) -> Result:
    """Check latest.json and switch to its bundle if it isn't the running one
    (check + install in one go: tests and tools; the bridge confirms first)."""
    latest = parse_latest(
        fetch(_https_only(latest_url, allow_http), MAX_LATEST_BYTES), allow_http=allow_http
    )
    running = current_version(state_dir, baked)
    if latest.version == running and not force:
        return Result(False, latest.version, f"up to date ({running})")
    return _install(state_dir, latest, running, force=force, fetch=fetch)


def _install(
    state_dir: str, latest: Latest, running: Optional[str], *, force: bool, fetch: Fetch
) -> Result:
    if latest.version == running and not force:
        return Result(False, latest.version, f"up to date ({running})")
    tgz = fetch(latest.url, MAX_BUNDLE_BYTES)
    got = hashlib.sha256(tgz).hexdigest()
    if got != latest.sha256:
        raise UpdateError(f"bundle {latest.version} failed its sha256 check (got {got})")

    agents = os.path.join(state_dir, "agent")
    os.makedirs(agents, mode=0o755, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".staging-", dir=state_dir)
    try:
        root = safe_extract(tgz, staging, latest.version)
        final = os.path.join(agents, latest.version)
        if os.path.exists(final):
            shutil.rmtree(final)
        os.rename(root, final)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    prev = os.path.basename(os.path.realpath(os.path.join(state_dir, "current")))
    _swap_current(state_dir, latest.version)
    _prune(state_dir, [latest.version, prev])
    with open(os.path.join(state_dir, ".updated"), "w") as f:
        f.write(latest.version + "\n")
    return Result(True, latest.version, f"updated {running or 'none'} -> {latest.version}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-agent-update", description=__doc__.split("\n")[0])
    ap.add_argument(
        "action",
        nargs="?",
        choices=("check", "install"),
        default="check",
        help="check: record what latest.json offers (default); install: install it",
    )
    ap.add_argument("--dir", default=os.environ.get("STATE_DIRECTORY", "/var/lib/splanc-agent"))
    ap.add_argument("--latest", default=os.environ.get("SPLANC_LATEST_URL", DEFAULT_LATEST))
    ap.add_argument("--baked", default=os.environ.get("SPLANC_AGENT_BAKED"))
    ap.add_argument("--auto", action="store_true", help="honour SPLANC_AUTO_UPDATE=0")
    ap.add_argument("--force", action="store_true", help="install: reinstall even if up to date")
    ap.add_argument("--allow-http", action="store_true", help=argparse.SUPPRESS)  # tests
    a = ap.parse_args(argv)
    if a.auto and os.environ.get("SPLANC_AUTO_UPDATE", "1").strip() == "0":
        print("automatic update checks are off (SPLANC_AUTO_UPDATE=0)")
        return 0
    kw = dict(latest_url=a.latest, baked=a.baked, allow_http=a.allow_http)
    state_dir = a.dir.split(":")[0]
    try:
        if a.action == "install":
            r = install(state_dir, force=a.force, **kw)
        else:
            r = check(state_dir, **kw)
    except (UpdateError, OSError) as e:
        print(f"splanc-agent-update: {e}", file=sys.stderr)
        return 1
    print(r.message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
