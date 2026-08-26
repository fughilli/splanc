"""Fail if any source annotation references a requirement id that doesn't exist.

Requirements: PR-25

Run over the whole workspace (``bazel run //requirements:check_annotations``):
scans the tree for ``Requirements: PR-…`` module docs and ``@requirements("PR-…")``
test markers and checks every referenced id against requirements/requirements.yaml.
Exits non-zero (listing the offenders) if any id is unknown.
"""

import os
import sys

from traceability import annotations
from traceability.model import load_model


def _workspace_root() -> str:
    # `bazel run` sets this to the source tree (not the sandbox).
    root = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    return root or os.getcwd()


def main() -> int:
    root = _workspace_root()
    model = load_model(os.path.join(root, "requirements", "requirements.yaml"))
    refs = annotations.scan_tree(root)
    unknown = annotations.unknown_references(refs, model)

    print(f"scanned {root}: {len(refs)} requirement reference(s) across the tree")
    if unknown:
        print(f"\n{len(unknown)} reference(s) to unknown requirement ids:", file=sys.stderr)
        for r in sorted(unknown, key=lambda x: (x.path, x.line)):
            print(f"  {r.path}:{r.line}: {r.pr_id} ({r.kind})", file=sys.stderr)
        return 1
    print("all requirement references resolve to defined ids.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
