"""HITL regression test for the LED-freeze fix (async ring logger).

Flash + ImprovBLE-provision the DUT, activate a shader effect over the player ws
(so the render loop is actually producing [fx] frames — a --erase-fs board has no
stored effect), then ship led_freeze_probe.py into the reservation and run it on
the rig's /dev/ttyACM0: it reads the [fx] frame counter, stops draining serial
for a while (backpressuring the console — the condition that froze the old
blocking logger), and asserts render kept advancing frames through the stall.

    bazel test //pi/hitl/harness:led_freeze   (CI HITL lane; needs a rig)
"""

import asyncio
import base64
import os
import ssl
import subprocess
import sys
import tempfile
from typing import Any

from hitl_client import Reservation
from provision import HarnessError, dut_target, ensure_booted, provision_dut

_BUNDLE_RUNFILE = "_main/firmware/player_app/esp32c6_flashbundle.tar"
_PROBE_RUNFILE = "_main/pi/hitl/harness/led_freeze_probe.py"
_FX_RUNFILE = "_main/pi/hitl/harness/benchmarks/empty.fx"
BLE_MARKER = "[ble] advertising"
LED_COUNT = 16


def _rloc(rel):
    from python.runfiles import runfiles

    p = runfiles.Create().Rlocation(rel)
    if not p or not os.path.exists(p):
        raise HarnessError(f"runfile not found: {rel}")
    return p


def _fx_compile():
    from python.runfiles import runfiles

    r = runfiles.Create()
    for rel in ("_main/fx_compiler/fx_compile", "_main/fx_compiler/fx_compile_/fx_compile"):
        p = r.Rlocation(rel)
        if p and os.path.exists(p):
            return p
    raise HarnessError("fx_compile not found in runfiles")


def flash(res, bundle, monitor_seconds=6.0):
    remote = "/tmp/" + os.path.basename(bundle)
    res.scp_to([bundle], "/tmp/")
    cmd = f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}"
    print(f"[flash] {cmd}", flush=True)
    proc = res.ssh(cmd, capture=True, timeout=monitor_seconds + 120)
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise HarnessError(f"hitl-flash exited {proc.returncode}")
    log = ensure_booted(res, log, monitor_seconds)
    if BLE_MARKER not in log:
        raise HarnessError(f"BLE never came up (no {BLE_MARKER!r})")
    print("[flash] OK — booted + BLE advertising", flush=True)


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 8.0):
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        msg = proto_wire.decode_server(await asyncio.wait_for(sock.recv(), timeout=timeout))
        if msg.get("type") == expect:
            return msg
        if msg.get("type") == "error":
            raise HarnessError(f"device error to {flat.get('type')}: {msg}")


async def activate_effect(ws_url: str, fxb: bytes) -> None:
    """Load + activate a shader effect so render produces [fx] frames."""
    import websockets

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    deadline = asyncio.get_event_loop().time() + 60
    while True:
        try:
            sock = await websockets.connect(ws_url, max_size=2**22, ssl=ctx, open_timeout=8)
            break
        except Exception as e:  # noqa: BLE001
            if asyncio.get_event_loop().time() >= deadline:
                raise HarnessError(f"ws never came up: {e}")
            await asyncio.sleep(1.5)
    async with sock:
        await _rpc(sock, {"type": "hello", "client": "led-freeze", "app_version": "1"}, "welcome")
        leds = [{"id": i, "xyz": [i / (LED_COUNT - 1), 0.0, 0.0]} for i in range(LED_COUNT)]
        await _rpc(
            sock,
            {
                "type": "submit_map",
                "map": {"map_id": "__ledfreeze", "led_count": LED_COUNT, "leds": leds},
            },
            "result_ready",
        )
        await _rpc(sock, {"type": "set_led_count", "led_count": LED_COUNT}, "led_count_state")
        await _rpc(
            sock,
            {
                "type": "submit_effect",
                "effect_id": "__ledfreeze",
                "fxb": base64.b64encode(fxb).decode("ascii"),
                "activate": True,
            },
            "result_ready",
        )
    print("[led-freeze] shader effect activated — render is producing [fx]", flush=True)


def main():
    server = os.environ.get("HITL_SERVER")
    res = Reservation(server=server or None, owner="led-freeze")
    res.acquire()
    try:
        flash(res, _rloc(_BUNDLE_RUNFILE))
        creds = res.wifi()
        if not creds:
            raise HarnessError("rig serves no provisioning AP")
        redirect = provision_dut(res, creds[0], creds[1], 90)
        host, port = dut_target(redirect, "wss")
        # compile the trivial effect and activate it through the tunnel
        fd, out = tempfile.mkstemp(suffix=".fxb")
        os.close(fd)
        subprocess.run([_fx_compile(), _rloc(_FX_RUNFILE), out], check=True)
        fxb = open(out, "rb").read()
        with res.forward(host, port) as lp:
            asyncio.run(activate_effect(f"wss://localhost:{lp}/ws", fxb))
        # now the effect renders [fx] from flash; run the serial-stall probe
        res.scp_to([_rloc(_PROBE_RUNFILE)], "/tmp/")
        print("[led-freeze] running the serial-stall probe on the rig…", flush=True)
        proc = res.ssh("python3 /tmp/led_freeze_probe.py", capture=True, timeout=120)
        sys.stdout.write((proc.stdout or "") + (proc.stderr or ""))
        if proc.returncode != 0:
            print(
                "\nFAIL: render stalled on serial backpressure (LED-freeze regression)",
                file=sys.stderr,
                flush=True,
            )
            return 1
    finally:
        res.release()
    print("\nPASS — LED render is immune to serial backpressure", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
