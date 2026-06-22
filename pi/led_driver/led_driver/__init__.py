"""LED pattern driver (M1, design doc §6 M1 / §8.1).

Drives an SK9822/APA102 strip over hardware SPI through a continuous Gray-code
cycle with an on/off sync delimiter, and exposes a local control socket so M2 can
``start``/``stop`` the pattern and read the pattern clock.

Public surface:

    from led_driver import LedDriver, ControlServer, ControlClient
    from led_driver import frame_plan, frame_bytes, RecordingSink, SpidevSink
"""

from __future__ import annotations

from .control import ControlClient, ControlServer, handle_line
from .driver import MODE_CYCLE, MODE_OFF, MODE_SINGLE, LedDriver
from .graycode import decode_gray, default_code_params, frame_plan, gray, gray_bit
from .spi import RecordingSink, SpidevSink, SpiSink, buffer_len, frame_bytes

__all__ = [
    "LedDriver",
    "MODE_CYCLE",
    "MODE_SINGLE",
    "MODE_OFF",
    "ControlServer",
    "ControlClient",
    "handle_line",
    "frame_plan",
    "frame_bytes",
    "buffer_len",
    "gray",
    "gray_bit",
    "decode_gray",
    "default_code_params",
    "SpiSink",
    "RecordingSink",
    "SpidevSink",
]
