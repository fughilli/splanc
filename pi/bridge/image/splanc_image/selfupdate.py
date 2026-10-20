"""Self-update of the Splanc agent bundle on the bridge image.

The image bakes one agent bundle (agent-pin.json) into the read-only Nix store.
This keeps a newer one, when splanc.io publishes it, in a state directory owned
by a dedicated `splanc-update` user (the bridge itself can only read it):

    <dir>/agent/<version>/      unpacked bundles (the current one + the previous)
    <dir>/current -> agent/<v>  what splanc-bridge.service runs (absent: the baked one)
    <dir>/.updated              marker: the unit restarts the bridge when present

Update rule: install whatever version latest.json names unless it is already the
one running — so publishing an older version there is how a bad release is rolled
back. A bundle is only ever switched to after its sha256 matches latest.json,
it unpacks cleanly (regular files and directories only, all inside one
`splanc-agent-<version>/` top directory) and its bundle.json names that version.

    python3 -m splanc_image.selfupdate --dir /var/lib/splanc-agent \\
        --baked /nix/store/...-splanc-agent-1.7.1 [--auto] [--force]

Exit status: 0 up to date or updated, 1 failure (the timer tries again later).
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
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

DEFAULT_LATEST = "https://splanc.io/agent/latest.json"
MAX_BUNDLE_BYTES = 64 << 20  # today's bundle is ~0.5 MB
MAX_LATEST_BYTES = 64 << 10
KEEP = 2  # current + previous

_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$")
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")

Fetch = Callable[[str, int], bytes]


class UpdateError(Exception):
    pass


@dataclass(frozen=True)
class Latest:
    version: str
    url: str
    sha256: str


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
    return Latest(version=version, url=_https_only(url, allow_http), sha256=sha.lower())


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


def update(
    state_dir: str,
    *,
    latest_url: str = DEFAULT_LATEST,
    baked: Optional[str] = None,
    force: bool = False,
    fetch: Fetch = fetch_url,
    allow_http: bool = False,
) -> Result:
    """Check latest.json and switch to its bundle if it isn't the running one."""
    latest = parse_latest(
        fetch(_https_only(latest_url, allow_http), MAX_LATEST_BYTES), allow_http=allow_http
    )
    running = current_version(state_dir, baked)
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
    ap.add_argument("--dir", default=os.environ.get("STATE_DIRECTORY", "/var/lib/splanc-agent"))
    ap.add_argument("--latest", default=os.environ.get("SPLANC_LATEST_URL", DEFAULT_LATEST))
    ap.add_argument("--baked", default=os.environ.get("SPLANC_AGENT_BAKED"))
    ap.add_argument("--auto", action="store_true", help="honour SPLANC_AUTO_UPDATE=0")
    ap.add_argument("--force", action="store_true", help="reinstall even if up to date")
    ap.add_argument("--allow-http", action="store_true", help=argparse.SUPPRESS)  # tests
    a = ap.parse_args(argv)
    if a.auto and os.environ.get("SPLANC_AUTO_UPDATE", "1").strip() == "0":
        print("automatic updates are off (SPLANC_AUTO_UPDATE=0)")
        return 0
    try:
        r = update(
            a.dir.split(":")[0],
            latest_url=a.latest,
            baked=a.baked,
            force=a.force,
            allow_http=a.allow_http,
        )
    except (UpdateError, OSError) as e:
        print(f"splanc-agent-update: {e}", file=sys.stderr)
        return 1
    print(r.message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
