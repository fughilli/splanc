"""ImprovBLE provisioning driver — runs *inside* the rig container.

The e2e harness ships this file (plus improv.py) into the reservation and runs
it with the container's python3, which has bleak and the D-Bus env pointing at
the host bluetoothd (pi/hitl/nix/container.nix). Doing it this way — rather than
baking a `hitl-improv` tool into the image — means the test never depends on the
rig image being redeployed in lockstep with the harness: the transport lives
here, the wire codec is the shared, unit-pinned improv.py, and only bleak needs
to be present in the container (it has been since the MVP).

    python3 hitl_improv.py provision --ssid S [--pass P] [--timeout N]

Scans for the Improv service, writes the WiFi-settings RPC, waits for the board
to join, and prints one JSON line — {ok, urls, error, device} — on stdout (logs
go to stderr) so the harness can parse the last line. Mirrors the flow in
tools/ble_onboard_server.py's provision().
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

# The container has no /var/run/dbus; point dbus-fast at the mounted host socket
# (matches container.nix's env for the other BLE tools) before importing bleak.
os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

from bleak import BleakClient, BleakScanner  # noqa: E402 — after the D-Bus env is set
from bleak.exc import BleakError  # noqa: E402
from improv import (  # noqa: E402
    CH_ERROR,
    CH_RPC_CMD,
    CH_RPC_RESULT,
    CH_STATE,
    STATE_PROVISIONED,
    SVC,
    build_wifi_rpc,
    error_name,
    parse_result,
)

# Errors that mean "the BLE link/GATT didn't come up" — as opposed to a clean
# result or the join wait timing out. asyncio.TimeoutError from BleakClient's
# own connect has an EMPTY message, which is exactly the useless "TimeoutError: "
# the harness used to surface; we catch it here and retry / report it precisely.
_TRANSPORT_ERRORS = (BleakError, asyncio.TimeoutError, OSError, EOFError)


def _adapter_kwargs() -> dict:
    """bleak `adapter=` kwargs from $HITL_BLE_ADAPTER, else empty (system default).

    The daemon sets HITL_BLE_ADAPTER (e.g. "hci1") on a rig whose BLE central runs
    on a USB dongle rather than the flaky onboard controller (see
    runner.PodmanConfig.BLEAdapter). bleak's BlueZ backend defaults to "hci0", so
    without this every scan/connect would hit the onboard controller regardless.
    """
    adp = os.environ.get("HITL_BLE_ADAPTER", "").strip()
    return {"adapter": adp} if adp else {}


def looks_like_player(name: str) -> bool:
    n = (name or "").lower()
    return "led widget" in n or "ledmapper" in n or "widget" in n


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


async def find(address: str | None, name_filter: str, scan_seconds: float, name_wait: float = 8.0):
    """Scan for the Improv DUT, preferring a fully-advertised (named) device.

    The firmware puts the device NAME in the BLE scan response, while only the
    flags + 128-bit Improv service UUID ride in the primary advertising packet
    (firmware/player_app/improv_ble.cpp). So a device we match by service UUID
    but whose `name` is still empty is one we caught mid-advertise — its scan
    response hasn't landed yet, i.e. we pounced before it settled. Re-scan for up
    to `name_wait` seconds to let the name resolve before falling back to a
    nameless hit, so we connect to a board that is actually up and advertising.

    NOTE (FUG-94): this name-wait gate is defence-in-depth, NOT the deflaker. The
    connect flake is independent of whether the name had resolved (it fails at the
    same ~50% rate on a fully-named, settled advertisement), and in practice the
    scan-response name resolves within ~200 ms so a name-less match is rare. The
    `_connect` rapid-retry loop is what actually deflaked provisioning. Keep this
    gate anyway — it's cheap and still avoids pouncing on a half-advertised board.
    """
    waited = 0.0
    nameless = None
    while True:
        found = await BleakScanner.discover(
            timeout=scan_seconds, return_adv=True, **_adapter_kwargs()
        )
        for addr, (dev, adv) in found.items():
            nm = dev.name or ""
            if address:
                if addr.lower() != address.lower():
                    continue
            else:
                if name_filter and name_filter.lower() not in nm.lower():
                    continue
                is_improv = SVC.lower() in [u.lower() for u in (adv.service_uuids or [])]
                if not (is_improv or looks_like_player(nm)):
                    continue
            if nm:
                return dev, nm
            nameless = (dev, nm)  # remember, but keep looking for a named sighting
        waited += scan_seconds
        if nameless is None or waited >= name_wait:
            break
        log("[improv] device seen without a name yet (scan-response race); re-scanning…")
    return nameless if nameless else (None, None)


async def _connect(dev, tries: int, connect_timeout: float, rescan_timeout: float = 8.0):
    """Open a BLE link to the DUT, retrying transient connect failures.

    The FIRST connect to a freshly-(re)booted C6 fails ~half the time with a
    message-less connect timeout (bleak gives up after `connect_timeout` and the
    link never reaches connected=True). This is a TRANSIENT, PER-ATTEMPT BLE
    connection-establishment failure — NOT a WiFi/BLE-coexistence effect. Measured
    on the erase-fs first-provision boot (FUG-94), where there is NO WiFi
    association to contend with (`WiFi.begin` is gated off with no stored creds —
    only an idle soft-AP beacons): the failure rate is ~50% AND is independent of
    how long the board has been advertising — a fully-settled, name-resolved board
    at ~8 s post-advertising still fails at the same rate. So retrying RAPIDLY
    within one boot rides it out, while reboot-gated single tries do not (a reboot
    just re-rolls the same per-attempt coin; observed originally: 3 reboot-gated
    retries all lost). THIS RETRY LOOP is the load-bearing half of the FUG-61 fix —
    find()'s name-wait gate is cheap defence-in-depth, not the deflaker, so don't
    "simplify" this loop away. Returns a connected BleakClient or raises the last
    transport error after `tries` attempts. The link-level mechanism (peripheral
    CONNECT_IND unanswered vs a central/BlueZ stall on the shared host adapter) is
    unconfirmed pending HCI capture — see the FUG-94 entry in pi/hitl/WORKLOG.md.

    Each retry RE-DISCOVERS the device by address: after a failed connect BlueZ
    drops the device object from its cache, so reusing the same handle raises
    "device '…' not found". Re-scanning gets a fresh handle and confirms the
    board is still advertising before we try again.
    """
    address = dev.address
    last: Exception | None = None
    for i in range(1, tries + 1):
        if dev is None:
            dev = await BleakScanner.find_device_by_address(
                address, timeout=rescan_timeout, **_adapter_kwargs()
            )
            if dev is None:
                last = BleakError(f"device {address} not advertising on rescan")
                log(f"[improv] connect {i}/{tries}: {last}")
                if i < tries:
                    await asyncio.sleep(1.0)
                continue
        client = BleakClient(dev, timeout=connect_timeout, **_adapter_kwargs())
        try:
            await client.connect()
            if client.is_connected:
                return client
            raise BleakError("connect returned but link is not up")
        except _TRANSPORT_ERRORS as e:
            last = e
            msg = str(e) or "(no message — likely a connect timeout)"
            log(f"[improv] connect {i}/{tries} failed: {type(e).__name__}: {msg}")
            try:
                await client.disconnect()  # tear down any half-open link before retrying
            except Exception:
                pass
            dev = None  # BlueZ has dropped it; force a fresh rediscover next try
            if i < tries:
                await asyncio.sleep(1.5)
    raise last if last is not None else BleakError("connect failed")


async def provision(
    ssid,
    password,
    address,
    name_filter,
    scan_seconds,
    timeout,
    connect_tries: int = 5,
    connect_timeout: float = 12.0,
):
    dev, nm = await find(address, name_filter, scan_seconds)
    if dev is None:
        return {"ok": False, "error": "no Improv device found in scan"}
    device = {"name": nm, "address": dev.address}
    log(f"[improv] provisioning {nm} ({dev.address}) ssid={ssid!r}")
    done = asyncio.Event()
    state = {"urls": None, "error": None, "state": None}

    def on_result(_sender, data):
        log(f"[improv] <- RPC_RESULT {bytes(data).hex()}")
        state["urls"] = parse_result(bytes(data))
        done.set()

    def on_error(_sender, data):
        code = data[0] if data else 0
        log(f"[improv] <- ERROR {bytes(data).hex()} (code={code})")
        if code != 0:
            state["error"] = error_name(code)
            done.set()

    def on_state(_sender, data):
        state["state"] = data[0] if data else None
        log(f"[improv] <- STATE {bytes(data).hex()}")
        # PROVISIONED is the spec success signal; the firmware sends it (right
        # after the RPC result) and then immediately drops BLE to go STA-only, so
        # completing here — not only on RPC_RESULT — is what makes the join
        # deterministic instead of racing the disconnect.
        if state["state"] == STATE_PROVISIONED:
            done.set()

    client = None
    try:
        client = await _connect(dev, connect_tries, connect_timeout)
        log(f"[improv] connected={client.is_connected}")
        # Subscribe BEFORE writing so the reply is never missed.
        await client.start_notify(CH_RPC_RESULT, on_result)
        await client.start_notify(CH_ERROR, on_error)
        try:
            await client.start_notify(CH_STATE, on_state)
            log("[improv] subscribed STATE/ERROR/RESULT")
        except Exception as e:
            log(f"[improv] STATE subscribe failed: {type(e).__name__}: {e}")
        rpc = build_wifi_rpc(ssid, password)
        log(f"[improv] -> RPC_CMD {rpc.hex()}")
        await client.write_gatt_char(CH_RPC_CMD, rpc, response=True)
        log("[improv] write ack; awaiting join…")
        try:
            await asyncio.wait_for(done.wait(), timeout)
        except asyncio.TimeoutError:
            if state["state"] != STATE_PROVISIONED:
                return {
                    "ok": False,
                    "error": "timed out waiting for the player to join",
                    "device": device,
                }
    except _TRANSPORT_ERRORS as e:
        # The board tears BLE down the instant it joins (soft-AP off, STA-only),
        # so a disconnect *after* we've seen PROVISIONED (or the redirect URL) is
        # the normal end of a successful provision — not a failure. Anything else
        # (notably a connect/GATT timeout, which arrives here as a message-less
        # TimeoutError) is a real transport error; report it precisely rather
        # than as a bare "TimeoutError: ".
        if state["state"] != STATE_PROVISIONED and state["urls"] is None:
            msg = str(e) or "(no message — likely a connect/GATT timeout)"
            return {
                "ok": False,
                "error": f"BLE transport failed: {type(e).__name__}: {msg}",
                "device": device,
            }
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
    if state["error"]:
        return {"ok": False, "error": state["error"], "device": device}
    return {"ok": True, "urls": state["urls"], "state": state["state"], "device": device}


def main() -> int:
    ap = argparse.ArgumentParser(prog="hitl_improv")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("provision")
    pr.add_argument("--ssid", required=True)
    pr.add_argument("--pass", dest="password", default="")
    pr.add_argument("--address", help="target this BLE address (else scan for the Improv service)")
    pr.add_argument("--name", default="", help="only match devices whose name contains this")
    pr.add_argument("--scan-seconds", type=float, default=8.0)
    pr.add_argument("--timeout", type=float, default=60.0)
    pr.add_argument(
        "--connect-tries", type=int, default=5, help="rapid BLE connect retries within one attempt"
    )
    pr.add_argument("--connect-timeout", type=float, default=12.0, help="per-connect timeout (s)")
    a = ap.parse_args()
    try:
        result = asyncio.run(
            provision(
                a.ssid,
                a.password,
                a.address,
                a.name,
                a.scan_seconds,
                a.timeout,
                a.connect_tries,
                a.connect_timeout,
            )
        )
    except Exception as e:  # noqa: BLE001 — report to the harness as a failed result
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
