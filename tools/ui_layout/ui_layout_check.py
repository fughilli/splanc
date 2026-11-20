#!/usr/bin/env python3
"""Layout guard: render screens at phone + desktop, light + dark, and fail on
overlapping or crammed controls (owner rule, 2026-11-18: never cram buttons).

    bazel run //tools/ui_layout:ui_layout_check                 # check, exit 1 on violations
    bazel run //tools/ui_layout:ui_layout_check -- --shots DIR  # + a PNG per screen/variant
    bazel run //tools/ui_layout:ui_layout_check -- --only flow-0 # scenarios whose id starts so

To guard another screen, add a module of `Scenario`s (see credits_scenarios.py)
and list it in SCENARIO_MODULES. `bazel run` only (a py_binary is never run by
`bazel test //...`), so CI needs no browser; the geometry itself is unit-tested
by //tools/ui_layout:layout_guard_test.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import connect_scenarios  # noqa: E402
import credits_scenarios  # noqa: E402
import layout_guard  # noqa: E402

SCENARIO_MODULES = [connect_scenarios, credits_scenarios]


def find_dist() -> Path:
    """The built //web:dist from runfiles (bazel run), else bazel-bin."""
    for base in (os.environ.get("RUNFILES_DIR"), os.path.abspath(__file__) + ".runfiles"):
        if base:
            for cand in (Path(base) / "_main" / "web" / "dist", Path(base) / "web" / "dist"):
                if (cand / "index.html").exists():
                    return cand
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY", ".")
    return Path(ws) / "bazel-bin" / "web" / "dist"


def ensure_browser() -> None:
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return
    except Exception:
        pass
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(x for x in sys.path if x))
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, env=env)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--dist", type=Path, help="built web app (default: //web:dist)")
    ap.add_argument("--shots", type=Path, help="write <scenario>-<viewport>-<theme>.png here")
    ap.add_argument(
        "--only", default="", help="only scenarios whose id starts with this (comma-separated)"
    )
    ap.add_argument("--viewport", choices=sorted(layout_guard.VIEWPORTS), help="one viewport only")
    ap.add_argument("--theme", choices=layout_guard.THEMES, help="one theme only")
    ap.add_argument(
        "--selftest",
        action="store_true",
        help="prove the guard fails on a deliberately crammed screen",
    )
    a = ap.parse_args()
    dist = a.dist or find_dist()
    if not (dist / "index.html").exists():
        sys.exit(f"no built app at {dist} (bazel build //web:dist)")
    prefixes = [p for p in a.only.split(",") if p]
    scenarios = [
        s
        for m in SCENARIO_MODULES
        for s in m.SCENARIOS
        if not prefixes or any(s.id.startswith(p) for p in prefixes)
    ]
    shots = a.shots
    if shots and not shots.is_absolute():
        shots = Path(os.environ.get("BUILD_WORKING_DIRECTORY", ".")) / shots
    ensure_browser()
    if a.selftest:
        return selftest(dist)
    vps = {a.viewport: layout_guard.VIEWPORTS[a.viewport]} if a.viewport else None
    themes = (a.theme,) if a.theme else layout_guard.THEMES
    res = layout_guard.run_scenarios(dist, scenarios, shots, vps, themes)
    bad = {k: v for k, v in res.items() if v}
    print(f"\n{len(res) - len(bad)}/{len(res)} screen variants pass the layout guard.")
    return 1 if bad else 0


def selftest(dist: Path) -> int:
    """The intro screen with its action row squeezed to a 2 px gap and the
    buttons side by side must FAIL (a guard that never fails guards nothing)."""
    crammed = layout_guard.Scenario(
        "selftest-crammed",
        "#/credits",
        seed=credits_scenarios.FLAG,
        network=credits_scenarios.fake(),
        steps=[
            (
                "css",
                ".cf-actions { flex-direction: row !important; gap: 2px !important; }"
                " .cf-actions > .k-btn { width: auto !important; }",
            )
        ],
    )
    res = layout_guard.run_scenarios(
        dist, [crammed], None, {"phone": layout_guard.VIEWPORTS["phone"]}, ("dark",)
    )
    caught = all(any(x.kind == "gap" for x in v) for v in res.values())
    print(
        "selftest:",
        "the guard caught the crammed row" if caught else "the guard MISSED the crammed row",
    )
    return 0 if caught else 1


if __name__ == "__main__":
    sys.exit(main())
