"""Which HITL tests a change can affect: the pure policy behind //pi/hitl/ci:hitl_select.

The HITL lane runs ~20 on-hardware tests (~1.4 C6 board-hours) per run. Most
changes can't affect most of them, so on pull_request / merge_group the lane runs
only the tests a change can reach. The selection is a pipeline:

  1. Bazel impact. Target Determinator (github.com/bazel-contrib/target-determinator)
     compares the configured target graph (cquery, -c opt) at the base and head
     revisions and reports the HITL test targets whose inputs changed: sources,
     BUILD/.bzl, flags (.bazelrc), external repos (MODULE.bazel, patches) and
     select()/transition outcomes. It is the only stage that decides "affected".
  2. Narrowing stages (none shipped yet). Each may only REMOVE tests from the
     Bazel-impacted set, and only when it is confident; otherwise it returns
     UNKNOWN, which keeps everything. A stage that raises is treated as UNKNOWN.
  3. Overrides. A small, reviewed map (overrides.toml) ADDS tests for inputs Bazel
     can't see: the HITL workflow itself, the rig catalogs the daemon serves, and
     the opt-in phone/web lanes, whose tests depend on //web:dist and so would be
     "impacted" by every web change.

Fail safe: if the changed-file list or the Bazel impact is unavailable, the
override map fails to parse, or anything else is unsure, every pool test runs.
Every test carries a machine-readable explanation of why it was kept or dropped.

Stdlib only: the workflow runs this with the runner's python3 before Bazel's
Python toolchain exists, and the unit tests import it directly.
"""

from __future__ import annotations

import dataclasses
import re
import tomllib
from typing import Callable, Iterable, Mapping, Sequence

ALL = "all"
SOME = "some"
NONE = "none"
LANES = ("android", "ios")  # the single-unit phone lanes (boolean opt-ins)


class RulesError(ValueError):
    """The override map is malformed (=> fail safe: run everything)."""


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """`**` = any number of path segments, `*` = within one segment, `?` = one char."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


@dataclasses.dataclass(frozen=True)
class Rule:
    id: str
    why: str
    paths: tuple[str, ...]
    pool_all: bool = False  # select every pool test
    tests: tuple[str, ...] = ()  # specific labels (pool or the web lane)
    lanes: tuple[str, ...] = ()  # phone lanes to switch on

    def matches(self, files: Iterable[str]) -> list[str]:
        rx = [glob_to_regex(p) for p in self.paths]
        return [f for f in files if any(r.match(f) for r in rx)]


_RULE_KEYS = {"id", "why", "paths", "pool", "tests", "lanes"}


def load_rules(text: str) -> list[Rule]:
    try:
        doc = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise RulesError(f"overrides: {e}") from e
    unknown_top = set(doc) - {"rule"}
    if unknown_top:
        raise RulesError(f"overrides: unknown top-level keys {sorted(unknown_top)}")
    rules, seen = [], set()
    for i, r in enumerate(doc.get("rule", [])):
        extra = set(r) - _RULE_KEYS
        if extra:
            raise RulesError(f"overrides rule #{i}: unknown keys {sorted(extra)}")
        rid, why, paths = r.get("id"), r.get("why"), r.get("paths")
        if not rid or not why or not paths:
            raise RulesError(f"overrides rule #{i}: id, why and paths are required")
        if rid in seen:
            raise RulesError(f"overrides: duplicate rule id {rid!r}")
        seen.add(rid)
        pool = r.get("pool")
        if pool not in (None, ALL):
            raise RulesError(f"overrides rule {rid!r}: pool must be {ALL!r}")
        tests = tuple(r.get("tests", ()))
        if any(not t.startswith("//") for t in tests):
            raise RulesError(f"overrides rule {rid!r}: tests must be absolute labels")
        lanes = tuple(r.get("lanes", ()))
        if any(lane not in LANES for lane in lanes):
            raise RulesError(f"overrides rule {rid!r}: lanes must be among {LANES}")
        if not (pool or tests or lanes):
            raise RulesError(f"overrides rule {rid!r}: selects nothing")
        rules.append(Rule(rid, why, tuple(paths), pool == ALL, tests, lanes))
    return rules


# ---------------------------------------------------------------------------
# Narrowing stages (phase 2 seam)


class Unknown:
    """A narrowing stage's "not sure": keep every candidate."""

    def __init__(self, why: str = ""):
        self.why = why


