"""Package and sign a Splanc MAX system for over-the-air updates
(docs/design/max-ota.md "Release artifacts").

  MAX_OTA_SIGNING_KEY=<hex> python3 tools/max_ota_release.py \\
      --toplevel /nix/store/...-nixos-system-ledmapper-... --board pi3 --version 1.10.0 \\
      --signer bazel-bin/firmware/ota/ota_sign --pubkey firmware/ota/keys/max.pub \\
      --out-dir _assets [--base-toplevel /nix/store/...-previous-release] [--base-version 1.9.0]

Writes, for board B and release X.Y.Z:
  max-B-X.Y.Z.nixclosure    the image: a text header (board, version, toplevel, and
                            for a delta the `base:` paths it leaves out), then
                            zstd(nix-store --export <the paths the device needs>);
  max-B-X.Y.Z.manifest      its 108-byte signed manifest (key id 3, board in flags
                            bits 24..31) — what a client sends in ota_begin;
  with --base-toplevel, a delta instead: max-B-X.Y.Z-from-W.nixclosure/.manifest,
  holding only the paths the base release doesn't have.

The Pi fetches the image itself (from the release, by the manifest's version); the
client only ever handles the 108-byte manifest. Refuses to sign when the key isn't
the one whose public half is committed (UNSET, or a different key): every MAX would
refuse such an image. `--key-file` signs with a file instead (the TEST key for HITL
images: firmware/ota/keys/test_max.key, with --pubkey firmware/ota/keys/test_max.pub).
Stdlib only; needs nix-store and zstd on PATH; the signature is //firmware/ota:ota_sign.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

MAGIC = "SPLANC-MAX-OTA 1"
KEY_ID_MAX = 3
BOARDS = {"pi3": 1, "pi4": 2, "pi5": 3, "zero2w": 4}
STORE_RE = re.compile(r"^/nix/store/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$")


def read_pub(path):
    lines = [ln.strip() for ln in open(path) if ln.strip() and not ln.strip().startswith("#")]
    return "".join(lines).lower()


def version_number(v):
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", v)
    if not m:
        sys.exit(f"max_ota_release: bad version {v!r} (want X.Y.Z)")
    a, b, c = (int(x) for x in m.groups())
    if b > 999 or c > 999:
        sys.exit(f"max_ota_release: version {v} doesn't fit the manifest")
    return a * 1_000_000 + b * 1_000 + c


def manifest_flags(board, security_version):
    return (KEY_ID_MAX << 8) | (security_version << 16) | (BOARDS[board] << 24)


def header(board, version, toplevel, base):
    lines = [
        MAGIC,
        f"board: {board}",
        f"version: {version}",
        f"toplevel: {toplevel}",
        "compression: zstd",
    ]
    lines += [f"base: {p}" for p in base]
    return ("\n".join(lines) + "\n\n").encode()


def closure(path):
    out = subprocess.run(
        ["nix-store", "-qR", path], check=True, capture_output=True, text=True
    ).stdout
    paths = [p for p in out.split() if p]
    for p in paths:
        if not STORE_RE.match(p):
            sys.exit(f"max_ota_release: unexpected store path {p!r}")
    return paths


def write_image(out_path, board, version, toplevel, base_paths, level):
    """header || zstd(nix-store --export (closure - base)). Returns (size, sha256, n_paths)."""
    full = closure(toplevel)
    base = sorted(set(full) & set(base_paths))
    export = [p for p in full if p not in set(base)]
    with open(out_path, "wb") as f:
        f.write(header(board, version, toplevel, base))
        f.flush()
        exp = subprocess.Popen(["nix-store", "--export", *export], stdout=subprocess.PIPE)
        z = subprocess.run(
            ["zstd", "-q", f"-{level}", "-T0", "-c"], stdin=exp.stdout, stdout=f, check=False
        )
        exp.stdout.close()
        if exp.wait() != 0 or z.returncode != 0:
            sys.exit("max_ota_release: nix-store --export | zstd failed")
    h = hashlib.sha256()
    with open(out_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return os.path.getsize(out_path), h.hexdigest(), len(export), len(base)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--toplevel", required=True, help="the system's store path, or a file holding it"
    )
    ap.add_argument("--board", required=True, choices=sorted(BOARDS))
    ap.add_argument("--version", required=True)
    ap.add_argument("--signer", required=True)
    ap.add_argument("--pubkey", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--key-env", default="MAX_OTA_SIGNING_KEY")
    ap.add_argument("--key-file", default="")
    ap.add_argument("--security-version", type=int, default=0)
    ap.add_argument("--base-toplevel", default="", help="build a delta against this system")
    ap.add_argument("--base-version", default="", help="the base's version (names the delta)")
    ap.add_argument("--name", default="", help="override the asset base name (HITL images)")
    ap.add_argument("--zstd-level", type=int, default=19)
    a = ap.parse_args()

    toplevel = a.toplevel
    if os.path.isfile(toplevel) and not toplevel.startswith("/nix/store/"):
        toplevel = open(toplevel).read().strip()
    toplevel = os.path.realpath(toplevel) if not STORE_RE.match(toplevel) else toplevel
    if not STORE_RE.match(toplevel):
        sys.exit(f"max_ota_release: --toplevel {toplevel!r} isn't a store path")
    base_top = a.base_toplevel
    if base_top and os.path.isfile(base_top) and not base_top.startswith("/nix/store/"):
        base_top = open(base_top).read().strip()

    want = read_pub(a.pubkey)
    if want == "unset":
        sys.exit(
            f"max_ota_release: {a.pubkey} is UNSET — generate the MAX key first (docs/design/max-ota.md)"
        )
    key_args = ["--key-file", a.key_file] if a.key_file else ["--key-env", a.key_env]
    if not a.key_file and not os.environ.get(a.key_env):
        sys.exit(f"max_ota_release: ${a.key_env} is not set")
    got = (
        subprocess.run([a.signer, "pubkey", *key_args], capture_output=True, text=True, check=True)
        .stdout.strip()
        .lower()
    )
    if got != want:
        sys.exit(f"max_ota_release: the signing key is not the one whose public half is {a.pubkey}")
    if not 0 <= a.security_version <= 255:
        sys.exit("max_ota_release: --security-version is 0..255")

    ver = version_number(a.version)
    vtext = re.match(r"^v?(\d+\.\d+\.\d+)", a.version).group(1)
    name = a.name or f"max-{a.board}-{vtext}"
    base_paths = []
    if base_top:
        base_paths = closure(base_top)
        if not a.name:
            name += f"-from-{a.base_version or 'base'}"
    os.makedirs(a.out_dir, exist_ok=True)
    img = os.path.join(a.out_dir, f"{name}.nixclosure")
    size, sha, n_export, n_base = write_image(img, a.board, ver, toplevel, base_paths, a.zstd_level)
    if size >= 1 << 32:
        sys.exit("max_ota_release: image is 4 GiB or more; the manifest can't describe it")
    man = os.path.join(a.out_dir, f"{name}.manifest")
    flags = manifest_flags(a.board, a.security_version)
    out = subprocess.run(
        [
            a.signer,
            "sign",
            "--version",
            str(ver),
            "--in",
            img,
            "--out",
            man,
            "--flags",
            str(flags),
            *key_args,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(out.stdout.strip().splitlines()[-1])
    if info["sha256"] != sha or info["size"] != size:
        sys.exit("max_ota_release: the signer saw a different image")
    print(
        json.dumps(
            {
                "image": os.path.basename(img),
                "manifest": os.path.basename(man),
                "board": a.board,
                "version": ver,
                "size": size,
                "sha256": sha,
                "toplevel": toplevel,
                "exported_paths": n_export,
                "base_paths": n_base,
                "flags": flags,
            }
        )
    )


if __name__ == "__main__":
    if not shutil.which("nix-store") or not shutil.which("zstd"):
        sys.exit("max_ota_release: needs nix-store and zstd on PATH")
    main()
