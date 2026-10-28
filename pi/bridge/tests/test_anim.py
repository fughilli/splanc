"""Easing, gliding values and slide retargeting, with a fake clock."""

import pytest
from splanc_display import anim
from splanc_display.anim import Scene, Slide, Tween


@pytest.mark.parametrize("ease", [anim.ease_out_cubic, anim.ease_in_out_cubic])
def test_eases_are_monotonic_and_pinned(ease):
    assert ease(0) == 0 and ease(1) == 1 and ease(-1) == 0 and ease(2) == 1
    xs = [ease(i / 100) for i in range(101)]
    assert xs == sorted(xs)
    for y in (0.1, 0.5, 0.9):
        assert ease(anim.inverse(ease, y)) == pytest.approx(y, abs=1e-6)


def test_tween_glides_retargets_and_snaps():
    t = Tween(0, duration=0.2)
    assert t.value(0) == 0 and not t.moving(0)
    t.set(10, now=1.0)
    assert t.value(1.0) == 0 and t.moving(1.05)
    assert 5 < t.value(1.1) < 10  # ease-out: past half way at half time
    mid = t.value(1.1)
    t.set(20, now=1.1)  # retarget from where it is, not from 10
    assert t.value(1.1) == pytest.approx(mid)
    assert t.value(1.3) == 20 and not t.moving(1.3)
    t.snap(3)
    assert t.value(1.3) == 3 and not t.moving(1.3)
    t.set(3, now=2.0)  # same target: nothing starts
    assert not t.moving(2.01)


def test_tween_shift_moves_a_running_glide():
    t = Tween(0, duration=0.2)
    t.set(1, now=0)
    before = t.value(0.1)
    t.shift(2)
    assert t.value(0.1) == pytest.approx(before + 2) and t.target == 3


def test_slide_progress_and_done():
    s = Slide(Scene("home"), Scene("qr"), "left", t0=5.0, duration=0.2)
    assert s.progress(5.0) == 0 and s.progress(5.2) == 1 and s.done(5.2)
    assert s.view(5.1).p == pytest.approx(anim.ease_out_cubic(0.5))


def test_retarget_starts_fresh_from_the_running_target():
    a, b, c = Scene("home"), Scene("qr"), Scene("players")
    cur = Slide(a, b, "left", 0.0, 0.2)
    nxt = anim.retarget(cur, b, c, "left", 0.05, 0.2)
    assert (nxt.src, nxt.dst, nxt.t0) == (b, c, 0.05)
    # A finished slide is ignored: start from the scene shown.
    nxt = anim.retarget(cur, b, c, "left", 1.0, 0.2)
    assert nxt.src == b and nxt.t0 == 1.0


def test_retarget_reverses_in_place():
    a, b = Scene("players"), Scene("detail", "k")
    cur = Slide(a, b, "left", 0.0, 0.2, style="push")
    p = cur.progress(0.06)
    back = anim.retarget(cur, b, a, "right", 0.06, 0.2, style="push")
    assert (back.src, back.dst, back.style) == (b, a, "push")
    assert back.progress(0.06) == pytest.approx(1 - p, abs=1e-6)
    assert back.done(0.06 + 0.2 * (1 - anim.inverse(back.ease, 1 - p)) + 1e-9)


def test_same_direction_back_is_not_a_reverse():
    a, b = Scene("home"), Scene("qr")
    cur = Slide(a, b, "left", 0.0, 0.2)
    nxt = anim.retarget(cur, b, a, "left", 0.05, 0.2)  # wrapped round the other way
    assert nxt.src == b and nxt.progress(0.05) == 0