@dataclasses.dataclass(frozen=True)
class Drop:
    """A narrowing stage's confident removals: {test label: reason}."""

    tests: Mapping[str, str]


@dataclasses.dataclass(frozen=True)
class Context:
    changed_files: tuple[str, ...]
    base: str
    head: str


@dataclasses.dataclass(frozen=True)
class Stage:
    """`narrow(candidates, ctx)` -> Drop | Unknown. May only remove candidates."""

    name: str
    narrow: Callable[[frozenset, Context], "Drop | Unknown"]


# Registered narrowing stages, run in order on the Bazel-impacted set. Empty today;
# phase 2 (requirements traceability, coverage) plugs in here.
STAGES: list[Stage] = []


# ---------------------------------------------------------------------------


@dataclasses.dataclass
class Selection:
    mode: str  # all | some | none (of the pool)
    pool: list[str]  # pool tests to run, sorted
    web: list[str]  # web-lane tests to run, sorted
    lanes: dict[str, bool]  # android / ios
    fail_safe: str | None  # why everything runs, when it does for an unsure reason
    tests: dict[str, dict]  # per test: kept + why
    stages: list[dict]  # what each stage did

    def to_json(self) -> dict:
        return dataclasses.asdict(self)


def _apply_overrides(rules, changed_files, pool, candidates, why, web, lanes, lane_why):
    files = list(changed_files)
    for rule in rules:
        hit = rule.matches(files)
        if not hit:
            continue
        ev = {"stage": "override", "rule": rule.id, "why": rule.why, "files": hit[:10]}
        if rule.pool_all:
            for t in pool:
                candidates.add(t)
                why[t].append(ev)
        for t in rule.tests:
            if t in why:
                candidates.add(t)
                why[t].append(ev)
            else:
                web.setdefault(t, []).append(ev)
        for lane in rule.lanes:
            lanes[lane] = True
            lane_why[lane].append(ev)


