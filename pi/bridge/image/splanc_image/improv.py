"""Improv-over-BLE WiFi provisioning for the Splanc bridge (splanc-improv.service).

Lets the Splanc phone app put the bridge onto a new WiFi network, the same way it
onboards a player: "Add device over Bluetooth" sends the network over the Improv
BLE service. The GATT peripheral, the RPC codec and the
AUTHORIZED -> PROVISIONING -> PROVISIONED state machine are the LED Mapper Pi's
(pi/provisioning/nix/improv/improv_ble_provision.py, a port of the C6 firmware's
improv_ble.cpp); only applying the credentials differs, and that is ``Joiner``:

  1. validate the SSID/PSK as the flasher does (a PSK WPA can't use is
     UNABLE_TO_CONNECT, as a failed join would be);
  2. a FRESH scan, every time (the rule the C6 firmware follows too: an Improv
     WiFi send is never a "same credentials" no-op). Up to three sweeps; an SSID
     none of them sees is tried as a hidden network;
  3. store the network as a NetworkManager keyfile rendered by the flasher's own
     renderer (splanc_image.wifi_profiles: added next to the known networks,
     deduplicated by SSID), load it, and ``nmcli connection up`` it;
  4. joined: answer the phone with ``http://<wifi ip>/#splanc-bridge`` (the Pi
     player's redirect URL; the ``#splanc-bridge`` fragment tells the app this is
     a bridge, to pair, not a player to connect to). Not joined: put the saved
     networks back as they were, rejoin the previous network, and answer
     UNABLE_TO_CONNECT.

Runs as root (it owns org.bluez objects and writes NetworkManager's store);
advertises for as long as it runs, like the Pi player's sbc-improv.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from typing import Awaitable, Callable, List, Optional, Tuple

from splanc_flasher import bootfiles
from splanc_image import wifi_profiles

NMCLI = os.environ.get("IMPROV_NMCLI", "nmcli")
REDIRECT_FRAGMENT = "splanc-bridge"
# The phone app gives up 45 s after sending the credentials (web/src/net/improv.ts):
# scan + join fit in this, so a failure is reported rather than timed out.
BUDGET_S = float(os.environ.get("IMPROV_BUDGET_S", "40"))
MIN_JOIN_S = 10
SWEEPS = 3
SWEEP_GAP_S = 1.5

# nmcli argv (without the nmcli binary) -> (returncode, stdout)
Runner = Callable[..., Awaitable[Tuple[int, str]]]


async def run_nmcli(*args: str) -> Tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        NMCLI, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    return proc.returncode or 0, (out or b"").decode("utf-8", "replace")


def terse_fields(line: str) -> List[str]:
    """Split one ``nmcli -t`` line (':' separated, '\\:' and '\\\\' escaped)."""
    fields, cur, i = [], [], 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            fields.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    fields.append("".join(cur))
    return fields


class Joiner:
    """Apply one set of Improv WiFi credentials through NetworkManager."""

    def __init__(
        self,
        *,
        nm_dir: str = wifi_profiles.NM_DIR,
        run: Runner = run_nmcli,
        log: Callable[[str], None] = print,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        chown_root: bool = True,
    ):
        self.nm_dir = nm_dir
        self.run = run
        self.log = log
        self.sleep = sleep
        self.clock = clock
        self.chown_root = chown_root

    async def visible(self, ssid: str) -> bool:
        """Fresh scan(s) for ``ssid`` (never just NetworkManager's cached list)."""
        for sweep in range(SWEEPS):
            if sweep:
                await self.sleep(SWEEP_GAP_S)
            rc, out = await self.run(
                "-t", "-f", "SSID", "device", "wifi", "list", "--rescan", "yes"
            )
            if rc == 0 and any(terse_fields(ln)[0] == ssid for ln in out.splitlines()):
                return True
        return False

    async def active_wifi(self) -> Optional[str]:
        rc, out = await self.run("-t", "-f", "UUID,TYPE", "connection", "show", "--active")
        if rc != 0:
            return None
        for ln in out.splitlines():
            f = terse_fields(ln)
            if len(f) >= 2 and f[1] in ("802-11-wireless", "wifi"):
                return f[0]
        return None

    async def wifi_ip(self) -> Optional[str]:
        """IPv4 address of the connected WiFi device (the network just joined)."""
        rc, out = await self.run("-t", "-f", "DEVICE,TYPE,STATE", "device")
        if rc != 0:
            return None
        dev = next(
            (f[0] for f in map(terse_fields, out.splitlines()) if f[1:3] == ["wifi", "connected"]),
            None,
        )
        if not dev:
            return None
        rc, out = await self.run("-g", "IP4.ADDRESS", "device", "show", dev)
        first = out.strip().splitlines()[0] if rc == 0 and out.strip() else ""
        ip = first.split("|")[0].split("/")[0].strip()
        return ip if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip) else None

    async def join(self, ssid: str, psk: str) -> Optional[str]:
        """Store + join the network. Returns the redirect URL, or None (not joined;
        the saved networks are as they were)."""
        start = self.clock()
        try:
            bootfiles.check_ssid(ssid)
            bootfiles.check_psk(psk)
        except bootfiles.InvalidSetting as e:
            self.log(f"refusing {ssid!r}: {e}")
            return None
        seen = await self.visible(ssid)
        if not seen:
            self.log(f"{ssid!r} not in a fresh scan; trying it as a hidden network")
        try:
            plan = wifi_profiles.plan(bootfiles.Wifi(ssid, psk, hidden=not seen), self.nm_dir)
        except (bootfiles.InvalidSetting, UnicodeError) as e:
            self.log(f"refusing {ssid!r}: {e}")
            return None
        before = await self.active_wifi()
        verb = "replacing" if plan.previous is not None else "adding"
        self.log(f"{verb} {os.path.basename(plan.path)} ({plan.conn_id}) for {ssid!r}")
        try:
            wifi_profiles.write(plan, chown_root=self.chown_root)
        except OSError as e:
            self.log(f"could not store the network: {e}")
            return None
        await self.run("connection", "load", plan.path)
        wait = max(MIN_JOIN_S, int(BUDGET_S - (self.clock() - start)))
        rc, out = await self.run("--wait", str(wait), "connection", "up", "uuid", plan.uuid)
        ip = await self.wifi_ip() if rc == 0 else None
        if rc == 0 and ip:
            url = f"http://{ip}/#{REDIRECT_FRAGMENT}"
            self.log(f"joined {ssid!r}: {url}")
            return url
        self.log(f"could not join {ssid!r} (rc={rc}): {out.strip()}")
        await self._undo(plan, before)
        return None

    async def _undo(self, plan: wifi_profiles.Plan, before: Optional[str]) -> None:
        try:
            if plan.previous is None:
                await self.run("connection", "delete", "uuid", plan.uuid)
                wifi_profiles.rollback(plan, chown_root=self.chown_root)
            else:
                wifi_profiles.rollback(plan, chown_root=self.chown_root)
                await self.run("connection", "load", plan.path)
        except OSError as e:
            self.log(f"could not restore the saved networks: {e}")
        if before:
            # Back onto the network we were on (don't wait: report the failure now).
            await self.run("--wait", "0", "connection", "up", "uuid", before)


