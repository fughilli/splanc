#!/usr/bin/env python3
"""Fail if a link to this repo's pre-transfer home reappears.

The repo moved from fughilli/splanc to Studio-Fug/splanc. github.com, the API
and raw.githubusercontent.com redirect the old slug, but GitHub Pages
(fughilli.github.io/splanc) does not, and the search API's `repo:` qualifier
does not either. So every reference has to name Studio-Fug/splanc or
studio-fug.github.io/splanc.

Not flagged (and not this repo): the person/brand "fughilli" in LICENSE,
.github/FUNDING.yml, author fields and copyright lines, and fughilli's other
repos (sbc-deploy, hitl-reserve, embedded, rules_fpga, td-deploy, ...).

Run by the `repo-links` prek hook; safe to run by hand from anywhere in the repo.
"""

import re
import subprocess
import sys

PATTERN = r"fughilli(/|\\/|\.github\.io/)(splanc|led_mapper)\b"

# path -> why the old slug is deliberate there.
ALLOWLIST = {
    "WORKLOG.md": "history: records the repo's earlier names",
    "web/_worker.js": "gh-asset still accepts old-owner asset URLs from cached release indexes",
    "web/tests/demoAiWorker.test.mjs": "tests that the old owner is still accepted",
    "tools/check_repo_links.py": "this checker",
}


def main() -> int:
    top = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
    ).stdout.strip()
    res = subprocess.run(
        ["git", "grep", "-n", "-I", "-i", "-P", PATTERN, "--", "."]
        + [f":(exclude){p}" for p in ALLOWLIST],
        cwd=top,
        capture_output=True,
        text=True,
    )
    if res.returncode == 1:
        return 0
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        return res.returncode
    sys.stderr.write(
        "Old repo location found. The repo is Studio-Fug/splanc and Pages is https://studio-fug.github.io/splanc/"
        " (fughilli.github.io does not redirect):\n" + res.stdout
    )
    return 1


if __name__ == "__main__":
    assert re.compile(PATTERN, re.I).search(
        "https://fughilli.github.io/splanc/"
    )  # keep the regex honest
    sys.exit(main())
