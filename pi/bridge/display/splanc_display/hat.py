"""Waveshare 1.3" OLED HAT: SH1106 128x64 over SPI (default) or I2C, + 8 keys.

Pins (BCM), from https://www.waveshare.com/wiki/1.3inch_OLED_HAT:
    display  SPI0 CE0 (/dev/spidev0.0), DC=24, RST=25; I2C mode: bus 1, addr 0x3C
    keys     KEY1=21 KEY2=20 KEY3=16; joystick up=6 down=19 left=5 right=26 press=13
             (active low, no pull-ups on the board: we enable the SoC's)

GPIO goes through gpiozero (lgpio pin factory on Bookworm), which handles the
Pi 5's RP1 GPIO block — so does the DC/RST adapter we hand luma instead of its
default RPi.GPIO (which does not work on a Pi 5).

Detection (``OLED=auto``): an SPI OLED is write-only, so it cannot be probed. We
use, in order: a HAT ID EEPROM naming an OLED; an I2C device ACKing at 0x3C (the
HAT's I2C mode); /dev/spidev0.0 present (the installer enables SPI for this HAT).
Driving SPI0/GPIO24/25 with no HAT attached is harmless, and unpressed keys read
high through the pull-ups, so a false positive only costs a little CPU.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

PIN_DC, PIN_RST = 24, 25
SPI_PORT, SPI_DEVICE = 0, 0
I2C_PORT, I2C_ADDR = 1, 0x3C

KEY_PINS = {
    "key1": 21,
    "key2": 20,
    "key3": 16,
    "up": 6,
    "down": 19,
    "left": 5,
    "right": 26,
    "press": 13,
}


def _hat_eeprom_says_oled() -> bool:
    try:
        with open("/proc/device-tree/hat/product", "rb") as f:
            return b"OLED" in f.read().upper()
    except OSError:
        return False


def _i2c_ack(port: int = I2C_PORT, addr: int = I2C_ADDR) -> bool:
    dev = f"/dev/i2c-{port}"
    if not os.path.exists(dev):
        return False
    try:
        from smbus2 import SMBus

        with SMBus(port) as bus:
            bus.write_quick(addr)
        return True
    except Exception:
        return False


def detect(mode: str = "auto") -> Optional[str]:
    """``"spi"``, ``"i2c"`` or None (no OLED). ``mode``: auto|spi|i2c|off."""
    mode = (mode or "auto").lower()
    if mode in ("off", "none", "no", "0", "false"):
        return None
    if mode in ("spi", "i2c"):
        return mode
    if _i2c_ack():
        return "i2c"
    if os.path.exists(f"/dev/spidev{SPI_PORT}.{SPI_DEVICE}") or _hat_eeprom_says_oled():
        return "spi"
    return None


class GpioAdapter:
    """The RPi.GPIO subset luma's ``spi`` interface calls, on gpiozero devices."""

    OUT, IN, HIGH, LOW, BCM = "out", "in", True, False, "bcm"

    def __init__(self, factory: Callable = None):
        if factory is None:
            from gpiozero import DigitalOutputDevice as factory  # noqa: N813
        self._factory = factory
        self._pins = {}

    def setmode(self, mode) -> None:
        pass

    def setwarnings(self, flag) -> None:
        pass

    def setup(self, pin, mode, initial=None, **_kw) -> None:
        if pin in self._pins:
            return
        self._pins[pin] = self._factory(
            pin, initial_value=bool(initial) if initial is not None else False
        )

    def output(self, pin, value) -> None:
        self._pins[pin].value = bool(value)

    def cleanup(self, pins=None) -> None:
        if pins is None:
            pins = list(self._pins)
        elif not isinstance(pins, (list, tuple, set)):
            pins = [pins]
        for p in pins:
            dev = self._pins.pop(p, None)
            if dev is not None:
                dev.close()


def open_device(kind: str, rotate: int = 2, gpio=None):
    """A luma.oled sh1106 device. Waveshare's own driver scans SEG0->127 / COM0->63
    (0xA0/0xC0); luma's init uses the flipped scan (0xA1/0xC8), so rotate=2 (180°)
    shows the image the same way up as Waveshare's demo (OLED_ROTATE overrides)."""
    from luma.core.interface.serial import i2c, spi
    from luma.oled.device import sh1106

    if kind == "i2c":
        serial = i2c(port=I2C_PORT, address=I2C_ADDR)
    else:
        serial = spi(
            port=SPI_PORT,
            device=SPI_DEVICE,
            gpio=gpio or GpioAdapter(),
            gpio_DC=PIN_DC,
            gpio_RST=PIN_RST,
            bus_speed_hz=8_000_000,
        )
    return sh1106(serial, width=128, height=64, rotate=rotate)


class Buttons:
    """gpiozero Buttons -> ``on_press(key)`` / ``on_release(key)`` callbacks.

    ``factory`` builds one button: factory(pin) -> object with ``when_pressed`` /
    ``when_released`` attributes and ``close()`` (gpiozero.Button, or a fake).
    """

    def __init__(self, on_press, on_release, factory: Callable = None, pins=KEY_PINS):
        if factory is None:
            from gpiozero import Button

            def factory(pin):
                return Button(pin, pull_up=True, bounce_time=0.03)

        self._buttons = {}
        for key, pin in pins.items():
            b = factory(pin)
            b.when_pressed = (lambda k: lambda *_: on_press(k))(key)
            b.when_released = (lambda k: lambda *_: on_release(k))(key)
            self._buttons[key] = b

    def close(self) -> None:
        for b in self._buttons.values():
            b.close()
        self._buttons.clear()
