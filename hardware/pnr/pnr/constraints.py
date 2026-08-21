"""Constraint schema + compiler (design doc §3).

Parses the sidecar ``constraints.yaml`` that sits next to a board and compiles it
into the terms the placer consumes: every constraint becomes either a **hard
barrier** (a feasibility region the optimizer must not violate — fixed poses,
keep-outs) or a **soft penalty** (a weighted gradient expressing intent — edge
pulls, side preference, grouping). See the design doc for why "hard as barriers,
soft as penalties" lets one relaxation engine handle both.

This module is the *front end* only: it validates the file, expands globs against
the real netlist, and emits structured, weighted :class:`Constraint` objects. The
actual penalty/barrier *math* (turning these into torch terms) lives in the
placement package added in a later phase — keeping the schema pure Python means
it is unit-testable with no torch/pcbnew in the loop.

Coordinate frame matches :mod:`pnr.graph`: mm, origin bottom-left, ``rot`` CCW.
Schema is versioned (``v0``); unknown top-level keys and unknown component refs
are warnings, not errors, so the file can grow without breaking older boards.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import yaml

SCHEMA_VERSION = "v0"

EDGES = ("north", "south", "east", "west")
SIDES = ("top", "bottom")

# The board-outline default when the file omits one; the placer reframes to the
# real Edge.Cuts once ingested.
DEFAULT_CLEARANCE_MM = 0.2


class Enforcement(Enum):
    """How a constraint acts in the optimizer."""

    HARD = "hard"  # feasibility barrier
    SOFT = "soft"  # weighted penalty gradient


# Default weights for soft terms (relative; tuned later against real boards).
DEFAULT_WEIGHTS = {
    "edge_align": 5.0,
    "side_pref": 1.0,
    "group": 2.0,
}


@dataclass
class BoardSpec:
    """The ``board:`` block — approximate outline + global rules."""

    width: Optional[float] = None
    height: Optional[float] = None
    layers: int = 2
    default_clearance_mm: float = DEFAULT_CLEARANCE_MM


@dataclass
class Constraint:
    """A single compiled constraint.

    ``kind`` is the YAML section it came from (``fixed``/``edge_align``/
    ``keepout``/``side_pref``/``group``); ``enforcement`` says whether the placer
    treats it as a barrier or a penalty; ``refs`` are the *resolved* component
    references it applies to (globs already expanded); ``params`` carries the
    kind-specific fields; ``weight`` is the penalty weight for soft terms
    (``None`` for hard).
    """

    kind: str
    enforcement: Enforcement
    refs: Tuple[str, ...]
    params: Dict = field(default_factory=dict)
    weight: Optional[float] = None
    name: Optional[str] = None


@dataclass
class CompiledConstraints:
    """The whole file, compiled and validated."""

    board: BoardSpec
    constraints: List[Constraint] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    schema: str = SCHEMA_VERSION

    @property
    def hard(self) -> List[Constraint]:
        return [c for c in self.constraints if c.enforcement is Enforcement.HARD]

    @property
    def soft(self) -> List[Constraint]:
        return [c for c in self.constraints if c.enforcement is Enforcement.SOFT]

    def for_ref(self, ref: str) -> List[Constraint]:
        return [c for c in self.constraints if ref in c.refs]

    @property
    def locked_refs(self) -> Tuple[str, ...]:
        """Refs held out of the position gradient (fixed poses)."""
        out: List[str] = []
        for c in self.constraints:
            if c.kind == "fixed":
                out.extend(c.refs)
        return tuple(out)


class ConstraintError(ValueError):
    """A structural problem that cannot be a warning (bad enum, malformed block)."""


def _expand_refs(
    patterns: Iterable[str], known: Sequence[str], warnings: List[str], where: str
) -> Tuple[str, ...]:
    """Expand a ref or glob against the netlist.

    A literal ref that matches nothing is a warning (kept, so the intent is
    visible, but the placer ignores it); a glob (``*``/``?``/``[``) that matches
    nothing is also a warning. Order is stable and de-duplicated.
    """

    resolved: List[str] = []
    seen = set()
    for pat in patterns:
        is_glob = any(ch in pat for ch in "*?[")
        if is_glob:
            matches = [r for r in known if fnmatch.fnmatchcase(r, pat)]
            if not matches:
                warnings.append(f"{where}: glob {pat!r} matched no components")
            hits = matches
        else:
            if pat in known:
                hits = [pat]
            else:
                warnings.append(f"{where}: unknown component ref {pat!r}")
                hits = [pat]  # keep it; the placer will skip refs it can't find
        for r in hits:
            if r not in seen:
                seen.add(r)
                resolved.append(r)
    return tuple(resolved)


def _require_enum(value, allowed, where: str):
    if value is not None and value not in allowed:
        raise ConstraintError(f"{where}: {value!r} not one of {tuple(allowed)}")
    return value


def _parse_board(raw: Dict) -> BoardSpec:
    outline = raw.get("outline") or {}
    return BoardSpec(
        width=outline.get("w"),
        height=outline.get("h"),
        layers=int(raw.get("layers", 2)),
        default_clearance_mm=float(raw.get("default_clearance_mm", DEFAULT_CLEARANCE_MM)),
    )


def compile_constraints(doc: Dict, known_refs: Sequence[str]) -> CompiledConstraints:
    """Compile a parsed constraints document against a netlist's refs.

    ``doc`` is the already-parsed YAML mapping (see :func:`load_constraints` for
    the file entry point); ``known_refs`` is the component references from the
    ingested :class:`pnr.graph.BoardGraph`. Returns validated, glob-expanded
    :class:`Constraint` objects plus non-fatal warnings.
    """

    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        raise ConstraintError("top level must be a mapping")

    warnings: List[str] = []
    board = _parse_board(doc.get("board") or {})
    constraints: List[Constraint] = []

    known_keys = {
        "schema",
        "board",
        "fixed",
        "edge_align",
        "keepout",
        "side_pref",
        "group",
    }
    for key in doc:
        if key not in known_keys:
            warnings.append(f"unknown top-level section {key!r} (ignored)")

    # fixed: HARD — locked pose, held out of the position gradient.
    for ref, spec in (doc.get("fixed") or {}).items():
        spec = spec or {}
        refs = _expand_refs([ref], known_refs, warnings, f"fixed.{ref}")
        _require_enum(spec.get("edge"), EDGES, f"fixed.{ref}.edge")
        _require_enum(spec.get("side"), SIDES, f"fixed.{ref}.side")
        constraints.append(
            Constraint(
                kind="fixed",
                enforcement=Enforcement.HARD,
                refs=refs,
                params={
                    "edge": spec.get("edge"),
                    "align": spec.get("align"),
                    "rot": spec.get("rot"),
                    "side": spec.get("side"),
                    "at": spec.get("at"),  # explicit (x, y) pose, optional
                },
            )
        )

    # edge_align: SOFT — pull the part to a board edge; snap orientation.
    for ref, spec in (doc.get("edge_align") or {}).items():
        spec = spec or {}
        refs = _expand_refs([ref], known_refs, warnings, f"edge_align.{ref}")
        edge = _require_enum(spec.get("edge"), EDGES, f"edge_align.{ref}.edge")
        if edge is None:
            raise ConstraintError(f"edge_align.{ref}: 'edge' is required")
        _require_enum(spec.get("side"), SIDES, f"edge_align.{ref}.side")
        constraints.append(
            Constraint(
                kind="edge_align",
                enforcement=Enforcement.SOFT,
                refs=refs,
                params={"edge": edge, "side": spec.get("side")},
                weight=float(spec.get("weight", DEFAULT_WEIGHTS["edge_align"])),
            )
        )

    # keepout: HARD — no parts/copper in a region (poly or relative-to-component).
    for entry in doc.get("keepout") or []:
        entry = entry or {}
        name = entry.get("name")
        ref = entry.get("ref")
        refs = _expand_refs([ref], known_refs, warnings, f"keepout.{name or ref}") if ref else ()
        if "extent" not in entry and "polygon" not in entry:
            raise ConstraintError(
                f"keepout {name!r}: needs an 'extent' (rel-to-ref) or a 'polygon'"
            )
        constraints.append(
            Constraint(
                kind="keepout",
                enforcement=Enforcement.HARD,
                refs=refs,
                name=name,
                params={
                    "extent": entry.get("extent"),
                    "polygon": entry.get("polygon"),
                },
            )
        )

    # side_pref: SOFT — bias a set of parts to a side.
    for side, patterns in (doc.get("side_pref") or {}).items():
        _require_enum(side, SIDES, "side_pref key")
        refs = _expand_refs(patterns or [], known_refs, warnings, f"side_pref.{side}")
        constraints.append(
            Constraint(
                kind="side_pref",
                enforcement=Enforcement.SOFT,
                refs=refs,
                params={"side": side},
                weight=DEFAULT_WEIGHTS["side_pref"],
            )
        )

    # group: SOFT — attract members together, near an anchor.
    for entry in doc.get("group") or []:
        entry = entry or {}
        members = entry.get("members") or []
        refs = _expand_refs(members, known_refs, warnings, "group.members")
        anchor = entry.get("anchor")
        if anchor is not None and anchor not in known_refs:
            warnings.append(f"group.anchor: unknown component ref {anchor!r}")
        constraints.append(
            Constraint(
                kind="group",
                enforcement=Enforcement.SOFT,
                refs=refs,
                params={"anchor": anchor, "radius_mm": entry.get("radius_mm")},
                weight=float(entry.get("weight", DEFAULT_WEIGHTS["group"])),
            )
        )

    return CompiledConstraints(
        board=board,
        constraints=constraints,
        warnings=warnings,
        schema=str(doc.get("schema", SCHEMA_VERSION)),
    )


def load_constraints(path: str, known_refs: Sequence[str]) -> CompiledConstraints:
    """Load and compile a ``constraints.yaml`` file (see :func:`compile_constraints`)."""

    with open(path, "r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    return compile_constraints(doc, known_refs)
