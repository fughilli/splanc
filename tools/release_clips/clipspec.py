"""Feature-preview clip scripts: the declarative format and its validation.

A clip script is a JSON file named ``<id>.clip.json`` checked in next to the
feature it shows (``web/src/ui/whatsnew/whats-new.clip.json``). It says where
the demo starts (route, ``?demo=`` scenario, seeded storage, fixture files),
then the steps to perform while recording. ``docs/release-clips.md`` is the
author's guide; this module is the reference for the fields.

Pure (stdlib only), so the release workflow, the recorder and the tests share it.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

SCHEMA = 1
SUFFIX = ".clip.json"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
FRAMINGS = ("phone", "desktop")
THEMES = ("dark", "light")
# Where clip scripts may live (searched recursively). Clip scripts sit next to
# the feature, so this is the app's source tree.
SEARCH_ROOTS = ("web/src",)
# Hard limits: a preview is a 5-15 s loop, not a tutorial.
MIN_SECONDS = 3.0
MAX_SECONDS = 15.0
MAX_STEPS = 40
MAX_WAIT_MS = 6000

# step kind -> (required keys, optional keys)
STEP_KINDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    # Move the on-screen finger to the element, press, click it.
    "click": (("click",), ("wait", "nth", "force")),
    # Tap + type into a field (typed at a human pace so the clip shows it).
    "type": (("type", "text"), ("wait", "delay")),
    # A key press (Escape, Enter, ArrowDown, ...).
    "press": (("press",), ("wait",)),
    # Smooth-scroll an element (or the page) by N px.
    "scroll": (("scroll", "by"), ("duration", "wait")),
    # Pick an <option> of a <select> by its visible label.
    "select": (("select", "label"), ("wait",)),
    # Wait until a selector is visible (not shown in the clip as an action).
    "wait_for": (("wait_for",), ("timeout",)),
    # A short caption pill over the top of the frame.
    "caption": (("caption",), ("ms",)),
    # Hover (desktop framing).
    "hover": (("hover",), ("wait",)),
    # Pause the script (the recording keeps running). Last: every other step
    # may carry a "wait" too.
    "wait": (("wait",), ()),
}


class SpecError(ValueError):
    pass


@dataclass
class ClipSpec:
    id: str
    title: str
    summary: str
    path: str  # repo-relative path of the .clip.json
    route: str = "#/maps"
    demo: str = ""
    framing: list[str] = field(default_factory=lambda: ["phone"])
    theme: str = "dark"
    prs: list[int] = field(default_factory=list)
    storage: dict[str, str] = field(default_factory=dict)
    fixtures: dict[str, str] = field(default_factory=dict)
    setup: list[dict] = field(default_factory=list)
    steps: list[dict] = field(default_factory=list)
    poster_at: Optional[float] = None
    tail_ms: int = 900
    app_version: str = ""
    drafted: bool = False

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "path": self.path,
            "route": self.route,
            "demo": self.demo,
            "framing": self.framing,
            "theme": self.theme,
            "prs": self.prs,
            "drafted": self.drafted,
        }


def _step_kind(step: dict) -> str:
    for kind in STEP_KINDS:
        if kind in step:
            return kind
    raise SpecError(f"unknown step {json.dumps(step)} (one of: {', '.join(STEP_KINDS)})")


def validate_step(step: Any, where: str) -> dict:
    if not isinstance(step, dict):
        raise SpecError(f"{where}: a step is an object")
    kind = _step_kind(step)
    req, opt = STEP_KINDS[kind]
    allowed = set(req) | set(opt) | {"note"}
    extra = set(step) - allowed
    if extra:
        raise SpecError(f"{where}: {kind} step has unknown keys {sorted(extra)}")
    for k in req:
        if k not in step:
            raise SpecError(f"{where}: {kind} step needs {k!r}")
    for k in ("wait", "ms", "duration", "timeout", "delay", "by", "nth"):
        if k in step and not isinstance(step[k], int):
            raise SpecError(f"{where}: {k!r} is an integer")
    for k in ("wait", "ms", "duration"):
        if k in step and not (0 <= step[k] <= MAX_WAIT_MS):
            raise SpecError(f"{where}: {k!r} must be 0..{MAX_WAIT_MS} ms")
    for k in (
        "click",
        "type",
        "press",
        "scroll",
        "select",
        "wait_for",
        "hover",
        "text",
        "label",
        "caption",
    ):
        if k in step and not (isinstance(step[k], str) and step[k]):
            raise SpecError(f"{where}: {k!r} is a non-empty string")
    return step


def estimate_seconds(steps: list[dict], tail_ms: int = 900) -> float:
    """Rough clip length from the script (the recorder trims to MAX_SECONDS)."""
    ms = tail_ms
    for s in steps:
        kind = _step_kind(s)
        if kind == "click":
            ms += 750 + s.get("wait", 700)
        elif kind == "type":
            ms += 400 + len(s["text"]) * s.get("delay", 70) + s.get("wait", 500)
        elif kind == "scroll":
            ms += s.get("duration", 900) + s.get("wait", 400)
        elif kind == "caption":
            ms += s.get("ms", 1600)
        elif kind == "wait":
            ms += s["wait"]
        else:
            ms += s.get("wait", 500)
    return ms / 1000.0


def parse_spec(obj: Any, path: str) -> ClipSpec:
    if not isinstance(obj, dict):
        raise SpecError(f"{path}: a clip script is a JSON object")
    if obj.get("schema", SCHEMA) != SCHEMA:
        raise SpecError(f"{path}: schema {obj.get('schema')} (this tool reads {SCHEMA})")
    known = {
        "schema", "id", "title", "summary", "route", "demo", "framing", "theme", "prs",
        "storage", "fixtures", "setup", "steps", "poster_at", "tail_ms", "app_version",
        "drafted", "note",
    }  # fmt: skip
    extra = set(obj) - known
    if extra:
        raise SpecError(f"{path}: unknown keys {sorted(extra)}")
    cid = obj.get("id")
    if not isinstance(cid, str) or not ID_RE.match(cid):
        raise SpecError(f"{path}: id must match {ID_RE.pattern}")
    base = os.path.basename(path)
    if base.endswith(SUFFIX) and base[: -len(SUFFIX)] != cid:
        raise SpecError(f"{path}: file name must be {cid}{SUFFIX}")
    for k in ("title", "summary"):
        if not isinstance(obj.get(k), str) or not obj[k].strip():
            raise SpecError(f"{path}: {k!r} is required")
    if len(obj["title"]) > 60:
        raise SpecError(f"{path}: title is at most 60 characters")
    if len(obj["summary"]) > 240:
        raise SpecError(f"{path}: summary is at most 240 characters")
    route = obj.get("route", "#/maps")
    if not isinstance(route, str) or not route.startswith("#/"):
        raise SpecError(f"{path}: route is a hash route like '#/maps'")
    demo = obj.get("demo", "")
    if not isinstance(demo, str) or not re.match(r"^[a-z0-9,_-]*$", demo):
        raise SpecError(f"{path}: demo is a ?demo= scenario list like 'device,bluetooth'")
    framing = obj.get("framing", ["phone"])
    if isinstance(framing, str):
        framing = [framing]
    if not framing or any(f not in FRAMINGS for f in framing) or len(set(framing)) != len(framing):
        raise SpecError(f"{path}: framing is a list from {FRAMINGS}")
    theme = obj.get("theme", "dark")
    if theme not in THEMES:
        raise SpecError(f"{path}: theme is one of {THEMES}")
    prs = obj.get("prs", [])
    if not isinstance(prs, list) or not all(isinstance(p, int) and p > 0 for p in prs):
        raise SpecError(f"{path}: prs is a list of PR numbers")
    storage = obj.get("storage", {})
    if not isinstance(storage, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in storage.items()
    ):
        raise SpecError(f"{path}: storage maps localStorage keys to string values")
    fixtures = obj.get("fixtures", {})
    if not isinstance(fixtures, dict):
        raise SpecError(f"{path}: fixtures maps served paths to repo files")
    for url, src in fixtures.items():
        if not (isinstance(url, str) and url.startswith("/") and ".." not in url):
            raise SpecError(f"{path}: fixture path {url!r} must start with '/'")
        if not (isinstance(src, str) and not os.path.isabs(src) and ".." not in src.split("/")):
            raise SpecError(f"{path}: fixture source {src!r} is a repo-relative file")
    setup = [validate_step(s, f"{path} setup[{i}]") for i, s in enumerate(obj.get("setup", []))]
    steps_raw = obj.get("steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise SpecError(f"{path}: steps is a non-empty list")
    if len(steps_raw) > MAX_STEPS:
        raise SpecError(f"{path}: at most {MAX_STEPS} steps")
    steps = [validate_step(s, f"{path} steps[{i}]") for i, s in enumerate(steps_raw)]
    tail_ms = obj.get("tail_ms", 900)
    if not isinstance(tail_ms, int) or not 0 <= tail_ms <= 4000:
        raise SpecError(f"{path}: tail_ms is 0..4000")
    est = estimate_seconds(steps, tail_ms)
    if est > MAX_SECONDS + 3:
        raise SpecError(
            f"{path}: the script runs ~{est:.1f}s; a preview is at most {MAX_SECONDS:.0f}s"
        )
    poster_at = obj.get("poster_at")
    if poster_at is not None and not (isinstance(poster_at, (int, float)) and poster_at >= 0):
        raise SpecError(f"{path}: poster_at is seconds into the clip")
    app_version = obj.get("app_version", "")
    if app_version and not re.match(r"^\d+\.\d+\.\d+$", str(app_version)):
        raise SpecError(f"{path}: app_version is X.Y.Z")
    return ClipSpec(
        id=cid,
        title=obj["title"].strip(),
        summary=obj["summary"].strip(),
        path=path,
        route=route,
        demo=demo,
        framing=list(framing),
        theme=theme,
        prs=list(prs),
        storage=dict(storage),
        fixtures=dict(fixtures),
        setup=setup,
        steps=steps,
        poster_at=float(poster_at) if poster_at is not None else None,
        tail_ms=tail_ms,
        app_version=str(app_version),
        drafted=bool(obj.get("drafted", False)),
    )


def load_spec(repo: str, rel: str) -> ClipSpec:
    with open(os.path.join(repo, rel)) as f:
        try:
            obj = json.load(f)
        except json.JSONDecodeError as e:
            raise SpecError(f"{rel}: {e}") from e
    return parse_spec(obj, rel)


def find_specs(repo: str) -> list[str]:
    """Repo-relative paths of every clip script, sorted."""
    out = []
    for root in SEARCH_ROOTS:
        top = os.path.join(repo, root)
        for d, dirs, files in os.walk(top):
            dirs[:] = [x for x in dirs if x not in ("node_modules", "dist")]
            for name in files:
                if name.endswith(SUFFIX):
                    out.append(os.path.relpath(os.path.join(d, name), repo))
    return sorted(out)


def load_all(repo: str) -> list[ClipSpec]:
    specs = [load_spec(repo, p) for p in find_specs(repo)]
    seen: dict[str, str] = {}
    for s in specs:
        if s.id in seen:
            raise SpecError(f"clip id {s.id!r} is used by {seen[s.id]} and {s.path}")
        seen[s.id] = s.path
    return specs
