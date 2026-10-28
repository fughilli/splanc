"""Nix binary-cache pieces shared by the bridge's system updater (sysupdate, on
the device) and its release tool (sysrelease, in CI).

A bridge system release is published as GitHub release assets (no other
infrastructure), which a stock Nix HTTP binary cache can't be laid out in: a
release holds at most 1000 assets, and one closure is ~610 store paths, so one
`.narinfo` + one NAR file per path doesn't fit. Instead:

  * every compressed NAR is its own asset, named exactly as in the cache
    (`<filehash>.nar.zst`: content-addressed, so boards share them);
  * all the closure's `.narinfo` texts travel in ONE manifest asset
    (``bridge-system-<board>-<version>.json``, schema MANIFEST_SCHEMA);
  * a small pointer (``bridge-system-<board>.json``, schema POINTER_SCHEMA) in a
    fixed "channel" release names the current manifest + its sha256.

The device rebuilds a local ``file://`` binary cache from the manifest (all the
narinfos, and only the NARs of store paths it doesn't have yet), then lets Nix
check the signatures and import it. The narinfo texts are kept verbatim, so the
ed25519 signatures CI made over them (``nix store sign``) are what Nix checks.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

MANIFEST_SCHEMA = "splanc-bridge-system/1"
POINTER_SCHEMA = "splanc-bridge-system-pointer/1"

STORE_DIR = "/nix/store"
NIX32_CHARS = "0123456789abcdfghijklmnpqrsvwxyz"

# <hash>-<name>, as Nix allows them (store-path.cc).
_HASH_RE = re.compile(r"^[0-9abcdfghijklmnpqrsvwxyz]{32}$")
_BASENAME_RE = re.compile(r"^([0-9abcdfghijklmnpqrsvwxyz]{32})-([A-Za-z0-9+\-._?=]{1,211})$")
# nar/<file hash>.nar[.<compression ext>] (what `nix copy --to file://` and
# nixpkgs' mkBinaryCache write).
_NAR_URL_RE = re.compile(r"^nar/([0-9a-z]{32,64}\.nar(?:\.(?:xz|zst|bz2|br|lz4|lzip|gz))?)$")
_NIX32_SHA256_RE = re.compile(r"^sha256:([0-9abcdfghijklmnpqrsvwxyz]{52})$")
_PUBKEY_RE = re.compile(r"^([A-Za-z0-9.\-_]{1,100}):([A-Za-z0-9+/]{43}=)$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$")
BOARD_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")


class CacheError(Exception):
    pass


def nix32(digest: bytes) -> str:
    """Nix's base-32 rendering of a hash (as in narinfo FileHash/NarHash)."""
    n = (len(digest) * 8 + 4) // 5
    out = []
    for i in range(n - 1, -1, -1):
        b = i * 5
        j, k = divmod(b, 8)
        c = digest[j] >> k
        if j + 1 < len(digest):
            c |= digest[j + 1] << (8 - k)
        out.append(NIX32_CHARS[c & 0x1F])
    return "".join(out)


def is_public_key(s: str) -> bool:
    return bool(_PUBKEY_RE.match(s))


def parse_public_keys(text: str) -> List[str]:
    """`name:base64` lines; blank lines and `#` comments are ignored."""
    keys = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if not is_public_key(line):
            raise CacheError(f"not a Nix public key: {line!r}")
        keys.append(line)
    return keys


def store_basename(path: str) -> str:
    if not path.startswith(STORE_DIR + "/"):
        raise CacheError(f"not a store path: {path!r}")
    base = path[len(STORE_DIR) + 1 :]
    if not _BASENAME_RE.match(base):
        raise CacheError(f"bad store path: {path!r}")
    return base


def hash_part(path: str) -> str:
    return store_basename(path)[:32]


