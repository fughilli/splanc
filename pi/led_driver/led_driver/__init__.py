"""LED pattern driver (M1, design doc §6 M1 / §8.1).

Drives an SK9822/APA102 strip over hardware SPI through a continuous hue-code
cycle (constant brightness, per-LED colors carry the code) with a
white/green sync delimiter, and exposes a local control socket so M2 can
``start``/``stop`` the pattern and read the pattern clock.

The hue code itself is NOT implemented here: ``pattern.color_plan`` renders each
frame with the Rust kernel ``//firmware/pattern`` (the one implementation),
through its Python binding ``ledmapper_pattern``. This package owns only the
output side: APA102/SK9822 framing (``spi``), spi_ws281x FPGA framing
(``fpga_spi``), the frame loop/pattern clock (``driver``) and the control socket.

Public surface:

    from led_driver import LedDriver, ControlServer, ControlClient
    from led_driver import color_plan, frame_bytes_colors, RecordingSink, SpidevSink
"""

from __future__ import annotations

from .control import ControlClient, ControlServer, handle_line
from .driver import MODE_CYCLE, MODE_OFF, MODE_SINGLE, LedDriver
from .pattern import check_code_params, color_plan, default_code_params
from .spi import (
    RecordingSink,
    SpidevSink,
    SpiSink,
    buffer_len,
    frame_bytes,
    frame_bytes_colors,
)

__all__ = [
    "LedDriver",
    "MODE_CYCLE",
    "MODE_SINGLE",
    "MODE_OFF",
    "ControlServer",
    "ControlClient",
    "handle_line",
    "color_plan",
    "check_code_params",
    "frame_bytes",
    "frame_bytes_colors",
    "buffer_len",
    "default_code_params",
    "SpiSink",
    "RecordingSink",
    "SpidevSink",
]
