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
import time
from urllib.parse import urlparse


class HarnessError(RuntimeError):
    """A HITL step failed in a way worth reporting with a diagnostic."""


# The firmware prints this once it's running the app (not sitting in the ROM
# USB downloader); the ROM prints one of the download-mode markers instead when
# a reset lands in `wait usb download`. See pi/hitl/AGENTS.md "A typical E2E test".
BOOT_MARKER = "SPI_FAST_FLASH_BOOT"
_DOWNLOAD_MODE_MARKERS = ("wait usb download", "USB_BOOT", "DOWNLOAD(USB")
BOOT_ATTEMPTS = 3


def in_download_mode(log: str) -> bool:
    """True if the DUT reset into the ROM USB downloader instead of the app."""
    return any(marker in log for marker in _DOWNLOAD_MODE_MARKERS)


def ensure_booted(res, log: str, monitor_seconds: float, attempts: int = BOOT_ATTEMPTS) -> str:
    """Ensure the freshly-flashed DUT booted the app; retry the *boot* if not.

    `log` is the serial captured by the initial flash+monitor. A C6 intermittently
    latches USB download mode after a flash: esptool's post-flash reset races the
    GPIO9/BOOT strap release over the native USB-Serial-JTAG, so the ROM samples
    the strap low and sits in `wait usb download` (rst:…, boot:0x0 USB_BOOT)
    instead of running the app — and SPI_FAST_FLASH_BOOT never prints. The flash
    write itself is fine; only the reset latched the wrong boot mode, and a clean
    re-reset (which re-samples the now-released strap) recovers it. So retry the
    boot — a bare reset, NOT a re-flash: the firmware is already written, and a
    re-flash would needlessly re-erase NVS/littlefs and cost ~30s. `hitl-monitor
    --reset` is the same already-deployed native-USB reset used between provision
    attempts. Returns the serial log that shows the successful boot; raises
    HarnessError once `attempts` boot observations are spent. A *persistent*
    download-mode (every reset lands there) is instead a real stuck-strap hardware
    fault (a held BOOT button), surfaced with a distinct human-actionable message.
    """
    for attempt in range(1, attempts + 1):
        if BOOT_MARKER in log:
            return log
        if attempt == attempts:
            if in_download_mode(log):
                raise HarnessError(
                    f"board stuck in USB download mode after {attempts} resets "
                    f"(no {BOOT_MARKER!r} in serial) — the GPIO9/BOOT strap is "
                    "likely held/stuck; a human must release BOOT and tap RESET"
                )
            raise HarnessError(f"board did not boot from flash (no {BOOT_MARKER!r} in serial)")
        why = "USB download mode" if in_download_mode(log) else "no boot banner"
        print(
            f"[flash] did not boot ({why}); re-resetting the DUT "
            f"(attempt {attempt + 1}/{attempts})…",
            flush=True,
        )
        proc = res.ssh(
            f"hitl-monitor --reset --seconds {monitor_seconds:g}",
            capture=True,
            timeout=monitor_seconds + 60,
        )
        log = (proc.stdout or "") + (proc.stderr or "")
        sys.stdout.write(log)
        if proc.returncode != 0:
            raise HarnessError(f"hitl-monitor exited {proc.returncode}")
    return log  # unreachable: the loop returns on boot or raises when spent


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
    # budget that comfortably covers that worst case rather than the old timeout+60.
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


# Cap the inter-attempt improv backoff: exponential so a transient RF/BLE hiccup
# (GATT `unable_to_connect`, a stalled advertising rebind after a reboot) gets more
# settle time each retry, but bounded so a genuinely-dead board still fails fast.
_PROVISION_BACKOFF_CAP_S = 8.0


def provision_backoff(attempt: int) -> float:
    """Seconds to wait before provisioning `attempt` (2, 3, …), FUG-137. Attempt 1
    never waits (it's the first try); later attempts back off 2, 4, 8, … capped at
    `_PROVISION_BACKOFF_CAP_S`, so BLE/RF (and a rebooted DUT's advertising) settle
    before the reset+retry rather than hammering a board that just NAK'd a connect."""
    if attempt <= 1:
        return 0.0
    return min(2.0 ** (attempt - 1), _PROVISION_BACKOFF_CAP_S)


def provision_dut(
    res,
    ssid: str,
    password: str,
    timeout: float,
    attempts: int = 3,
    address: str | None = None,
    sleep=time.sleep,
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
            # Back off first so a transient BLE/RF failure (GATT unable_to_connect,
            # advertising not yet rebound after a reboot) gets settle time that
            # grows each retry — then reset. A failed join also leaves the WiFi
            # stack wedged (re-sending creds on the same boot fares worse — the
            # retry often can't even re-advertise PROVISIONING); a hard reset
            # returns the board to a clean soft-AP first-join state (creds were
            # cleared on the join-timeout), the reliably-provisionable path. The 4s
            # read lets the boot settle.
            backoff = provision_backoff(attempt)
            if backoff:
                print(
                    f"[improv] backing off {backoff:g}s before retry {attempt}/{attempts}…",
                    flush=True,
                )
                sleep(backoff)
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
