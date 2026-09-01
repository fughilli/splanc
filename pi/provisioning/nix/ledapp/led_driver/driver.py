"""The LED pattern driver (M1, design doc §6 M1 / §8.1).

`LedDriver` runs a continuous Gray-code cycle on a background thread, holding
each frame for ``bitPeriodMs`` and pushing framed bytes to a :class:`SpiSink`.
It records the **pattern clock epoch** — the monotonic time at which frame 0 of a
cycle is displayed — which M2 reads (via the control socket) and hands to the
phone so a capture time can be mapped to a bit index (§8.2).

The interface mirrors the design-doc M1 contract: ``start(code_params) → epoch``,
``stop()``, ``set_debug(mode, args)``, ``get_clock()``.

Timing (``clock``/``sleep``) is injected so the loop can be driven
deterministically in tests with no real wall-clock waits.
"""

from __future__ import annotations

import threading
from typing import Callable, Dict, Optional

from ledmapper_protocol import CodeParams

from .clock import now_ms
from .fpga_spi import FpgaCodec
from .graycode import color_plan
from .spi import RGB, SpiSink, frame_bytes, frame_bytes_colors

# Debug modes for set_debug (design doc M1 "debug single-LED mode").
MODE_CYCLE = "cycle"  # normal Gray-code cycle
MODE_SINGLE = "single"  # light one LED continuously (wiring/debug)
MODE_OFF = "off"  # all LEDs dark
MODE_STATIC = "static"  # hold an explicit per-LED frame (deterministic capture)
_MODES = {MODE_CYCLE, MODE_SINGLE, MODE_OFF, MODE_STATIC}


class LedDriver:
    def __init__(
        self,
        sink: SpiSink,
        *,
        on_color: RGB = (255, 255, 255),
        brightness: int = 31,
        fpga: Optional[FpgaCodec] = None,
        clock: Callable[[], float] = now_ms,
        sleep: Callable[[float], None] | None = None,
    ):
        self._sink = sink
        self._on_color = on_color
        self._brightness = brightness
        # When set, frames are encoded for the spi_ws281x FPGA instead of APA102.
        self._fpga = fpga
        self._static_colors: list[RGB] = []
        self._clock = clock
        if sleep is None:
            import time

            sleep = time.sleep
        self._sleep = sleep

        self._params: Optional[CodeParams] = None
        self._epoch: float = 0.0
        self._mode = MODE_CYCLE
        self._debug_led = 0
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._started = threading.Event()
        self._lock = threading.Lock()

    # -- lifecycle --------------------------------------------------------

    def start(self, code_params: CodeParams) -> float:
        """Begin the cycle; returns the pattern clock epoch (ms, monotonic).

        Blocks until the worker has stamped the epoch and is about to display
        frame 0, so the returned epoch reflects the real start of the cycle.
        """
        self.stop()  # idempotent: tear down any prior run
        self._params = code_params
        self._stop.clear()
        self._started.clear()
        self._thread = threading.Thread(target=self._run, name="led-driver", daemon=True)
        self._thread.start()
        self._started.wait()
        return self._epoch

    def stop(self) -> None:
        """Stop the cycle and leave the strip dark. Safe to call when idle."""
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join()
        self._thread = None

    def join(self, timeout: Optional[float] = None) -> None:
        """Wait for the worker to exit on its own (used in tests)."""
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    # -- queries / control ------------------------------------------------

    def get_clock(self) -> Dict[str, float]:
        """Return ``{epoch, bitPeriodMs, cycleLen}`` (design doc M1 interface)."""
        if self._params is None:
            return {"epoch": 0.0, "bitPeriodMs": 0.0, "cycleLen": 0}
        return {
            "epoch": self._epoch,
            "bitPeriodMs": self._params.bitPeriodMs,
            "cycleLen": self._params.cycleFrames,
        }

    def set_debug(self, mode: str, args: Optional[dict] = None) -> None:
        if mode not in _MODES:
            raise ValueError(f"unknown debug mode {mode!r}; expected one of {sorted(_MODES)}")
        with self._lock:
            self._mode = mode
            if mode == MODE_SINGLE:
                led = int((args or {}).get("ledId", 0))
                n = self._params.ledCount if self._params else led + 1
                if not 0 <= led < n:
                    raise ValueError(f"ledId {led} out of range [0, {n})")
                self._debug_led = led
            elif mode == MODE_STATIC:
                self._static_colors = [
                    tuple(int(c) for c in px) for px in (args or {}).get("colors", [])
                ]

    # -- worker -----------------------------------------------------------

    def _colors_for(self, mode: str, plan, frame_idx: int, n: int, led: int, static) -> list:
        """Semantic per-LED colours for a frame (the FPGA codec's input)."""
        if mode == MODE_OFF:
            return [(0, 0, 0)] * n
        if mode == MODE_SINGLE:
            c = [(0, 0, 0)] * n
            if 0 <= led < n:
                c[led] = self._on_color
            return c
        if mode == MODE_STATIC:
            s = list(static)[:n]
            return s + [(0, 0, 0)] * (n - len(s))
        return list(plan[frame_idx % len(plan)])

    def _frame_for(self, frame_idx: int, plan, n: int) -> bytes:
        with self._lock:
            mode, led, static = self._mode, self._debug_led, list(self._static_colors)
        # FPGA output: encode the semantic frame for the spi_ws281x stream.
        if self._fpga is not None:
            return self._fpga.frame(self._colors_for(mode, plan, frame_idx, n, led, static))
        # APA102/SK9822 output (unchanged wire bytes).
        if mode == MODE_OFF:
            return frame_bytes(frozenset(), n, brightness=self._brightness)
        if mode == MODE_SINGLE:
            return frame_bytes(
                frozenset((led,)), n, color=self._on_color, brightness=self._brightness
            )
        if mode == MODE_STATIC:
            return frame_bytes_colors(
                self._colors_for(mode, plan, frame_idx, n, led, static), brightness=self._brightness
            )
        # Normal hue cycle: every LED lit, per-LED colors from the plan.
        return frame_bytes_colors(plan[frame_idx % len(plan)], brightness=self._brightness)

    def _run(self) -> None:
        assert self._params is not None
        params = self._params
        plan = color_plan(params)
        n = params.ledCount
        period_s = params.bitPeriodMs / 1000.0

        # Stamp the epoch at the start of the cycle, then release start().
        self._epoch = self._clock()
        self._started.set()

        frame_idx = 0
        try:
            while not self._stop.is_set():
                # FPGA output: re-send the CSR (active port count) every frame.
                # The FPGA resets num_ports to its default (= MAX_PORTS) on any
                # reconfig — reflash, power-cycle, or USB replug — so a one-time
                # write at startup silently reverts and the data smears across all
                # ports. Refreshing it each frame (3 bytes, one CS transaction)
                # keeps it correct through any FPGA reset.
                if self._fpga is not None:
                    self._sink.write(self._fpga.configure())
                self._sink.write(self._frame_for(frame_idx, plan, n))
                frame_idx += 1
                self._sleep(period_s)
        finally:
            # Leave the strip dark whenever the loop ends, however triggered.
            if self._fpga is not None:
                self._sink.write(self._fpga.dark(n))
            else:
                self._sink.write(frame_bytes(frozenset(), n, brightness=self._brightness))
