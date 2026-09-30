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
import contextlib
import fcntl
import json
import os
import sys
import time

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


def _resolve_usb_hci() -> str:
    """The first Bluetooth controller on the USB bus (a dongle), or "" if none.

    Reads /sys/class/bluetooth/hci*/device (mounted read-only in the reservation
    container): a USB controller's device path resolves under .../usbN/..., while a
    Pi's onboard controller sits on a serial/platform path. Mirrors the old daemon's
    runner.resolveUSBHCI, done here now that the generalized daemon no longer selects
    the BLE central for us.
    """
    root = "/sys/class/bluetooth"
    try:
        names = sorted(n for n in os.listdir(root) if n.startswith("hci"))
    except OSError:
        return ""
    for n in names:
        try:
            dev = os.path.realpath(os.path.join(root, n, "device"))
        except OSError:
            continue
        if "/usb" in dev:
            return n
    return ""


def _adapter_kwargs() -> dict:
    """bleak `adapter=` kwargs: an explicit $HITL_BLE_ADAPTER wins; otherwise (or for
    the sentinel "usb") prefer a USB dongle over the flaky onboard controller.

    The Pi 5 Cypress onboard controller flakes on connect (0x3E), which a USB BT
    dongle fixes — so route BLE at the dongle when one is present, falling back to
    the system default (onboard) when there isn't (e.g. a Pi 3 rig). The generalized
    daemon no longer injects HITL_BLE_ADAPTER (the old daemon resolved this host-side
    via --ble-adapter usb); we resolve it here from sysfs in the container instead.
    """
    adp = os.environ.get("HITL_BLE_ADAPTER", "").strip()
    if not adp or adp == "usb":
        adp = _resolve_usb_hci()  # "" -> bleak's system default (onboard)
    return {"adapter": adp} if adp else {}


async def _reset_adapter() -> bool:
    """Power-cycle the BLE adapter over BlueZ dbus to clear a wedged controller.

    A stale BLE connection handle can leave LE scanning silently returning nothing
    (kernel logs "ACL packet for unknown connection handle N") — seen fleet-wide as a
    persistent "no Improv device found in scan" that left the whole netstack HITL lane
    red until a manual `systemctl restart bluetooth`. The reservation container is
    unprivileged (no CAP_NET_ADMIN for `hciconfig`/hci down-up), but it drives the host
    bluetoothd over dbus, and toggling Adapter1.Powered off->on makes BlueZ issue an HCI
    reset + re-init on the controller, which clears the stale handles.

    Best-effort: returns True if the off->on cycle completed, False on any error (the
    caller then reports the empty scan exactly as before). Uses a hand-built
    Properties.Set message (no Introspect call) to stay inside the container's org.bluez
    dbus policy (Properties + ObjectManager only — see nix/hitl-app.nix).
    """
    adp = _adapter_kwargs().get("adapter") or "hci0"
    path = f"/org/bluez/{adp}"
    try:
        from dbus_fast import BusType, Message, MessageType, Variant
        from dbus_fast.aio import MessageBus
    except ImportError:  # older bleak shipped dbus_next under a different name
        try:
            from dbus_next import BusType, Message, MessageType, Variant
            from dbus_next.aio import MessageBus
        except ImportError as e:
            log(f"[improv] adapter reset unavailable (no dbus lib: {e})")
            return False
    bus = None
    try:
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        for val in (False, True):
            reply = await bus.call(
                Message(
                    destination="org.bluez",
                    path=path,
                    interface="org.freedesktop.DBus.Properties",
                    member="Set",
                    signature="ssv",
                    body=["org.bluez.Adapter1", "Powered", Variant("b", val)],
                )
            )
            if reply.message_type != MessageType.METHOD_RETURN:
                log(f"[improv] adapter {path} Powered={val} rejected: {reply.body}")
                return False
            await asyncio.sleep(1.5)
        return True
    except Exception as e:  # noqa: BLE001 — recovery is best-effort; never mask the scan result
        log(f"[improv] adapter power-cycle failed ({type(e).__name__}: {e})")
        return False
    finally:
        if bus is not None:
            try:
                bus.disconnect()
            except Exception:  # noqa: BLE001
                pass


