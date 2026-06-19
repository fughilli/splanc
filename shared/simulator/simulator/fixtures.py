"""Ground-truth fixtures for the simulator (M9).

Each builder returns an ``(N, 3)`` array of true LED positions in meters,
centered near the origin and spanning roughly ``scale`` meters. These are the
known geometries the reconstruction (M3) must recover.
"""

from __future__ import annotations

import numpy as np


def line(n: int, scale: float = 1.0) -> np.ndarray:
    xs = np.linspace(-scale / 2, scale / 2, n)
    return np.column_stack([xs, np.zeros(n), np.zeros(n)])


def grid(n: int, scale: float = 1.0) -> np.ndarray:
    side = int(np.ceil(np.sqrt(n)))
    coords = np.linspace(-scale / 2, scale / 2, side)
    pts = [[x, y, 0.0] for y in coords for x in coords]
    return np.asarray(pts[:n], dtype=float)


def cube(n: int, scale: float = 1.0) -> np.ndarray:
    side = int(np.ceil(round(n ** (1.0 / 3.0), 6)))
    coords = np.linspace(-scale / 2, scale / 2, max(side, 2))
    pts = [[x, y, z] for z in coords for y in coords for x in coords]
    return np.asarray(pts[:n], dtype=float)


def helix(n: int, scale: float = 1.0, turns: float = 3.0) -> np.ndarray:
    t = np.linspace(0.0, turns * 2.0 * np.pi, n)
    radius = scale / 3.0
    x = radius * np.cos(t)
    z = radius * np.sin(t)
    y = np.linspace(-scale / 2, scale / 2, n)
    return np.column_stack([x, y, z])


FIXTURES = {"line": line, "grid": grid, "cube": cube, "helix": helix}


def make_fixture(name: str, n: int, scale: float = 1.0) -> np.ndarray:
    if name not in FIXTURES:
        raise ValueError(f"unknown fixture {name!r}; choose from {sorted(FIXTURES)}")
    return FIXTURES[name](n, scale)
