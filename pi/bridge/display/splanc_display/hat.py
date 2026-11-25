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

Taking over from the early boot splash (splash.py): the splash hands over its
GPIO line request for DC/RST (``LineFdGpio``) instead of releasing the lines (a
released RST pin falls back to an input and the panel would reset), and the
panel is already initialised the way luma would, so ``open_device(takeover=)``
skips the reset and luma's init/clear: the splash's last frame stays up until
the first one drawn here replaces it.
"""

from __future__ import annotations

import fcntl
import os
import struct
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


# The SoC's GPIO block, by gpiochip label (as the splash finds it). Its chip
# number is not fixed: drivers probed asynchronously at boot can register the
# firmware's 8-line GPIO expander (raspberrypi-exp-gpio) first, making the SoC
# gpiochip1. gpiozero 2.0.1's lgpio factory ignores its `chip` argument and
# always opens 0 (4 on a Pi 5), which then fails with "bad GPIO number".
SOC_GPIO_LABELS = ("pinctrl-bcm2835", "pinctrl-bcm2711", "pinctrl-rp1")
_GPIO_GET_CHIPINFO_IOCTL = 0x8044B401  # _IOR(0xB4, 0x01, struct gpiochip_info), 68 bytes
_MIN_LINES = max(PIN_DC, PIN_RST, *KEY_PINS.values()) + 1


def _chip_info(path: str):
    """(label, lines) of a /dev/gpiochipN, or None."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        buf = bytearray(68)  # name[32], label[32], u32 lines
        fcntl.ioctl(fd, _GPIO_GET_CHIPINFO_IOCTL, buf)
        return bytes(buf[32:64]).split(b"\0")[0].decode(errors="replace"), struct.unpack_from("<I", buf, 64)[0]
    except OSError:
        return None
    finally:
        os.close(fd)


def soc_gpiochip(info: Callable = _chip_info, dev: str = "/dev") -> Optional[int]:
    """The number of the SoC's gpiochip (see SOC_GPIO_LABELS), or None."""
    for n in range(16):
        got = info(f"{dev}/gpiochip{n}")
        if got and got[0] in SOC_GPIO_LABELS and got[1] >= _MIN_LINES:
            return n
    return None


def use_soc_gpiochip() -> None:
    """Make gpiozero's lgpio pin factory open the SoC's gpiochip (found by label)
    instead of the number it assumes. A no-op with another factory, or when no
    SoC gpiochip is found (gpiozero's own default then applies)."""
    if os.environ.get("GPIOZERO_PIN_FACTORY", "lgpio") != "lgpio":
        return
    chip = soc_gpiochip()
    if chip is None:
        return
    from gpiozero import Device
    from gpiozero.pins.lgpio import LGPIOFactory, LGPIOPin
    from gpiozero.pins.local import LocalPiFactory

    if isinstance(Device.pin_factory, LGPIOFactory) and Device.pin_factory.chip == chip:
        return

    class _SocLGPIOFactory(LGPIOFactory):
        def __init__(self, chip):
            LocalPiFactory.__init__(self)  # LGPIOFactory.__init__ would open its own guess
            import lgpio

            self._handle = lgpio.gpiochip_open(chip)
            self._chip = chip
            self.pin_class = LGPIOPin

    if Device.pin_factory is not None:
        Device.pin_factory.close()
    Device.pin_factory = _SocLGPIOFactory(chip)


class GpioAdapter:
    """The RPi.GPIO subset luma's ``spi`` interface calls, on gpiozero devices."""

    OUT, IN, HIGH, LOW, BCM = "out", "in", True, False, "bcm"

    def __init__(self, factory: Callable = None):
        if factory is None:
            use_soc_gpiochip()
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


GPIO_V2_LINE_SET_VALUES_IOCTL = 0xC010B40F  # _IOWR(0xB4, 0x0F, struct gpio_v2_line_values)


class LineFdGpio:
    """The RPi.GPIO subset luma calls, on a GPIO v2 line request fd that already
    holds DC (line 0) and RST (line 1) as outputs: the boot splash's, passed to us
    at its hand-off. RST stays high (out of reset) the whole time."""

    OUT, IN, HIGH, LOW, BCM = "out", "in", True, False, "bcm"
    LINES = {PIN_DC: 0, PIN_RST: 1}

    def __init__(self, fd: int, ioctl=fcntl.ioctl):
        self.fd = fd
        self._ioctl = ioctl
        self._bits = 0b10  # DC low, RST high

    def setmode(self, mode) -> None:
        pass

    def setwarnings(self, flag) -> None:
        pass

    def setup(self, pin, mode, initial=None, **_kw) -> None:
        if pin not in self.LINES:
            raise ValueError(f"GPIO {pin} is not in the splash's line request")

    def output(self, pin, value) -> None:
        bit = 1 << self.LINES[pin]
        self._bits = (self._bits | bit) if value else (self._bits & ~bit)
        self._ioctl(self.fd, GPIO_V2_LINE_SET_VALUES_IOCTL, struct.pack("<QQ", self._bits, 0b11))

    def cleanup(self, pins=None) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class _Muted:
    """A luma serial interface that drops writes while ``muted`` (luma's init and
    clear, on a panel the splash has already set up identically)."""

    def __init__(self, inner):
        self.inner = inner
        self.muted = True

    def command(self, *cmd):
        if not self.muted:
            self.inner.command(*cmd)

    def data(self, data):
        if not self.muted:
            self.inner.data(data)

    def cleanup(self):
        self.inner.cleanup()


def open_device(
    kind: str, rotate: int = 2, gpio=None, takeover: Optional[int] = None, spi_dev=None
):
    """A luma.oled sh1106 device. Waveshare's own driver scans SEG0->127 / COM0->63
    (0xA0/0xC0); luma's init uses the flipped scan (0xA1/0xC8), so rotate=2 (180°)
    shows the image the same way up as Waveshare's demo (OLED_ROTATE overrides).

    ``takeover``: the boot splash's DC/RST line request fd (SPI only): no reset,
    no init, no clear; the panel keeps showing the splash until our first frame."""
    from luma.core.interface.serial import i2c, spi
    from luma.oled.device import sh1106

    if kind == "i2c":
        serial = i2c(port=I2C_PORT, address=I2C_ADDR)
    elif takeover is not None:
        serial = _Muted(
            spi(
                spi=spi_dev,
                port=SPI_PORT,
                device=SPI_DEVICE,
                gpio=gpio or LineFdGpio(takeover),
                gpio_DC=PIN_DC,
                gpio_RST=None,
                bus_speed_hz=8_000_000,
            )
        )
        dev = sh1106(serial, width=128, height=64, rotate=rotate)
        serial.muted = False
        return dev
    else:
        serial = spi(
            spi=spi_dev,
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
            use_soc_gpiochip()
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
