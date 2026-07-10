"""SPI byte framing for SK9822 / APA102 and the SPI sink abstraction.

The framing is pure (an on-set + colour → bytes), so it is unit-tested without
hardware. The sink is an injection seam: :class:`SpidevSink` drives the real
``/dev/spidev*`` bus on the Pi, while :class:`RecordingSink` captures writes for
tests. The driver loop only knows the :class:`SpiSink` protocol.

Wire format (SK9822/APA102):

  * start frame: 4 × ``0x00``
  * per LED: ``0xE0 | brightness5`` then ``B, G, R`` (APA102 colour order)
  * end frame: ``ceil(n/16)`` (min 4) × ``0x00`` — the SK9822 32-bit latch plus
    enough extra clock to flush a long cascade. (Classic APA102 used ``0xFF``
    here; SK9822 fixed the cascade quirk and wants zeros, which are the safer
    cross-compatible choice.)
"""

from __future__ import annotations

from typing import Iterable, List, Protocol, Set, Tuple

RGB = Tuple[int, int, int]


class SpiSink(Protocol):
    """Anything the driver can push framed bytes to."""

    def write(self, data: bytes) -> None: ...

    def close(self) -> None: ...


def _brightness_byte(level: int) -> int:
    if not 0 <= level <= 31:
        raise ValueError(f"brightness must be 0..31, got {level}")
    return 0xE0 | level


def _end_frame_len(n: int) -> int:
    # SK9822 needs a 32-bit end latch; long strips need ~n/16 extra clock bytes.
    return max(4, (n + 15) // 16)


def frame_bytes(
    on_ids: Set[int], n: int, color: RGB = (255, 255, 255), brightness: int = 31
) -> bytes:
    """Encode one frame: LEDs in ``on_ids`` lit with ``color``/``brightness``, rest off."""
    if brightness < 0 or brightness > 31:
        raise ValueError(f"brightness must be 0..31, got {brightness}")
    bright = _brightness_byte(brightness)
    r, g, b = color
    for c in (r, g, b):
        if not 0 <= c <= 255:
            raise ValueError(f"colour channels must be 0..255, got {color}")
    on_led = bytes((bright, b, g, r))
    off_led = bytes((0xE0, 0, 0, 0))  # brightness 0, colour 0 → dark

    buf = bytearray(b"\x00\x00\x00\x00")  # start frame
    for i in range(n):
        buf += on_led if i in on_ids else off_led
    buf += b"\x00" * _end_frame_len(n)  # end frame
    return bytes(buf)


def frame_bytes_colors(colors: List[RGB], brightness: int = 31) -> bytes:
    """Encode one hue-code frame: every LED lit with its OWN color.

    The hue carrier keeps all LEDs lit every frame (constant brightness;
    the code is in the color), so this is the driver's normal frame path;
    :func:`frame_bytes` remains for the dark/debug frames.
    """
    bright = _brightness_byte(brightness)
    buf = bytearray(b"\x00\x00\x00\x00")  # start frame
    for r, g, b in colors:
        for c in (r, g, b):
            if not 0 <= c <= 255:
                raise ValueError(f"colour channels must be 0..255, got {(r, g, b)}")
        buf += bytes((bright, b, g, r))  # APA102 colour order: B, G, R
    buf += b"\x00" * _end_frame_len(len(colors))  # end frame
    return bytes(buf)


def buffer_len(n: int) -> int:
    """Total framed length for ``n`` LEDs (start + LED frames + end)."""
    return 4 + 4 * n + _end_frame_len(n)


class RecordingSink:
    """Test/dry-run sink: keeps every buffer written."""

    def __init__(self) -> None:
        self.writes: List[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))

    def close(self) -> None:
        self.closed = True


class SpidevSink:
    """Real hardware sink over ``/dev/spidev<bus>.<device>`` (Pi only).

    ``spidev`` is imported lazily so this module imports fine off-Pi (and in the
    hermetic Bazel test sandbox), where the package is absent.
    """

    def __init__(self, bus: int = 0, device: int = 0, max_speed_hz: int = 8_000_000):
        try:
            import spidev  # type: ignore
        except ImportError as exc:  # pragma: no cover - hardware-only path
            raise RuntimeError(
                "spidev is not available; SpidevSink only works on the Pi "
                "(provisioned via pi/provisioning/nix/modules/spi.nix)"
            ) from exc
        self._spi = spidev.SpiDev()
        self._spi.open(bus, device)
        self._spi.max_speed_hz = max_speed_hz
        self._spi.mode = 0b00

    def write(self, data: bytes) -> None:  # pragma: no cover - hardware-only path
        self._spi.writebytes2(data)

    def close(self) -> None:  # pragma: no cover - hardware-only path
        self._spi.close()


def stdout_hex(buffers: Iterable[bytes]) -> str:
    """Render buffers as hex lines (debug helper for --dry-run)."""
    return "\n".join(b.hex() for b in buffers)
