"""Shared HITL provisioning helpers: get a freshly-flashed DUT onto WiFi over
ImprovBLE and work out its player-WebSocket address.

Extracted from hitl_e2e.py so the on-hardware FX benchmark (fx_bench.py) reaches
the board the SAME way the e2e does — one implementation of the fragile
provision/retry/reset dance, not two that can drift. Both the e2e driver and the
fx_bench harness import from here.

The BLE provisioner (hitl_improv.py) + its wire codec (improv.py) run in the
reservation's container (which has bleak and the host bluetoothd); we ship them
per-reservation rather than baking them into the image so a run doesn't depend on
the rig image being redeployed in lockstep. Both live next to this file.
"""

from __future__ import annotations

import json
import os
import re
import sys
from urllib.parse import urlparse


class HarnessError(RuntimeError):
    """A HITL step failed in a way worth reporting with a diagnostic."""


def dut_target(redirect: str, scheme: str) -> tuple[str, int]:
    """Device redirect (http://<ip>/) -> (host, ws_port) for the player socket.

    Mirrors web/src/net/improv.ts wsUrlFromRedirect: the TLS app talks
    wss://<ip>:443/ws; the bench path is the plain ws://<ip>:81/ws socket.
    """
    host = urlparse(redirect).hostname
    if not host:
        raise HarnessError(f"could not parse a host from redirect URL {redirect!r}")
    return host, (443 if scheme == "wss" else 81)


# The provisioner + codec live next to this file (harness srcs -> both e2e and
# fx_bench runfiles), shipped into the reservation and run there.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROVISIONER = os.path.join(_HERE, "hitl_improv.py")
_CODEC = os.path.join(_HERE, "improv.py")


def _run_provisioner(
    res, ssid: str, password: str, timeout: float, address: str | None = None
) -> str:
    """One ImprovBLE provisioning attempt; returns the redirect URL or raises.

    When `address` is set, the scan pins that exact BLE MAC — so a stray Improv
    board in RF range (another rig's DUT, a bench spare) can never be provisioned
    in place of the board we actually flashed. Without it, the scan takes whatever
    named Improv device answers first, which is how a renamed stray got picked.
    """
    # Run with the container's python3 (has bleak); PYTHONPATH lets the shipped
    # hitl_improv import the shipped improv codec.
    cmd = (
        f"PYTHONPATH=/tmp python3 /tmp/hitl_improv.py provision "
        f"--ssid {json.dumps(ssid)} --pass {json.dumps(password)} --timeout {timeout:g}"
    )
    if address:
        cmd += f" --address {address}"
    # The provisioner now retries the BLE connect several times WITHIN one call
    # (hitl_improv._connect — the first connect to a freshly-booted C6 fails ~half
    # the time with a per-attempt connect timeout; see FUG-94), so a single call
    # can spend ~scan + N*connect_timeout + join before it reports. Give the ssh a
    # budget
    # that comfortably covers that worst case rather than the old timeout+60.
    proc = res.ssh(cmd, capture=True, timeout=timeout + 180)
    out = (proc.stdout or "").strip()
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        raise HarnessError(f"provisioner exited {proc.returncode}: {out}")
    try:
        result = json.loads(out.splitlines()[-1])
    except (ValueError, IndexError) as e:
        raise HarnessError(f"provisioner gave no JSON result: {out!r}") from e
    if not result.get("ok"):
        raise HarnessError(f"ImprovBLE provisioning failed: {result.get('error')}")
    urls = result.get("urls") or []
    if not urls:
        raise HarnessError(f"provisioning reported no redirect URL: {result}")
    return urls[0]


# The DUT prints its BLE advertising address on boot, e.g.
#   [ble] advertising "Led Widget CA2BFE" as 8c:fd:49:12:31:72 (Improv service …)
#   [player] identity 8C:FD:49:12:31:72 / "Led Widget CA2BFE" …
_BLE_MAC_RE = re.compile(r"advertising\b.*?\bas\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})")
_IDENTITY_MAC_RE = re.compile(r"identity\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})")


