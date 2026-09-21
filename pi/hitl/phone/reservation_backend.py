"""Real rig-reservation device backend for the phone HITL station.

Reserve an ESP32-C6 on the HITL rig, flash the netstack player bundle, provision it
onto the rig's AP over BLE Improv, and forward its wss:443 to localhost — so the
phone journeys run against REAL firmware (the map upload we validated in #175/#176,
real hardware/gamma config) instead of the mock. Reuses the existing harness:
hitl_client.Reservation + provision.provision_dut/dut_target + res.forward().

Synchronous (the reservation/ssh path is), used as a plain context manager around
the async journey run; the forward tunnel + heartbeat live in their own
subprocess/thread, so they stay up across asyncio.run.
"""

from __future__ import annotations

import os
from typing import Any

from hitl_client import Reservation
from provision import dut_target, ensure_booted, provision_dut


def _bundle() -> str:
    env = os.environ.get("HITL_BUNDLE")
    if env and os.path.exists(env):
        return env
    try:
        from python.runfiles import runfiles  # type: ignore

        rl = os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        )
        p = runfiles.Create().Rlocation(rl)
        if p and os.path.exists(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit("netstack flash bundle not found (set $HITL_BUNDLE or add the data dep)")


class ReservationBackend:
    """Context manager: __enter__ reserves+flashes+provisions+forwards and returns the
    device wss URL (ws to localhost, tunneled to the DUT); __exit__ tears it all down."""

    def __init__(
        self,
        server: str | None = None,
        owner: str | None = None,
        flash: bool = True,
        monitor_seconds: float = 8.0,
    ) -> None:
        self._res = Reservation(server=server, owner=owner)
        self._flash = flash
        self._monitor = monitor_seconds
        self._forward_cm: Any = None
        self.device_ws = ""

    def __enter__(self) -> str:
        res = self._res
        res.acquire()
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no provisioning AP")
        ssid, psk = creds
        if self._flash:
            bundle = _bundle()
            remote = "/tmp/" + os.path.basename(bundle)
            print(f"[rig] flashing {os.path.basename(bundle)} -> {res.host}", flush=True)
            res.scp_to([bundle], "/tmp/")
            proc = res.ssh(
                f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {self._monitor:g}",
                capture=True,
                timeout=self._monitor + 180,
            )
            log = (proc.stdout or "") + (proc.stderr or "")
            if proc.returncode != 0:
                raise SystemExit(f"hitl-flash exited {proc.returncode}")
            ensure_booted(res, log, self._monitor)
        print("[rig] provisioning DUT onto the rig AP over BLE Improv…", flush=True)
        redirect = provision_dut(res, ssid, psk, timeout=90.0, attempts=3)
        host, port = dut_target(redirect, "wss")
        self._forward_cm = res.forward(host, port)
        local_port = self._forward_cm.__enter__()
        self.device_ws = f"wss://127.0.0.1:{local_port}/ws"
        print(f"[rig] DUT reachable at {self.device_ws} (tunnel -> {host}:{port})", flush=True)
        return self.device_ws

    def __exit__(self, *exc: Any) -> None:
        try:
            if self._forward_cm is not None:
                self._forward_cm.__exit__(*exc)
        finally:
            self._res.release()
