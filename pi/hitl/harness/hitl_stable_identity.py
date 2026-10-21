"""HITL: the netstack keeps a stable network identity across reboots.

One DUT, one reservation:
  1. flash with --erase-fs and wire-provision onto the rig AP (boot 1: MAC + lease);
  2. reset (hitl-monitor --reset) and watch the boot (boot 2): the board must rejoin
     on its own (persisted credentials), with the SAME factory station MAC and the SAME
     DHCP lease, and announce mDNS for it;
  3. from the rig: a legacy-unicast `_splanc._tcp.local` PTR query to <ip>:5353 must
     answer with A=<lease> and TXT id=<device id>;
  4. while one live wss client holds the board's single session, an extra TCP client
     must be refused promptly (RST), and the first must still answer a WS ping.

Prints `RESULT ... verdict=PASS|FAIL|SKIP` (exit 1 only on FAIL). Serial logs of every
phase go to --log-dir (default: the test outputs dir); the Reservation's serial capture
is dumped on failure too.

    bazel run //pi/hitl/harness:stable_identity -- --server http://hitl-rig-1:8087 \\
        --device c6-123170
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import shlex
import sys

import stable_identity_core as core


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


class _Tee:
    def __init__(self, inner) -> None:
        self.inner = inner
        self.buf = io.StringIO()

    def write(self, s: str) -> int:
        self.buf.write(s)
        return self.inner.write(s)

    def flush(self) -> None:
        self.inner.flush()


# Runs in the reservation container: unicast mDNS browse + the extra-client refusal.
PROBE_SCRIPT = r"""
import base64, json, socket, ssl, sys, time
ip = sys.argv[1]
query = base64.b64decode(sys.argv[2])
out = {}
# 1. legacy-unicast mDNS (src port != 5353 -> the responder answers us directly)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1.0)
reply = None
for _ in range(6):
    try:
        s.sendto(query, (ip, 5353))
        reply, _ = s.recvfrom(4096)
        break
    except OSError:
        time.sleep(0.5)
