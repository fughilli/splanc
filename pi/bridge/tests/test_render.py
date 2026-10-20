"""Render every state for HDMI and OLED; check geometry + key content, save PNGs.

The PNGs land in Bazel's undeclared test outputs (bazel-testlogs/pi/bridge/
display_test/test.outputs/outputs.zip) or $SPLANC_RENDER_OUT, for visual review.
"""

import os

import pytest
from splanc_display import draw, fake_bridge, render_hdmi, render_oled
from splanc_display.status import WAITING, Status, parse
from splanc_display.ui import PAGES, View

NOW = 1_760_000_000.0
STATES = [WAITING, "starting", "offline", "unpaired", "pairing", "paired", "error"]


def status(state):
    return Status(state=WAITING) if state == WAITING else parse(fake_bridge.sample(state, NOW))


def save(img, outdir, name):
    if outdir:
        img.save(os.path.join(outdir, name))


def distinct_colors(img):
    return len(img.convert("RGB").getcolors(1 << 20) or [])


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("size", [(1920, 1080), (1280, 720), (720, 480), (1024, 768)])
def test_hdmi_states(state, size, outdir):
    img = render_hdmi.render(status(state), size, now=NOW, oled=True)
    assert img.size == size and img.mode == "RGB"
    assert distinct_colors(img) > 8  # actually drew something
    if size == (1920, 1080):
        save(img, outdir, f"hdmi-{state}.png")


def test_hdmi_pairing_has_a_qr_code(outdir):
    s = status("pairing")
    img = render_hdmi.render(s, (1920, 1080), now=NOW)
    # The QR panel is white with black modules on the right-hand side.
    right = img.crop((1280, 170, 1840, 730)).convert("L")
    hist = right.histogram()
    assert hist[255] > 50_000 and hist[0] > 20_000
    save(img, outdir, "hdmi-pairing-noled.png")


def test_hdmi_without_code_has_no_qr():
    img = render_hdmi.render(status("paired"), (1920, 1080), now=NOW)
    assert img.crop((1280, 170, 1840, 730)).convert("L").histogram()[255] < 1000


def test_hdmi_expired_code_is_not_shown():
    doc = fake_bridge.sample("pairing", NOW)
    doc["pairing"]["expires_at"] = NOW - 1
    a = render_hdmi.render(parse(doc), now=NOW)
    assert a.crop((1280, 170, 1840, 730)).convert("L").histogram()[255] < 1000


def test_hdmi_handles_extremes():
    doc = fake_bridge.sample("paired", NOW)
    doc["players"] = [{"name": "x" * 200, "host": "h" * 100, "ok": i % 2 == 0} for i in range(50)]
    doc["clients"] = 123456
    doc["relay"] = "wss://" + "r" * 300
    render_hdmi.render(parse(doc), (1920, 1080), now=NOW)
    render_hdmi.render(parse(doc), (320, 240), now=NOW)
    render_hdmi.render(parse(dict(doc, state="error", error="e " * 400)), now=NOW)
    render_hdmi.render(
        parse({"state": "pairing", "pairing": {"code": "A" * 60, "url": "https://x/" + "y" * 900}}),
        now=NOW,
    )


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("page", PAGES)
def test_oled_pages(state, page, outdir):
    img = render_oled.render(status(state), View(page=page), now=NOW)
    assert img.size == (128, 64) and img.mode == "1"
    lit = img.histogram()[255]
    assert 40 < lit < 128 * 64 * 0.75  # some text, not a white-out
    save(img.convert("L").resize((512, 256)), outdir, f"oled-{state}-{page}.png")


def test_oled_home_shows_the_code_big():
    s = status("pairing")
    img = render_oled.render(s, View(page="home"), now=NOW)
    band = img.crop((0, 14, 128, 37))  # the big-code band
    assert band.histogram()[255] > 300


def test_oled_qr_page_is_scannable_size():
    s = status("pairing")
    matrix = draw.qr_matrix(s.pairing.url)
    assert len(matrix) * 2 <= 64 - 4  # 2 px modules fit the 64 px panel
    img = render_oled.render(s, View(page="qr"), now=NOW)
    # light quiet zone on the left edge, dark finder-pattern gap inside it
    assert img.getpixel((0, 32)) == 255


@pytest.mark.parametrize(
    "view",
    [
        View(page="home", overlay="hold", overlay_seconds=3.0),
        View(page="home", overlay="confirm", overlay_seconds=7.0),
        View(page="home", overlay="toast", overlay_text="Identifying fixtures"),
    ],
    ids=["hold", "confirm", "toast"],
)
def test_oled_overlays(view, outdir):
    img = render_oled.render(status("pairing"), view, now=NOW)
    assert img.size == (128, 64)
    save(img.convert("L").resize((512, 256)), outdir, f"oled-overlay-{view.overlay}.png")


def test_oled_confirm_hides_the_page_behind():
    s = status("pairing")
    conf = render_oled.render(s, View(page="home", overlay="confirm", overlay_seconds=5), now=NOW)
    conf_other = render_oled.render(
        s, View(page="players", overlay="confirm", overlay_seconds=5), now=NOW
    )
    assert conf.tobytes() == conf_other.tobytes()


def test_oled_asleep_is_black_and_shift_moves():
    s = status("pairing")
    assert render_oled.render(s, View(page="home", asleep=True), now=NOW).histogram()[255] == 0
    a = render_oled.render(s, View(page="home"), now=NOW)
    b = render_oled.render(s, View(page="home", shift=(1, 1)), now=NOW)
    assert a.histogram()[255] == b.histogram()[255] and a.tobytes() != b.tobytes()
