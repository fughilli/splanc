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


def _run_provisioner(res, ssid: str, password: str, timeout: float) -> str:
    """One ImprovBLE provisioning attempt; returns the redirect URL or raises."""
    # Run with the container's python3 (has bleak); PYTHONPATH lets the shipped
    # hitl_improv import the shipped improv codec.
    cmd = (
        f"PYTHONPATH=/tmp python3 /tmp/hitl_improv.py provision "
        f"--ssid {json.dumps(ssid)} --pass {json.dumps(password)} --timeout {timeout:g}"
    )
    proc = res.ssh(cmd, capture=True, timeout=timeout + 60)
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


def provision_dut(res, ssid: str, password: str, timeout: float, attempts: int = 3) -> str:
    """Provision the DUT onto WiFi over ImprovBLE; return its redirect URL.

    The WiFi association is intermittently flaky on real hardware (RF + the
    single-core C6's WiFi/BLE coexistence): the board occasionally fails to join
    within the window. On a join-timeout the firmware clears the just-tried
    credentials and returns to AUTHORIZED, so re-sending them is a clean retry —
    bounded, so a genuinely bad credential / unreachable AP still fails.
    """
    print("[improv] shipping provisioner + provisioning DUT over BLE…", flush=True)
    res.scp_to([_PROVISIONER, _CODEC], "/tmp/")
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
            url = _run_provisioner(res, ssid, password, timeout)
            print(f"[improv] OK — DUT joined WiFi, redirect={url}", flush=True)
            return url
        except HarnessError as e:
            last = e
            print(f"[improv] provision attempt {attempt}/{attempts} failed: {e}", flush=True)
    assert last is not None
    raise last