out["mdns"] = base64.b64encode(reply).decode() if reply else None
# 2. one LIVE wss client holds the single session (WS upgraded = the firmware's
#    "serving_live" state); an extra client must be refused promptly (RST), and the
#    first must still answer a WS ping afterwards. (An idle pre-WS TLS socket is
#    deliberately NOT protected this way: that window is when the same client
#    reconnects for the cert page, see tcp.rs serving_live.)
import os as _os
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
first = None
for _ in range(8):
    try:
        raw = socket.create_connection((ip, 443), timeout=5)
        raw.settimeout(8)
        first = ctx.wrap_socket(raw)
        key = base64.b64encode(_os.urandom(16)).decode()
        first.sendall(("GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (ip, key)).encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            c = first.recv(1024)
            if not c:
                break
            resp += c
        if b" 101 " not in resp.split(b"\r\n", 1)[0]:
            raise OSError("no 101: %r" % resp[:40])
        break
    except Exception as e:
        out["first_err"] = "%s:%s" % (type(e).__name__, str(e)[:60])
        first = None
        time.sleep(1.5)
if first is None:
    out["refusal"] = None
else:
    time.sleep(0.5)
    t0 = time.time()
    second = "connected"
    try:
        c2 = socket.create_connection((ip, 443), timeout=3)
        c2.settimeout(2)
        try:
            d = c2.recv(1)
            second = "closed" if d == b"" else "data"
        except socket.timeout:
            second = "hung"
        except ConnectionResetError:
            second = "reset"
        c2.close()
    except ConnectionRefusedError:
        second = "refused"
    except ConnectionResetError:
        second = "reset"
    except socket.timeout:
        second = "hung"
    except OSError as e:
        second = "oserror:%s" % e.errno
    second_s = round(time.time() - t0, 2)
    status = None
    try:
        # masked WS ping (opcode 9, 4-byte payload) -> expect a pong (opcode 10)
        mask = _os.urandom(4); pl = b"ping"
        first.sendall(bytes([0x89, 0x80 | len(pl)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(pl)))
        deadline = time.time() + 6
        buf = b""
        while time.time() < deadline:
            c = first.recv(1024)
            if not c:
                break
            buf += c
            if len(buf) >= 2 and buf[0] & 0x0F == 0x0A:
                status = 200
                break
            if len(buf) >= 2:
                buf = buf[2 + (buf[1] & 0x7F):] if (buf[1] & 0x7F) < 126 else b""
    except Exception as e:
        out["first_after_err"] = type(e).__name__
    out["refusal"] = {"second": second, "second_s": second_s, "first_after": status}
print("PROBE_JSON " + json.dumps(out))
"""


def _flash(res, remote: str, monitor_seconds: float) -> str:
    from provision import ensure_booted

    proc = res.ssh_serialized(
        f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}",
        capture=True,
        timeout=300 + monitor_seconds,
    )
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"hitl-flash exited {proc.returncode}:\n{log[-2000:]}")
    return ensure_booted(res, log, monitor_seconds)


def _probe(res, ip: str) -> dict:
    q = base64.b64encode(core.build_ptr_query()).decode()
    b64 = base64.b64encode(PROBE_SCRIPT.encode()).decode()
    py = f"import base64,sys;exec(base64.b64decode({b64!r}))"
    proc = res.ssh(
        f"python3 -c {shlex.quote(py)} {shlex.quote(ip)} {shlex.quote(q)}",
        capture=True,
        timeout=120,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    m = re.search(r"^PROBE_JSON (.*)$", out, re.M)
    if not m:
        raise RuntimeError(f"probe produced no result (rc={proc.returncode}):\n{out[-2000:]}")
    return json.loads(m.group(1))


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, wire_provision_dut

    res = Reservation(server=args.server, owner=args.owner, device=args.device)
    res.acquire()
    logs: dict[str, str] = {}
    boot1 = boot2 = mdns = refusal = None
    probe: dict = {}
    try:
        creds = (args.wifi_ssid, args.wifi_pass) if args.wifi_ssid else res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP (pass --wifi-ssid/--wifi-pass)")
        ssid, password = creds
        res.scp_to([args.bundle], "/tmp/")
        remote = f"/tmp/{os.path.basename(args.bundle)}"
        _log(f"[1/4] flash {os.path.basename(args.bundle)} --erase-fs + wired PROV")
        logs["flash"] = _flash(res, remote, 12.0)
        tee = _Tee(sys.stdout)
        sys.stdout = tee
        try:
            wire_provision_dut(res, ssid, password, args.lease_timeout)
        except HarnessError as e:
            _log(f"  provisioning failed: {e}")
        finally:
            sys.stdout = tee.inner
            logs["provision"] = tee.buf.getvalue()
        boot1 = core.parse_boot(logs["flash"] + "\n" + logs["provision"])
        _log(f"  boot1 {json.dumps(boot1)}")
        if boot1.get("lease_ip"):
            _log(f"[2/4] reset; watching {args.monitor_seconds:g}s")
            proc = res.ssh_serialized(
                f"hitl-monitor --reset --seconds {args.monitor_seconds:g}",
                capture=True,
                timeout=args.monitor_seconds + 60,
            )
            logs["reboot"] = (proc.stdout or "") + (proc.stderr or "")
            boot2 = core.parse_boot(logs["reboot"])
            _log(f"  boot2 {json.dumps(boot2)}")
            ip = boot2.get("lease_ip") or boot1["lease_ip"]
            _log(f"[3/4] unicast mDNS query + [4/4] extra-client refusal against {ip}")
            probe = _probe(res, ip)
            if probe.get("mdns"):
                mdns = core.parse_answers(base64.b64decode(probe["mdns"]))
            refusal = probe.get("refusal")
            _log(f"  mdns={json.dumps(mdns)} refusal={json.dumps(refusal)}")
    finally:
        res.release()
    g = core.grade(boot1, boot2, mdns, refusal)
    if args.log_dir:
        os.makedirs(args.log_dir, exist_ok=True)
        for k, v in logs.items():
            with open(os.path.join(args.log_dir, f"stable_identity_{k}.log"), "w") as f:
                f.write(v)
    if g["verdict"] == "FAIL":
        for k in ("reboot", "provision"):
            if k in logs:
                _log(f"----- {k} serial log -----")
                _log(logs[k][-6000:])
    _log(
        "STABLE_IDENTITY_JSON "
        + json.dumps({"boot1": boot1, "boot2": boot2, "mdns": mdns, "probe": probe, **g})
    )
    _log(
        f"RESULT unit={res._unit} mac={(boot1 or {}).get('sta_mac')}->{(boot2 or {}).get('sta_mac')} "
        f"ip={(boot1 or {}).get('lease_ip')}->{(boot2 or {}).get('lease_ip')} "
        f"mdns_a={(mdns or {}).get('a')} id={(mdns or {}).get('txt', {}).get('id')} "
        f"extra_client={(refusal or {}).get('second')} verdict={g['verdict']}"
        + (f" skip={g['skip']!r}" if g["skip"] else "")
    )
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(
        description="HITL: stable MAC/IP + mDNS + clean extra-client refusal"
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-123170)")
    ap.add_argument("--bundle", default=default_flashbundle())
    ap.add_argument("--wifi-ssid", help="provision onto this AP instead of the rig's own")
    ap.add_argument("--wifi-pass", default="")
    ap.add_argument("--monitor-seconds", type=float, default=45.0)
    ap.add_argument("--lease-timeout", type=float, default=60.0)
    ap.add_argument("--log-dir", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    args = ap.parse_args()
    if not args.bundle:
        raise SystemExit("no flash bundle (run via bazel run, or pass --bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
