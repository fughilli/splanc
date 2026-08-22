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
class FabProfile:
    """The manufacturable design-rule set (a ``fab:`` block) the router targets and
    the emitted board is checked against — a knob for **local DRC relaxation**.

    The defaults are a conservative JLCPCB-class 4-layer set; a fab house that
    supports finer geometry (advanced/2-layer) lets you tighten these, which lowers
    the DRC-clean grid-pitch floor (``track_width + clearance``) and so lets tracks
    escape between finer-pitch pads. Every value flows into the grid pitch, the
    router's via/track geometry, and the ``.kicad_pro`` DRC rules — one source of
    truth. ``min_through_drill`` / ``via_annular`` are loosened only to *tolerate
    source footprints* (vendor parts with sub-spec drills / annuli), not routing.
    """

    track_width_mm: float = 0.15
    clearance_mm: float = 0.13
    via_diameter_mm: float = 0.45
    via_drill_mm: float = 0.25
    hole_clearance_mm: float = 0.20
    edge_clearance_mm: float = 0.20
    min_through_drill_mm: float = 0.20
    via_annular_mm: float = 0.0

    @property
    def pitch_floor_mm(self) -> float:
        """Smallest DRC-clean grid pitch: two adjacent tracks clear iff
        ``pitch ≥ track + clearance``. The router grid may not go finer."""
        return self.track_width_mm + self.clearance_mm


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


def width_for_current(
    current_a: float, *, copper_oz: float = 1.0, delta_t_c: float = 10.0, external: bool = True
) -> float:
    """Minimum trace width (mm) to carry ``current_a`` within a ``delta_t_c`` rise,
    per **IPC-2221**: ``A[mils²] = (I / (k·ΔT^0.44))^(1/0.725)``, then
    ``width = A / (thickness[mils] · 1.378·copper_oz)``. ``k`` = 0.048 external /
    0.024 internal. Lets a net class be specified by *amperage* instead of a raw
    width, so power rails get sized for their expected current."""
    k = 0.048 if external else 0.024
    area_mils2 = (current_a / (k * (delta_t_c**0.44))) ** (1.0 / 0.725)
    thickness_mils = 1.378 * copper_oz  # 1 oz ≈ 1.378 mil
    width_mils = area_mils2 / thickness_mils
    return width_mils * 0.0254  # mils -> mm


@dataclass
class NetClass:
    """A named routing rule set (trace width / clearance) over a set of nets.

    ``nets`` are net-name globs, resolved against the real netlist at route time
    (nets are not component refs, so they can't be expanded at compile time).
    ``plane_layer`` (e.g. ``In1.Cu``) pours the class's nets as a copper plane on
    that layer instead of trace-routing them — the right home for high-fanout
    ground / power nets on a multilayer board. ``current_a`` sizes the trace width
    from the expected current (IPC-2221) when ``width_mm`` is not given directly —
    so a class is defined by *type/amperage* (signal vs power) rather than a raw
    width."""

    name: str
    width_mm: Optional[float] = None
    clearance_mm: Optional[float] = None
    nets: Tuple[str, ...] = ()
    plane_layer: Optional[str] = None
    current_a: Optional[float] = None

    def resolved_width_mm(self, floor_mm: float) -> Optional[float]:
        """The class width: explicit ``width_mm``, else derived from ``current_a``
        (IPC-2221), else ``None``. Never below the fab ``floor_mm``."""
        if self.width_mm:
            return max(self.width_mm, floor_mm)
        if self.current_a:
            return max(width_for_current(self.current_a), floor_mm)
        return None


@dataclass
class DiffPair:
    """A differential pair: two nets routed together, length-skew-checked."""

    name: str
    p: str
    n: str
    width_mm: Optional[float] = None
    gap_mm: Optional[float] = None
    skew_mm: float = 0.5  # max acceptable + / - routed-length difference


@dataclass
class LengthMatch:
    """A group of nets whose routed lengths must agree within a tolerance."""

    name: str
    nets: Tuple[str, ...] = ()
    tolerance_mm: float = 1.0


@dataclass
class CompiledConstraints:
    """The whole file, compiled and validated."""

    board: BoardSpec
    constraints: List[Constraint] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    schema: str = SCHEMA_VERSION
    # The manufacturable design-rule set (a ``fab:`` block) — see :class:`FabProfile`.
    fab: FabProfile = field(default_factory=FabProfile)
    # Routing rules (design §9.6). Kept separate from placement constraints — the
    # placer ignores them; writeback + the quality pass consume them.
    net_classes: List[NetClass] = field(default_factory=list)
    diff_pairs: List[DiffPair] = field(default_factory=list)
    length_matches: List[LengthMatch] = field(default_factory=list)

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


def _opt_float(value):
    return None if value is None else float(value)


def _expand_nets(patterns: Iterable[str], net_names: Sequence[str]) -> Tuple[str, ...]:
    """Expand net-name literals/globs against the real netlist (order-stable)."""
    resolved: List[str] = []
    seen = set()
    for pat in patterns:
        is_glob = any(ch in pat for ch in "*?[")
        hits = (
            [n for n in net_names if fnmatch.fnmatchcase(n, pat)]
            if is_glob
            else ([pat] if pat in net_names else [])
        )
        for n in hits:
            if n not in seen:
                seen.add(n)
                resolved.append(n)
    return tuple(resolved)


