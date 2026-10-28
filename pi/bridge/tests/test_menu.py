"""The fixture menu: list navigation + scrolling, detail + back, fixtures coming
and going while it's open, transitions (timing, interruption), and the boot hand-off."""

import pytest
from splanc_display import anim, ui
from splanc_display.anim import Scene

KEYS9 = [f"02:00:5E:00:00:{i:02X}" for i in range(9)]


class Dispatcher:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, done):
        self.calls.append(cmd)
        done(True, "")


@pytest.fixture
def d():
    return Dispatcher()


@pytest.fixture
def u(d, clock):
    m = ui.OledUI(d, clock)
    m.set_fixtures(KEYS9, rows_of=lambda k: 14)
    return m


def to_list(u, clock):
    while u.view().page != "players":
        u.press("right")
    clock.advance(1)
    u.tick()


def settle(u, clock, s=1.0):
    clock.advance(s)
    u.tick()
    return u.view()


def test_list_selection_moves_and_scrolls(u, clock):
    to_list(u, clock)
    v = u.view()
    assert (v.sel, v.list_pos, v.list_top) == (0, 0, 0)
    u.press("up")  # already at the top: stays (no wrap into another page)
    assert u.view().page == "players" and u.view().sel == 0
    for _ in range(3):
        u.press("down")
    assert settle(u, clock).list_top == 0  # rows 0-3 fit: no scroll yet
    u.press("down")  # row 4: the list scrolls by one
    v = settle(u, clock)
    assert (v.sel, v.list_pos, v.list_top) == (4, 4, 1)
    for _ in range(20):
        u.press("down")
    v = settle(u, clock)
    assert (v.sel, v.list_top) == (8, 8 - ui.LIST_ROWS + 1)  # clamped at the last row
    for _ in range(8):
        u.press("up")
    v = settle(u, clock)
    assert (v.sel, v.list_top) == (0, 0)


def test_left_right_still_change_pages_from_the_list(u, clock):
    to_list(u, clock)
    u.press("right")
    assert u.view().page == "network"
    u.press("left")
    assert u.view().page == "players"


def test_empty_list_pages_like_before(d, clock):
    m = ui.OledUI(d, clock)
    m.press("right")
    m.press("right")
    assert m.view().page == "players"
    m.press("down")  # nothing to select: pages on, as before
    assert m.view().page == "network"


def test_highlight_glides_and_a_new_press_retargets(u, clock):
    to_list(u, clock)
    u.press("down")
    clock.advance(anim.LIST_SECONDS / 2)
    mid = u.view().list_pos
    assert 0 < mid < 1 and u.view().animating
    u.press("down")  # mid-glide: heads for row 2 from where it is, no queue
    v = u.view()
    assert v.sel == 2 and v.list_pos == pytest.approx(mid)
    clock.advance(anim.LIST_SECONDS)
    v = u.view()
    assert v.list_pos == 2 and not v.animating


def test_open_detail_scroll_and_back(u, clock):
    to_list(u, clock)
    u.press("down")
    u.press("down")
    u.press("press")
    v = u.view()
    assert v.page == "detail" and v.key == KEYS9[2]
    assert v.slide.src == Scene("players") and v.slide.dst == Scene("detail", KEYS9[2])
    assert v.slide.style == "push" and v.slide.direction == "left"
    v = settle(u, clock)
    assert v.slide is None and v.detail_scroll == 0
    for _ in range(30):
        u.press("down")
    assert settle(u, clock).detail_scroll == 14 - ui.DETAIL_ROWS  # clamped to its rows
    u.press("up")
    assert settle(u, clock).detail_scroll == 14 - ui.DETAIL_ROWS - 1
    u.press("left")
    v = u.view()
    assert v.page == "players" and v.slide.direction == "right" and v.sel == 2
    u.press("press")  # open again; press backs out too
    u.press("press")
    assert u.view().page == "players"


def test_detail_does_not_auto_cycle_but_times_out(u, clock):
    to_list(u, clock)
    u.press("press")
    clock.advance(ui.AUTO_CYCLE_SECONDS + ui.MANUAL_HOLD_SECONDS + 1)
    u.tick()
    assert u.view().page == "detail"
    clock.advance(ui.DETAIL_IDLE_SECONDS)
    u.tick()
    assert u.view().page == "players"


def test_fixture_disappearing_while_its_detail_is_open(u, clock):
    to_list(u, clock)
    for _ in range(5):
        u.press("down")
    u.press("press")
    settle(u, clock)
    gone = KEYS9[5]
    u.set_fixtures([k for k in KEYS9 if k != gone])
    v = u.view()
    assert v.page == "players" and v.slide.direction == "right"
    assert v.overlay_text == "Fixture is gone"
    assert v.sel == 5  # the neighbour that moved up into its row