def reserved_board_ble_mac(res, seconds: float = 6.0) -> str | None:
    """Reset the reserved DUT and read its BLE advertising MAC off its OWN serial.

    Because `hitl-monitor` reads the specific USB port of the board this
    reservation holds, the MAC we parse is guaranteed to be the board we flashed
    — not some other Improv device in RF range. The reset also drops it to a
    clean soft-AP first-join state (the reliably-provisionable path). Returns the
    MAC, or None if the boot banner didn't surface one in the window.
    """
    try:
        proc = res.ssh(
            f"hitl-monitor --reset --seconds {seconds:g}", capture=True, timeout=seconds + 40
        )
    except Exception as e:  # noqa: BLE001 — best-effort; fall back to a name scan
        print(f"[improv] could not read board serial for MAC ({e}); scanning by name", flush=True)
        return None
    text = (proc.stdout or "") + (proc.stderr or "")
    m = _BLE_MAC_RE.search(text) or _IDENTITY_MAC_RE.search(text)
    return m.group(1).lower() if m else None


def provision_dut(
    res, ssid: str, password: str, timeout: float, attempts: int = 3, address: str | None = None
) -> str:
    """Provision the DUT onto WiFi over ImprovBLE; return its redirect URL.

    Two distinct flakes are bounded here. (1) The BLE CONNECT itself is
    intermittently unreliable on a freshly-booted C6 — a transient, per-attempt
    connection-establishment failure (NOT WiFi/BLE coexistence: on the erase-fs
    first-provision boot there is no WiFi association at all, only an idle soft-AP;
    measured ~50% first-connect timeouts, independent of advertising-settle time —
    see FUG-94 in WORKLOG.md). That is absorbed by hitl_improv._connect's rapid
    in-attempt retries; the reset+retry loop below is the last-resort backstop.
    (2) The WiFi ASSOCIATION is separately flaky on real RF: the board occasionally
    fails to join within the window. On a join-timeout the firmware clears the
    just-tried credentials and returns to AUTHORIZED, so re-sending them is a clean
    retry — bounded, so a genuinely bad credential / unreachable AP still fails.

    We pin the scan to the reserved board's BLE MAC (read from its own serial)
    so provisioning can never latch onto a stray Improv board in RF range — a
    real failure mode on a multi-rig bench that manifested as flaky wss (we'd
    flash one board and then talk to a different, drifting one). Pass `address`
    to override; None auto-derives it, and a failed read falls back to name scan.
    """
    print("[improv] shipping provisioner + provisioning DUT over BLE…", flush=True)
    res.scp_to([_PROVISIONER, _CODEC], "/tmp/")
    if address is None:
        address = reserved_board_ble_mac(res)
        if address:
            print(f"[improv] pinning provisioning to reserved board {address}", flush=True)
        else:
            print(
                "[improv] WARN: no reserved-board MAC; scanning by name (stray-board risk)",
                flush=True,
            )
    last: HarnessError | None = None
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            # A failed join leaves the WiFi stack wedged (re-sending creds on the
            # same boot fares worse — the retry often can't even re-advertise
            # PROVISIONING). A hard reset returns the board to a clean soft-AP
            # first-join state (creds were cleared on the join-timeout), which is
            # the reliably-provisionable path. The 4s read lets the boot settle.
            print(f"[improv] resetting DUT for a clean retry {attempt}/{attempts}…", flush=True)
            res.ssh("hitl-monitor --reset --seconds 4", capture=True, timeout=30)
        try:
            url = _run_provisioner(res, ssid, password, timeout, address=address)
            print(f"[improv] OK — DUT joined WiFi, redirect={url}", flush=True)
            return url
        except HarnessError as e:
            last = e
            print(f"[improv] provision attempt {attempt}/{attempts} failed: {e}", flush=True)
    assert last is not None
    raise last
