#!/usr/bin/env python3
"""One-target user-guide rebuild (FUG-103): regenerate the Markdown + static
site + screenshot manifest, then capture fresh app screenshots — in a single
`bazel run //docs:build_user_guide`.

The Markdown/HTML/manifest come from the TypeScript generator (`//web:gen_user_guide`,
a js_binary carried here as a runfiles data dep); the screenshots come from the
sibling `capture_user_guide` module. Both write into the working tree via
`$BUILD_WORKSPACE_DIRECTORY`, so one command leaves the guide fully refreshed.
Like FUG-104's `//docs:build`, it is a `bazel run` tool and never part of
`bazel test //...`.
"""

import os
import subprocess
import sys

import capture_user_guide


def find_generator() -> str:
    """Locate the //web:gen_user_guide launcher in our runfiles (it's a data
    dep). We search rather than hard-code the mangled js_binary path so a rules_js
    layout change can't silently break the one-target rebuild."""
    roots = []
    rf = os.environ.get("RUNFILES_DIR")
    if rf:
        roots.append(rf)
    manifest = os.environ.get("RUNFILES_MANIFEST_FILE")
    if manifest and manifest.endswith(".runfiles_manifest"):
        roots.append(manifest[: -len("_manifest")])
    # Fallback: <argv0>.runfiles next to this binary.
    roots.append(sys.argv[0] + ".runfiles")
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            if "gen_user_guide" in files:
                cand = os.path.join(dirpath, "gen_user_guide")
                if os.access(cand, os.X_OK):
                    return cand
    sys.exit("could not locate //web:gen_user_guide in runfiles")


def main() -> int:
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    if not ws:
        sys.exit("run via `bazel run //docs:build_user_guide`")
    gen = find_generator()
    print("[build_user_guide] regenerating Markdown + site + manifest…", file=sys.stderr)
    # BAZEL_BINDIR="." lets the aspect_rules_js launcher run outside a build
    # action (it otherwise refuses); gen writes via absolute BUILD_WORKSPACE_DIRECTORY.
    env = dict(os.environ, BUILD_WORKSPACE_DIRECTORY=ws, BAZEL_BINDIR=".")
    subprocess.run([gen], check=True, cwd=ws, env=env)
    print("[build_user_guide] capturing app screenshots…", file=sys.stderr)
    return capture_user_guide.main()


if __name__ == "__main__":
    sys.exit(main())
