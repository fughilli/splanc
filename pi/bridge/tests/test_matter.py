"""The Matter bridge on the screens (docs/guides/matter.md): the status file's
``matter`` block, the OLED's Matter page (QR + manual code, or who has it), the
joystick press that lets another controller in, and the HDMI pairing panel."""

from splanc_display import fake_bridge, render_hdmi, render_oled, ui
from splanc_display.status import Matter, parse
from splanc_display.ui import View

NOW = 1_800_000_000.0


class Dispatcher:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, done, **args):
        self.calls.append(cmd)
        done(True, "")


def status(commissioned=False, **over):
    return parse(
        fake_bridge.sample(
            "paired", NOW, matter=fake_bridge.sample_matter(commissioned=commissioned, **over)
        )
    )


def test_matter_block_parses_leniently():
    s = status()
    assert s.matter == Matter(
        state="ready",
        commissioned=False,
        commissionable=True,
        qr=fake_bridge.SAMPLE_MATTER_QR,
        manual=fake_bridge.SAMPLE_MATTER_MANUAL,
        fabrics=(),
        lamps=len(fake_bridge.SAMPLE_PLAYERS),
        error=None,
    )
    assert s.matter.manual_grouped == "3497-011-2332"
    assert s.matter.show_code
    assert parse(fake_bridge.sample("paired", NOW)).matter is None  # older bridge / off
    junk = parse(dict(fake_bridge.sample("paired", NOW), matter={"qr": "not a qr", "lamps": "x"}))
    assert junk.matter.qr == "" and junk.matter.lamps == 0 and not junk.matter.show_code
    paired = status(commissioned=True)
    assert paired.matter.fabrics == ("Apple Home",) and not paired.matter.show_code


def test_matter_changes_count_as_salient():
    assert status().salient() != status(commissioned=True).salient()


def test_matter_page_appears_after_qr_and_keeps_the_current_page(clock):
    u = ui.OledUI(Dispatcher(), clock)
    assert "matter" not in u.pages
    u.press("right")  # qr
    u.press("right")  # players
    assert u.pages[u.page] == "players"
    u.set_matter(True)
    assert u.pages == ("home", "qr", "matter", "players", "network", "clients")
    assert u.pages[u.page] == "players"
    u.set_matter(False)
    assert u.pages == ui.PAGES and u.pages[u.page] == "players"


def test_press_on_the_matter_page_opens_pairing(clock):
    d = Dispatcher()
    u = ui.OledUI(d, clock)
    u.set_matter(True)
    u.press("right")
    u.press("right")
    assert u.view().page == "matter"
    u.press("press")
    assert d.calls == ["matter_pair"]
    assert u.view().page == "matter"  # stays (press goes home on other pages)


def _lit(img):
    return sum(1 for px in img.tobytes() for b in range(8) if px >> b & 1)


def test_oled_matter_page_renders_every_state():
    for s in (
        status(),
        status(commissioned=True),
        status(state="error", error="UDP port 5540 is in use"),
        status(state="starting"),
        parse(fake_bridge.sample("paired", NOW)),
    ):
        img = render_oled.render(s, View(page="matter"), now=NOW)
        assert img.size == (128, 64)
        assert _lit(img) > 20
    # The QR state and the "added to" state are different screens.
    qr = render_oled.render(status(), View(page="matter"), now=NOW)
    added = render_oled.render(status(commissioned=True), View(page="matter"), now=NOW)
    assert qr.tobytes() != added.tobytes()


def test_hdmi_shows_the_matter_code_when_no_relay_code_is_up():
    plain = render_hdmi.render(parse(fake_bridge.sample("paired", NOW)), size=(480, 270), now=NOW)
    with_code = render_hdmi.render(status(), size=(480, 270), now=NOW)
    assert plain.tobytes() != with_code.tobytes()
    # A live relay pairing code wins the main area (it expires; Matter's doesn't).
    relay = parse(fake_bridge.sample("pairing", NOW, matter=fake_bridge.sample_matter()))
    assert relay.active_code(NOW) is not None
    render_hdmi.render(relay, size=(480, 270), now=NOW)


def test_fake_bridge_answers_matter_commands(tmp_path):
    fb = fake_bridge.FakeBridge(str(tmp_path / "status.json"), str(tmp_path / "control.sock"))
    fb.set(fake_bridge.sample("paired", NOW))
    assert fb.handle(b'{"cmd": "matter_pair"}')["ok"] is False  # Matter off
    fb.set(fake_bridge.sample("paired", NOW, matter=fake_bridge.sample_matter(commissioned=True)))
    r = fb.handle(b'{"cmd": "matter_pair"}')
    assert r["ok"] and r["matter"]["commissionable"] and r["matter"]["commissioned"]
