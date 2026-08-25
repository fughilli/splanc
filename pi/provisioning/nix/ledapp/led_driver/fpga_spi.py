"""SPI framing for the ``//fpga/spi_ws281x`` streaming WS281x driver.

The FPGA is an alternative output to the SK9822/APA102 path (see :mod:`spi`): the
Pi streams pixel data over SPI and the FPGA fans it out to N WS281x strips. The
wire protocol (matching ``fpga/spi_ws281x/{spi_ctrl,csr,ws281x_stream}.v``):

  * A transaction begins on CS-low with a 1-byte opcode.
  * ``0x01`` WRITE_CSR: an address byte then value byte(s) (address auto-
    increments). CSR ``0x00`` = ``num_ports`` (active outputs), ``0x01`` = led_type.
  * ``0x02`` STREAM: the rest of the transaction is pixel data, **round-robin
    across the ports** — byte ``i`` goes to port ``i mod num_ports``. CS-high
    latches (the FPGA emits the WS reset pulse).

So per port the bytes are its pixels in WS wire order (GRB for WS2812), and the
global stream interleaves the ports byte-by-byte. Because the FPGA consumes at a
fixed WS rate with only a couple of bytes of buffer per port, the SPI clock must
be roughly rate-matched (see :func:`matched_speed_hz`).

Everything here is pure (colours → bytes) so it is unit-tested without hardware;
the transport reuses :class:`led_driver.spi.SpidevSink`.
"""

from __future__ import annotations

from typing import List, Optional, Sequence

from .spi import RGB

OP_WRITE_CSR = 0x01
OP_STREAM = 0x02

CSR_NUM_PORTS = 0x00
CSR_LED_TYPE = 0x01

# WS2812: one byte is 8 bits * 1.25 us = 10 us on the wire.
WS_BYTE_US = 10.0


def to_wire(pixel: RGB, color_order: str = "GRB") -> bytes:
    """One pixel in the strip's wire byte order (WS2812 = GRB)."""
    r, g, b = pixel
    chan = {"R": r, "G": g, "B": b}
    for c in (r, g, b):
        if not 0 <= c <= 255:
            raise ValueError(f"colour channels must be 0..255, got {pixel}")
    return bytes(chan[c] for c in color_order)


def encode_csr(addr: int, *values: int) -> bytes:
    """A WRITE_CSR transaction: opcode, start address, then value byte(s)."""
    return bytes((OP_WRITE_CSR, addr, *values))


def set_num_ports(num_ports: int) -> bytes:
    """WRITE_CSR transaction that sets the active port count."""
    return encode_csr(CSR_NUM_PORTS, num_ports)


def encode_stream(port_frames: Sequence[Sequence[RGB]], color_order: str = "GRB") -> bytes:
    """A STREAM transaction for one frame across ``len(port_frames)`` ports.

    ``port_frames[p]`` is port p's pixels. Each port's wire bytes are interleaved
    round-robin (byte ``i`` → port ``i mod N``); shorter ports are padded with
    zero bytes so every port stays byte-aligned in the interleave.
    """
    port_bytes = [b"".join(to_wire(px, color_order) for px in pf) for pf in port_frames]
    width = max((len(pb) for pb in port_bytes), default=0)
    port_bytes = [pb + b"\x00" * (width - len(pb)) for pb in port_bytes]

    out = bytearray((OP_STREAM,))
    for k in range(width):
        for pb in port_bytes:
            out.append(pb[k])
    return bytes(out)


def split_ports(
    colors: Sequence[RGB], num_ports: int, port_counts: Optional[Sequence[int]] = None
) -> List[List[RGB]]:
    """Split a flat pixel list into ``num_ports`` contiguous per-port runs.

    With ``port_counts`` the split follows those lengths (the driver's per-channel
    topology); otherwise the pixels are divided as evenly as possible, with the
    remainder going to the earliest ports.
    """
    colors = list(colors)
    if port_counts is not None:
        if len(port_counts) != num_ports:
            raise ValueError(f"port_counts has {len(port_counts)} entries, expected {num_ports}")
        counts = list(port_counts)
    else:
        base, extra = divmod(len(colors), num_ports)
        counts = [base + (1 if p < extra else 0) for p in range(num_ports)]

    out: List[List[RGB]] = []
    i = 0
    for c in counts:
        out.append(colors[i : i + c])
        i += c
    return out


def matched_speed_hz(num_ports: int, ws_byte_us: float = WS_BYTE_US) -> int:
    """SPI clock (Hz) that delivers ~``num_ports`` bytes per WS byte-time.

    The FPGA drains one byte per port per WS byte-time, so the aggregate byte rate
    is ``num_ports / ws_byte_us``; ×8 for bits. Clocking much faster overflows the
    per-port double buffer; slower risks a mid-frame gap.
    """
    return int(num_ports * 8 * 1_000_000 / ws_byte_us)


class FpgaCodec:
    """Encodes the driver's per-frame colours into ``spi_ws281x`` transactions.

    Reused across frames: :meth:`configure` (the one-time CSR write) is sent once
    at start, then :meth:`frame` / :meth:`dark` produce a STREAM transaction per
    frame. The driver writes each via a separate ``SpiSink.write`` so CS frames
    each transaction.
    """

    def __init__(
        self,
        num_ports: int,
        *,
        color_order: str = "GRB",
        port_counts: Optional[Sequence[int]] = None,
    ):
        if num_ports < 1:
            raise ValueError(f"num_ports must be >= 1, got {num_ports}")
        self.num_ports = num_ports
        self.color_order = color_order
        self.port_counts = list(port_counts) if port_counts is not None else None

    def configure(self) -> bytes:
        """The one-time CSR write (active port count)."""
        return set_num_ports(self.num_ports)

    def frame(self, colors: Sequence[RGB]) -> bytes:
        """A STREAM transaction for one flat frame of ``colors``."""
        ports = split_ports(colors, self.num_ports, self.port_counts)
        return encode_stream(ports, self.color_order)

    def dark(self, n: int) -> bytes:
        """A STREAM transaction with every LED off."""
        return self.frame([(0, 0, 0)] * n)
