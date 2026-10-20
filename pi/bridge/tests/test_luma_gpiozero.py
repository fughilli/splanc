"""The real libraries the Pi uses (luma.oled, gpiozero), with gpiozero's mock pins.

Skipped where they aren't installed (the Bazel test env has neither: they come
from the Pi-side lockfile + apt). Run on a dev box with
``pip install -r pi/bridge/display/requirements.lock gpiozero``.
"""

import pytest

luma_device = pytest.importorskip("luma.oled.device")
gpiozero = pytest.importorskip("gpiozero")
from gpiozero.pins.mock import MockFactory  # noqa: E402
from splanc_display import fake_bridge, hat, render_oled  # noqa: E402
from splanc_display.status import parse  # noqa: E402
from splanc_display.ui import View  # noqa: E402


@pytest.fixture
def mock_pins():
    old = gpiozero.Device.pin_factory
    gpiozero.Device.pin_factory = MockFactory()
    yield gpiozero.Device.pin_factory
    gpiozero.Device.pin_factory.reset()
    gpiozero.Device.pin_factory = old


class FakeSpidev:
    def __init__(self):
        self.written = []
        self.max_speed_hz = 0
        self.mode = 0

    def open(self, port, device):
        self.port = (port, device)

    def writebytes(self, data):
        self.written.append(bytes(data))

    def writebytes2(self, data):
        self.written.append(bytes(data))

    def close(self):
        pass


def test_luma_sh1106_over_spi_with_gpiozero_dc_rst(mock_pins):
    from luma.core.interface.serial import spi

    dev = FakeSpidev()
    serial = spi(spi=dev, gpio=hat.GpioAdapter(), gpio_DC=hat.PIN_DC, gpio_RST=hat.PIN_RST)
    oled = luma_device.sh1106(serial, width=128, height=64, rotate=2)
    dev.written.clear()
    img = render_oled.render(parse(fake_bridge.sample("pairing", 1e9)), View(page="home"), now=1e9)
    oled.display(img)
    data = b"".join(dev.written)
    assert len(data) >= 128 * 8  # 8 pages of 128 columns
    assert mock_pins.pin(hat.PIN_RST).state is True  # out of reset
    oled.contrast(0x10)
    oled.hide()
    oled.show()


def test_gpiozero_buttons_with_pull_ups(mock_pins):
    got = []
    b = hat.Buttons(got.append, lambda k: got.append("-" + k))
    pin = mock_pins.pin(hat.KEY_PINS["key2"])
    pin.drive_low()  # active-low press
    pin.drive_high()
    b.close()
    assert got == ["key2", "-key2"]
