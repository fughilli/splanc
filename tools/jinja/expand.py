"""Jinja2 expansion behind the jinja_template rule (see jinja.bzl).

Deliberately strict and boring: StrictUndefined so a template referencing a
variable the BUILD file didn't pass FAILS the action (the sed pipeline this
replaces would silently ship the raw placeholder); no autoescaping because
the rendered file IS the artifact and the variables are build constants.

The loader searches the execroot (workspace-relative paths) and the
template's own directory, so {% include %} works both for siblings and for
deps from other packages.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined


def parse_defines(defines: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for d in defines:
        key, sep, value = d.partition("=")
        if not sep or not key:
            raise SystemExit(f"--define must be KEY=VALUE, got {d!r}")
        out[key] = value
    return out


def render(template: str, variables: dict[str, str]) -> str:
    # Load the template by BASENAME rooted at its own directory —
    # FileSystemLoader rejects absolute template names, and this keeps the
    # entry template working from any path shape. "." (the execroot) stays on
    # the search path so {% include %} can reference deps from other packages
    # by workspace-relative POSIX path.
    path = Path(template)
    env = Environment(
        loader=FileSystemLoader([str(path.parent), "."]),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
        autoescape=False,
    )
    return env.get_template(path.name).render(variables)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--define",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="a template variable (repeatable)",
    )
    args = parser.parse_args(argv)
    rendered = render(args.template, parse_defines(args.define))
    Path(args.out).write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
