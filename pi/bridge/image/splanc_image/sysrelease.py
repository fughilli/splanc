"""CI side of the bridge's full-system OTA: turn a signed ``file://`` Nix binary
cache into flat GitHub release assets (see nixcache.py for the layout).

    # after: nix copy --to file://$C?compression=zstd $TOP
    #        nix store sign --store file://$C --key-file $KEY -r $TOP
    python3 -m splanc_image.sysrelease manifest --cache $C --toplevel $TOP \\
        --board pi5 --version 1.3.0 \\
        --nar-base-url https://github.com/<repo>/releases/download/pi-bridge-ota-v1.3.0 \\
        --require-key splanc-bridge-1 --out out-ota
    #  -> out-ota/<filehash>.nar.zst ...  (one asset per store path)
    #     out-ota/bridge-system-pi5-1.3.0.json   (the manifest: every narinfo)

    python3 -m splanc_image.sysrelease pointer --manifest out-ota/bridge-system-pi5-1.3.0.json \\
        --manifest-url https://.../pi-bridge-ota-v1.3.0/bridge-system-pi5-1.3.0.json \\
        --out bridge-system-pi5.json      # -> the channel release (pi-bridge-ota)

`manifest` refuses a closure path without a narinfo or NAR file, and (with
--require-key) one not signed by that key, so CI can't publish a release the
device would reject. Without --require-key it is a dry run (no signing key in CI
yet): same assets, unsigned, which no device accepts.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

from splanc_image import nixcache as nc


def read_cache(cache_dir: str) -> dict:
    infos = {}
    for name in os.listdir(cache_dir):
        if not name.endswith(".narinfo"):
            continue
        with open(os.path.join(cache_dir, name), encoding="utf-8") as f:
            ni = nc.parse_narinfo(f.read())
        if name != ni.hash + ".narinfo":
            raise nc.CacheError(f"{name} describes {ni.store_path}")
        infos[ni.hash] = ni
    return infos


def build_manifest(
    cache_dir: str,
    toplevel: str,
    board: str,
    version: str,
    nar_base_url: str,
    out_dir: str,
    require_key: str = "",
) -> dict:
    if not nc.BOARD_RE.match(board):
        raise nc.CacheError(f"bad board {board!r}")
    if not nc.VERSION_RE.match(version):
        raise nc.CacheError(f"bad version {version!r}")
    infos = read_cache(cache_dir)
    paths = nc.closure(infos, toplevel)
    os.makedirs(out_dir, exist_ok=True)
    unsigned = []
    file_bytes = nar_bytes = 0
    for ni in paths:
        if require_key and not ni.signed_by(require_key):
            unsigned.append(ni.store_path)
        src = os.path.join(cache_dir, ni.url)
        try:
            size = os.path.getsize(src)
        except OSError as e:
            raise nc.CacheError(f"{ni.store_path}: NAR file {ni.url} missing") from e
        if size != ni.file_size:
            raise nc.CacheError(f"{ni.url}: {size} bytes, narinfo says {ni.file_size}")
        dst = os.path.join(out_dir, ni.nar_file)
        if not os.path.exists(dst):
            shutil.copyfile(src, dst)
        file_bytes += ni.file_size
        nar_bytes += ni.nar_size
    if unsigned:
        raise nc.CacheError(
            f"{len(unsigned)} store paths are not signed by {require_key}, e.g. {unsigned[0]}"
        )
    name = f"bridge-system-{board}-{version}.json"
    with open(os.path.join(out_dir, name), "wb") as f:
        f.write(nc.render_manifest(board, version, toplevel, nar_base_url, paths))
    return {
        "manifest": name,
        "paths": len(paths),
        "nar_files": len({ni.nar_file for ni in paths}),
        "compressed_bytes": file_bytes,
        "nar_bytes": nar_bytes,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="sysrelease", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("manifest", help="cache dir -> flat NAR assets + manifest")
    m.add_argument("--cache", required=True)
    m.add_argument("--toplevel", required=True)
    m.add_argument("--board", required=True)
    m.add_argument("--version", required=True)
    m.add_argument("--nar-base-url", required=True)
    m.add_argument("--out", required=True)
    m.add_argument("--require-key", default="", help="key name every path must be signed by")
    p = sub.add_parser("pointer", help="manifest -> channel pointer")
    p.add_argument("--manifest", required=True)
    p.add_argument("--manifest-url", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--allow-http", action="store_true", help=argparse.SUPPRESS)  # VM test
    a = ap.parse_args(argv)
    try:
        if a.cmd == "manifest":
            top = os.path.realpath(a.toplevel) if os.path.islink(a.toplevel) else a.toplevel
            s = build_manifest(
                a.cache, top, a.board, a.version, a.nar_base_url, a.out, a.require_key
            )
            print(
                f"{s['manifest']}: {s['paths']} store paths, {s['nar_files']} NAR files, "
                f"{s['compressed_bytes'] / 1e6:.0f} MB compressed ({s['nar_bytes'] / 1e6:.0f} MB unpacked)"
            )
        else:
            with open(a.manifest, "rb") as f:
                data = f.read()
            man = nc.parse_manifest(data, allow_http=a.allow_http)
            with open(a.out, "wb") as f:
                f.write(nc.render_pointer(man, data, a.manifest_url))
            print(f"{a.out}: {man.board} {man.version} -> {a.manifest_url}")
    except (nc.CacheError, OSError) as e:
        print(f"sysrelease: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
