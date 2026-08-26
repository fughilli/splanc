"""Scan the source tree for requirement annotations and check them.

Requirements: PR-25

Two annotation styles carry traceability in the source:

* **Module docs** — a ``Requirements: PR-1, PR-2`` line in a module docstring or
  comment declares which PRs a module implements.
* **Test markers** — ``@requirements("PR-1", "PR-2")`` (or ``@pytest.mark.
  requirements(...)``) on a test declares which PRs it verifies.

This module extracts every referenced ``PR-…`` id (with source locations) and,
given a requirements model, reports any id that is not defined. Wiring this into
CI (``//requirements:check_annotations``) closes the loop against RISK-8: a test
or module can never quietly reference a requirement that has been renamed or
deleted.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from traceability.model import RequirementsModel

# `Requirements: PR-1, PR-2` in a docstring/comment.
_MODULE_RE = re.compile(r"Requirements:\s*([A-Z0-9,\s\-]+)")
# `@requirements("PR-1", "PR-2")` / `requirements("PR-1")` markers.
_MARKER_RE = re.compile(r"requirements\(\s*([^)]*)\)")
_PR_RE = re.compile(r"PR-\d+")

_SCAN_EXTENSIONS = (".py", ".ts", ".rs", ".cc", ".c", ".h", ".hpp", ".go", ".bzl")
# Bazel package files are the uniform, cross-language home for a module's
# "Requirements: PR-…" documentation line, so scan them too.
_SCAN_NAMES = ("BUILD", "BUILD.bazel")
_SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist-test",
    "bazel-testlogs",
    "bazel-out",
    "bazel-bin",
    ".bazel-disk-cache",
    ".bazel-repo-cache",
    "third_party",
}


@dataclass(frozen=True)
class Reference:
    pr_id: str
    path: str
    line: int
    kind: str  # "module" | "test"


def extract_from_text(text: str, path: str = "") -> list[Reference]:
    refs: list[Reference] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for match in _MODULE_RE.finditer(line):
            for pr in _PR_RE.findall(match.group(1)):
                refs.append(Reference(pr, path, lineno, "module"))
        for match in _MARKER_RE.finditer(line):
            for pr in _PR_RE.findall(match.group(1)):
                refs.append(Reference(pr, path, lineno, "test"))
    return refs


def scan_tree(root: str) -> list[Reference]:
    refs: list[Reference] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith("bazel-")]
        for name in filenames:
            if not (name.endswith(_SCAN_EXTENSIONS) or name in _SCAN_NAMES):
                continue
            full = os.path.join(dirpath, name)
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            rel = os.path.relpath(full, root)
            refs.extend(extract_from_text(text, rel))
    return refs


def unknown_references(refs: list[Reference], model: RequirementsModel) -> list[Reference]:
    known = model.known_pr_ids()
    return [r for r in refs if r.pr_id not in known]
