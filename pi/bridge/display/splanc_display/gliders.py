"""The OLED screensaver: Conway's Life gliders crossing the panel, one per online fixture.

The board is the panel in 2x2-pixel cells (64 x 32), wrapped as a *twisted* torus:
leaving the bottom edge comes back at the top, and leaving the right edge comes back
at the left SKEW cells lower. All gliders fly the same way (down-right) at the same
speed (c/4: one cell diagonally every 4 generations), so the whole pattern is one
translation of that space and:

- They never collide: the distance between any two stays what it was at the start,
  and they start at least SAFE cells apart (up to max_gliders(); more fixtures than
  fit show that many) (far enough that no cell ever has live
  neighbours from two gliders, so each evolves exactly as a lone glider would).
- Wear is even: with SKEW odd, the diagonal step generates the whole space (a cyclic
  group of order 64 * 32), so each glider passes every position once per PERIOD and
  lights every cell equally often; the skew makes each pass precess down the panel
  instead of retracing one diagonal.

This is real Life (tests/test_gliders.py steps the rules on the same twisted torus and
gets the same pixels), drawn in closed form so a frame costs a few rectangles.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Dict, List, Tuple

from PIL import Image, ImageDraw

PANEL_W, PANEL_H = 128, 64
CELL = 2  # pixels per Life cell
GW, GH = PANEL_W // CELL, PANEL_H // CELL  # the board, in cells
SKEW = 5  # rows a glider drops when it wraps the right edge (odd: covers the board;
# 5 fits the most gliders, 33, at SAFE spacing)
CYCLES = GW * GH  # diagonal steps before a glider retraces itself
PERIOD = 4 * CYCLES  # generations in the full (wear-even) cycle
SAFE = 6  # minimum Chebyshev distance (cells) between glider origins
GENS_PER_SECOND = 6.0  # slow enough to watch each generation: 1.5 cells/s = 3 px/s

Cell = Tuple[int, int]

# A glider heading down-right (y grows downwards), phase 0.
_SEED = ((1, 0), (2, 1), (0, 2), (1, 2), (2, 2))


def life_step(cells, wrap=None):
    """One generation of B3/S23 over a set of live cells (``wrap`` maps a cell into
    the board; None = the unbounded plane)."""
    counts: Dict[Cell, int] = {}
    for x, y in cells:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx or dy:
                    c = (x + dx, y + dy)
                    if wrap is not None:
                        c = wrap(c)
                    counts[c] = counts.get(c, 0) + 1
    live = set(cells)
    return {c for c, n in counts.items() if n == 3 or (n == 2 and c in live)}


def _phases() -> Tuple[Tuple[Cell, ...], ...]:
    """The glider's four phases, relative to its origin (the plane's rules)."""
    out, cells = [], set(_SEED)
    for _ in range(4):
        out.append(tuple(sorted(cells)))
        cells = life_step(cells)
    assert cells == {(x + 1, y + 1) for x, y in _SEED}, "not a down-right glider"
    return tuple(out)


PHASES = _phases()


def wrap(c: Cell) -> Cell:
    """A cell of the plane, as the board's (twisted-torus) cell."""
    x, y = c
    a, x = divmod(x, GW)
    return x, (y + a * SKEW) % GH


def _centred(d: Cell) -> Cell:
    """The shortest representative of offset ``d`` on the board (as ``wrap``: the
    lattice is (GW, -SKEW), (0, GH)): x in [-GW/2, GW/2), then y in [-GH/2, GH/2)."""
    x, y = d
    a = (x + GW // 2) // GW
    x, y = x - a * GW, y + a * SKEW
    y = (y + GH // 2) % GH - GH // 2
    return x, y


@lru_cache(maxsize=None)
def _step_distance(dt: int) -> int:
    """Chebyshev distance between gliders ``dt`` diagonal steps apart on the board."""
    x, y = _centred((dt, dt))
    return max(abs(x), abs(y))


@lru_cache(maxsize=1)
def _sequence() -> Tuple[int, ...]:
    """Glider start steps along the diagonal orbit (step t = cell (t, t)), each the
    one farthest from all before it (ties: the earliest), while that is >= SAFE.

    A prefix of it is the placement for any count, so a fixture connecting adds a
    glider without moving the others; farthest-first keeps any prefix spread out."""
    chosen = [0]
    near = [_step_distance(t) for t in range(CYCLES)]  # distance to the nearest chosen
    while True:
        t = max(range(CYCLES), key=lambda i: (near[i], -i))
        if near[t] < SAFE:
            return tuple(chosen)
        chosen.append(t)
        for i in range(CYCLES):
            d = _step_distance((i - t) % CYCLES)
            if d < near[i]:
                near[i] = d


def origins(n: int) -> Tuple[Cell, ...]:
    """Where ``n`` gliders start (plane coordinates, on the diagonal orbit)."""
    return tuple((t, t) for t in _sequence()[: max(0, n)])


def min_distance(n: int) -> int:
    ts = _sequence()[:n]
    return min(
        (_step_distance((b - a) % CYCLES) for i, a in enumerate(ts) for b in ts[i + 1 :]),
        default=GW,
    )


def max_gliders() -> int:
    return len(_sequence())


def live_cells(n: int, gen: int) -> List[Cell]:
    """The board's live cells after ``gen`` generations with ``n`` gliders."""
    n = max(0, min(n, max_gliders()))
    step, phase = divmod(gen, 4)
    step %= CYCLES
    out = []
    for ox, oy in origins(n) if n else ():
        for px, py in PHASES[phase]:
            out.append(wrap((ox + step + px, oy + step + py)))
    return out


def render(n: int, gen: int) -> Image.Image:
    img = Image.new("1", (PANEL_W, PANEL_H), 0)
    dr = ImageDraw.Draw(img)
    for x, y in live_cells(n, gen):
        dr.rectangle([x * CELL, y * CELL, x * CELL + CELL - 1, y * CELL + CELL - 1], fill=255)
    return img