def main() -> int:  # pragma: no cover - needs BlueZ + NetworkManager (on the Pi)
    # The Pi player's Improv service (bless GATT server + state machine); only the
    # join differs. Imported here so the module above stays testable without bless.
    import improv_ble_provision as ibp
    from improv_codec import (
        ERR_UNABLE_TO_CONNECT,
        STATE_AUTHORIZED,
        STATE_PROVISIONED,
        STATE_PROVISIONING,
    )

    joiner = Joiner(log=ibp.log)

    class BridgeImprovServer(ibp.ImprovServer):
        async def _provision(self, ssid: str, password: str) -> None:
            try:
                ibp.log(f"provisioning: joining {ssid!r}")
                self.set_state(STATE_PROVISIONING)
                url = await joiner.join(ssid, password)
                if url:
                    # Improv order: the result first, then PROVISIONED.
                    self.send_redirect(url)
                    self.set_state(STATE_PROVISIONED)
                else:
                    self.set_error(ERR_UNABLE_TO_CONNECT)
                    self.set_state(STATE_AUTHORIZED)
            except Exception as e:  # noqa: BLE001 - never wedge the service
                ibp.log(f"join error: {e!r}")
                self.set_error(ERR_UNABLE_TO_CONNECT)
                self.set_state(STATE_AUTHORIZED)
            finally:
                self._busy = False

    ibp.ImprovServer = BridgeImprovServer  # amain() builds the server by this name
    return ibp.main()


if __name__ == "__main__":
    sys.exit(main())
