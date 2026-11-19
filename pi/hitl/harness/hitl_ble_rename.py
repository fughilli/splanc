"""HITL: renaming a device changes its advertised BLE name live (no reboot).

Owner report: "The bluetooth advertised name doesn't get immediately changed when
renaming a device." On the netstack C6 the heapless BLE host kept the boot-time name
in its scan response until the next boot; it now re-sends LE Set Scan Response Data on
a rename (advertising left on), or — with a central connected — when advertising
resumes (firmware/netstack/src/hci.rs). This gate proves it on real hardware in ONE
reservation (phases + grading: ble_rename_core):

  setup   flash --erase-fs, read the board's BLE address, wire-provision the rig AP,
          then over wss upload a map + an effect (it must keep rendering throughout);
  adv     set_device_name over wss; the rig's scanner (ble_name_watch.py, inside the
          container) must see the new name within --budget s of the rename's reply;
  conn    over the BLE player transport: hello, set_device_name, hello (the link must
          survive the rename), disconnect; the new name must be on the air within
          --budget s of the disconnect;
  long    a 32-byte name: the Improv advertisement stays intact (Shortened name);
  final   set_device_name over wss again: on the air within --budget s;
  improv  Improv-provision the rig AP over BLE: must still PROVISION.

The Reservation's always-on serial capture is graded too (no reset, the effect's frame
counter keeps advancing from the first rename on) and its tail printed on failure.

    bazel run //pi/hitl/harness:ble_rename -- --server http://hitl-rig-1:8087

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
import uuid
from urllib.parse import urlparse

import ble_rename_core as core
import hitl_ws

_HERE = os.path.dirname(os.path.abspath(__file__))
_SHIP = [
    os.path.join(_HERE, n)
    for n in ("ble_name_watch.py", "hitl_ble_player.py", "hitl_improv.py", "improv.py")
]
REMOTE = "/tmp/blern"


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(rel: str | None) -> str | None:
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        got = runfiles.Create().Rlocation(rel)
        return got if got and os.path.exists(got) else None
    except Exception:
        return None


def _json_tail(out: str) -> dict:
    for line in reversed((out or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                break
    return {"ok": False, "error": f"no JSON result: {(out or '')[-300:]!r}"}


def _watch(res, address: str, want: str, timeout: float, prefix: bool = False) -> dict:
    # The name travels base64'd (no shell quoting); the watcher decodes it.
    cmd = (
        f"PYTHONPATH={REMOTE} python3 {REMOTE}/ble_name_watch.py --address {address} "
        f"--want {base64.b64encode(want.encode()).decode()} --b64 --timeout {timeout:g}"
        + (" --prefix" if prefix else "")
    )
    try:
        proc = res.ssh(cmd, capture=True, timeout=timeout + 120)
    except subprocess.TimeoutExpired:
        return {"ok": False, "names": [], "error": "ssh timeout (scanner hung)"}
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    return _json_tail(proc.stdout)


async def _wss_rename(ws_url: str, name: str) -> dict:
    """One wss session: hello, set_device_name. Returns the welcome reply."""
    from hitl_map_upload import _open_ws, _rpc

    sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
    try:
        await _rpc(sock, {"type": "hello", "client": "ble_rename", "app_version": "1"}, "welcome")
        return await _rpc(sock, {"type": "set_device_name", "name": name}, "welcome", timeout=20)
    finally:
        try:
            await sock.close()
        except OSError:
            pass


async def _wss_setup(ws_url: str, fxb: bytes, leds: int) -> None:
    from hitl_map_upload import _open_ws, _rpc, _submit_chunked
    from map_upload_core import synth_output_map

    sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
    try:
        await _submit_chunked(sock, synth_output_map(leds, "__blerename"), "MAP", 1, "map")
        await _rpc(
            sock,
            {
                "type": "submit_effect",
                "effect_id": "__blerename",
                "fxb": base64.b64encode(fxb).decode("ascii"),
                "activate": True,
            },
            "result_ready",
        )
    finally:
        try:
            await sock.close()
        except OSError:
            pass


def _name_phase(res, ws_url: str, address: str, name: str, args, prefix_len: int = 0) -> dict:
    p: dict = {"want": name}
    try:
        w = asyncio.run(_wss_rename(ws_url, name))
        p["reply_name"] = w.get("deviceName")
    except (SystemExit, OSError, RuntimeError, asyncio.TimeoutError) as e:
        p["error"] = f"wss rename failed: {e!r}"
        return p
    t_reply = time.monotonic()
    want = name[:prefix_len] if prefix_len else name
    lead_start = t_reply
    w = _watch(res, address, want, args.watch_timeout, prefix=bool(prefix_len))
    # The watcher's clock starts when its scan does (after ssh + python start-up + the
    # adapter lock): add that lead, so on_air_s is the elapsed time from the trigger
    # to the first sighting (an upper bound on the true latency).
    lead = lead_start - t_reply + float(w.get("startup_s") or 0.0)
    p["watch"] = w
    p["lead_s"] = round(lead, 2)
    p["on_air_s"] = core.on_air_s(w, lead)
    return p


def _conn_phase(res, address: str, name: str, args) -> dict:
    from server import proto_wire

    p: dict = {"want": name}
    hello = proto_wire.encode_client({"type": "hello", "client": "ble_rename", "app_version": "1"})
    rename = proto_wire.encode_client({"type": "set_device_name", "name": name})
    frames = ",".join(base64.b64encode(f).decode("ascii") for f in (hello, rename, hello))
    cmd = (
        f"PYTHONPATH={REMOTE} python3 {REMOTE}/hitl_ble_player.py exchange "
        f"--frames-b64 {frames} --timeout 30 --address {address}"
    )
    try:
        proc = res.ssh(cmd, capture=True, timeout=240)
        ex = _json_tail(proc.stdout)
        if proc.stderr:
            sys.stderr.write(proc.stderr)
    except subprocess.TimeoutExpired:
        ex = {"ok": False, "error": "BLE transport failed: ssh timeout"}
    t_disc = time.monotonic()  # the exchange disconnected the central before returning
    p["exchange"] = {k: v for k, v in ex.items() if k != "replies_b64"}
    if not ex.get("ok"):
        return p
    p["reply_names"] = [
        proto_wire.decode_server(base64.b64decode(r)).get("deviceName")
        for r in ex.get("replies_b64", [])
    ]
    lead_start = time.monotonic()
    w = _watch(res, address, name, args.watch_timeout)
    lead = lead_start - t_disc + float(w.get("startup_s") or 0.0)
    p["watch"] = w
    p["lead_s"] = round(lead, 2)
    p["on_air_s"] = core.on_air_s(w, lead)
    return p


def run(args) -> int:
    from hitl_client import Reservation
    from provision import (
        HarnessError,
        _run_provisioner,
        ensure_booted,
        reserved_board_ble_mac,
        wire_provision_dut,
    )

    with open(args.fxb, "rb") as fh:
        fxb = fh.read()
    tag = uuid.uuid4().hex[:4]
    names = {
        "adv": f"hitl-rn-{tag}-adv",
        "conn": f"hitl-rn-{tag}-conn",
        "long": f"hitl-rn-{tag}-" + "L" * (32 - len(f"hitl-rn-{tag}-")),
        "final": f"hitl-rn-{tag}-final",
    }
    phases: dict[str, dict | None] = {n: None for n in core.ALL_PHASES}
    setup: dict = {}
    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        res.ssh(f"mkdir -p {REMOTE}")
        res.scp_to([args.bundle, *_SHIP], f"{REMOTE}/")
        _log("[setup] flash --erase-fs")
        proc = res.ssh_serialized(
            f"hitl-flash {REMOTE}/{os.path.basename(args.bundle)} --erase-fs "
            "--monitor --monitor-seconds 10",
            capture=True,
            timeout=320,
        )
        if proc.returncode != 0:
            raise HarnessError(f"hitl-flash exited {proc.returncode}")
        ensure_booted(res, (proc.stdout or "") + (proc.stderr or ""), 10.0)
        address = reserved_board_ble_mac(res)
        if not address:
            raise HarnessError("no BLE address in the boot log")
        setup["address"] = address
        url = wire_provision_dut(res, ssid, password, args.lease_timeout)
        ip = urlparse(url).hostname
        with res.forward(ip, 443) as port:
            ws_url = f"wss://localhost:{port}/ws"
            asyncio.run(_wss_setup(ws_url, fxb, args.leds))
            _log(f"[setup] {args.leds}-LED map + effect running; board {address} at {ip}")
            time.sleep(3.0)

            _log(f"[adv] rename over wss -> {names['adv']!r}")
            phases["adv"] = _name_phase(res, ws_url, address, names["adv"], args)
            _log(f"  {json.dumps(phases['adv'])}")

            _log(f"[conn] rename over the BLE player transport -> {names['conn']!r}")
            phases["conn"] = _conn_phase(res, address, names["conn"], args)
            _log(f"  {json.dumps(phases['conn'])}")

            _log(f"[long] rename over wss -> {names['long']!r} ({len(names['long'])} B)")
            phases["long"] = _name_phase(res, ws_url, address, names["long"], args, prefix_len=29)
            _log(f"  {json.dumps(phases['long'])}")

            _log(f"[final] rename over wss -> {names['final']!r}")
            phases["final"] = _name_phase(res, ws_url, address, names["final"], args)
            _log(f"  {json.dumps(phases['final'])}")

        _log("[improv] Improv-provision the rig AP over BLE after the renames")
        t0 = time.monotonic()
        try:
            got = _run_provisioner(res, ssid, password, args.improv_budget, address=address)
            phases["improv"] = {"ok": True, "url": got, "wall_s": round(time.monotonic() - t0, 1)}
        except HarnessError as e:
            phases["improv"] = {"ok": False, "error": str(e)}
        except subprocess.TimeoutExpired:
            phases["improv"] = {"ok": False, "error": "BLE transport failed: provisioner hung"}
        _log(f"  {json.dumps(phases['improv'])}")
        # A few more [fx] seconds after the join, so "kept rendering" covers it too.
        time.sleep(5.0)
    except HarnessError as e:
        setup["error"] = str(e)
        _log(f"[setup] {e}")
    finally:
        res.release()

    log = "\n".join(res.serial_logs.values()) if res.serial_logs else ""
    g = core.grade(phases, log, args.budget)
    if setup.get("error") and g["verdict"] != "FAIL":
        g["verdict"] = "SKIP"
        g["skips"].append(f"setup: {setup['error']}")
    if g["verdict"] != "PASS" and log:
        _log("----- DUT serial log (tail) -----")
        _log(log[-12000:])
    _log(
        "BLE_RENAME_JSON "
        + json.dumps({"setup": setup, "phases": phases, **g}, sort_keys=True, default=str)
    )
    _log(
        f"RESULT unit={res._unit} budget={args.budget:g}s "
        + " ".join(f"{k}={c['verdict']}" for k, c in g["checks"].items())
        + " "
        + " ".join(f"{k}_s={(phases[k] or {}).get('on_air_s')}" for k in ("adv", "conn", "final"))
        + f" verdict={g['verdict']}"
    )
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    for s in g["skips"]:
        _log(f"  SKIP: {s}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE") or None)
    ap.add_argument("--bundle", default=_runfile(os.environ.get("HITL_BUNDLE_RUNFILE")))
    ap.add_argument("--fxb", default=_runfile(os.environ.get("BLE_RENAME_FXB_RUNFILE")))
    ap.add_argument("--leds", type=int, default=120)
    ap.add_argument("--budget", type=float, default=5.0, help="rename -> new name on the air (s)")
    ap.add_argument("--watch-timeout", type=float, default=20.0)
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--improv-budget", type=float, default=60.0)
    args = ap.parse_args()
    if not args.bundle or not args.fxb:
        raise SystemExit("need --bundle and --fxb (run via bazel)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, _HERE)
    main()