def select(
    pool: Sequence[str],
    changed_files: Sequence[str] | None,
    impacted: Iterable[str] | None,
    *,
    impact_universe: Iterable[str] | None = None,
    impact_error: str = "",
    rules: Sequence[Rule] | None = None,
    rules_error: str = "",
    stages: Sequence[Stage] = (),
    force_all: str = "",
    base: str = "",
    head: str = "",
) -> Selection:
    """Pick the HITL tests to run.

    pool: every `hitl`-tagged pool test (the lane's discovery query).
    changed_files: the diff's paths (None = unavailable => fail safe).
    impacted: Target Determinator's impacted targets (None = it failed => fail safe).
    impact_universe: the pool tests Target Determinator was asked about; a pool test
        outside it is kept (Bazel didn't look at it).
    force_all: a reason to run everything regardless (push to main, dispatch).
    """
    pool = sorted(set(pool))
    why: dict[str, list[dict]] = {t: [] for t in pool}
    dropped: dict[str, dict] = {}
    stage_log: list[dict] = []
    lanes = {lane: False for lane in LANES}
    lane_why: dict[str, list[dict]] = {lane: [] for lane in LANES}
    web: dict[str, list[dict]] = {}

    fail_safe = ""  # an "unsure" reason; force_all is policy, not unsureness
    if force_all:
        pass
    elif changed_files is None:
        fail_safe = "changed-file list unavailable"
    elif rules is None:
        fail_safe = f"override map unusable: {rules_error or 'not loaded'}"
    elif impacted is None:
        fail_safe = f"bazel impact unavailable: {impact_error or 'target-determinator failed'}"

    if force_all or fail_safe:
        reason = force_all or f"fail safe: {fail_safe}"
        for t in pool:
            why[t].append({"stage": "all", "why": reason})
        if changed_files is not None and rules is not None:
            # The pool runs whole (policy), but the opt-in lanes still follow their paths.
            _apply_overrides(rules, changed_files, pool, set(), why, web, lanes, lane_why)
            for t in pool:
                why[t] = why[t][:1]  # "all" says it; per-rule pool hits are noise here
        else:
            for lane in LANES:
                lanes[lane] = True
                lane_why[lane].append({"stage": "all", "why": reason})
    else:
        # 1. Bazel impact.
        imp = set(impacted)
        universe = set(impact_universe) if impact_universe is not None else set(pool)
        candidates = set()
        for t in pool:
            if t not in universe:
                candidates.add(t)
                why[t].append(
                    {"stage": "bazel", "why": "outside the bazel-impact universe: kept (unsure)"}
                )
            elif t in imp:
                candidates.add(t)
                why[t].append({"stage": "bazel", "why": "impacted (target-determinator)"})
        stage_log.append({"stage": "bazel", "kept": len(candidates), "of": len(pool)})

        # 2. Narrowing: only removes, only when confident.
        ctx = Context(tuple(changed_files), base, head)
        for st in stages:
            try:
                res = st.narrow(frozenset(candidates), ctx)
            except Exception as e:  # noqa: BLE001 - a broken stage must not drop tests
                res = Unknown(f"stage raised {type(e).__name__}: {e}")
            if isinstance(res, Drop):
                bad = set(res.tests) - candidates
                if bad:
                    stage_log.append(
                        {
                            "stage": st.name,
                            "result": "unknown",
                            "why": f"tried to drop non-candidates {sorted(bad)}",
                        }
                    )
                    continue
                for t, r in res.tests.items():
                    candidates.discard(t)
                    dropped[t] = {"stage": st.name, "why": r}
                stage_log.append({"stage": st.name, "result": "dropped", "n": len(res.tests)})
            else:
                stage_log.append(
                    {"stage": st.name, "result": "unknown", "why": getattr(res, "why", "")}
                )

        # 3. Overrides: add what Bazel can't see.
        _apply_overrides(rules, changed_files, pool, candidates, why, web, lanes, lane_why)
        for t in list(dropped):
            if t in candidates:  # an override re-added it
                dropped.pop(t)
        for t in pool:
            if t not in candidates:
                why[t] = []

    selected = sorted(t for t in pool if why[t])
    tests: dict[str, dict] = {}
    for t in pool:
        if why[t]:
            tests[t] = {"lane": "pool", "kept": True, "why": why[t]}
        else:
            tests[t] = {
                "lane": "pool",
                "kept": False,
                "why": [dropped.get(t) or {"stage": "bazel", "why": "not impacted"}],
            }
    for t, ev in web.items():
        tests[t] = {"lane": "web", "kept": True, "why": ev}
    for lane in LANES:
        tests[f"lane:{lane}"] = {
            "lane": lane,
            "kept": lanes[lane],
            "why": lane_why[lane] or [{"stage": "override", "why": "no opt-in path changed"}],
        }

    mode = ALL if len(selected) == len(pool) and pool else (SOME if selected else NONE)
    return Selection(
        mode=mode,
        pool=selected,
        web=sorted(web),
        lanes=lanes,
        fail_safe=fail_safe or None,
        tests=tests,
        stages=stage_log,
    )


def summary_markdown(sel: Selection, n_files: int | None) -> str:
    lines = ["### HITL test selection", ""]
    if sel.fail_safe:
        lines.append(f"**Fail safe — running everything:** {sel.fail_safe}")
    lines.append(
        f"Pool: **{sel.mode}** — {len(sel.pool)} of "
        f"{sum(1 for v in sel.tests.values() if v['lane'] == 'pool')} tests"
        + (f" ({n_files} changed files)" if n_files is not None else "")
    )
    lines.append("")
    lines.append("| test | runs | why |")
    lines.append("|---|---|---|")
    for t, v in sorted(sel.tests.items()):
        reasons = "; ".join(
            (f"{w['stage']}:{w['rule']}" if "rule" in w else f"{w['stage']}: {w['why']}")
            for w in v["why"]
        )
        lines.append(f"| `{t}` | {'yes' if v['kept'] else 'no'} | {reasons} |")
    return "\n".join(lines) + "\n"
