#!/usr/bin/env python3
"""Keep a Splanc Pi bridge paired across a reflash (tools/bridge_migrate/README.md).

Run it on your laptop (macOS or Linux, Python 3.8+, nothing to install):

    bridge_migrate.py enable-ssh [--card DIR]        1. let the laptop log into the OLD bridge
    bridge_migrate.py backup --ssh splanc-bridge.local   2. copy its state into a bundle
    bridge_migrate.py inspect BUNDLE                 (what's in a bundle; secrets redacted)
    bridge_migrate.py restore BUNDLE [--card DIR]    3. put it on the NEW, freshly flashed card
    bridge_migrate.py restore BUNDLE --ssh splanc-bridge.local
                                                     4. finish + check it's paired again
    bridge_migrate.py verify BUNDLE --ssh splanc-bridge.local   (read-only check)

What carries the pairing: the bridge identity, `/var/lib/splanc-bridge/bridge.json`
(an Ed25519 key and the bridge id the relay gave it). The relay keeps every paired
client's credentials under that bridge id and only checks the key's signature when
the bridge connects, so a bridge that comes back with the same bridge.json is the
same bridge to the relay and to every app/agent paired with it. Nothing needs doing
on the relay. The rest of the state (known fixtures + their TLS pins, rooms/poses,
the LAN endpoint's certificate, LAN tickets, the local effects library, saved WiFi
networks, SSH keys, the card's settings) is nice to keep: without it the bridge
still works, but fixtures are re-discovered and the browser has to accept the LAN
certificate again.

The bundle is a .tar.gz with a manifest (sizes + SHA-256 of every file), written
0600 in a 0700 directory. It holds the bridge's private key and WiFi passwords:
keep it like a password and delete it once the new bridge is paired. Nothing here
ever prints a secret.

Stdlib only. Tests: tools/bridge_migrate/bridge_migrate_test.py.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import io
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

TOOL_VERSION = 1
BACKUP_FORMAT = "splanc-bridge-backup"
# The on-card restore bundle the image imports at boot
# (pi/bridge/image/splanc_image/bootconfig.py, import_restore): keep in step.
RESTORE_DIR = "splanc-restore"
RESTORE_FORMAT = "splanc-bridge-restore"
RESTORE_RESULT = "splanc-restore-result.txt"
DEFAULT_RELAY = "https://splanc.pages.dev"  # agent/src/bridge/relayLink.ts
DEFAULT_HOST = "splanc-bridge.local"
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".config", "splanc-bridge-migrate")
DEFAULT_KEY = os.path.join(CONFIG_DIR, "id_ed25519")
DEFAULT_OUT = os.path.join(os.path.expanduser("~"), "splanc-bridge-backup")
KEY_COMMENT = "splanc-bridge-migrate"
MAX_BUNDLE_BYTES = 64 << 20
MAX_STATE_TOTAL = 32 << 20  # = the image's RESTORE_MAX_TOTAL_BYTES

# What a backup reads, relative to the bridge's root filesystem.
STATE_PREFIX = "var/lib/splanc-bridge/"
WIFI_PREFIX = "etc/NetworkManager/system-connections/"
SSH_KEYS = "var/lib/splanc-ssh/authorized_keys"
BOOT_CONF = "boot/firmware/splanc-bridge.conf"
IMAGE_JSON = "etc/splanc-bridge/image.json"
PIOS_ENV = "etc/splanc-bridge/bridge.env"  # the Raspberry Pi OS install.sh path
BACKUP_PATHS = [
    STATE_PREFIX.rstrip("/"),
    WIFI_PREFIX.rstrip("/"),
    SSH_KEYS,
    BOOT_CONF,
    IMAGE_JSON,
    PIOS_ENV,
]

# State files we know (relative to /var/lib/splanc-bridge): class, secret, what.
KNOWN_STATE = {
    "bridge.json": (
        "must-keep",
        True,
        "bridge identity (Ed25519 key + relay bridge id): the pairing",
    ),
    "config/hub.json": (
        "nice-to-keep",
        False,
        "hub config: known fixtures, their TLS pins, groups, poses",
    ),
    "live-tls.json": ("nice-to-keep", True, "LAN direct endpoint: TLS certificate + private key"),
    "live-clients.json": ("nice-to-keep", True, "LAN tickets of paired clients (hashes)"),
    "effects-library.json": ("nice-to-keep", False, "local effects library"),
}
# Never copied: leftovers of earlier restores and temp files.
_SKIP_STATE = re.compile(r"^(pre-restore-[^/]*(/.*)?|\.restore-imported|.*\.tmp|.*\.restore-tmp)$")
_REL_PART = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
_HOST_RE = re.compile(r"^([a-z_][a-z0-9_-]*@)?[A-Za-z0-9][A-Za-z0-9.:-]*$")
_KEY_PREFIXES = (
    "ssh-ed25519 ",
    "ssh-rsa ",
    "ecdsa-sha2-",
    "sk-ssh-ed25519@openssh.com ",
    "sk-ecdsa-sha2-",
)


def prog() -> str:
    """How the user ran this script, for the "Next:" hints."""
    me = os.path.basename(sys.argv[0]) if sys.argv and sys.argv[0] else "bridge_migrate.py"
    if not me.endswith(".py"):
        me = "bridge_migrate.py"
    return f"python3 {me}"


class Fail(Exception):
    """A problem the user must fix; the message says how."""


# ------------------------------------------------------------------ output ---


class Out:
    def __init__(self, stream=None, quiet: bool = False):
        self.stream = stream or sys.stdout
        self.quiet = quiet
        self.n = 0
        self.bundle = ""

    def step(self, msg: str) -> None:
        self.n += 1
        self._p(f"\n[{self.n}] {msg}")

    def ok(self, msg: str) -> None:
        self._p(f"    ok    {msg}")

    def info(self, msg: str) -> None:
        self._p(f"          {msg}")

    def warn(self, msg: str) -> None:
        self._p(f"    WARN  {msg}")

    def plan(self, msg: str) -> None:
        self._p(f"    would {msg}")

    def _p(self, s: str) -> None:
        if not self.quiet:
            print(s, file=self.stream, flush=True)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_rel(rel: str) -> bool:
    """Same rule as the image's bootconfig.safe_rel_path."""
    if not isinstance(rel, str) or not rel or len(rel) > 512:
        return False
    parts = rel.split("/")
    return 1 <= len(parts) <= 4 and all(_REL_PART.match(p) for p in parts)


# ------------------------------------------------------------------ bundle ---


@dataclass
class Entry:
    path: str  # relative to the bridge's root, e.g. var/lib/splanc-bridge/bridge.json
    role: str  # state | wifi | ssh | conf | image | pios-env
    data: bytes
    mode: int = 0o600
    rel: str = ""  # state: relative to the state dir; wifi: file name
    klass: str = "nice-to-keep"
    secret: bool = True
    what: str = ""

    def meta(self) -> dict:
        return {
            "path": self.path,
            "role": self.role,
            "rel": self.rel,
            "class": self.klass,
            "secret": self.secret,
            "what": self.what,
            "size": len(self.data),
            "sha256": sha256(self.data),
            "mode": f"{self.mode & 0o7777:04o}",
        }


