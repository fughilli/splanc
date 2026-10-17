#!/usr/bin/env python3
"""Dynamic USB-serial port discovery by VID/PID — reusable across the HITL fleet.

The ESP32-C6's built-in USB-Serial-JTAG enumerates under Espressif's USB vendor id
(0x303a); the OS assigns the serial device path (`/dev/cu.usbmodem<N>` on macOS,
`/dev/ttyACM<N>` on Linux) DYNAMICALLY, so it renumbers across replug/reset. Never
hardcode the path — resolve it at flash/monitor time from the stable USB identity
(vendor/product id, plus the per-board USB serial number when several boards are
attached).

This is deliberately host-agnostic (macOS + the Linux rigs) and stdlib-only apart
from an OPTIONAL, lazily-imported `pyserial` (`serial.tools.list_ports`), which is
already present wherever `esptool` is (esptool depends on it). The port-selection
logic is pure and dependency-injected (`comports=`), so it unit-tests in a
container that has no pyserial and no hardware.

CLI (prints the resolved device path, for `esptool --port "$(...)"`):

    python3 serial_discovery.py                       # the sole Espressif C6 port
    python3 serial_discovery.py --serial 8C:FD:49:12:56:E8   # a specific board
    python3 serial_discovery.py --json                # every candidate, as JSON
    python3 serial_discovery.py --fallback /dev/cu.usbmodem21101   # sanity fallback

Env defaults (so it drops into the reservation session with no flags):
    HITL_ESP_SERIAL / HITL_ADAPTER_SERIAL  -> --serial (pick the reserved board)
    HITL_ESP_PORT                          -> --fallback (sanity value only)
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from typing import Callable, Iterable, Optional, Sequence

# Espressif's USB vendor id. The ESP32-C6/C3/S3 built-in USB-Serial-JTAG bridge all
# enumerate under it; the JTAG/serial function is product id 0x1001. A board behind
# an external UART bridge (CP210x/FTDI) would use that chip's VID instead — pass
# --vid/--pid for those.
ESPRESSIF_VID = 0x303A
USB_SERIAL_JTAG_PID = 0x1001


@dataclasses.dataclass(frozen=True)
class PortInfo:
    """The subset of a serial port's USB identity we select on. Mirrors the fields
    `serial.tools.list_ports_common.ListPortInfo` exposes, so a real pyserial record
    duck-types straight in."""

    device: str  # OS path, e.g. /dev/cu.usbmodem21101 or /dev/ttyACM0
    vid: Optional[int] = None
    pid: Optional[int] = None
    serial_number: Optional[str] = None
    location: Optional[str] = None
    manufacturer: Optional[str] = None
    product: Optional[str] = None

    def as_dict(self) -> dict:
        d = dataclasses.asdict(self)
        # Render vid/pid as the hex the datasheets/udev rules use.
        d["vid"] = None if self.vid is None else f"0x{self.vid:04x}"
        d["pid"] = None if self.pid is None else f"0x{self.pid:04x}"
        return d


def _default_comports() -> Sequence:
    """Lazily import pyserial only when actually enumerating hardware, so importing
    this module (and unit-testing the selection logic) needs neither pyserial nor a
    serial device."""
    try:
        from serial.tools import list_ports  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            "pyserial is required to enumerate serial ports "
            "(install it, or run where esptool lives). "
            f"import failed: {e}"
        )
    return list(list_ports.comports())


def _norm_serial(s: Optional[str]) -> str:
    """Normalize a USB serial / adapter id for tolerant comparison: drop the
    separators MACs are written with and upper-case. So '8C:FD:49:12:56:E8',
    '8c-fd-49-12-56-e8' and '8CFD491256E8' all compare equal — we confirm the exact
    form the C6 reports live, and this stays robust to which one the catalog uses."""
    if not s:
        return ""
    return "".join(ch for ch in s if ch.isalnum()).upper()


def _matches_serial(port: PortInfo, want: str) -> bool:
    want_n = _norm_serial(want)
    if not want_n:
        return True
    have_n = _norm_serial(port.serial_number)
    if not have_n:
        return False
    # Exact after normalization, or one contained in the other (a board may report
    # the MAC as its serial with extra vendor prefix/suffix bytes).
    return have_n == want_n or want_n in have_n or have_n in want_n


def list_esp_ports(
    comports: Optional[Callable[[], Iterable]] = None,
    *,
    vid: Optional[int] = ESPRESSIF_VID,
    pids: Optional[Sequence[int]] = None,
) -> list[PortInfo]:
    """Every attached serial port matching `vid` (and `pids`, when given), newest
    OS name last so the ordering is deterministic. `comports` is injectable for
    tests; by default it enumerates real hardware via pyserial."""
    src = comports or _default_comports
    ports: list[PortInfo] = []
    for p in src():
        info = PortInfo(
            device=getattr(p, "device", "") or "",
            vid=getattr(p, "vid", None),
            pid=getattr(p, "pid", None),
            serial_number=getattr(p, "serial_number", None),
            location=getattr(p, "location", None),
            manufacturer=getattr(p, "manufacturer", None),
            product=getattr(p, "product", None),
        )
        if not info.device:
            continue
        if vid is not None and info.vid != vid:
            continue
        if pids is not None and info.pid not in tuple(pids):
            continue
        ports.append(info)
    ports.sort(key=lambda x: x.device)
    return ports


class PortSelectionError(RuntimeError):
    """No single port could be resolved (none matched, or several did with no serial
    to disambiguate). Carries the candidates for a useful message."""

    def __init__(self, msg: str, candidates: Sequence[PortInfo]):
        super().__init__(msg)
        self.candidates = list(candidates)


def select_port(
    serial: Optional[str] = None,
    *,
    comports: Optional[Callable[[], Iterable]] = None,
    vid: Optional[int] = ESPRESSIF_VID,
    pids: Optional[Sequence[int]] = None,
    fallback: Optional[str] = None,
) -> PortInfo:
    """Resolve exactly one port.

    - If `serial` is given, keep only the port whose USB serial matches it
      (tolerant of MAC punctuation) — this is how the right board is chosen when
      several C6s are attached (match the reserved unit's HITL_ADAPTER_SERIAL).
    - With no serial: return the sole match, or raise if it's ambiguous.
    - `fallback` (e.g. the catalog's last-known HITL_ESP_PORT) is used ONLY when
      enumeration finds nothing AND the fallback path currently exists — a sanity
      net, never a substitute for discovery. Raises PortSelectionError otherwise.
    """
    ports = list_esp_ports(comports, vid=vid, pids=pids)
    if serial:
        matched = [p for p in ports if _matches_serial(p, serial)]
        if len(matched) == 1:
            return matched[0]
        if len(matched) > 1:
            raise PortSelectionError(
                f"{len(matched)} ports match serial {serial!r}: "
                + ", ".join(p.device for p in matched),
                matched,
            )
        # No serial match — fall through to fallback/error (do NOT silently grab a
        # different board).
        if fallback and os.path.exists(fallback):
            return PortInfo(device=fallback, serial_number=serial)
        raise PortSelectionError(
            f"no {_vidpid(vid, pids)} port matches serial {serial!r} "
            f"(saw: {', '.join(p.device for p in ports) or 'none'})",
            ports,
        )
    if len(ports) == 1:
        return ports[0]
    if len(ports) == 0:
        if fallback and os.path.exists(fallback):
            return PortInfo(device=fallback)
        raise PortSelectionError(f"no {_vidpid(vid, pids)} serial port found", ports)
    raise PortSelectionError(
        f"{len(ports)} {_vidpid(vid, pids)} ports found "
        f"({', '.join(p.device for p in ports)}); pass --serial to pick one",
        ports,
    )


def _vidpid(vid: Optional[int], pids: Optional[Sequence[int]]) -> str:
    v = "any-VID" if vid is None else f"VID 0x{vid:04x}"
    if pids:
        v += " PID " + "/".join(f"0x{p:04x}" for p in pids)
    return v


def _parse_hex(s: str) -> int:
    return int(s, 16) if s.lower().startswith("0x") else int(s, 16)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--vid",
        default=f"0x{ESPRESSIF_VID:04x}",
        help="USB vendor id to match (hex; default Espressif 0x303a). 'any' matches all.",
    )
    ap.add_argument(
        "--pid",
        action="append",
        default=None,
        help="USB product id(s) to match (hex; repeatable). Default: any Espressif function.",
    )
    ap.add_argument(
        "--serial",
        default=os.environ.get("HITL_ESP_SERIAL") or os.environ.get("HITL_ADAPTER_SERIAL"),
        help="USB serial / adapter id of the specific board (default $HITL_ESP_SERIAL / "
        "$HITL_ADAPTER_SERIAL). MAC punctuation is ignored when matching.",
    )
    ap.add_argument(
        "--fallback",
        default=os.environ.get("HITL_ESP_PORT"),
        help="last-known device path, used only if enumeration finds nothing AND it exists "
        "(default $HITL_ESP_PORT). A sanity net, not a replacement for discovery.",
    )
    ap.add_argument(
        "--json", action="store_true", help="print all candidates as JSON (no selection)"
    )
    args = ap.parse_args(argv)

    vid = None if str(args.vid).lower() == "any" else _parse_hex(args.vid)
    pids = [_parse_hex(p) for p in args.pid] if args.pid else None

    if args.json:
        ports = list_esp_ports(vid=vid, pids=pids)
        json.dump([p.as_dict() for p in ports], sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    try:
        port = select_port(args.serial, vid=vid, pids=pids, fallback=args.fallback)
    except PortSelectionError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(port.device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
