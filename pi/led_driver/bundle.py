"""Write the Pi image's APA102 driver bundle (``ledapp.tar``) deterministically.

    bundle.py OUT.tar DIR FILE... [-- DIR FILE...]...

Each group places its ``.py``/``.rs`` FILEs at ``DIR/<basename>`` (``.`` = the
archive root). The tar is reproducible (sorted, zero mtimes/owners) so the Nix
derivation that unpacks it (pi/provisioning/nix/apps.nix, via sbc-deploy
build_data) only rebuilds when a source actually changes. Stdlib only.
"""

from __future__ import annotations

import io
import sys
import tarfile
from pathlib import Path


def groups(argv: list[str]):
    group: list[str] = []
    for arg in argv + ["--"]:
        if arg == "--":
            if group:
                yield group[0], group[1:]
            group = []
        else:
            group.append(arg)


def main(argv: list[str]) -> int:
    out, rest = argv[0], argv[1:]
    members: dict[str, bytes] = {}
    for arcdir, files in groups(rest):
        for f in files:
            p = Path(f)
            if p.suffix not in (".py", ".rs"):
                continue
            arc = p.name if arcdir == "." else f"{arcdir}/{p.name}"
            if arc in members:
                raise SystemExit(f"duplicate bundle member {arc} ({f})")
            members[arc] = p.read_bytes()
    with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as tar:
        for arc in sorted(members):
            info = tarfile.TarInfo(arc)
            info.size = len(members[arc])
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(members[arc]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
