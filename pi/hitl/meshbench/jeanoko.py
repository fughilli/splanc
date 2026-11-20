"""Direct driver for a Jeanoko 0-6 GHz digital attenuator over its USB serial port
(docs/design/mesh-hitl-rig.md §5.2, §5.8).

The rig normally drives the units from rfctl's PIO UARTs (device kind
`atten_uart`), so their changes sit on the controller's timeline. This driver is
for calibration on the VNA and for the fallback when a unit's UART header can't
be used: the unit's micro-USB port, 115200 8N1, one command per line.

Protocol (Silicon Chip, Nov 2021 / PE Dec 2024 reviews of the same module family;
github.com/emptemp/att6000_control). CONFIRM on the units that arrived:

    "wv0XXYY\\n"   set XX.YY dB (0.25 dB steps, 0..31.75); the unit answers "ok\\r\\n"
                  (the review saw "OK") and shows the value on its OLED

The unit powers up at 0.00 dB.
"""

from __future__ import annotations

import time

STEP_DB = 0.25
MAX_DB = 31.75
BAUD = 115200


def command(db: float) -> str:
    """The set command for `db` (a multiple of 0.25, 0..31.75)."""
    q = db / STEP_DB
    if abs(q - round(q)) > 1e-9 or not 0 <= db <= MAX_DB:
        raise ValueError(f"Jeanoko: {db} dB is not a multiple of {STEP_DB} in 0..{MAX_DB}")
    cdb = int(round(round(q) * STEP_DB * 100))
    return f"wv0{cdb:04d}\n"


class JeanokoError(RuntimeError):
    pass


class Jeanoko:
    """One unit on a serial port (or any object with write(bytes) and
    readline() -> bytes, for tests)."""

    def __init__(self, port_or_serial, timeout: float = 0.3) -> None:
        if isinstance(port_or_serial, str):
            import serial  # pyserial

            self.ser = serial.Serial(port_or_serial, BAUD, timeout=timeout)
            self.ser.reset_input_buffer()
        else:
            self.ser = port_or_serial
        self.timeout = timeout
        self.value: float | None = None  # unknown until set (powers up at 0 dB)

    def set(self, db: float, retries: int = 2) -> float:
        """Set the attenuation; returns the seconds from write to "ok". Raises
        JeanokoError if the unit never acknowledges."""
        cmd = command(db).encode()
        for _ in range(retries + 1):
            t0 = time.monotonic()
            self.ser.write(cmd)
            deadline = t0 + self.timeout
            while time.monotonic() < deadline:
                line = self.ser.readline()
                if not line:
                    continue
                if line.strip().lower() == b"ok":
                    self.value = float(db)
                    return time.monotonic() - t0
        raise JeanokoError(f"no 'ok' for {cmd!r} after {retries + 1} tries")

    def close(self) -> None:
        close = getattr(self.ser, "close", None)
        if close:
            close()

    def __enter__(self) -> "Jeanoko":
        return self

    def __exit__(self, *exc) -> None:
        try:
            self.set(MAX_DB)  # leave it at its safe value
        except Exception:
            pass
        self.close()
