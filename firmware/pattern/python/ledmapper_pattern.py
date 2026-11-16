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
    "pk_color_rgb_sync": ([_U32] * 6, _U32),
    "pk_frame_rgb_sync": ([_U32] * 5 + [ctypes.c_void_p, _U32], _U32),
    "pk_stagger_step": ([_U32], _U32),
    "pk_stagger_phase": ([_U32] * 6, _U32),
    "pk_expected_bits_sync": ([_U32] * 4, _U32),
    "pk_cycle_frames_sync": ([_U32] * 4, _U32),
}

# CodeParams.syncPattern -> the kernel's SyncPattern code. "stagger_white" and
# "stagger_gm" are the link simulator's comparators, not wire values.
SYNC_CODES = {"on_off": 0, "stagger_pilot": 1, "stagger_white": 2, "stagger_gm": 3}


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


def _sync(sync_pattern: str) -> int:
    try:
        return SYNC_CODES[sync_pattern]
    except KeyError:
        raise ValueError(f"unknown sync pattern {sync_pattern!r}") from None


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


def expected_bits(led_count: int, fec: str, symbols: int = 2, sync_pattern: str = "on_off") -> int:
    """Transmitted code-bit count implied by ``led_count`` + ``fec`` (and, for
    the pruned hue code v2 book, the alphabet + sync pattern)."""
    sync = _sync(sync_pattern)
    if sync == 0:
        return kernel().pk_expected_bits(led_count, _secded(fec))
    _check_symbols(symbols)
    return kernel().pk_expected_bits_sync(led_count, symbols, _secded(fec), sync)


def cycle_frames(led_count: int, symbols: int, fec: str, sync_pattern: str = "on_off") -> int:
    """Full cycle length: the sync position (2 frames, or the hue code v2
    palette pilot) + the data frames."""
    _check_symbols(symbols)
    sync = _sync(sync_pattern)
    if sync == 0:
        return kernel().pk_cycle_frames(led_count, symbols, _secded(fec))
    return kernel().pk_cycle_frames_sync(led_count, symbols, _secded(fec), sync)


# --- render -----------------------------------------------------------------


def color_rgb(
    led_id: int,
    frame_index: int,
    led_count: int,
    symbols: int,
    fec: str,
    sync_pattern: str = "on_off",
) -> RGB:
    """The RGB ``led_id`` shows in cycle frame ``frame_index`` (the GLOBAL
    frame under a staggered ``sync_pattern``)."""
    _check_symbols(symbols)
    k = kernel()
    sync = _sync(sync_pattern)
    if sync == 0:
        v = k.pk_color_rgb(led_id, frame_index, led_count, symbols, _secded(fec))
    else:
        v = k.pk_color_rgb_sync(led_id, frame_index, led_count, symbols, _secded(fec), sync)
    return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)


def frame_rgb(
    frame_index: int, led_count: int, symbols: int, fec: str, sync_pattern: str = "on_off"
) -> List[RGB]:
    """Every LED's RGB in cycle frame ``frame_index`` (one kernel call)."""
    _check_symbols(symbols)
    n = led_count * 3
    buf = (ctypes.c_uint8 * max(n, 1))()
    sync = _sync(sync_pattern)
    if sync == 0:
        wrote = kernel().pk_frame_rgb(frame_index, led_count, symbols, _secded(fec), buf, n)
    else:
        wrote = kernel().pk_frame_rgb_sync(
            frame_index, led_count, symbols, _secded(fec), sync, buf, n
        )
    if wrote != n:
        raise ValueError(
            f"frame_index {frame_index} outside the cycle of "
            f"{cycle_frames(led_count, symbols, fec)} frames"
        )
    raw = bytes(buf)[:n]
    return [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, n, 3)]


def stagger_step(cycle_frames: int) -> int:
    """The stagger step S for a cycle of ``cycle_frames`` frames."""
    return kernel().pk_stagger_step(cycle_frames)


def stagger_phase(led_id: int, led_count: int, symbols: int, fec: str, sync_pattern: str) -> int:
    """Coded id ``led_id``'s phase rotation, ``(id * S + h(id div C)) mod C``
    (h: the kernel's keyed per-block offset; 0 under on_off)."""
    _check_symbols(symbols)
    bits = expected_bits(led_count, fec, symbols, sync_pattern)
    return kernel().pk_stagger_phase(
        led_id, led_count, bits, symbols, _secded(fec), _sync(sync_pattern)
    )
