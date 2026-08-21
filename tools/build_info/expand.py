"""Expand `@KEY@` placeholders in a template from a Bazel status file.

Reads a Bazel workspace-status file (`KEY value` per line — the format Bazel
writes to stable-status.txt from //tools/build_info/status.sh) and substitutes
every `@KEY@` occurrence in the template with that key's value, writing the
result to `--out`.

Pure stdlib so the py_binary stays hermetic and dependency-free (like
shared/protocol/codegen.py). An `@KEY@` with no matching status key is a build
error, so a renamed status key can't silently ship an unsubstituted template.
"""

from __future__ import annotations

import argparse
import re
import sys

PLACEHOLDER = re.compile(r"@([A-Z0-9_]+)@")


def parse_status(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            # `KEY value` — the value itself may contain spaces.
            key, _, value = line.partition(" ")
            values[key] = value
    return values


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--status", required=True, help="Bazel status file (KEY value lines).")
    ap.add_argument("--template", required=True, help="Template with @KEY@ placeholders.")
    ap.add_argument("--out", required=True, help="Expanded output path.")
    args = ap.parse_args()

    values = parse_status(args.status)
    with open(args.template, encoding="utf-8") as f:
        template = f.read()

    missing: list[str] = []

    def replace(m: "re.Match[str]") -> str:
        key = m.group(1)
        if key not in values:
            missing.append(key)
            return m.group(0)
        return values[key]

    result = PLACEHOLDER.sub(replace, template)
    if missing:
        print(
            f"build_info: template {args.template} references unknown status key(s): "
            + ", ".join(sorted(set(missing))),
            file=sys.stderr,
        )
        return 1

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