@dataclass
class Bundle:
    manifest: dict
    entries: List[Entry] = field(default_factory=list)

    def get(self, path: str) -> Optional[Entry]:
        for e in self.entries:
            if e.path == path:
                return e
        return None

    def role(self, role: str) -> List[Entry]:
        return [e for e in self.entries if e.role == role]

    @property
    def identity(self) -> dict:
        return self.manifest.get("identity") or {}

    @property
    def bridge_ids(self) -> Dict[str, str]:
        return dict(self.identity.get("bridge_ids") or {})


def classify(path: str, data: bytes, mode: int) -> Optional[Entry]:
    """An archive path -> its bundle entry, or None to leave it out."""
    if path.startswith(STATE_PREFIX):
        rel = path[len(STATE_PREFIX) :]
        if not rel or _SKIP_STATE.match(rel) or not safe_rel(rel):
            return None
        klass, secret, what = KNOWN_STATE.get(rel, ("nice-to-keep", True, "other bridge state"))
        return Entry(path, "state", data, mode, rel, klass, secret, what)
    if path.startswith(WIFI_PREFIX):
        name = path[len(WIFI_PREFIX) :]
        if "/" in name or not name.endswith(".nmconnection"):
            return None
        return Entry(path, "wifi", data, mode, name, "nice-to-keep", True, "saved WiFi network")
    if path == SSH_KEYS:
        return Entry(
            path, "ssh", data, mode, "", "nice-to-keep", False, "SSH public keys (root login)"
        )
    if path == BOOT_CONF:
        return Entry(
            path,
            "conf",
            data,
            mode,
            "",
            "nice-to-keep",
            False,
            "card settings: hostname, WiFi country, relay, OLED",
        )
    if path == IMAGE_JSON:
        return Entry(
            path, "image", data, mode, "", "info", False, "old image version (not restored)"
        )
    if path == PIOS_ENV:
        return Entry(
            path,
            "pios-env",
            data,
            mode,
            "",
            "info",
            False,
            "Raspberry Pi OS settings (not restored to the SD image)",
        )
    return None


def parse_identity(data: bytes) -> dict:
    """bridge.json -> {"public_key", "bridge_ids"}; Fail if it isn't an identity."""
    try:
        j = json.loads(data.decode("utf-8"))
        key = j["key"]
        if not (
            isinstance(key["private_pkcs8"], str)
            and key["private_pkcs8"]
            and isinstance(key["public_raw"], str)
            and key["public_raw"]
        ):
            raise ValueError
        bridges = j.get("bridges") or {}
        if not isinstance(bridges, dict):
            raise ValueError
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise Fail(
            "bridge.json is damaged: it is not a bridge identity (key + bridge ids)."
        ) from None
    return {
        "public_key": key["public_raw"],
        "bridge_ids": {str(k): str(v) for k, v in bridges.items() if isinstance(v, str)},
    }