def looks_like_player(name: str) -> bool:
    n = (name or "").lower()
    return "led widget" in n or "ledmapper" in n or "widget" in n


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# Per-rig BLE-adapter mutex. A rig has ONE Bluetooth controller shared by every
# reservation container over the host system D-Bus (bluetoothd). BLE provisioning
# is adapter-exclusive end to end: discovery (Start/StopDiscovery, refcounted
# per-sender by BlueZ) and connection setup collide when two containers run at
# once, AND — more subtly — a second container's discovery/link drops the Improv
# join-confirmation notification off the first container's still-open link at the
# moment its DUT brings up Wi-Fi (radio coex at its weakest), so the DUT joins yet
# its provisioner times out. So the whole provision is held under this flock. The
# lock dir is a host-shared bind mount (hitl-app.nix --mount /run/hitl-provision),
# making the flock a host-wide mutex across the rig's containers; only provisioning
# is serialized, while the test's network traffic to already-joined DUTs stays
# concurrent. Best-effort: no lock dir (rig not yet redeployed) ⇒ unserialized.
_ADAPTER_LOCK_PATH = os.environ.get(
    "HITL_BLE_ADAPTER_LOCK", "/run/hitl/provision-lock/adapter.lock"
)


@contextlib.contextmanager
def _adapter_lock():
    """Hold the per-rig BLE-adapter mutex for the enclosed provisioning."""
    d = os.path.dirname(_ADAPTER_LOCK_PATH)
    fd = None
    if os.path.isdir(d):
        try:
            fd = os.open(_ADAPTER_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o666)
        except OSError as e:
            log(f"[improv] adapter lock unavailable ({e}); proceeding unserialized")
    if fd is None:
        yield
        return
    t0 = time.monotonic()
    log("[improv] acquiring rig BLE-adapter lock (serialize provisioning)…")
    fcntl.flock(fd, fcntl.LOCK_EX)
    log(f"[improv] adapter lock held (waited {time.monotonic() - t0:.1f}s)")
    try:
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


# Per-rig AP-EXCLUSIVE bandwidth mutex. Every DUT on a rig associates to ONE AP on ONE
# 2.4 GHz radio/channel (the C6 is 2.4-only; rig-1/rig-2 host the AP on the onboard
# brcmfmac FullMAC radio, which has NO airtime-fairness lever). Under concurrent
# multi-DUT load a sibling DUT's traffic starves the channel, breaking cross-DUT
# isolation. The DHCP-join at the tail of provisioning is one casualty: the DUT
# completes the WPA 4-way then sends DHCP DISCOVERs, but the AP's DHCP OFFER goes out
# as a broadcast/group frame that is never 802.11-ACKed, so it is dropped FIRST under a
# sibling's airtime and the join times out. This lock lets a DUT claim the AP's airtime
# exclusively across ONLY that window; everything else stays concurrent.
#
# LOCK ORDER (deadlock-freedom): the global order is BLE-adapter BEFORE AP-exclusive.
# Provisioning takes the adapter lock for the whole provision (above) and nests THIS
# lock inside it around just the join window; the bandwidth benches take the AP lock
# alone, AFTER provisioning has released both. Nothing ever takes the adapter lock
# while holding the AP lock, so the two can never deadlock. Same best-effort contract
# as the adapter lock: no lock dir (rig not yet redeployed) ⇒ unserialized. flock
# auto-releases on fd-close/process-exit, so a crashed/killed provisioner can't strand
# it. The lock dir is a host-shared bind mount (hitl-app.nix), making the flock a
# host-wide mutex across the rig's reservation containers.
_AP_LOCK_PATH = os.environ.get("HITL_AP_LOCK", "/run/hitl/ap-lock/ap.lock")


