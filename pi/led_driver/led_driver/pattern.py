"""The hue-code cycle the driver emits — rendered by the Rust kernel.

There is no colour-code logic in this package. ``color_plan`` asks the hue-code
kernel (``//firmware/pattern``, the one implementation the players link and the
phone runs as wasm) for every LED's RGB in every cycle frame, through the one
Python binding ``ledmapper_pattern`` (ctypes over the kernel's C ABI). The
driver only frames those colours for the strip (``spi.frame_bytes_colors``,
APA102/SK9822) or the FPGA (``fpga_spi``).

The cycle (design doc §8.1): ``[white ALL_ON][green ALL_OFF]`` sync delimiter,
then ``ceil(bits / log2(symbols))`` data frames; every LED is lit every frame
at constant brightness and the code is carried by colour alone.
"""

from __future__ import annotations

from typing import List

import ledmapper_pattern as kernel
from ledmapper_protocol import CodeParams

from .spi import RGB


def check_code_params(code_params: CodeParams) -> None:
    """Reject a code-book the kernel would not derive for its own LED count."""
    n, sym, fec = code_params.ledCount, code_params.symbols, code_params.fec
    want_bits = kernel.expected_bits(n, fec)
    if code_params.bits != want_bits:
        raise ValueError(
            f"bits={code_params.bits} but ledCount={n} with fec={fec!r} implies "
            f"{want_bits}; code-book is inconsistent"
        )
    want_frames = kernel.cycle_frames(n, sym, fec)
    if code_params.cycleFrames != want_frames:
        raise ValueError(
            f"cycleFrames={code_params.cycleFrames} but the kernel's cycle is "
            f"{want_frames} frames; code-book is inconsistent"
        )


def color_plan(code_params: CodeParams) -> List[List[RGB]]:
    """The ordered per-frame colour lists for one full cycle.

    ``code_params.cycleFrames`` entries; entry ``f`` lists every LED's colour in
    that frame, straight from the kernel.
    """
    check_code_params(code_params)
    n, sym, fec = code_params.ledCount, code_params.symbols, code_params.fec
    return [kernel.frame_rgb(f, n, sym, fec) for f in range(code_params.cycleFrames)]


def default_code_params(
    led_count: int, bit_period_ms: float = 100.0, symbols: int = 2
) -> CodeParams:
    """A default code-book for ``led_count`` LEDs (CLI ``--start`` / dry-run only).

    In normal operation M2 issues the :class:`CodeParams`
    (``pi/server/server/codebook.py``) and hands them to ``start()``. Sized by
    the kernel, matching M2's defaults: SEC-DED on, hue carrier.
    """
    return CodeParams(
        ledCount=led_count,
        bits=kernel.expected_bits(led_count, "secded"),
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=kernel.cycle_frames(led_count, symbols, "secded"),
        fec="secded",
    )
