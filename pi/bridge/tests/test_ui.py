"""The OLED button/page state machine, driven with a fake clock + dispatcher."""

import pytest
from splanc_display import ui


class Dispatcher:
    """Records commands; finishes them when the test says so."""

    def __init__(self):
        self.calls = []
        self.pending = []

    def __call__(self, cmd, done):
        self.calls.append(cmd)
        self.pending.append(done)

    def finish(self, ok=True, msg=""):
        self.pending.pop(0)(ok, msg)


@pytest.fixture
def d():
    return Dispatcher()


@pytest.fixture
def u(d, clock):
    return ui.OledUI(d, clock)


def test_key1_key2_send_commands_and_toast(u, d, clock):
    u.press("key1")
    assert d.calls == ["new_pairing_code"]
    assert u.view().overlay_text == "Working…"
    u.press("key2")  # busy: refused, not queued
    assert d.calls == ["new_pairing_code"]
    d.finish(True)
    assert u.view().overlay_text == "New code requested"
    clock.advance(ui.TOAST_SECONDS + 0.1)
    assert u.view().overlay is None
    u.press("key2")
    d.finish(False, "bridge is not running (no control socket)")
    assert u.view().overlay_text.startswith("bridge is not running")
    assert d.calls == ["new_pairing_code", "identify"]


def test_key3_short_press_does_not_revoke(u, d, clock):
    u.press("key3")
    assert u.view().overlay == "hold"
    clock.advance(2)
    u.tick()
    assert u.view().overlay == "hold" and u.view().overlay_seconds == pytest.approx(3)
    u.release("key3")
    assert d.calls == []
    assert "Hold KEY3" in u.view().overlay_text


def test_key3_hold_then_confirm_revokes(u, d, clock):
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    assert u.view().overlay == "confirm"
    u.release("key3")  # letting go of the hold must not confirm
    assert u.view().overlay == "confirm" and d.calls == []
    clock.advance(1)
    u.press("key3")
    assert d.calls == ["revoke_all"]
    d.finish(True)
    assert u.view().overlay_text == "All clients revoked"


def test_confirm_cancelled_by_other_key_or_timeout(u, d, clock):
    for cancel in ("key1", "press", None):
        u.press("key3")
        clock.advance(ui.HOLD_SECONDS + 0.01)
        u.tick()
        u.release("key3")
        assert u.view().overlay == "confirm"
        if cancel:
            u.press(cancel)
        else:
            clock.advance(ui.CONFIRM_SECONDS)
            u.tick()
        assert u.view().overlay_text == "Cancelled"
        clock.advance(ui.TOAST_SECONDS + 1)
    assert d.calls == []  # neither revoke nor the cancelling key's own action


def test_joystick_pages_and_pauses_auto_cycle(u, clock):
    assert u.view().page == "home"
    u.press("right")
    assert u.view().page == "qr"
    u.press("down")
    assert u.view().page == "players"
    u.press("left")
    u.press("up")
    assert u.view().page == "home"
    u.press("up")  # wraps
    assert u.view().page == ui.PAGES[-1]
    u.press("press")
    assert u.view().page == "home"
    clock.advance(ui.AUTO_CYCLE_SECONDS + 1)
    u.tick()
    assert u.view().page == "home"  # manual paging pauses auto-cycle
    clock.advance(ui.MANUAL_HOLD_SECONDS)
    u.tick()
    assert u.view().page == "qr"


def test_auto_cycle(u, clock):
    seen = []
    for _ in range(len(ui.PAGES)):
        seen.append(u.view().page)
        clock.advance(ui.AUTO_CYCLE_SECONDS)
        u.tick()
    assert seen == list(ui.PAGES)
    assert u.view().page == "home"


def test_no_auto_cycle_during_hold_or_confirm(u, clock):
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    clock.advance(ui.AUTO_CYCLE_SECONDS)  # past a page dwell, inside the confirm window
    u.tick()
    assert u.view().page == "home" and u.view().overlay == "confirm"


def test_dim_sleep_and_wake(u, d, clock):
    clock.advance(ui.DIM_AFTER_SECONDS)
    assert u.view().dimmed and not u.view().asleep
    u.activity()  # a status change undims
    assert not u.view().dimmed
    u.code_visible = True
    clock.advance(ui.SLEEP_AFTER_SECONDS)
    assert not u.view().asleep  # a pairing code on screen keeps it awake
    u.code_visible = False
    assert u.view().asleep
    u.press("key1")  # the wake-up press does nothing else
    assert d.calls == [] and not u.view().asleep
    u.press("key1")
    assert d.calls == ["new_pairing_code"]


def test_pixel_shift_cycles(u, clock):
    shifts = set()
    for _ in range(len(ui.SHIFTS)):
        shifts.add(u.view().shift)
        clock.advance(ui.SHIFT_PERIOD_SECONDS)
    assert shifts == set(ui.SHIFTS)


def test_unknown_key_ignored(u, d):
    u.press("key9")
    u.release("key9")
    assert d.calls == [] and u.view().overlay is None
