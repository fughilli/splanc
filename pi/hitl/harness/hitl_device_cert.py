"""HITL: the per-device TLS identity on real C6 hardware (docs/design/per-device-cert.md).

Every netstack player generates its own EC P-256 key + self-signed certificate on first
boot, persists it in littlefs, and keeps :443 closed until it exists. This driver checks
that on one DUT, inside ONE reservation (rig DUTs get reflashed by other users between
reservations):

  1. flash --erase-fs (no stored identity) with the boot monitor, and read the first-boot
     keygen time from `[tls] generated per-device identity in N ms`;
  2. race: on the rig, PROV the DUT over its serial console and — the instant the DHCP
     lease prints — hammer TLS handshakes at <dut>:443 every ~50 ms for a window. Every
     handshake that completes must present the SAME, non-legacy certificate (no
     handshake ever meets a missing/partial cert), and :443 must open within the window;
  3. over a tunnel: the manifest says tls.state=ready, persisted=true and pins the cert
     the handshake presented; get_tls_info over wss agrees;
  4. reboot (hitl-monitor --reset): the boot log says `[tls] loaded per-device identity`
     with the SAME sha256; after re-provisioning, the handshake presents the same cert.

Prints `RESULT ...` and a `DEVCERT_JSON {...}` line; `--out` appends that JSON to a local
file so runs on two DUTs can be compared (`--compare`: their certs must differ).

    bazel run //pi/hitl/harness:device_cert -- --server http://hitl-rig-2:8087 \\
        --device c6-003f08 --out /workspace/.claude/devcert/hitl.jsonl
    bazel run //pi/hitl/harness:device_cert -- --compare /workspace/.claude/devcert/hitl.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import shlex
import ssl
import sys
import time
from typing import Any

import device_cert_core as core


def _log(msg: str) -> None:
    print(msg, flush=True)


def default_flashbundle() -> str | None:
    rel = os.environ.get("HITL_BUNDLE_RUNFILE")
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(rel)
    except Exception:
        return None


# Runs INSIDE the reservation container (python3 there has ssl). Opens the DUT console,
# writes PROV, watches for the lease, then hammers TLS handshakes at <ip>:443.
RACE_SCRIPT = r"""
import hashlib, json, os, re, socket, ssl, subprocess, sys, threading, time
tty, ssid, pw, window, lease_timeout = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
subprocess.call(["stty", "-F", tty, "raw", "-echo", "115200"])
fd = os.open(tty, os.O_RDWR | os.O_NOCTTY)
lines, ip, done = [], [None], [False]
lease = re.compile(
    r"(?:DHCP LEASE ACQUIRED.*?IP\s+|TCP LISTEN on\s+|PROV re-received.*?IP\s+)"
    r"(\d{1,3}(?:\.\d{1,3}){3})"
)
t_start = time.time()
def reader():
    buf = b""
    while not done[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            time.sleep(0.05)
            continue
        if not chunk:
            time.sleep(0.01)
            continue
        buf += chunk
        while b"\n" in buf:
            ln, buf = buf.split(b"\n", 1)
            s = ln.decode("utf-8", "replace").rstrip("\r")
            lines.append("%7.3f %s" % (time.time() - t_start, s))
            m = lease.search(s)
            if m and ip[0] is None:
                ip[0] = m.group(1)
threading.Thread(target=reader, daemon=True).start()
os.write(fd, ("PROV %s %s\n" % (ssid, pw)).encode())
deadline = time.time() + lease_timeout
while ip[0] is None and time.time() < deadline:
    time.sleep(0.02)
out = {"ip": ip[0], "attempts": [], "lease_s": round(time.time() - t_start, 3)}
if ip[0]:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    t0 = time.time()
    while time.time() - t0 < window:
        a = {"t": round(time.time() - t0, 3)}
        try:
            s = socket.create_connection((ip[0], 443), timeout=1.5)
            try:
                s.settimeout(6)
                ss = ctx.wrap_socket(s)
                a["sha"] = hashlib.sha256(ss.getpeercert(True)).hexdigest()
                a["ok"] = True
                try:
                    ss.sendall(b"GET /.well-known/splanc.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                    body = b""
                    while True:
                        c = ss.recv(4096)
                        if not c:
                            break
                        body += c
                    a["http"] = body.split(b"\r\n", 1)[0].decode("latin-1")
                    if b"\r\n\r\n" in body:
                        a["manifest"] = json.loads(body.split(b"\r\n\r\n", 1)[1].decode())
                except Exception as e:
                    a["http_err"] = type(e).__name__
                ss.close()
            except Exception as e:
                a["err"] = "tls:%s:%s" % (type(e).__name__, str(e)[:80])
                s.close()
        except Exception as e:
            a["err"] = "tcp:%s" % type(e).__name__
        out["attempts"].append(a)
        time.sleep(0.05)
time.sleep(0.5)
done[0] = True
out["serial"] = lines[-400:]
print("RACE_JSON " + json.dumps(out))
"""


def _flash_first_boot(res, bundle: str, monitor_seconds: float) -> str:
    from provision import ensure_booted

    remote = f"/tmp/{os.path.basename(bundle)}"
    res.scp_to([bundle], "/tmp/")
    _log(f"[flash] {os.path.basename(bundle)} --erase-fs (clean: no stored identity)")
    proc = res.ssh_serialized(
        f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}",
        capture=True,
        timeout=300,
    )
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise SystemExit(f"hitl-flash exited {proc.returncode}:\n{log[-2000:]}")
    return ensure_booted(res, log, monitor_seconds)


def _race(res, ssid: str, password: str, window: float, lease_timeout: float) -> dict:
    b64 = base64.b64encode(RACE_SCRIPT.encode()).decode()
    py = f"import base64,sys;exec(base64.b64decode({b64!r}))"
    cmd = "python3 -c {} /dev/ttyACM0 {} {} {:g} {:g}".format(
        shlex.quote(py), shlex.quote(ssid), shlex.quote(password), window, lease_timeout
    )
    proc = res.ssh_serialized(cmd, capture=True, timeout=window + lease_timeout + 90)
    out = (proc.stdout or "") + (proc.stderr or "")
    m = re.search(r"^RACE_JSON (.*)$", out, re.M)
    if not m:
        raise SystemExit(f"race script produced no result (rc={proc.returncode}):\n{out[-3000:]}")
    return json.loads(m.group(1))


def _reboot_log(res, seconds: float) -> str:
    proc = res.ssh_serialized(
        f"hitl-monitor --reset --seconds {seconds:g}", capture=True, timeout=seconds + 60
    )
    return (proc.stdout or "") + (proc.stderr or "")


async def _tls_info(host: str, port: int) -> dict[str, Any]:
    import websockets
    from server import proto_wire

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    async with websockets.connect(f"wss://{host}:{port}/ws", ssl=ctx, open_timeout=15) as sock:
        der = sock.transport.get_extra_info("ssl_object").getpeercert(True)

        async def rpc(flat: dict, expect: str) -> dict:
            await sock.send(proto_wire.encode_client(flat))
            while True:
                msg = proto_wire.decode_server(await asyncio.wait_for(sock.recv(), timeout=15))
                if msg.get("type") in (expect, "error"):
                    return msg

        welcome = await rpc(
            {"type": "hello", "client": "device_cert", "app_version": "1"}, "welcome"
        )
        info = await rpc({"type": "get_tls_info"}, "tls_info")
        return {"welcome": welcome, "tls_info": info, "ws_sha": hashlib.sha256(der).hexdigest()}


def _ws_check(res, ip: str) -> dict[str, Any]:
    with res.forward(ip, 443) as local_port:
        last: Exception | None = None
        for _ in range(6):
            try:
                return asyncio.run(_tls_info("localhost", local_port))
            except Exception as e:  # noqa: BLE001 — retried; reported below
                last = e
                time.sleep(2)
        raise SystemExit(f"wss get_tls_info failed: {last}")


def run(args) -> int:
    from hitl_client import Reservation

    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    result: dict[str, Any] = {"unit": res._unit, "server": res.server}
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds

        boot1 = _flash_first_boot(res, args.bundle, args.monitor_seconds)
        gen = core.parse_identity_log(boot1)
        _log(f"[boot1] {gen}")
        result["first_boot"] = gen

        race = _race(res, ssid, password, args.race_window, args.lease_timeout)
        verdict = core.race_verdict(race["attempts"], core.LEGACY_SHA256)
        result["race"] = {k: v for k, v in verdict.items()}
        result["race"]["lease_s"] = race.get("lease_s")
        result["race_serial_identity"] = core.parse_identity_log("\n".join(race.get("serial", [])))
        _log(f"[race] ip={race.get('ip')} {json.dumps(verdict)}")
        ip = race.get("ip")
        if not ip:
            raise SystemExit("DUT never leased during the race window")

        ws = _ws_check(res, ip)
        info = ws["tls_info"]
        result["tls_info"] = info
        result["ws_sha"] = ws["ws_sha"]
        result["mac"] = ws["welcome"].get("mac")
        manifests = [a["manifest"] for a in race["attempts"] if a.get("manifest")]
        result["manifest_tls"] = manifests[-1].get("tls") if manifests else None
        _log(f"[ws] tls_info={info} ws_sha={ws['ws_sha']} manifest.tls={result['manifest_tls']}")

        boot2 = _reboot_log(res, args.monitor_seconds)
        loaded = core.parse_identity_log(boot2)
        result["reboot"] = loaded
        _log(f"[boot2] {loaded}")
        race2 = _race(res, ssid, password, 6.0, args.lease_timeout)
        v2 = core.race_verdict(race2["attempts"], core.LEGACY_SHA256)
        result["reboot_race"] = v2
        _log(f"[reboot race] {json.dumps(v2)}")

        problems = core.check_run(result)
        result["problems"] = problems
        result["verdict"] = "PASS" if not problems else "FAIL"
    finally:
        res.release()
    line = json.dumps(result, sort_keys=True)
    _log("DEVCERT_JSON " + line)
    if args.out:
        with open(args.out, "a") as f:
            f.write(line + "\n")
    fb = result.get("first_boot") or {}
    _log(
        f"RESULT unit={result.get('unit')} keygen_ms={fb.get('gen_ms', fb.get('recorded_gen_ms'))} "
        f"load_ms={(result.get('reboot') or {}).get('load_ms')} "
        f"race_ok={result['race'].get('ok')}/{result['race'].get('attempts')} "
        f"distinct_certs={result['race'].get('distinct')} verdict={result['verdict']}"
    )
    for p in result["problems"]:
        _log(f"  PROBLEM: {p}")
    return 0 if result["verdict"] == "PASS" else 1


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL per-device TLS identity check")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-003f08)")
    ap.add_argument("--bundle", default=default_flashbundle())
    ap.add_argument("--monitor-seconds", type=float, default=12.0)
    ap.add_argument("--race-window", type=float, default=20.0)
    ap.add_argument("--lease-timeout", type=float, default=60.0)
    ap.add_argument("--out", help="append the run's JSON to this file")
    ap.add_argument("--compare", help="compare runs in this JSON-lines file and exit")
    args = ap.parse_args()
    if args.compare:
        runs = [json.loads(ln) for ln in open(args.compare) if ln.strip()]
        problems = core.compare_runs(runs)
        for p in problems:
            _log(f"  PROBLEM: {p}")
        _log(f"RESULT compare runs={len(runs)} verdict={'PASS' if not problems else 'FAIL'}")
        raise SystemExit(0 if not problems else 1)
    if not args.bundle:
        raise SystemExit("no flash bundle (run via bazel run, or pass --bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
