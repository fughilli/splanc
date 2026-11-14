"""Code-book derivation (design doc §7.6 / §8.1, hue-only revision).

The temporal hue cycle is fully determined by the LED count, the symbol
alphabet, the frame period and the FEC mode: ``ceil(log2(ledCount+1))`` Gray
data bits, wrapped in an extended-Hamming SEC-DED code by default
(``fec="secded"``), transmitted ``log2(symbols)`` bits per color frame, plus
the 2-frame white/green sync delimiter. The same :class:`CodeParams` go into
both the ``welcome`` and ``mapping_started`` messages.

The arithmetic is NOT reimplemented here: it is the Rust hue-code kernel
(``//firmware/pattern``, the one implementation the players link and the phone
runs as wasm), called through its C ABI (``firmware/pattern/abi/kernel_abi.rs``)
from the host cdylib ``//firmware/pattern:kernel_abi``, loaded with ctypes on
first use. This module only validates arguments and assembles the message.
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path
from typing import Optional

from ledmapper_protocol import CodeParams

# design doc §12 default: frame period ≥ ~3 camera frame intervals at 30 fps.
DEFAULT_BIT_PERIOD_MS = 100.0

# Robust fallback alphabet for clients that don't negotiate one: red/blue has
# maximum hue separation; the client upgrades to 4 when its measured chroma
# SNR supports the finer palette.
DEFAULT_SYMBOLS = 2

_LIB_NAME = "libledmapper_pattern_abi" + (".dylib" if sys.platform == "darwin" else ".so")
_kernel: Optional[ctypes.CDLL] = None


def _kernel_path() -> str:
    """$LEDMAPPER_PATTERN_LIB, else the cdylib in this target's runfiles."""
    env = os.environ.get("LEDMAPPER_PATTERN_LIB")
    if env:
        return env
    from python.runfiles import runfiles

    r = runfiles.Create()
    path = r.Rlocation(f"_main/firmware/pattern/{_LIB_NAME}") if r else None
    if not path or not Path(path).exists():
        raise RuntimeError(
            f"hue-code kernel {_LIB_NAME} not found in runfiles "
            "(depend on //pi/server, or set LEDMAPPER_PATTERN_LIB)"
        )
    return path


def kernel() -> ctypes.CDLL:
    """The loaded hue-code kernel (C ABI, every argument/result a u32)."""
    global _kernel
    if _kernel is None:
        lib = ctypes.CDLL(_kernel_path())
        for name, argc in (
            ("pk_data_bits", 1),
            ("pk_expected_bits", 2),
            ("pk_cycle_frames", 3),
            ("pk_secded_total_bits", 1),
        ):
            fn = getattr(lib, name)
            fn.argtypes = [ctypes.c_uint32] * argc
            fn.restype = ctypes.c_uint32
        _kernel = lib
    return _kernel


def data_bits_for(led_count: int) -> int:
    """Gray data-word width: ``ceil(log2(ledCount + 1))``, minimum 1.

    +1: codewords carry id + 1 (the kernel's CODE_OFFSET — the all-zero word is
    reserved-invalid), so the code space is [1, ledCount].
    """
    return kernel().pk_data_bits(led_count)


def secded_total_bits(k: int) -> int:
    """Transmitted bits of the SEC-DED code around a ``k``-bit data word."""
    if k < 1:
        raise ValueError(f"k must be >= 1, got {k}")
    return kernel().pk_secded_total_bits(k)


def code_params_for(
    led_count: int,
    bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
    symbols: int = DEFAULT_SYMBOLS,
    fec: str = "secded",
    brightness: float | None = None,
) -> CodeParams:
    """Build the :class:`CodeParams` code-book for a fixture of ``led_count`` LEDs.

    ``bits`` counts the coded BITS: the Gray data word plus, with
    ``fec="secded"`` (the default), the extended-Hamming parity bits that
    make single misreads correctable and double misreads detectable — the
    raw Gray codebook has Hamming distance 1, so without FEC one decisive
    window error decodes to a valid WRONG id. Bits are transmitted
    ``log2(symbols)`` per color frame (``symbols`` is the client-negotiated
    data alphabet: 2 = red/blue, 4 = the Gray-ordered
    blue/magenta/red/yellow palette that halves the data frames);
    ``cycleFrames`` adds the 2-frame white/green sync delimiter.
    """
    if led_count < 1:
        raise ValueError(f"led_count must be ≥ 1, got {led_count}")
    if fec not in ("none", "secded"):
        raise ValueError(f"unknown fec {fec!r}")
    if symbols not in (2, 4):
        raise ValueError(f"symbols must be 2 or 4, got {symbols}")
    if brightness is not None and not 0.0 <= brightness <= 1.0:
        raise ValueError(f"brightness must be in [0, 1], got {brightness}")
    k = kernel()
    secded = 1 if fec == "secded" else 0
    return CodeParams(
        ledCount=led_count,
        bits=k.pk_expected_bits(led_count, secded),
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=k.pk_cycle_frames(led_count, symbols, secded),
        fec=fec,
        # None (= 1.0 on the wire) unless the phone servoed it down against
        # measured bloom/wash-out (exposure.ts planLedBrightness).
        brightness=brightness,
    )