@dataclass(frozen=True)
class NarInfo:
    store_path: str
    url: str  # nar/<file>
    compression: str
    file_hash: str  # nix32 sha256 of the compressed file
    file_size: int
    nar_hash: str
    nar_size: int
    references: Tuple[str, ...]  # basenames
    sigs: Tuple[str, ...]
    text: str  # verbatim

    @property
    def hash(self) -> str:
        return self.store_path[len(STORE_DIR) + 1 :][:32]

    @property
    def nar_file(self) -> str:
        """The NAR's file name (= its release asset name)."""
        return self.url[len("nar/") :]

    def signed_by(self, key_name: str) -> bool:
        return any(s.split(":", 1)[0] == key_name for s in self.sigs)


def parse_narinfo(text: str) -> NarInfo:
    """Strict narinfo parser: the fields the updater relies on must be present
    and well formed (the file names it derives from them go onto the disk)."""
    fields: Dict[str, str] = {}
    sigs: List[str] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        k, sep, v = line.partition(": ")
        if not sep:
            raise CacheError(f"narinfo: bad line {line!r}")
        if k == "Sig":
            sigs.append(v)
        elif k in fields:
            raise CacheError(f"narinfo: duplicate {k}")
        else:
            fields[k] = v
    for k in ("StorePath", "URL", "FileHash", "FileSize", "NarHash", "NarSize"):
        if k not in fields:
            raise CacheError(f"narinfo: no {k}")
    sp = fields["StorePath"]
    store_basename(sp)
    if not _NAR_URL_RE.match(fields["URL"]):
        raise CacheError(f"narinfo {sp}: bad URL {fields['URL']!r}")
    fh = _NIX32_SHA256_RE.match(fields["FileHash"])
    if not fh:
        raise CacheError(f"narinfo {sp}: FileHash must be sha256 in nix32")
    try:
        file_size, nar_size = int(fields["FileSize"]), int(fields["NarSize"])
    except ValueError as e:
        raise CacheError(f"narinfo {sp}: bad size") from e
    if file_size < 0 or nar_size <= 0:
        raise CacheError(f"narinfo {sp}: bad size")
    refs = tuple(r for r in fields.get("References", "").split(" ") if r)
    for r in refs:
        if not _BASENAME_RE.match(r):
            raise CacheError(f"narinfo {sp}: bad reference {r!r}")
    return NarInfo(
        store_path=sp,
        url=fields["URL"],
        compression=fields.get("Compression", "bzip2"),
        file_hash=fh.group(1),
        file_size=file_size,
        nar_hash=fields["NarHash"],
        nar_size=nar_size,
        references=refs,
        sigs=tuple(sigs),
        text=text if text.endswith("\n") else text + "\n",
    )


def closure(narinfos: Dict[str, NarInfo], top: str) -> List[NarInfo]:
    """Every narinfo reachable from store path ``top`` (``narinfos`` keyed by
    hash part). Fails if any reference has no narinfo."""
    seen: Dict[str, NarInfo] = {}
    todo = [hash_part(top)]
    while todo:
        h = todo.pop()
        if h in seen:
            continue
        ni = narinfos.get(h)
        if ni is None:
            raise CacheError(f"no narinfo for {h} (in the closure of {top})")
        seen[h] = ni
        todo.extend(r[:32] for r in ni.references)
    if narinfos[hash_part(top)].store_path != top:
        raise CacheError(f"narinfo for {top} names another path")
    return sorted(seen.values(), key=lambda n: n.store_path)


@dataclass(frozen=True)
class Manifest:
    board: str
    version: str
    toplevel: str
    nar_base_url: str
    narinfos: Dict[str, NarInfo]

    def closure(self) -> List[NarInfo]:
        return closure(self.narinfos, self.toplevel)


def _str(doc: dict, key: str, what: str) -> str:
    v = doc.get(key)
    if not isinstance(v, str) or not v:
        raise CacheError(f"{what}: no {key}")
    return v


