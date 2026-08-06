"""Finalize a LedMapper custom operator into a self-contained `.tox`.

This script runs *inside TouchDesigner* (paste into a Textport, or run via
`TouchDesigner.exe project.toe -python build_tox.py -- ...`), because a genuine
`.tox` is TouchDesigner's own component-serialization format and can only be
written by TouchDesigner. It wraps the compiled Custom OP plugin in a Base COMP,
embeds the plugin binary with the component's Virtual File System (VFS) so the
resulting `.tox` is self-contained, and saves it.

The Bazel target `//tools/touchdesigner/tox:*` produces a bundle (the plugin +
this script + install notes); this is the last step, run once in TouchDesigner.

Usage inside TouchDesigner's Textport:

    args = ['--plugin', '/path/to/plugin', '--optype', 'Ledmappertexture',
            '--out', '/path/to/LedMapperTexture.tox']
    exec(open('build_tox.py').read())

NOTE: TouchDesigner's Python API differs slightly across releases; validate the
COMP-creation / VFS calls against your version. This is a template, not a
tested build step (it cannot run outside TouchDesigner).
"""

import argparse
import os
import sys


def build_tox(plugin_path: str, optype: str, out_path: str) -> None:
    # `op`, `project`, `baseCOMP` are TouchDesigner globals available in-app.
    root = op("/")  # noqa: F821 (TD global)
    name = os.path.splitext(os.path.basename(out_path))[0]

    comp = root.create(baseCOMP, name)  # noqa: F821 (TD global)

    # Embed the compiled plugin so the .tox carries its own binary (VFS). At
    # load time the component extracts it to a temp Plugins path.
    comp.vfs.addFile(plugin_path)

    # Instantiate the custom operator by its registered type. `optype` is the
    # opType string from Fill*PluginInfo (e.g. "Ledmappertexture").
    try:
        comp.create(optype, optype.lower())
    except Exception as exc:  # noqa: BLE001 - surface, don't abort the save
        print(f"[build_tox] could not auto-create '{optype}': {exc}")
        print("[build_tox] add the operator manually, then re-save the COMP.")

    comp.save(out_path)
    print(f"[build_tox] wrote {out_path}")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plugin", required=True, help="path to the compiled plugin")
    ap.add_argument("--optype", required=True, help="Custom OP type name")
    ap.add_argument("--out", required=True, help="output .tox path")
    args = ap.parse_args(argv)
    build_tox(args.plugin, args.optype, args.out)


if __name__ == "__main__":
    # When run inside TouchDesigner the args come after a `--` separator.
    argv = sys.argv[1:]
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    main(argv)
