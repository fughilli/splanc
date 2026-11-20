"""Watch a BLE board's advertised name — runs *inside* the rig container.

    python3 ble_name_watch.py --address AA:BB:.. --want "new name" [--timeout 20]

Active-scans (BlueZ via bleak) for the board at --address and records every name it
reports, with the time since the scan started, until a sighting carries the --want
name (and still advertises the Improv service) or --timeout passes. Prints one JSON
line on stdout: {ok, seen_s, names: [[t, name, improv, wall], ...], startup_s,
scan_start_wall, lock_wait_s, error}: `t`/`seen_s` count from the scan start, `wall` is
the container's time.time() — the same clock that stamps the reservation's serial
capture, so a sighting lines up with the firmware's own "[ble] renamed" line.

The name rides in the board's scan response, so this is the name a phone's Bluetooth
list / the app's picker shows. BlueZ updates a known device's Name only from a
COMPLETE local name (a Shortened one never replaces it), which is why a >29-byte name
can show here as the previous name; --prefix accepts a name that starts with --want.
Holds the rig's BLE-adapter lock (hitl_improv._adapter_lock) for the scan, like the
provisioner, so it never collides with another container's scan or connect.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time

_PROC_T0 = time.monotonic()  # before bleak: startup_s covers its import + the BlueZ setup

os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

from bleak import BleakScanner  # noqa: E402 — after the D-Bus env is set
from hitl_improv import SVC, _adapter_kwargs, _adapter_lock  # noqa: E402


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


async def watch(address: str, want: str, timeout: float, prefix: bool) -> dict:
    names: list[list] = []
    done = asyncio.Event()
    hit: dict = {}
    t0 = time.monotonic()  # reset once the scan is running

    def match(nm: str) -> bool:
        return nm.startswith(want) if prefix else nm == want

    def on_adv(dev, adv) -> None:
        if dev.address.lower() != address.lower():
            return
        nm = adv.local_name or dev.name or ""
        improv = SVC.lower() in [u.lower() for u in (adv.service_uuids or [])]
        t = round(time.monotonic() - t0, 2)
        if not names or names[-1][1] != nm or names[-1][2] != improv:
            names.append([t, nm, improv, round(time.time(), 3)])
            log(f"[watch] {t:6.2f}s name={nm!r} improv={improv}")
        if nm and match(nm) and improv and "t" not in hit:
            hit["t"] = t
            done.set()

    scanner = BleakScanner(detection_callback=on_adv, **_adapter_kwargs())
    await scanner.start()
    t0 = time.monotonic()
    startup_s = round(t0 - _PROC_T0, 2)
    scan_wall = round(time.time(), 3)
    try:
        await asyncio.wait_for(done.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass
    finally:
        await scanner.stop()
    out = {"names": names, "startup_s": startup_s, "scan_start_wall": scan_wall}
    if "t" in hit:
        return {"ok": True, "seen_s": hit["t"], **out}
    return {"ok": False, "seen_s": None, **out, "error": f"no {want!r} in {timeout:g}s"}


def main() -> int:
    ap = argparse.ArgumentParser(prog="ble_name_watch")
    ap.add_argument("--address", required=True)
    ap.add_argument("--want", required=True)
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--prefix", action="store_true", help="accept a name starting with --want")
    ap.add_argument("--b64", action="store_true", help="--want is base64 (UTF-8)")
    a = ap.parse_args()
    want = base64.b64decode(a.want).decode("utf-8") if a.b64 else a.want
    try:
        t_lock = time.monotonic()
        with _adapter_lock():
            lock_wait = round(time.monotonic() - t_lock, 2)
            result = asyncio.run(watch(a.address, want, a.timeout, a.prefix))
        result["lock_wait_s"] = lock_wait
    except Exception as e:  # noqa: BLE001 — report to the harness as a failed result
        result = {"ok": False, "seen_s": None, "names": [], "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