def compile_routing_rules(compiled: "CompiledConstraints", net_names: Sequence[str]) -> Dict:
    """Resolve net-class / diff-pair / length-match rules against the real net
    names into a plain (JSON-serializable) dict — the ``rules.json`` seam the
    pcbnew steps (writeback, quality) consume without pyyaml/torch. Net globs are
    expanded here (where the netlist is known); unknown literal nets are dropped.
    """
    names = set(net_names)
    fab = compiled.fab
    return {
        "layers": int(compiled.board.layers),
        "default_clearance_mm": float(compiled.board.default_clearance_mm),
        "fab": {
            "track_width_mm": fab.track_width_mm,
            "clearance_mm": fab.clearance_mm,
            "via_diameter_mm": fab.via_diameter_mm,
            "via_drill_mm": fab.via_drill_mm,
            "hole_clearance_mm": fab.hole_clearance_mm,
            "edge_clearance_mm": fab.edge_clearance_mm,
            "min_through_drill_mm": fab.min_through_drill_mm,
            "via_annular_mm": fab.via_annular_mm,
        },
        "net_classes": [
            {
                "name": nc.name,
                # Resolved width: explicit, else IPC-2221 from current_a, else the
                # fab default — the router emits each net's tracks at this width.
                "width_mm": nc.resolved_width_mm(fab.track_width_mm),
                "clearance_mm": nc.clearance_mm,
                "plane_layer": nc.plane_layer,
                "nets": list(_expand_nets(nc.nets, net_names)),
            }
            for nc in compiled.net_classes
        ],
        "diff_pairs": [
            {
                "name": dp.name,
                "p": dp.p,
                "n": dp.n,
                "width_mm": dp.width_mm,
                "gap_mm": dp.gap_mm,
                "skew_mm": dp.skew_mm,
            }
            for dp in compiled.diff_pairs
            if dp.p in names and dp.n in names
        ],
        "length_match": [
            {
                "name": lm.name,
                "nets": list(_expand_nets(lm.nets, net_names)),
                "tolerance_mm": lm.tolerance_mm,
            }
            for lm in compiled.length_matches
        ],
    }


def _parse_board(raw: Dict) -> BoardSpec:
    outline = raw.get("outline") or {}
    return BoardSpec(
        width=outline.get("w"),
        height=outline.get("h"),
        layers=int(raw.get("layers", 2)),
        default_clearance_mm=float(raw.get("default_clearance_mm", DEFAULT_CLEARANCE_MM)),
    )


def _parse_fab(raw: Dict) -> FabProfile:
    """Parse the optional ``fab:`` block; any omitted field keeps its default."""
    d = FabProfile()
    fields = (
        "track_width_mm",
        "clearance_mm",
        "via_diameter_mm",
        "via_drill_mm",
        "hole_clearance_mm",
        "edge_clearance_mm",
        "min_through_drill_mm",
        "via_annular_mm",
    )
    for k in fields:
        if k in raw:
            setattr(d, k, float(raw[k]))
    return d


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
    fab = _parse_fab(doc.get("fab") or {})
    constraints: List[Constraint] = []

    known_keys = {
        "schema",
        "board",
        "fab",
        "fixed",
        "edge_align",
        "keepout",
        "side_pref",
        "group",
        "net_class",
        "diff_pair",
        "length_match",
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
                    # protrude past the edge (mm) for a mating connector; -inset
                    "overhang_mm": spec.get("overhang_mm"),
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

    # net_class: routing rule sets over net-name globs (resolved at route time).
    net_classes: List[NetClass] = []
    for name, spec in (doc.get("net_class") or {}).items():
        spec = spec or {}
        nets = spec.get("nets") or []
        net_classes.append(
            NetClass(
                name=str(name),
                width_mm=_opt_float(spec.get("width_mm")),
                clearance_mm=_opt_float(spec.get("clearance_mm")),
                nets=tuple(str(n) for n in nets),
                plane_layer=spec.get("plane_layer"),
                current_a=_opt_float(spec.get("current_a")),
            )
        )

    # diff_pair: two nets routed together + skew-checked.
    diff_pairs: List[DiffPair] = []
    for entry in doc.get("diff_pair") or []:
        entry = entry or {}
        if not entry.get("p") or not entry.get("n"):
            raise ConstraintError(f"diff_pair {entry.get('name')!r}: needs 'p' and 'n' nets")
        diff_pairs.append(
            DiffPair(
                name=str(entry.get("name") or f"{entry['p']}/{entry['n']}"),
                p=str(entry["p"]),
                n=str(entry["n"]),
                width_mm=_opt_float(entry.get("width_mm")),
                gap_mm=_opt_float(entry.get("gap_mm")),
                skew_mm=float(entry.get("skew_mm", 0.5)),
            )
        )

    # length_match: groups whose routed lengths must agree within a tolerance.
    length_matches: List[LengthMatch] = []
    for entry in doc.get("length_match") or []:
        entry = entry or {}
        nets = entry.get("nets") or []
        if len(nets) < 2:
            raise ConstraintError(f"length_match {entry.get('name')!r}: needs >= 2 nets")
        length_matches.append(
            LengthMatch(
                name=str(entry.get("name") or "group"),
                nets=tuple(str(n) for n in nets),
                tolerance_mm=float(entry.get("tolerance_mm", 1.0)),
            )
        )

    return CompiledConstraints(
        board=board,
        constraints=constraints,
        warnings=warnings,
        schema=str(doc.get("schema", SCHEMA_VERSION)),
        fab=fab,
        net_classes=net_classes,
        diff_pairs=diff_pairs,
        length_matches=length_matches,
    )


def load_constraints(path: str, known_refs: Sequence[str]) -> CompiledConstraints:
    """Load and compile a ``constraints.yaml`` file (see :func:`compile_constraints`)."""

    with open(path, "r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    return compile_constraints(doc, known_refs)