def test_fixtures_appearing_keep_the_selection(u, clock):
    to_list(u, clock)
    for _ in range(3):
        u.press("down")
    settle(u, clock)
    new = ["02:00:5E:00:01:00", "02:00:5E:00:01:01"]
    u.set_fixtures(new + KEYS9)  # two new fixtures listed above it
    v = u.view()
    assert v.sel == 5 and v.list_pos == 5  # still on KEYS9[3], no glide for it
    assert v.list_top <= 5 < v.list_top + ui.LIST_ROWS
    u.press("press")
    assert u.view().key == KEYS9[3]


def test_detail_of_a_fixture_appearing_elsewhere_stays_open(u, clock):
    to_list(u, clock)
    u.press("press")
    u.set_fixtures(["02:00:5E:00:01:00"] + KEYS9)
    assert u.view().page == "detail" and u.view().key == KEYS9[0]


def test_all_fixtures_gone(u, clock):
    to_list(u, clock)
    u.press("press")
    u.set_fixtures([])
    v = u.view()
    assert v.page == "players" and v.sel == 0
    u.press("down")  # empty: the joystick pages again
    assert u.view().page == "network"


def test_detail_shrinking_clamps_its_scroll(u, clock):
    to_list(u, clock)
    u.press("press")
    for _ in range(30):
        u.press("down")
    settle(u, clock)
    u.set_fixtures(KEYS9, rows_of=lambda k: 6)  # an error cleared: fewer rows
    assert settle(u, clock).detail_scroll == 6 - ui.DETAIL_ROWS


def test_key1_from_a_detail_goes_home_to_show_the_code(u, d, clock):
    to_list(u, clock)
    u.press("press")
    settle(u, clock)
    u.press("key1")
    assert d.calls == ["new_pairing_code"]
    v = u.view()
    assert v.page == "home" and v.slide.src.page == "detail"


def test_key1_on_the_qr_page_stays(u, d, clock):
    u.press("right")
    settle(u, clock)
    u.press("key1")
    assert u.view().page == "qr" and d.calls == ["new_pairing_code"]


def test_page_slide_timing(u, clock):
    u.press("right")
    v = u.view()
    assert v.slide.src == Scene("home") and v.slide.dst == Scene("qr")
    assert v.slide.direction == "left" and v.slide.p == 0
    clock.advance(anim.PAGE_SECONDS / 2)
    p = u.view().slide.p
    assert 0.5 < p < 1  # eased out: more than half way at half time
    clock.advance(anim.PAGE_SECONDS / 2)
    u.tick()
    assert u.view().slide is None and not u.view().animating


def test_a_press_mid_slide_starts_the_next_at_once(u, clock):
    u.press("right")
    clock.advance(anim.PAGE_SECONDS * 0.3)
    u.press("right")  # home -> qr still sliding: go on to players now
    v = u.view()
    assert v.page == "players" and v.slide.src == Scene("qr") and v.slide.p == 0
    clock.advance(anim.PAGE_SECONDS)
    u.tick()
    assert u.view().slide is None  # nothing queued behind it


def test_back_mid_push_reverses_in_place(u, clock):
    to_list(u, clock)
    u.press("press")
    clock.advance(anim.PUSH_SECONDS * 0.4)
    shown = u.view().slide.p  # how far the detail has come in
    u.press("left")
    v = u.view()
    assert v.slide.src.page == "detail" and v.slide.dst == Scene("players")
    assert v.slide.p == pytest.approx(1 - shown, abs=1e-3)  # continues from there
    # ...and finishes sooner than a full push (by the part it had done; the
    # ease-out start covers most of the distance early, so that part is small).
    clock.advance(anim.PUSH_SECONDS * 0.95)
    u.tick()
    assert u.view().slide is None


def test_boot_plays_then_hands_off(d, clock):
    m = ui.OledUI(d, clock)
    m.start_boot(2.0)
    v = m.view()
    assert v.page == "boot" and v.boot_t == 0 and v.animating
    clock.advance(1.0)
    m.tick()
    assert m.view().page == "boot" and m.view().boot_t == 1.0
    clock.advance(1.0)
    m.tick()
    v = m.view()
    assert v.page == "home" and v.slide.src == Scene("boot") and v.slide.direction == "up"
    assert v.boot_t == 2.0  # the renderer still draws the logo while it slides out
    clock.advance(anim.HANDOFF_SECONDS)
    m.tick()
    v = m.view()
    assert v.slide is None and v.boot_t is None
    clock.advance(ui.AUTO_CYCLE_SECONDS - anim.HANDOFF_SECONDS - 0.1)
    m.tick()
    assert m.view().page == "home"  # the first page gets its full dwell after the logo


def test_a_key_during_boot_skips_it_and_still_works(d, clock):
    m = ui.OledUI(d, clock)
    m.start_boot(2.0)
    clock.advance(0.5)
    m.press("key1")
    assert d.calls == ["new_pairing_code"]
    v = m.view()
    assert v.page == "home" and v.slide.src == Scene("boot")


def test_queued_press_uses_its_own_time(d, clock):
    m = ui.OledUI(d, clock)
    t = clock()
    clock.advance(6)
    m.press("key3", at=t)  # pressed 6 s ago, handled now: the hold already counts
    m.tick()
    assert m.view().overlay == "confirm"
