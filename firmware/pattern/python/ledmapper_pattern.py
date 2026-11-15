"""The ONE Python binding of the hue-code kernel (``//firmware/pattern``).

Every Python caller of the LED colour code goes through this module, which
loads the kernel's flat C ABI (``firmware/pattern/abi/kernel_abi.rs``, built as
the host cdylib ``//firmware/pattern:kernel_abi``) with ctypes. Nothing here
re-derives the code: it only marshals arguments into the kernel and results
back out.

Callers:

* ``pi/server/server/codebook.py`` — the M2 dev backend's code-book sizing.
* ``pi/led_driver`` (``led_driver.pattern``) — the APA102/SK9822 M1 driver's
  per-frame colours, in Bazel and in the Pi image (``pi/provisioning/nix``
  builds the same cdylib from the same sources and points
  ``$LEDMAPPER_PATTERN_LIB`` at it).

The library is found via ``$LEDMAPPER_PATTERN_LIB``, else in the Bazel runfiles
of a target that depends on ``//firmware/pattern:pattern_py``. Stdlib only (the
runfiles helper is imported lazily, only on the Bazel path).
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path
from typing import List, Optional, Tuple

RGB = Tuple[int, int, int]

LIB_NAME = "libledmapper_pattern_abi" + (".dylib" if sys.platform == "darwin" else ".so")

_kernel: Optional[ctypes.CDLL] = None

# name -> (argtypes, restype). Every scalar is a u32 across the ABI.
_U32 = ctypes.c_uint32
_SIGNATURES = {
    "pk_data_bits": ([_U32], _U32),
    "pk_expected_bits": ([_U32] * 2, _U32),
    "pk_cycle_frames": ([_U32] * 3, _U32),
    "pk_secded_total_bits": ([_U32], _U32),
    "pk_color_rgb": ([_U32] * 5, _U32),
    "pk_frame_rgb": ([_U32] * 4 + [ctypes.c_void_p, _U32], _U32),
}


def library_path() -> str:
    """``$LEDMAPPER_PATTERN_LIB``, else the cdylib in this target's runfiles."""
    env = os.environ.get("LEDMAPPER_PATTERN_LIB")
    if env:
        return env
    from python.runfiles import runfiles

    r = runfiles.Create()
    path = r.Rlocation(f"_main/firmware/pattern/{LIB_NAME}") if r else None
    if not path or not Path(path).exists():
        raise RuntimeError(
            f"hue-code kernel {LIB_NAME} not found in runfiles "
            "(depend on //firmware/pattern:pattern_py, or set LEDMAPPER_PATTERN_LIB)"
        )
    return path


def kernel() -> ctypes.CDLL:
    """The loaded hue-code kernel (typed on first use)."""
    global _kernel
    if _kernel is None:
        lib = ctypes.CDLL(library_path())
        for name, (argtypes, restype) in _SIGNATURES.items():
            fn = getattr(lib, name)
            fn.argtypes = argtypes
            fn.restype = restype
        _kernel = lib
    return _kernel


def _secded(fec: str) -> int:
    if fec not in ("none", "secded"):
        raise ValueError(f"unknown fec {fec!r}")
    return 1 if fec == "secded" else 0


def _check_symbols(symbols: int) -> None:
    if symbols not in (2, 4):
        raise ValueError(f"unsupported symbol alphabet {symbols}")


# --- code-book sizing --------------------------------------------------------


def data_bits(led_count: int) -> int:
    """Gray data-word width for ``led_count`` LEDs (codewords carry id + 1)."""
    return kernel().pk_data_bits(led_count)


def secded_total_bits(k: int) -> int:
    """Transmitted bits of the SEC-DED code around a ``k``-bit data word."""
    if k < 1:
        raise ValueError(f"k must be >= 1, got {k}")
    return kernel().pk_secded_total_bits(k)


def expected_bits(led_count: int, fec: str) -> int:
    """Transmitted code-bit count implied by ``led_count`` + ``fec``."""
    return kernel().pk_expected_bits(led_count, _secded(fec))


def cycle_frames(led_count: int, symbols: int, fec: str) -> int:
    """Full cycle length: the 2-frame sync delimiter + the data frames."""
    _check_symbols(symbols)
    return kernel().pk_cycle_frames(led_count, symbols, _secded(fec))


# --- render -----------------------------------------------------------------


def color_rgb(led_id: int, frame_index: int, led_count: int, symbols: int, fec: str) -> RGB:
    """The RGB ``led_id`` shows in cycle frame ``frame_index``."""
    _check_symbols(symbols)
    v = kernel().pk_color_rgb(led_id, frame_index, led_count, symbols, _secded(fec))
    return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)


def frame_rgb(frame_index: int, led_count: int, symbols: int, fec: str) -> List[RGB]:
    """Every LED's RGB in cycle frame ``frame_index`` (one kernel call)."""
    _check_symbols(symbols)
    n = led_count * 3
    buf = (ctypes.c_uint8 * max(n, 1))()
    wrote = kernel().pk_frame_rgb(frame_index, led_count, symbols, _secded(fec), buf, n)
    if wrote != n:
        raise ValueError(
            f"frame_index {frame_index} outside the cycle of "
            f"{cycle_frames(led_count, symbols, fec)} frames"
        )
    raw = bytes(buf)[:n]
    return [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, n, 3)]
