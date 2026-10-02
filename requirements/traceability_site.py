#!/usr/bin/env python3
"""Assemble the published traceability site (GitHub Pages, /traceability/).

Output layout:
  index.html                 the COMBINED report: the model at the published
                             commit against the evidence of the latest main Test
                             run (software) and HITL run (hardware) together
  traceability-report.json   the combined report as data
  traceability-queue.json    its gap queue
  software/index.html (+ .json, queue)   the Test run's own report
  hitl/index.html (+ .json, queue)       the HITL run's own report
  build-info.json            provenance: commits, runs, generation time

Hardware evidence stamped with another commit than the published one reads
STALE in the combined report (it was gathered on different firmware).

Run by .github/workflows/traceability-site.yaml, with `rr` (rules_requirements,
installed at the commit MODULE.bazel pins) on PATH. See
docs/requirements-driven-development.md.

@rr(PR-25): the published traceability report
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import shutil
import subprocess
import sys

TITLE = "splanc requirements traceability"

_NAV_STYLE = (
    "font:13px/1.5 system-ui,sans-serif;padding:8px 16px;margin:0;"
    "border-bottom:1px solid rgba(127,127,127,.35);display:flex;flex-wrap:wrap;"
    "gap:4px 16px;align-items:baseline"
)


def _copy_report(src: str, dst: str, html_name: str) -> bool:
    """Copy one run's report files into ``dst`` (its HTML as index.html)."""
    if not src or not os.path.isdir(src):
        return False
    os.makedirs(dst, exist_ok=True)
    found = False
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if not os.path.isfile(path) or name.endswith(".md"):
            continue  # Markdown: GitHub Pages' Jekyll would rewrite it; the run summary has it
        target = "index.html" if name == html_name else name
        shutil.copyfile(path, os.path.join(dst, target))
        found = found or name == html_name
    return found


def _nav(prefix: str, info: dict, current: str) -> str:
    """The banner on every page: what this is, where it came from, the others."""

    def link(href: str, text: str, key: str) -> str:
        if key == current:
            return f"<strong>{html.escape(text)}</strong>"
        return f'<a href="{html.escape(prefix + href)}">{html.escape(text)}</a>'

    def run(label: str, url: str, sha: str) -> str:
        if not url:
            return f"{label}: none yet"
        return (
            f'{label}: <a href="{html.escape(url)}">run</a> @ <code>{html.escape(sha[:8])}</code>'
        )

    pages = [
        link("./", "Combined (software + hardware)", "combined"),
        link("software/", "Software", "software"),
    ]
    if info["hitl"]["run"]:
        pages.append(link("hitl/", "Hardware (HITL)", "hitl"))
    data = "software/" if current == "software" else "hitl/" if current == "hitl" else ""
    downloads = [
        f'<a href="{html.escape(prefix + data + name)}">{label}</a>'
        for name, label in (
            ("traceability-report.json", "JSON"),
            ("traceability-queue.json", "gap queue"),
        )
    ]
    if current == "hitl":
        downloads = [
            f'<a href="{html.escape(prefix + "hitl/" + name)}">{label}</a>'
            for name, label in (
                ("hitl-traceability-report.json", "JSON"),
                ("hitl-traceability-queue.json", "gap queue"),
            )
        ]
    parts = [
        " · ".join(pages),
        f"main @ <code>{html.escape(info['commit'][:8])}</code>",
        run("software", info["software"]["run"], info["software"]["commit"]),
        run("hardware", info["hitl"]["run"], info["hitl"]["commit"]),
        f"generated {html.escape(info['generated'])}",
        " · ".join(downloads),
    ]
    items = "".join(f"<span>{p}</span>" for p in parts)
    return f'<nav class="rr-site" style="{_NAV_STYLE}">{items}</nav>'


def _inject(path: str, nav: str) -> None:
    with open(path, encoding="utf-8") as fh:
        page = fh.read()
    marker = "<body>"
    if marker not in page:
        raise SystemExit(f"{path}: no <body> to put the site banner after")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(page.replace(marker, marker + nav, 1))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", required=True, help="site directory to create")
    ap.add_argument("--root", required=True, help="the repository checkout at the published commit")
    ap.add_argument("--commit", required=True, help="the published commit (the software run's)")
    ap.add_argument(
        "--software-report", default="", help="the Test run's traceability-report artifact"
    )
    ap.add_argument(
        "--software-evidence", default="", help="the Test run's traceability-evidence artifact"
    )
    ap.add_argument("--software-run", default="", help="URL of that Test run")
    ap.add_argument(
        "--hitl-report", default="", help="the HITL run's hitl-traceability-report artifact"
    )
    ap.add_argument(
        "--hitl-evidence", default="", help="the HITL run's hitl-traceability-evidence artifact"
    )
    ap.add_argument("--hitl-run", default="", help="URL of that HITL run")
    ap.add_argument("--hitl-commit", default="", help="the commit that HITL run tested")
    args = ap.parse_args(argv)

    if not args.software_evidence or not os.path.isdir(args.software_evidence):
        raise SystemExit("no software evidence: nothing to publish")
    evidence = [args.software_evidence]
    has_hitl = bool(args.hitl_evidence) and os.path.isdir(args.hitl_evidence)
    if has_hitl:
        evidence.append(args.hitl_evidence)
    os.makedirs(args.out, exist_ok=True)
    info = {
        "commit": args.commit,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "software": {"run": args.software_run, "commit": args.commit},
        "hitl": {
            "run": args.hitl_run if has_hitl else "",
            "commit": args.hitl_commit if has_hitl else "",
        },
    }

    # The combined report: hardware evidence from another commit reads STALE.
    out = os.path.abspath(args.out)
    subprocess.run(
        [
            "rr",
            "report",
            "--model",
            os.path.join(args.root, "requirements"),
            "--evidence",
            *evidence,
            "--current-build",
            f"dut_git_sha={args.commit}",
            "--scan",
            "--root",
            args.root,
            "--title",
            TITLE + (" (software + hardware)" if has_hitl else " (software; no HITL run yet)"),
            "--html",
            os.path.join(out, "index.html"),
            "--json",
            os.path.join(out, "traceability-report.json"),
            "--queue-out",
            os.path.join(out, "traceability-queue.json"),
        ],
        check=True,
    )
    _inject(os.path.join(out, "index.html"), _nav("", info, "combined"))
    if _copy_report(
        args.software_report, os.path.join(out, "software"), "traceability-report.html"
    ):
        _inject(os.path.join(out, "software", "index.html"), _nav("../", info, "software"))
    if has_hitl and _copy_report(
        args.hitl_report, os.path.join(out, "hitl"), "hitl-traceability-report.html"
    ):
        _inject(os.path.join(out, "hitl", "index.html"), _nav("../", info, "hitl"))
    with open(os.path.join(out, "build-info.json"), "w", encoding="utf-8") as fh:
        json.dump(info, fh, indent=2)
        fh.write("\n")
    print(
        f"site: {out} ({'software + hardware' if has_hitl else 'software only'})", file=sys.stderr
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
