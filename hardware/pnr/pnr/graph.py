"""Internal board graph — the ingestion contract (design doc §2).

This is the neutral representation the rest of the engine consumes. It is
deliberately **stdlib-only** (dataclasses + json) so it can be imported from
both interpreters in the flow:

- :mod:`pnr.ingest` builds a :class:`BoardGraph` from a ``.kicad_pcb`` while
  running under the KiCad ``pcbnew`` python (``@kicad_python``, python 3.12);
- the placement engine loads it under the hermetic rules_python interpreter
  that carries torch.

Because those two never share a live process, a :class:`BoardGraph` round-trips
through JSON (:meth:`BoardGraph.to_json` / :meth:`BoardGraph.from_json`). Keeping
this module dependency-free is what makes that seam work — do not import pcbnew,
torch, numpy, or yaml here.

Units: all coordinates and lengths are **millimetres**; ``rot`` is degrees CCW.
The frame matches the constraint file: origin at the board-outline bottom-left.
(``pcbnew`` reports nanometres with y pointing down; :mod:`pnr.ingest` converts.)
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple

SCHEMA_VERSION = "v0"

# Copper side of a footprint / pad.
SIDE_TOP = "top"
SIDE_BOTTOM = "bottom"
SIDES = (SIDE_TOP, SIDE_BOTTOM)


def _fpair(v) -> Tuple[float, float]:
    """Coerce a 2-vector to a float tuple.

    Coordinates come from pcbnew as floats, but a hand-authored graph (tests,
    fixtures) may carry ints. Normalizing on construction keeps ``to_json`` a
    deterministic fixed point so round-trips are byte-stable."""
    return (float(v[0]), float(v[1]))


@dataclass
class Pad:
    """One pad of a component, bound to a net.

    ``offset`` is the pad centre relative to the component origin, in the
    component's *unrotated* frame (mm); the placer rotates it by the component
    orientation. ``net`` is the net name (``""`` for an unconnected pad).
    """

    name: str
    net: str
    offset: Tuple[float, float]

    def __post_init__(self):
        self.offset = _fpair(self.offset)


@dataclass
class Component:
    """A placeable footprint instance.

    ``pos``/``rot``/``side`` are the *current* placement (initially atopile's
    naive row); the placer overwrites them. ``courtyard`` is the axis-aligned
    (width, height) of the courtyard used for overlap/density; ``bbox`` is the
    full graphical bounding box. Both are in mm and orientation-agnostic
    (measured at ``rot`` as ingested — :mod:`pnr.ingest` records them as seen).
    """

    ref: str
    footprint: str
    pos: Tuple[float, float]
    rot: float
    side: str
    courtyard: Tuple[float, float]
    bbox: Tuple[float, float]
    locked: bool = False
    pads: List[Pad] = field(default_factory=list)

    def __post_init__(self):
        self.pos = _fpair(self.pos)
        self.courtyard = _fpair(self.courtyard)
        self.bbox = _fpair(self.bbox)


@dataclass
class Net:
    """A net: a set of ``(component_ref, pad_name)`` connection points."""

    name: str
    code: int
    pins: List[Tuple[str, str]] = field(default_factory=list)

    @property
    def degree(self) -> int:
        return len(self.pins)


@dataclass
class BoardOutline:
    """Placement region. ``polygon`` is the real ``Edge.Cuts`` outline when the
    board has one; ``width``/``height`` are the bounding box (from the polygon or
    the constraint file). All mm, in the bottom-left origin frame."""

    width: float
    height: float
    polygon: List[Tuple[float, float]] = field(default_factory=list)

    def __post_init__(self):
        self.width = float(self.width)
        self.height = float(self.height)
        self.polygon = [_fpair(pt) for pt in self.polygon]


@dataclass
class BoardGraph:
    """The whole ingested board: components, nets, and the outline."""

    name: str
    components: List[Component] = field(default_factory=list)
    nets: List[Net] = field(default_factory=list)
    outline: Optional[BoardOutline] = None
    schema: str = SCHEMA_VERSION

    # -- convenience views -------------------------------------------------

    @property
    def refs(self) -> List[str]:
        return [c.ref for c in self.components]

    def component(self, ref: str) -> Component:
        for c in self.components:
            if c.ref == ref:
                return c
        raise KeyError(ref)

    def net(self, name: str) -> Net:
        for n in self.nets:
            if n.name == name:
                return n
        raise KeyError(name)

    @property
    def pad_count(self) -> int:
        return sum(len(c.pads) for c in self.components)

    # -- serialization (the ingest -> place seam) --------------------------

    def to_dict(self) -> Dict:
        return asdict(self)

    def to_json(self, *, indent: Optional[int] = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=True)

    @classmethod
    def from_dict(cls, d: Dict) -> "BoardGraph":
        # Numeric tuples are normalized to float by each dataclass's
        # __post_init__, so raw JSON lists/ints can be passed straight through.
        components = [
            Component(
                ref=c["ref"],
                footprint=c["footprint"],
                pos=c["pos"],
                rot=float(c["rot"]),
                side=c["side"],
                courtyard=c["courtyard"],
                bbox=c["bbox"],
                locked=bool(c.get("locked", False)),
                pads=[
                    Pad(name=p["name"], net=p["net"], offset=p["offset"]) for p in c.get("pads", [])
                ],
            )
            for c in d.get("components", [])
        ]
        nets = [
            Net(
                name=n["name"],
                code=int(n["code"]),
                pins=[(pin[0], pin[1]) for pin in n.get("pins", [])],
            )
            for n in d.get("nets", [])
        ]
        outline = None
        if d.get("outline"):
            o = d["outline"]
            outline = BoardOutline(
                width=o["width"],
                height=o["height"],
                polygon=o.get("polygon", []),
            )
        return cls(
            name=d["name"],
            components=components,
            nets=nets,
            outline=outline,
            schema=d.get("schema", SCHEMA_VERSION),
        )

    @classmethod
    def from_json(cls, text: str) -> "BoardGraph":
        return cls.from_dict(json.loads(text))
