"""Package a built TouchDesigner plugin into a distributable bundle.

Bundles the compiled Custom OP plugin together with the in-TouchDesigner
finalizer (`build_tox.py`) and install notes into a single `.tar.gz`. A genuine
`.tox` can only be written by TouchDesigner itself (it is TD's proprietary
component format), so the Bazel build stops here: the bundle is the artifact,
and the `.tox` is produced by either dropping the plugin into TouchDesigner's
Plugins folder or running `build_tox.py` inside TouchDesigner.
"""

import argparse
import io
import os
import tarfile

INSTALL = """\
LedMapper TouchDesigner custom operator — install
==================================================

This bundle contains the compiled plugin plus `build_tox.py`.

Option A — Plugins folder (simplest)
------------------------------------
Copy the plugin from `plugin/` into your TouchDesigner Plugins directory:
  * Windows: Documents/Derivative/Plugins
  * macOS:   ~/Library/Application Support/Derivative/TouchDesigner*/Plugins
Restart TouchDesigner; the operator ({optype}) appears in the OP Create menu.

Option B — self-contained .tox
------------------------------
Run `build_tox.py` inside TouchDesigner to wrap the operator in a COMP and embed
the plugin via VFS, producing a portable `{optype}.tox`. See that file's header
for exact usage.
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="output .tar.gz path")
    ap.add_argument("--optype", required=True, help="Custom OP type name")
    ap.add_argument("--finalizer", required=True, help="path to build_tox.py")
    ap.add_argument("plugins", nargs="+", help="built plugin file(s)")
    args = ap.parse_args()

    with tarfile.open(args.out, "w:gz") as tar:
        for p in args.plugins:
            # macOS ships a `<Name>.plugin` bundle (a directory); Windows ships a
            # bare `.dll`. Add the bundle whole, the .dll on its own, and skip
            # import/archive stubs (.lib/.a/.exp) that ride along on Windows.
            if os.path.isdir(p) or p.endswith((".plugin", ".dll")):
                tar.add(p, arcname=f"plugin/{os.path.basename(p)}")
        tar.add(args.finalizer, arcname="build_tox.py")
        notes = INSTALL.format(optype=args.optype).encode()
        info = tarfile.TarInfo("INSTALL.md")
        info.size = len(notes)
        tar.addfile(info, io.BytesIO(notes))


if __name__ == "__main__":
    main()
