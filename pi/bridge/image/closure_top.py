#!/usr/bin/env python3
"""Print the N largest store paths by self (NAR) size from `nix path-info --json`.

From td-deploy (.github/scripts/closure_top.py, MIT). Nix's human `-h` sizes
don't sort and `--all` includes build tooling; this sorts the system closure
numerically so the CI size step shows what dominates the image.

    nix path-info -r --json <toplevel> | closure_top.py [N] [--markdown]
"""

import json
import sys


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    md = "--markdown" in sys.argv
    n = int(args[0]) if args else 30
    data = json.load(sys.stdin)
    # `nix path-info --json` is a dict {path: info} on newer Nix, a list on older.
    items = data.items() if isinstance(data, dict) else [(x["path"], x) for x in data]
    rows = sorted(((int((v or {}).get("narSize") or 0), k) for k, v in items), reverse=True)
    total = sum(sz for sz, _ in rows)
    if md:
        print(f"Closure: **{total / 1e6:.0f} MB** in {len(rows)} store paths\n")
        print("| MB | store path |\n|---:|---|")
        for sz, path in rows[:n]:
            print(f"| {sz / 1e6:.1f} | `{path.split('/')[-1][33:]}` |")
        return 0
    print(f"total closure self-size: {total / 1e6:.0f} MB across {len(rows)} paths")
    for sz, path in rows[:n]:
        print(f"{sz / 1e6:9.1f} MB  {path.split('/')[-1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