def _check_url(url: str, allow_http: bool, what: str) -> str:
    if url.startswith("https://") or (allow_http and url.startswith("http://")):
        return url
    raise CacheError(f"{what}: refusing non-https URL {url!r}")


def _common(doc, schema: str, what: str) -> Tuple[str, str, str]:
    if not isinstance(doc, dict) or doc.get("schema") != schema:
        raise CacheError(f"{what}: not a {schema} document")
    board, version, top = (
        _str(doc, "board", what),
        _str(doc, "version", what),
        _str(doc, "toplevel", what),
    )
    if not BOARD_RE.match(board):
        raise CacheError(f"{what}: bad board {board!r}")
    if not VERSION_RE.match(version):
        raise CacheError(f"{what}: bad version {version!r}")
    store_basename(top)
    return board, version, top


def parse_manifest(data: bytes, *, allow_http: bool = False) -> Manifest:
    try:
        doc = json.loads(data)
    except ValueError as e:
        raise CacheError(f"manifest is not JSON: {e}") from e
    board, version, top = _common(doc, MANIFEST_SCHEMA, "manifest")
    base = _check_url(_str(doc, "nar_base_url", "manifest").rstrip("/"), allow_http, "manifest")
    raw = doc.get("narinfo")
    if not isinstance(raw, dict) or not raw:
        raise CacheError("manifest: no narinfo")
    narinfos = {}
    for h, text in raw.items():
        if not isinstance(h, str) or not _HASH_RE.match(h) or not isinstance(text, str):
            raise CacheError(f"manifest: bad narinfo entry {h!r}")
        ni = parse_narinfo(text)
        if ni.hash != h:
            raise CacheError(f"manifest: narinfo {h} is for {ni.store_path}")
        narinfos[h] = ni
    if hash_part(top) not in narinfos:
        raise CacheError("manifest: no narinfo for the toplevel")
    return Manifest(
        board=board, version=version, toplevel=top, nar_base_url=base, narinfos=narinfos
    )


def render_manifest(
    board: str, version: str, toplevel: str, nar_base_url: str, infos: Iterable[NarInfo]
) -> bytes:
    doc = {
        "schema": MANIFEST_SCHEMA,
        "board": board,
        "version": version,
        "toplevel": toplevel,
        "nar_base_url": nar_base_url.rstrip("/"),
        "narinfo": {ni.hash: ni.text for ni in sorted(infos, key=lambda n: n.hash)},
    }
    return (json.dumps(doc, indent=1, sort_keys=True) + "\n").encode()


@dataclass(frozen=True)
class Pointer:
    board: str
    version: str
    toplevel: str
    manifest_url: str
    manifest_sha256: str


def parse_pointer(data: bytes, *, allow_http: bool = False) -> Pointer:
    try:
        doc = json.loads(data)
    except ValueError as e:
        raise CacheError(f"channel pointer is not JSON: {e}") from e
    board, version, top = _common(doc, POINTER_SCHEMA, "channel pointer")
    url = _check_url(_str(doc, "manifest_url", "channel pointer"), allow_http, "channel pointer")
    sha = _str(doc, "manifest_sha256", "channel pointer").lower()
    if not _SHA256_HEX_RE.match(sha):
        raise CacheError("channel pointer: bad manifest_sha256")
    return Pointer(
        board=board, version=version, toplevel=top, manifest_url=url, manifest_sha256=sha
    )


def render_pointer(manifest: Manifest, manifest_bytes: bytes, manifest_url: str) -> bytes:
    doc = {
        "schema": POINTER_SCHEMA,
        "board": manifest.board,
        "version": manifest.version,
        "toplevel": manifest.toplevel,
        "manifest_url": manifest_url,
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }
    return (json.dumps(doc, indent=1, sort_keys=True) + "\n").encode()


def key_name(public_key: str) -> Optional[str]:
    m = _PUBKEY_RE.match(public_key)
    return m.group(1) if m else None