def write_bundle(path: str, manifest: dict, entries: Sequence[Entry]) -> None:
    """Write the .tar.gz, created 0600 (never world-readable, even briefly)."""
    manifest = dict(manifest)
    manifest["files"] = [e.meta() for e in entries]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:

        def add(name: str, data: bytes) -> None:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mode = 0o600
            ti.mtime = int(manifest.get("created_at") or time.time())
            tf.addfile(ti, io.BytesIO(data))

        add("manifest.json", (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
        for e in entries:
            add("files/" + e.path, e.data)
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = path + ".partial"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(buf.getvalue())
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_bundle(path: str) -> Bundle:
    """Read + verify a bundle (every checksum). Fail on any problem."""
    try:
        if os.path.getsize(path) > MAX_BUNDLE_BYTES:
            raise Fail(f"{path} is too large to be a bridge backup.")
        tf = tarfile.open(path, mode="r:gz")
    except (OSError, tarfile.TarError) as e:
        raise Fail(f"Can't open the backup {path}: {e}") from None
    files: Dict[str, bytes] = {}
    with tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue  # the writer only makes regular files
            name = m.name
            if name.startswith("/") or ".." in name.split("/"):
                raise Fail(f"{path}: unexpected entry {name!r}; not a bridge backup.")
            f = tf.extractfile(m)
            files[name] = f.read() if f else b""
    if "manifest.json" not in files:
        raise Fail(f"{path} is not a bridge backup (no manifest.json).")
    try:
        manifest = json.loads(files["manifest.json"].decode("utf-8"))
    except ValueError:
        raise Fail(f"{path}: the manifest is damaged.") from None
    if manifest.get("format") != BACKUP_FORMAT or manifest.get("v") != 1:
        raise Fail(f"{path} is not a bridge backup this tool understands.")
    entries = []
    for m in manifest.get("files") or []:
        data = files.get("files/" + m.get("path", ""))
        if data is None:
            raise Fail(f"{path}: {m.get('path')} is listed but missing: the backup is incomplete.")
        if sha256(data) != m.get("sha256") or len(data) != m.get("size"):
            raise Fail(f"{path}: {m.get('path')} fails its checksum: the backup is damaged.")
        e = classify(m["path"], data, int(m.get("mode", "0600"), 8))
        if e is None:
            continue
        entries.append(e)
    b = Bundle(manifest, entries)
    if b.get(STATE_PREFIX + "bridge.json") is None:
        raise Fail(f"{path} has no bridge identity (bridge.json): it can't restore the pairing.")
    return b


# --------------------------------------------------------------- transport ---


def ssh_argv(host: str, key: Optional[str], known_hosts: str, command: str) -> List[str]:
    prog = os.environ.get("BRIDGE_MIGRATE_SSH", "ssh")
    target = host if "@" in host else f"root@{host}"
    argv = shlex.split(prog) + [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        f"UserKnownHostsFile={known_hosts}",
        "-o",
        "LogLevel=ERROR",
    ]
    if key:
        argv += ["-i", key, "-o", "IdentitiesOnly=yes"]
    return argv + [target, command]


class Ssh:
    """Runs fixed shell scripts on the bridge as root."""

    def __init__(self, host: str, key: Optional[str], phase: str, root: str = "/"):
        if not _HOST_RE.match(host):
            raise Fail(f"{host!r} doesn't look like a host name.")
        self.host = host
        self.key = key if key and os.path.exists(key) else None
        os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
        # Separate known_hosts per side: the new card has a new SSH host key under
        # the same name, and that must not look like an attack on the old one.
        self.known_hosts = os.path.join(CONFIG_DIR, f"known_hosts-{phase}")
        self.root = root.rstrip("/") + "/"

    def script(self, body: str) -> str:
        return f"R={shlex.quote(self.root)}\n{body}"

    def run(
        self, body: str, stdin: Optional[bytes] = None, timeout: float = 120, check: bool = True
    ) -> bytes:
        argv = ssh_argv(self.host, self.key, self.known_hosts, self.script(body))
        try:
            p = subprocess.run(
                argv,
                input=stdin if stdin is not None else b"",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
        except FileNotFoundError:
            raise Fail("`ssh` isn't installed on this computer.") from None
        except subprocess.TimeoutExpired:
            raise Fail(f"{self.host} stopped answering over SSH.") from None
        if check and p.returncode != 0:
            raise Fail(self.explain(p.returncode, p.stderr.decode("utf-8", "replace")))
        return p.stdout

    def explain(self, code: int, err: str) -> str:
        err = err.strip().splitlines()[-1] if err.strip() else ""
        if code == 255:
            if "Host key verification failed" in err or "REMOTE HOST IDENTIFICATION" in err:
                return (
                    f"{self.host}'s SSH host key changed (expected after a reflash). Delete "
                    f"{self.known_hosts} and run this again."
                )
            if "Permission denied" in err:
                return (
                    f"{self.host} refused the SSH key. Was `enable-ssh` (old card) or "
                    "`restore --card` (new card) run on this card before it booted?"
                )
            return (
                f"Can't reach {self.host} over SSH ({err or 'no answer'}). Is it powered on, on "
                "the same network as this computer, and did it boot from the card you prepared?"
            )
        return f"A command on the bridge failed (exit {code}): {err}"


PROBE = r"""
p() { echo "@@$1"; cat "$R$2" 2>/dev/null; echo; }
echo "@@uid"; id -u
p image etc/splanc-bridge/image.json
p status run/splanc-bridge/status.json
echo "@@pub"
sed -n 's/.*"public_raw": *"\([^"]*\)".*/\1/p' "$R"var/lib/splanc-bridge/bridge.json 2>/dev/null | head -n1
p result boot/firmware/splanc-restore-result.txt
echo "@@end"
"""

BACKUP_TAR = r"""
set -eu
cd "$R"
set --
for p in {paths}; do [ -e "$p" ] && set -- "$@" "$p"; done
exec tar -czhf - --exclude='var/lib/splanc-bridge/pre-restore-*' --exclude='*.tmp' --exclude='*.restore-tmp' "$@"
"""

STOP_BRIDGE = "systemctl stop splanc-bridge.service"
POWEROFF = "(sleep 2; systemctl poweroff) >/dev/null 2>&1 </dev/null &"

# Upload (stdin: a .tar.gz with SHA256SUMS, state/<rel>, wifi/<name>), check, place.
RESTORE_SSH = r"""
set -eu
S="$R"var/lib/splanc-bridge
N="$R"etc/NetworkManager/system-connections
T="$(mktemp -d "$R"var/lib/splanc-migrate.XXXXXX)"
trap 'rm -rf "$T"' EXIT
tar -xzf - -C "$T" --no-same-owner --no-same-permissions
(cd "$T" && sha256sum -c --quiet SHA256SUMS) || { echo "upload damaged" >&2; exit 3; }
systemctl stop splanc-bridge.service
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$S"
(cd "$T/state" && find . -type f) | while read -r f; do
  f="${f#./}"
  d="$(dirname "$f")"
  if [ -e "$S/$f" ]; then mkdir -p "$S/pre-restore-$stamp/$d"; mv "$S/$f" "$S/pre-restore-$stamp/$f"; fi
  mkdir -p "$S/$d"
  cp "$T/state/$f" "$S/$f.restore-tmp"
  mv "$S/$f.restore-tmp" "$S/$f"
done
chown -R splanc:splanc "$S"
find "$S" -type d -exec chmod 700 {} +
find "$S" -type f -exec chmod 600 {} +
if [ -d "$T/wifi" ]; then
  mkdir -p "$N"
  added=0
  for f in "$T"/wifi/*.nmconnection; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    if [ -e "$N/$b" ]; then continue; fi
    cp "$f" "$N/$b"; chmod 600 "$N/$b"; chown root:root "$N/$b"; added=$((added+1))
  done
  if [ "$added" -gt 0 ]; then nmcli connection reload >/dev/null 2>&1 || true; fi
  echo "wifi-added $added"
fi
# A bundle the image didn't import (it predates the first-boot import) must not
# stay on the FAT partition: it holds the bridge's private key.
rm -rf "$R"boot/firmware/splanc-restore "$R"boot/firmware/splanc-restore.partial
systemctl start splanc-bridge.service
echo "restored"
"""


def parse_probe(out: bytes) -> dict:
    sections: Dict[str, List[str]] = {}
    cur = None
    for line in out.decode("utf-8", "replace").splitlines():
        if line.startswith("@@"):
            cur = line[2:].strip()
            sections[cur] = []
        elif cur is not None:
            sections[cur].append(line)
    text = {k: "\n".join(v).strip() for k, v in sections.items()}

    def js(k: str) -> Optional[dict]:
        try:
            v = json.loads(text.get(k) or "null")
            return v if isinstance(v, dict) else None
        except ValueError:
            return None

    return {
        "complete": "end" in sections,
        "uid": text.get("uid", ""),
        "image": js("image"),
        "status": js("status"),
        "public_key": text.get("pub") or None,
        "result": text.get("result") or None,
    }


def probe(ssh: Ssh) -> dict:
    p = parse_probe(ssh.run(PROBE, timeout=60))
    if not p["complete"]:
        raise Fail(f"{ssh.host} gave an unexpected answer; is it a Splanc bridge?")
    if p["uid"] != "0":
        raise Fail(
            f"Logged into {ssh.host} as a user other than root; use root@{ssh.host.split('@')[-1]}."
        )
    return p


def read_tar(data: bytes) -> Dict[str, Tuple[bytes, int]]:
    """A tar stream from the bridge -> {path: (data, mode)}; regular files only."""
    out: Dict[str, Tuple[bytes, int]] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
            for m in tf.getmembers():
                name = m.name.lstrip("./") if m.name.startswith("./") else m.name
                if not m.isfile() or name.startswith("/") or ".." in name.split("/"):
                    continue
                f = tf.extractfile(m)
                out[name] = (f.read() if f else b"", m.mode)
    except tarfile.TarError as e:
        raise Fail(f"The copy from the bridge is damaged ({e}); run the backup again.") from None
    return out


def read_root(root: str, boot: Optional[str]) -> Dict[str, Tuple[bytes, int]]:
    """The same files, from a mounted root (ext4) partition (+ optional boot partition)."""
    out: Dict[str, Tuple[bytes, int]] = {}

    def resolve(rel: str) -> str:
        # Follow symlinks INSIDE the mounted root: an absolute link such as
        # /etc/static/... means <root>/etc/static/..., never this computer's /etc,
        # and ".." stops at the root.
        parts, done, hops = rel.split("/"), [], 0
        while parts:
            part = parts.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if done:
                    done.pop()
                continue
            cand = os.path.join(root, *done, part)
            if os.path.islink(cand):
                hops += 1
                if hops > 32:
                    return os.path.join(root, "nonexistent-symlink-loop")
                t = os.readlink(cand)
                if t.startswith("/"):
                    done = []
                parts = t.split("/") + parts
                continue
            done.append(part)
        return os.path.join(root, *done)

    def add_file(rel: str) -> None:
        full = resolve(rel)
        if not os.path.isfile(full):
            return
        try:
            with open(full, "rb") as f:
                out[rel] = (f.read(), os.stat(full).st_mode & 0o7777)
        except PermissionError:
            raise Fail(
                f"No permission to read {full}. Run this with sudo (the files belong to the "
                "bridge's own user)."
            ) from None

    if not os.path.isdir(os.path.join(root, "var", "lib")) or not os.path.isdir(
        os.path.join(root, "etc")
    ):
        raise Fail(f"{root} doesn't look like the bridge's root partition (no var/lib, etc).")
    for top in (STATE_PREFIX.rstrip("/"), WIFI_PREFIX.rstrip("/")):
        base = os.path.join(root, top)
        if os.path.islink(base):
            continue

        def denied(err: OSError) -> None:
            raise Fail(
                f"No permission to read {err.filename}. Run this with sudo (the files belong "
                "to the bridge's own user)."
            )

        for dirpath, dirnames, filenames in os.walk(base, onerror=denied):
            dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                if os.path.islink(full):
                    continue
                add_file(os.path.relpath(full, root).replace(os.sep, "/"))
    for rel in (SSH_KEYS, IMAGE_JSON, PIOS_ENV):
        add_file(rel)
    conf = os.path.join(boot, "splanc-bridge.conf") if boot else None
    if conf and os.path.isfile(conf):
        with open(conf, "rb") as f:
            out[BOOT_CONF] = (f.read(), 0o644)
    elif not boot:
        add_file(BOOT_CONF)  # a root that has the FAT partition mounted at boot/firmware
    return out


# ---------------------------------------------------------- cards (FAT) ---


def candidate_cards() -> List[str]:
    pats = (
        ["/Volumes/*"]
        if platform.system() == "Darwin"
        else ["/media/*/*", "/run/media/*/*", "/media/*", "/mnt/*"]
    )
    seen = []
    for pat in pats:
        for d in sorted(glob.glob(pat)):
            if os.path.isfile(os.path.join(d, "config.txt")) and d not in seen:
                seen.append(d)
    return seen


def find_card(card: Optional[str]) -> str:
    if card:
        if not os.path.isfile(os.path.join(card, "config.txt")):
            raise Fail(
                f"{card} is not a Raspberry Pi boot partition (no config.txt). Pass the card's "
                "boot volume, e.g. /Volumes/FIRMWARE on a Mac."
            )
        return card
    found = candidate_cards()
    if len(found) == 1:
        return found[0]
    if not found:
        raise Fail(
            "No Raspberry Pi card found. Insert the card (the boot volume mounts by itself, "
            "e.g. /Volumes/FIRMWARE) or pass --card <its folder>."
        )
    raise Fail(
        "More than one Raspberry Pi card is mounted ("
        + ", ".join(found)
        + "); pick one with --card."
    )


def parse_conf(text: str) -> Dict[str, str]:
    vals: Dict[str, str] = {}
    for line in text.replace("\r\n", "\n").lstrip("﻿").split("\n"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = (x.strip() for x in line.split("=", 1))
            vals[k] = v
    return vals


def merge_conf(new_text: str, old_text: str) -> Tuple[str, List[str], List[Tuple[str, str, str]]]:
    """Add the old card's settings the new card lacks. Returns (text, added keys,
    [(key, kept new value, old value)] for differing ones: the flasher's choice wins)."""
    new, old = parse_conf(new_text), parse_conf(old_text)
    added = [k for k in old if k not in new]
    differ = [(k, new[k], old[k]) for k in old if k in new and new[k] != old[k]]
    text = new_text
    if added:
        if text and not text.endswith("\n"):
            text += "\n"
        text += "# Restored from the old card by bridge_migrate\n"
        text += "".join(f"{k}={old[k]}\n" for k in added)
    return text, added, differ


def _unescape_kf(v: str) -> str:
    out, i = [], 0
    while i < len(v):
        if v[i] == "\\" and i + 1 < len(v):
            out.append(
                {"s": " ", "n": "\n", "t": "\t", "r": "\r", "\\": "\\"}.get(v[i + 1], v[i + 1])
            )
            i += 2
        else:
            out.append(v[i])
            i += 1
    return "".join(out)


def keyfile_fields(text: str) -> Dict[str, str]:
    """[section] key=value of a NetworkManager keyfile -> {"section.key": value}."""
    out, sec = {}, ""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            sec = s[1:-1]
        elif "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            out[f"{sec}.{k.strip()}"] = v.strip()
    return out


def keyfile_ssid(text: str) -> Optional[bytes]:
    v = keyfile_fields(text).get("wifi.ssid")
    if v is None:
        return None
    if re.fullmatch(r"(\d{1,3};)+\d{0,3}", v):
        return bytes(int(x) for x in v.split(";") if x != "")
    return _unescape_kf(v).encode("utf-8")


def ssid_label(ssid: Optional[bytes]) -> str:
    if ssid is None:
        return "(not WiFi)"
    s = ssid.decode("utf-8", "replace")
    return "".join(c if c.isprintable() else "?" for c in s)


def restored_keyfile(name: str, text: str) -> Tuple[str, str]:
    """An old network's keyfile under a name that can't clash with the flasher's
    (`restored-<name>`, id `restored-<id>`; uuid kept)."""
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", name[: -len(".nmconnection")])[:48] or "wifi"
    if stem.startswith("restored-"):
        stem = stem[len("restored-") :]
    out, sec = [], ""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            sec = s[1:-1]
        if sec == "connection" and s.startswith("id=") and not s[3:].startswith("restored-"):
            line = "id=restored-" + s[3:]
        out.append(line)
    return f"restored-{stem}.nmconnection", "\n".join(out) + "\n"


def tool_pubkey(key: Optional[str]) -> Optional[str]:
    if key and os.path.isfile(key + ".pub"):
        with open(key + ".pub") as f:
            line = f.read().strip()
        return line if line.startswith(_KEY_PREFIXES) else None
    return None


def ensure_key(key: str, out: Out, dry: bool) -> str:
    if os.path.isfile(key) and os.path.isfile(key + ".pub"):
        out.ok(f"using the SSH key {key}")
        return key
    if dry:
        out.plan(f"create an SSH key for this tool: {key}")
        return key
    os.makedirs(os.path.dirname(key), mode=0o700, exist_ok=True)
    try:
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", KEY_COMMENT, "-f", key],
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        raise Fail("Couldn't create an SSH key (is `ssh-keygen` installed?).") from None
    out.ok(f"created an SSH key for this tool: {key}")
    return key


def merge_keys(existing: str, add: Sequence[str]) -> Tuple[str, int]:
    have = [k.strip() for k in existing.splitlines() if k.strip()]
    new = [k.strip() for k in add if k.strip().startswith(_KEY_PREFIXES) and k.strip() not in have]
    return "\n".join(have + new) + "\n", len(new)


def _write_file(path: str, data: bytes) -> None:
    tmp = path + ".partial"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---------------------------------------------------------------- commands ---


def cmd_enable_ssh(a, out: Out) -> int:
    out.step("Find the OLD bridge's card (its boot volume)")
    card = find_card(a.card)
    out.ok(f"card: {card}")
    out.step("SSH key for this tool")
    if a.pubkey:
        with open(os.path.expanduser(a.pubkey)) as f:
            pub = f.read().strip()
        if not pub.startswith(_KEY_PREFIXES):
            raise Fail(f"{a.pubkey} isn't an SSH public key.")
    else:
        ensure_key(a.key, out, a.dry_run)
        pub = tool_pubkey(a.key) or "ssh-ed25519 (new key) " + KEY_COMMENT
    out.step("Let that key log into the bridge as root")
    path = os.path.join(card, "authorized_keys")
    existing = open(path).read() if os.path.isfile(path) else ""
    text, n = merge_keys(existing, [pub])
    if n == 0:
        out.ok("the card already trusts this key")
    elif a.dry_run:
        out.plan(f"add the key to {path}")
    else:
        _write_file(path, text.encode())
        out.ok(f"added the key to {path}")
    print(
        f"""
Next:
  1. Eject the card, put it back in the old bridge and power it on.
  2. Wait ~2 minutes (until the bridge's screen shows its status again), then run:
       {prog()} backup --ssh {DEFAULT_HOST}"""
    )
    return 0


def expected_relay(status: Optional[dict], conf_text: Optional[str]) -> str:
    if status and isinstance(status.get("relay"), str) and status["relay"]:
        return status["relay"].rstrip("/")
    if conf_text:
        r = parse_conf(conf_text).get("SPLANC_RELAY", "").strip("\"'")
        if r:
            return r.rstrip("/")
    return DEFAULT_RELAY


def cmd_backup(a, out: Out) -> int:
    status = image = None
    if a.ssh:
        ssh = Ssh(a.ssh, a.key, "old", a.remote_root)
        out.step(f"Connect to the old bridge ({a.ssh})")
        p = probe(ssh)
        status, image = p["status"], p["image"]
        out.ok("logged in as root")
        if image:
            out.info(
                f"image: board {image.get('board', '?')}, rev {str(image.get('rev', '?'))[:12]}, "
                f"agent baked {image.get('agent_baked', '?')}"
            )
        if status:
            out.info(
                f"bridge status: {status.get('state')}  bridge id: {status.get('bridge_id') or '-'}  "
                f"paired clients: {len(status.get('paired_clients') or [])}"
            )
        else:
            out.warn("the bridge isn't running right now (no status); backing up its files anyway")
        if not a.leave_running and not a.dry_run:
            out.step(
                "Stop the old bridge (so nothing changes after the copy, and so it can't "
                "fight the new one for the connection)"
            )
            ssh.run(STOP_BRIDGE, timeout=60)
            out.ok("stopped splanc-bridge on the old Pi (its screen now says 'Waiting for bridge')")
        out.step("Copy the bridge's state")
        if a.dry_run:
            out.plan("copy: " + ", ".join("/" + p for p in BACKUP_PATHS))
            return 0
        files = read_tar(
            ssh.run(BACKUP_TAR.replace("{paths}", " ".join(BACKUP_PATHS)), timeout=300)
        )
        source = {"kind": "ssh", "host": a.ssh}
    else:
        out.step(f"Read the old card ({a.from_root})")
        files = read_root(a.from_root, a.from_boot)
        if IMAGE_JSON in files:
            try:
                image = json.loads(files[IMAGE_JSON][0].decode())
            except ValueError:
                image = None
        source = {"kind": "card", "root": a.from_root}
    entries = [e for e in (classify(p, d, m) for p, (d, m) in sorted(files.items())) if e]
    out.ok(f"read {len(entries)} file(s)")

    out.step("Check the must-keep items")
    ident_e = next((e for e in entries if e.role == "state" and e.rel == "bridge.json"), None)
    if ident_e is None:
        raise Fail(
            "The old bridge has no identity file (/var/lib/splanc-bridge/bridge.json). Without "
            "it the pairing can't be kept; nothing was saved. (Did it ever pair?)"
        )
    ident = parse_identity(ident_e.data)
    out.ok(f"bridge identity found (public key {ident['public_key'][:10]}...)")
    conf_e = next((e for e in entries if e.role == "conf"), None)
    relay = expected_relay(status, conf_e.data.decode("utf-8", "replace") if conf_e else None)
    bid = ident["bridge_ids"].get(relay)
    problems = []
    if not ident["bridge_ids"]:
        problems.append(
            "the identity was never registered with a relay (no bridge id), so there is "
            "no pairing to keep"
        )
    elif not bid:
        problems.append(
            f"the identity has no bridge id for the relay it uses ({relay}); it has "
            f"{', '.join(ident['bridge_ids'])}"
        )
    else:
        out.ok(f"bridge id {bid} on {relay}")
    if status and status.get("bridge_id") and bid and status["bridge_id"] != bid:
        problems.append(
            f"the running bridge reports bridge id {status['bridge_id']}, but the file says {bid}"
        )
    if status and status.get("state") not in ("paired", "pairing"):
        msg = f"the bridge's state is '{status.get('state')}'"
        if status.get("state") == "unpaired":
            problems.append(msg + ": no client is paired with it")
        else:
            out.warn(msg + " (not 'paired'); the identity is what matters and it is saved")
    if problems:
        for pr in problems:
            out.warn(pr)
        if not a.force:
            raise Fail("Stopping: see the warnings above. Re-run with --force to save it anyway.")
    if not any(e.role == "wifi" for e in entries):
        out.warn(
            "no saved WiFi networks found (fine on Ethernet; the flasher sets WiFi on the new card)"
        )

    total = sum(len(e.data) for e in entries if e.role == "state")
    if total > MAX_STATE_TOTAL:
        raise Fail(f"The bridge state is {total >> 20} MB, more than a restore can carry.")
    created = int(time.time())
    manifest = {
        "format": BACKUP_FORMAT,
        "v": 1,
        "tool": TOOL_VERSION,
        "created_at": created,
        "source": dict(source, image=image),
        "relay": relay,
        "identity": ident
        and {"public_key": ident["public_key"], "bridge_ids": ident["bridge_ids"]},
        "status_at_backup": status
        and {
            "state": status.get("state"),
            "bridge_id": status.get("bridge_id"),
            "relay": status.get("relay"),
            "paired_clients": len(status.get("paired_clients") or []),
            "players": len(status.get("players") or []),
        },
    }
    out.step("Write the backup bundle")
    out_dir = os.path.expanduser(a.out)
    name = time.strftime(
        f"splanc-bridge-{bid or 'unregistered'}-%Y%m%d-%H%M%S.tar.gz", time.localtime(created)
    )
    path = os.path.join(out_dir, name)
    write_bundle(path, manifest, entries)
    os.chmod(out_dir, 0o700)
    if os.geteuid() == 0 and os.environ.get("SUDO_UID"):
        uid, gid = int(os.environ["SUDO_UID"]), int(os.environ.get("SUDO_GID", "0"))
        os.chown(out_dir, uid, gid)
        os.chown(path, uid, gid)
    load_bundle(path)  # read back + verify every checksum
    out.ok(f"saved and verified: {path}")
    out.info("(readable only by you; it holds the bridge's private key and WiFi passwords)")
    for e in entries:
        out.info(
            f"{e.klass:<12} {e.what}"
            + (f" [{e.rel}]" if e.role == "state" and e.rel not in KNOWN_STATE else "")
        )
    if a.ssh and a.shutdown:
        out.step("Power off the old bridge")
        ssh.run(POWEROFF, timeout=30, check=False)
        out.ok("it is shutting down; unplug it once the green light stops blinking")
    print(
        f"""
Next:
  1. Unplug the old bridge and keep its card as it is (it is your way back).
  2. Write the new image to a NEW card with the Splanc Bridge Flasher (same WiFi as before).
  3. Leave that card in this computer (don't boot it yet!) and run:
       {prog()} restore {path}"""
    )
    return 0


def cmd_inspect(a, out: Out) -> int:
    b = load_bundle(a.bundle)
    m = b.manifest
    print(f"Backup: {a.bundle}")
    print(
        f"  made:        {time.strftime('%Y-%m-%d %H:%M', time.localtime(m.get('created_at', 0)))}"
    )
    src = m.get("source") or {}
    img = src.get("image") or {}
    print(
        f"  from:        {src.get('host') or src.get('root') or '?'}"
        + (f" (board {img.get('board')}, image rev {str(img.get('rev', '?'))[:12]})" if img else "")
    )
    st = m.get("status_at_backup") or {}
    if st:
        print(
            f"  status then: {st.get('state')}, {st.get('paired_clients')} paired client(s), "
            f"{st.get('players')} fixture(s)"
        )
    print(f"  relay:       {m.get('relay')}")
    for r, bid in b.bridge_ids.items():
        print(f"  bridge id:   {bid}  ({r})")
    pk = b.identity.get("public_key", "")
    print(f"  public key:  {pk[:10]}... (private key: [secret, not shown])")
    print("  checksums:   all files OK")
    print("\nFiles:")
    for e in b.entries:
        detail = describe(e)
        print(
            f"  {e.klass:<12} {e.path:<58} {len(e.data):>8} B  {e.what}"
            + (" [secret]" if e.secret else "")
            + (f"\n{'':15}{detail}" if detail else "")
        )
    return 0


def describe(e: Entry) -> str:
    """A secret-free one-line summary of an entry's contents."""
    try:
        if e.role == "state" and e.rel == "config/hub.json":
            j = json.loads(e.data)
            return (
                f"{len(j.get('players') or {})} fixture(s), {len(j.get('groups') or {})} group(s), "
                f"{len(j.get('poses') or {})} pose(s)"
            )
        if e.role == "state" and e.rel == "effects-library.json":
            return f"{len(json.loads(e.data).get('entries') or {})} effect(s)"
        if e.role == "state" and e.rel == "live-clients.json":
            return f"{len(json.loads(e.data).get('tickets') or {})} ticket(s)"
        if e.role == "state" and e.rel == "live-tls.json":
            j = json.loads(e.data)
            exp = time.strftime("%Y-%m-%d", time.gmtime(j.get("notAfter", 0) / 1000))
            return f"certificate sha256 {str(j.get('sha256', ''))[:16]}..., valid until {exp}"
        if e.role == "wifi":
            return f"network {ssid_label(keyfile_ssid(e.data.decode('utf-8', 'replace')))!r}, password hidden"
        if e.role == "ssh":
            keys = [k for k in e.data.decode("utf-8", "replace").splitlines() if k.strip()]
            return f"{len(keys)} key(s): " + ", ".join(
                (k.split()[2] if len(k.split()) > 2 else k.split()[0]) for k in keys
            )
        if e.role in ("conf", "pios-env"):
            vals = parse_conf(e.data.decode("utf-8", "replace"))
            return ", ".join(f"{k}={v}" for k, v in vals.items())
    except (ValueError, AttributeError, TypeError):
        return "(unreadable)"
    return ""


def restore_manifest(b: Bundle) -> Tuple[dict, List[Entry]]:
    state = [e for e in b.role("state") if safe_rel(e.rel)]
    return {
        "format": RESTORE_FORMAT,
        "v": 1,
        "created_at": int(time.time()),
        "bridge_ids": b.bridge_ids,
        "files": [{"path": e.rel, "size": len(e.data), "sha256": sha256(e.data)} for e in state],
    }, state


def cmd_restore(a, out: Out) -> int:
    out.step("Open and check the backup")
    b = load_bundle(a.bundle)
    out.ok(f"{a.bundle}: every checksum matches")
    for r, bid in b.bridge_ids.items():
        out.info(f"bridge id {bid} ({r})")
    if a.ssh:
        return restore_ssh(a, b, out)
    return restore_card(a, b, out)


def restore_card(a, b: Bundle, out: Out) -> int:
    out.step("Find the NEW card (freshly written by the flasher, not booted yet)")
    card = find_card(a.card)
    out.ok(f"card: {card}")
    if not os.path.isfile(os.path.join(card, "splanc-bridge.conf")):
        out.warn(
            "this card has no splanc-bridge.conf: was it written by the Splanc Bridge Flasher?"
        )
    if os.path.isfile(os.path.join(card, RESTORE_RESULT)):
        out.warn(
            f"this card has already booted with a restore ({RESTORE_RESULT}); continuing replaces it"
        )

    manifest, state = restore_manifest(b)
    need = sum(len(e.data) for e in state) + 64 * 1024
    free = shutil.disk_usage(card).free
    if free < need + (1 << 20):
        raise Fail(
            f"The card's boot partition is too full ({free >> 10} KB free, {need >> 10} KB needed)."
        )

    out.step("Bridge identity and state -> imported by the new image on its first boot")
    dst = os.path.join(card, RESTORE_DIR)
    for e in state:
        out.info(f"{e.rel} ({e.what})")
    if a.dry_run:
        out.plan(f"write {len(state)} file(s) to {dst}/")
    else:
        tmp = dst + ".partial"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "state"))
        for e in state:
            p = os.path.join(tmp, "state", *e.rel.split("/"))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            _write_file(p, e.data)
        _write_file(
            os.path.join(tmp, "manifest.json"), (json.dumps(manifest, indent=2) + "\n").encode()
        )
        shutil.rmtree(dst, ignore_errors=True)
        os.replace(tmp, dst)
        try:
            os.remove(os.path.join(card, RESTORE_RESULT))
        except OSError:
            pass
        out.ok(
            f"wrote {len(state)} file(s) to {dst}/ (the bridge deletes them from the card once imported)"
        )

    out.step("Saved WiFi networks")
    conn_dir = os.path.join(card, "system-connections")
    have_ssids = set()
    if os.path.isdir(conn_dir):
        for fn in os.listdir(conn_dir):
            if fn.endswith(".nmconnection"):
                with open(os.path.join(conn_dir, fn), "rb") as f:
                    s = keyfile_ssid(f.read().decode("utf-8", "replace"))
                if s is not None:
                    have_ssids.add(s)
                    out.info(f"the flasher set up {ssid_label(s)!r}")
    wifi = b.role("wifi")
    if a.no_wifi or not wifi:
        out.info("none to restore" if not wifi else "skipped (--no-wifi)")
    for e in [] if a.no_wifi else wifi:
        text = e.data.decode("utf-8", "replace")
        ssid = keyfile_ssid(text)
        if ssid is not None and ssid in have_ssids:
            out.info(f"{ssid_label(ssid)!r}: already set up by the flasher, kept the flasher's")
            continue
        name, body = restored_keyfile(e.rel, text)
        if a.dry_run:
            out.plan(f"add {ssid_label(ssid)!r} as system-connections/{name}")
            continue
        os.makedirs(conn_dir, exist_ok=True)
        _write_file(os.path.join(conn_dir, name), body.encode())
        out.ok(f"added {ssid_label(ssid)!r} (password hidden)")

    out.step("Card settings and SSH keys")
    conf_e = b.role("conf")
    conf_path = os.path.join(card, "splanc-bridge.conf")
    if conf_e:
        cur = open(conf_path, encoding="utf-8-sig").read() if os.path.isfile(conf_path) else ""
        text, added, differ = merge_conf(cur, conf_e[0].data.decode("utf-8", "replace"))
        for k, new_v, old_v in differ:
            out.info(f"{k}: keeping the flasher's '{new_v}' (old card had '{old_v}')")
        if added and not a.dry_run:
            _write_file(conf_path, text.encode())
        if added:
            (out.plan if a.dry_run else out.ok)(f"settings from the old card: {', '.join(added)}")
        elif not differ:
            out.ok("settings match the old card")
    # The relay the new bridge will use must be one the identity is registered on.
    conf_now = open(conf_path, encoding="utf-8-sig").read() if os.path.isfile(conf_path) else ""
    if a.dry_run and conf_e:
        conf_now = merge_conf(conf_now, conf_e[0].data.decode("utf-8", "replace"))[0]
    relay_now = expected_relay(None, conf_now)
    if relay_now not in b.bridge_ids:
        out.warn(
            f"the new card's relay is {relay_now}, but the identity is registered on "
            f"{', '.join(b.bridge_ids) or 'no relay'}: set SPLANC_RELAY={b.manifest.get('relay')} "
            f"in {conf_path}, or the bridge comes up unpaired"
        )
    keys = []
    for e in b.role("ssh"):
        keys += e.data.decode("utf-8", "replace").splitlines()
    pub = tool_pubkey(a.key)
    if pub:
        keys.append(pub)
    ak = os.path.join(card, "authorized_keys")
    existing = open(ak).read() if os.path.isfile(ak) else ""
    text, n = merge_keys(existing, keys)
    if n and a.dry_run:
        out.plan(f"trust {n} SSH key(s) (so step 4 can check the new bridge)")
    elif n:
        _write_file(ak, text.encode())
        out.ok(f"trusts {n} more SSH key(s) (so the next step can check the new bridge)")
    else:
        out.ok(
            "SSH keys already in place"
            if existing.strip()
            else "no SSH keys (the check step needs one)"
        )
    if a.dry_run:
        print("\n(dry run: nothing was written)")
        return 0
    print(
        f"""
Until step 4 is done, the card holds the bridge's private key in {RESTORE_DIR}/ (images newer
than pi-bridge-v1.2.0 delete it at first boot; with older ones step 4 does).

Next:
  1. Eject the card, put it in the bridge, power it on.
  2. Wait ~3 minutes (the first boot grows the card), then run:
       {prog()} restore {a.bundle} --ssh {DEFAULT_HOST}
     It checks the bridge came back with its old identity (and finishes the restore over
     SSH if this image can't import it by itself), then waits for 'paired'."""
    )
    return 0


def upload_tar(b: Bundle, include_wifi: bool) -> bytes:
    buf = io.BytesIO()
    sums = []
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:

        def add(name: str, data: bytes) -> None:
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode, ti.mtime = len(data), 0o600, int(time.time())
            tf.addfile(ti, io.BytesIO(data))

        for e in b.role("state"):
            if safe_rel(e.rel):
                add(f"state/{e.rel}", e.data)
                sums.append(f"{sha256(e.data)}  state/{e.rel}")
        if include_wifi:
            for e in b.role("wifi"):
                name, body = restored_keyfile(e.rel, e.data.decode("utf-8", "replace"))
                add(f"wifi/{name}", body.encode())
                sums.append(f"{sha256(body.encode())}  wifi/{name}")
        add("SHA256SUMS", ("\n".join(sums) + "\n").encode())
    return buf.getvalue()


def restore_ssh(a, b: Bundle, out: Out) -> int:
    ssh = Ssh(a.ssh, a.key, "new", a.remote_root)
    out.step(f"Connect to the new bridge ({a.ssh})")
    p = probe(ssh)
    out.ok("logged in as root")
    if p["image"]:
        out.info(
            f"image: board {p['image'].get('board', '?')}, rev {str(p['image'].get('rev', '?'))[:12]}"
        )
    if p["result"]:
        out.info(f"first-boot import said: {p['result'].splitlines()[0]}")
    want = b.identity.get("public_key")
    out.step("Is the old identity in place?")
    if p["public_key"] == want:
        out.ok("yes: the bridge imported it from the card at first boot")
    else:
        out.info(
            "not yet"
            + (" (this image doesn't import restore bundles by itself)" if not p["result"] else "")
        )
        if a.dry_run:
            out.plan(
                "stop the bridge, put the identity + state in /var/lib/splanc-bridge (owner splanc, "
                "0600), add the WiFi networks, start the bridge"
            )
            return 0
        res = ssh.run(RESTORE_SSH, stdin=upload_tar(b, not a.no_wifi), timeout=180).decode(
            "utf-8", "replace"
        )
        if "restored" not in res:
            raise Fail(
                "The restore on the bridge didn't finish; nothing about the old card changed. Try again."
            )
        m = re.search(r"wifi-added (\d+)", res)
        out.ok(
            f"placed {len(b.role('state'))} file(s) in /var/lib/splanc-bridge (owner splanc, mode 0600)"
            + (f"; {m.group(1)} WiFi network(s) added" if m else "")
        )
        out.ok("restarted the bridge")
    if a.dry_run:
        return 0
    return wait_paired(ssh, b, out, a.timeout)


def wait_paired(
    ssh: Ssh, b: Bundle, out: Out, timeout: float, sleep: Callable[[float], None] = time.sleep
) -> int:
    out.step(f"Wait for the bridge to report 'paired' (up to {int(timeout)} s)")
    deadline = time.monotonic() + timeout
    last = None
    st: dict = {}
    pub_ok = False
    while True:
        p = probe(ssh)
        st = p["status"] or {}
        pub_ok = p["public_key"] == b.identity.get("public_key")
        relay = (st.get("relay") or "").rstrip("/")
        want = b.bridge_ids.get(relay) if relay else None
        cur = (st.get("state"), st.get("bridge_id"))
        if cur != last:
            out.info(
                f"state: {st.get('state') or 'waiting for the bridge'}"
                + (f", bridge id {st.get('bridge_id')}" if st.get("bridge_id") else "")
            )
            last = cur
        paired = st.get("state") == "paired" or (
            st.get("state") == "pairing" and st.get("paired_clients")
        )
        if pub_ok and want and st.get("bridge_id") == want and paired:
            n = len(st.get("paired_clients") or [])
            before = (b.manifest.get("status_at_backup") or {}).get("paired_clients")
            out.ok(
                f"PAIRED as bridge {want}"
                + (f", {n} paired client(s)" if st.get("paired_clients") is not None else "")
            )
            if isinstance(before, int) and n < before:
                out.warn(
                    f"the old bridge had {before} paired client(s); some may have been revoked meanwhile"
                )
            print(
                "\nDone. The bridge kept its pairing: apps and agents paired with it work as before.\n"
                "Keep the old card (unplugged) for a few days as a fallback, then wipe it. Delete the\n"
                f"backup once you're happy: it holds the bridge's private key ({out.bundle})."
            )
            return 0
        if time.monotonic() >= deadline:
            break
        sleep(5)
    # Explain what is wrong.
    relay = (st.get("relay") or "").rstrip("/")
    if not pub_ok:
        raise Fail(
            "The bridge is NOT using the old identity. Run `restore BUNDLE --ssh ...` again; if it "
            "keeps failing, put the old card back in (nothing on it was changed)."
        )
    if relay and relay not in b.bridge_ids:
        raise Fail(
            f"The new bridge uses the relay {relay}, but the old identity was registered on "
            f"{', '.join(b.bridge_ids) or 'no relay'}. Set SPLANC_RELAY={b.manifest.get('relay')} in "
            "splanc-bridge.conf on the card's boot partition and reboot it."
        )
    state = st.get("state")
    if state in (None, "starting", "offline"):
        raise Fail(
            "The bridge has its old identity but isn't connected to the relay yet"
            + (f" ({st.get('error')})" if st.get("error") else "")
            + ". Check its network (and that its clock is right), then run "
            "`verify BUNDLE --ssh ...` again."
        )
    if state == "unpaired":
        raise Fail(
            "The bridge is back with its old bridge id, but the relay has no paired clients for it "
            "(were they revoked?). Pair again from the app."
        )
    raise Fail(
        f"The bridge reports '{state}'" + (f": {st.get('error')}" if st.get("error") else "") + "."
    )


def cmd_verify(a, out: Out) -> int:
    b = load_bundle(a.bundle)
    ssh = Ssh(a.ssh, a.key, "new", a.remote_root)
    return wait_paired(ssh, b, out, a.timeout)


# --------------------------------------------------------------------- main ---


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="bridge_migrate.py",
        description="Keep a Splanc Pi bridge paired across a reflash: back up its state from the old "
        "card, restore it onto the new one. See tools/bridge_migrate/README.md.",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--key",
        default=DEFAULT_KEY,
        help=f"SSH private key to log in with (default: this tool's own, {DEFAULT_KEY})",
    )
    common.add_argument(
        "--dry-run", action="store_true", help="say what would happen; change nothing"
    )
    common.add_argument("--remote-root", default="/", help=argparse.SUPPRESS)  # tests
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser(
        "enable-ssh",
        parents=[common],
        help="let this computer log into the OLD bridge (writes a key on its card)",
    )
    s.add_argument("--card", help="the card's boot volume (default: the one mounted)")
    s.add_argument("--pubkey", help="use this SSH public key instead of making one")

    s = sub.add_parser("backup", parents=[common], help="copy the old bridge's state into a bundle")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--ssh", metavar="HOST", help=f"the running old bridge (e.g. {DEFAULT_HOST})")
    g.add_argument(
        "--from-root", metavar="DIR", help="the old card's root (ext4) partition, mounted"
    )
    s.add_argument(
        "--from-boot", metavar="DIR", help="with --from-root: the old card's boot volume"
    )
    s.add_argument("--out", default=DEFAULT_OUT, help=f"where to save it (default {DEFAULT_OUT})")
    s.add_argument("--leave-running", action="store_true", help="don't stop the old bridge")
    s.add_argument("--shutdown", action="store_true", help="power the old bridge off afterwards")
    s.add_argument("--force", action="store_true", help="save even if a must-keep check fails")

    s = sub.add_parser(
        "inspect", parents=[common], help="show what a bundle holds (secrets redacted)"
    )
    s.add_argument("bundle")

    s = sub.add_parser(
        "restore",
        parents=[common],
        help="put a bundle on the NEW card (--card) or the running new bridge (--ssh)",
    )
    s.add_argument("bundle")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--card", help="the new card's boot volume (default: the one mounted)")
    g.add_argument("--ssh", metavar="HOST", help=f"the new bridge, running (e.g. {DEFAULT_HOST})")
    s.add_argument("--no-wifi", action="store_true", help="don't add the old card's WiFi networks")
    s.add_argument(
        "--timeout", type=float, default=300, help="seconds to wait for 'paired' (--ssh)"
    )

    s = sub.add_parser(
        "verify", parents=[common], help="check the new bridge is paired as the old one"
    )
    s.add_argument("bundle")
    s.add_argument("--ssh", metavar="HOST", default=DEFAULT_HOST)
    s.add_argument("--timeout", type=float, default=60)
    return ap


def main(argv: Optional[Sequence[str]] = None) -> int:
    a = build_parser().parse_args(argv)
    if getattr(a, "from_boot", None) and not getattr(a, "from_root", None):
        print("bridge_migrate: --from-boot goes with --from-root", file=sys.stderr)
        return 2
    a.key = os.path.expanduser(a.key)
    out = Out()
    out.bundle = getattr(a, "bundle", "")
    sudo_user = os.environ.get("SUDO_USER")
    if a.cmd == "backup" and a.out == DEFAULT_OUT and sudo_user and os.geteuid() == 0:
        # `sudo` (to read a mounted card): still save into the user's own home.
        a.out = os.path.join(os.path.expanduser(f"~{sudo_user}"), "splanc-bridge-backup")
    if a.dry_run:
        print("(dry run: nothing will be changed)")
    try:
        return {
            "enable-ssh": cmd_enable_ssh,
            "backup": cmd_backup,
            "inspect": cmd_inspect,
            "restore": cmd_restore,
            "verify": cmd_verify,
        }[a.cmd](a, out)
    except Fail as e:
        print(f"\nSTOPPED: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
