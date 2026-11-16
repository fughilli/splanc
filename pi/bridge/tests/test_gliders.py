"""The screensaver's gliders: real Life, never colliding, wearing the panel evenly."""

from collections import Counter

import pytest
from splanc_display import gliders as g


def test_the_skew_lets_one_glider_cover_the_board():
    assert g.SKEW % 2 == 1
    seen = {g.wrap((t, t)) for t in range(g.CYCLES)}
    assert len(seen) == g.GW * g.GH


def test_closed_form_is_real_life_on_the_twisted_torus():
    """Step B3/S23 on the board itself (wrapping like the saver) and compare."""
    n = g.max_gliders()
    cells = set(g.live_cells(n, 0))
    assert len(cells) == 5 * n
    for gen in range(1, 4 * g.GW + 9):  # every glider wraps the right edge at least once
        cells = g.life_step(cells, g.wrap)
        assert cells == set(g.live_cells(n, gen)), f"diverged at generation {gen}"


def test_gliders_stay_apart():
    n = g.max_gliders()
    assert n >= 30
    assert g.min_distance(n) >= g.SAFE
    # Adding one (a fixture connected) keeps the others where they were.
    assert g.origins(n)[:5] == g.origins(5)


@pytest.mark.parametrize("n", [1, 7])
def test_wear_is_even_over_a_period(n):
    lit = Counter()
    for gen in range(g.PERIOD):
        lit.update(g.live_cells(n, gen))
    assert len(lit) == g.GW * g.GH
    assert set(lit.values()) == {5 * 4 * n}  # every cell, every glider, every phase


def test_count_and_render():
    assert g.render(0, 123).getbbox() is None  # no connected fixtures: nothing flies
    img = g.render(3, 0)
    assert img.size == (128, 64)
    assert sum(1 for v in img.tobytes() for b in range(8) if v >> b & 1) == 3 * 5 * g.CELL * g.CELL
    assert len(g.live_cells(1000, 0)) == 5 * g.max_gliders()  # capped at what fits