@contextlib.asynccontextmanager
async def _ap_lock(reason: str = ""):
    """Hold the per-rig AP-exclusive bandwidth mutex for the enclosed join window.

    Acquired in a thread executor so the asyncio event loop keeps servicing the
    already-open BLE link (BlueZ keepalives) while we wait for a sibling test to
    release the airtime — otherwise a long wait could idle-drop the link. Best-effort:
    no lock dir ⇒ yields immediately, unserialized.
    """
    d = os.path.dirname(_AP_LOCK_PATH)
    fd = None
    if os.path.isdir(d):
        try:
            fd = os.open(_AP_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o666)
        except OSError as e:
            log(f"[improv] AP lock unavailable ({e}); proceeding unserialized")
    if fd is None:
        yield
        return
    t0 = time.monotonic()
    log(f"[improv] acquiring rig AP-exclusive lock ({reason})…")
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: fcntl.flock(fd, fcntl.LOCK_EX))
    log(f"[improv] AP lock held (waited {time.monotonic() - t0:.1f}s)")
    try:
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


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
    device = None
    try:
        # Hold the per-rig BLE-adapter lock across the ENTIRE provisioning, not just
        # discover+connect. The Improv join-confirmation (the RPC_RESULT carrying the
        # DUT's redirect URL + the PROVISIONED state) is a load-bearing check — it
        # proves the firmware's ImprovBLE path actually reported the join, so the test
        # must keep waiting for it, not infer the join out-of-band. But that reply
        # arrives over the still-open BLE link at the exact moment the C6 brings up
        # Wi-Fi (radio coex at its weakest), and a SECOND container discovering /
        # holding a link on the shared controller reliably drops it — the DUT joins
        # (DHCP lease appears) yet its notification never lands, so the provisioner
        # times out. Only ONE genuinely-exclusive thing is happening here (BLE
        # provisioning on the one adapter), so serialize the whole of it per rig; the
        # AP stays up throughout and every OTHER container step — the test's WSS/HTTP
        # traffic to already-joined DUTs over the network — still runs concurrently.
        # Best-effort: no lock dir (rig not redeployed) ⇒ unserialized, as before.
        with _adapter_lock():
            dev, nm = await find(address, name_filter, scan_seconds)
            if dev is None:
                # An empty scan can mean the controller wedged (a stale connection
                # handle blocks LE scanning). We hold the rig's adapter lock here, so
                # it's safe to reset: power-cycle the adapter and re-scan ONCE before
                # giving up — self-heals the wedge that otherwise reds the whole netstack
                # lane until a manual `systemctl restart bluetooth`.
                if await _reset_adapter():
                    log("[improv] scan empty — power-cycled the BLE adapter, re-scanning…")
                    dev, nm = await find(address, name_filter, scan_seconds)
                if dev is None:
                    return {"ok": False, "error": "no Improv device found in scan"}
            device = {"name": nm, "address": dev.address}
            log(f"[improv] provisioning {nm} ({dev.address}) ssid={ssid!r}")
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
            # Hold the per-rig AP-exclusive lock across ONLY the DHCP-join window: the
            # RPC write triggers the DUT to bring up Wi-Fi and DHCP-DISCOVER, and its
            # AP's DHCP OFFER — a broadcast/group frame that is never 802.11-ACKed — is
            # the frame a sibling DUT's airtime starves first, which is what makes the
            # join time out under concurrent load. So claim the channel exclusively from
            # the write through the join confirmation, then release immediately. Nested
            # INSIDE the adapter lock (order adapter→AP; see _ap_lock). Best-effort:
            # no lock dir (rig not yet redeployed) ⇒ unserialized, exactly as today.
            async with _ap_lock("DHCP-join window"):
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
