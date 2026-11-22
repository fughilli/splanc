"""HITL: renaming a netstack player withdraws its old mDNS name and announces the new one
(PR #510; logic in mdns_rename_core.py).

One DUT, one reservation:
  1. flash with --erase-fs and wire-provision onto the rig AP;
  2. start a listener in the reservation container for the whole run: it joins the mDNS
     group (224.0.0.251:5353, plus one QM query to see whether the group reaches this
     container at all) and sends a legacy-unicast `_splanc._tcp.local` PTR query to the
     DUT once a second;
  3. rename twice over wss (factory name -> A, then A -> B), closing the session right
     after each ack (announcements wait for no live session);
  4. grade each rename: the old name's goodbye (TTL 0 PTR) and the new name's
     announcement on the group, and unicast answers naming only the new name, each within
     mdns_rename_core.DEADLINE_S of the session closing.

Prints `RESULT ... verdict=PASS|FAIL|SKIP` (exit 1 only on FAIL). The DUT serial log is
captured by the Reservation and printed on failure.

    bazel run //pi/hitl/harness:mdns_rename -- --server http://hitl-rig-3:8087
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import secrets
import shlex
import sys
import threading
import time
from urllib.parse import urlparse

import mdns_rename_core as core
import stable_identity_core as sic


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


# Runs in the reservation container (python3 stdlib only). argv: dut_ip, seconds, query_b64.
LISTEN_SCRIPT = r"""
import base64, json, select, socket, struct, sys, time
ip, secs, query = sys.argv[1], float(sys.argv[2]), base64.b64decode(sys.argv[3])
def ev(src, data):
    print("EV " + json.dumps({"t": time.time(), "src": src, "b64": base64.b64encode(data).decode()}), flush=True)
m = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
m.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    m.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
except (AttributeError, OSError):
    pass
m.bind(("", 5353))
try:
    m.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                 struct.pack("4s4s", socket.inet_aton("224.0.0.251"), socket.inet_aton("0.0.0.0")))
    print("JOINED", flush=True)
except OSError as e:
    print("JOIN_FAILED %s" % e, flush=True)
m.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
try:  # one QM query on the group: a multicast reply proves the group reaches us
    m.sendto(query, ("224.0.0.251", 5353))
except OSError as e:
    print("QM_FAILED %s" % e, flush=True)
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
u.bind(("", 0))
print("START %f" % time.time(), flush=True)
end = time.time() + secs
next_q = 0.0
while time.time() < end:
    now = time.time()
    if now >= next_q:
        try:
            u.sendto(query, (ip, 5353))
        except OSError:
            pass
        next_q = now + 1.0
    r, _, _ = select.select([m, u], [], [], max(0.05, min(next_q, end) - time.time()))
    for s in r:
        data, addr = s.recvfrom(9000)
        if addr[0] == ip:
            ev("mcast" if s is m else "ucast", data)
print("END %f" % time.time(), flush=True)
"""


def _flash(res, remote: str) -> str:
    from provision import ensure_booted

    proc = res.ssh_serialized(
        f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 10",
        capture=True,
        timeout=320,
    )
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"hitl-flash exited {proc.returncode}:\n{log[-2000:]}")
    return ensure_booted(res, log, 10.0)


def _clock_offset(res) -> float:
    """container clock - local clock, from the tighter of three round trips."""
    best = None
    for _ in range(3):
        t0 = time.time()
        p = res.ssh("python3 -c 'import time;print(repr(time.time()))'", capture=True, timeout=30)
        t1 = time.time()
        try:
            remote = float((p.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            continue
        if best is None or t1 - t0 < best[0]:
            best = (t1 - t0, remote - t1)  # the command runs at the END of the ssh setup
    if best is None:
        raise RuntimeError("could not read the container clock")
    _log(f"  container clock offset {best[1]:+.3f} s (rtt {best[0]:.2f} s)")
    return best[1]


async def _rename(ws_url: str, new_name: str) -> tuple[str | None, float, float]:
    """One wss session: hello, set_device_name, close. Returns (old name, sent, closed)."""
    import ssl

    import hitl_ws
    import websockets
    from server import proto_wire

    async def _rpc(sock, flat: dict, expect: str, timeout: float = hitl_ws.RPC_TIMEOUT) -> dict:
        await sock.send(proto_wire.encode_client(flat))
        while True:
            msg = proto_wire.decode_server(await asyncio.wait_for(sock.recv(), timeout=timeout))
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise RuntimeError(f"device error to {flat.get('type')}: {msg}")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    deadline = time.monotonic() + 60
    while True:
        try:
            sock = await websockets.connect(
                ws_url, max_size=2**22, ssl=ctx, open_timeout=hitl_ws.OPEN_TIMEOUT
            )
            welcome = await _rpc(
                sock, {"type": "hello", "client": "mdns_rename", "app_version": "1"}, "welcome"
            )
            break
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() > deadline:
                raise RuntimeError(f"wss never came up: {type(e).__name__}: {e}")
            await asyncio.sleep(1.5)
    old = welcome.get("deviceName")
    sent = time.time()
    try:
        ack = await _rpc(sock, {"type": "set_device_name", "name": new_name}, "welcome", timeout=20)
        _log(f"  ack: name={ack.get('deviceName')!r}")
    except Exception as e:  # noqa: BLE001 — the reply can be cut by the TLS re-issue
        _log(f"  no clean ack ({type(e).__name__}: {e})")
    try:
        await sock.close()
    except Exception:  # noqa: BLE001
        pass
    return old, sent, time.time()


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, wire_provision_dut

    res = Reservation(server=args.server, owner=args.owner, device=args.device)
    res.acquire()
    tag = secrets.token_hex(2)
    names = [f"mdnsA-{tag}", f"mdnsB-{tag}"]
    renames: list[tuple[str, str, float, float]] = []
    lst: dict = {}
    skip = None
    try:
        creds = (args.wifi_ssid, args.wifi_pass) if args.wifi_ssid else res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP (pass --wifi-ssid/--wifi-pass)")
        res.scp_to([args.bundle], "/tmp/")
        _log(f"[1/4] flash {os.path.basename(args.bundle)} --erase-fs + wired PROV")
        _flash(res, f"/tmp/{os.path.basename(args.bundle)}")
        try:
            redirect = wire_provision_dut(res, creds[0], creds[1], args.lease_timeout)
        except HarnessError as e:
            skip = f"provisioning failed (infra): {e}"
            redirect = None
        if redirect:
            ip = urlparse(redirect).hostname
            off = _clock_offset(res)
            secs = args.baseline + len(names) * args.window + 5
            q = base64.b64encode(sic.build_ptr_query()).decode()
            py = f"import base64,sys;exec(base64.b64decode({base64.b64encode(LISTEN_SCRIPT.encode()).decode()!r}))"
            cmd = f"python3 -u -c {shlex.quote(py)} {ip} {secs:g} {q}"

            def listen() -> None:
                try:
                    p = res.ssh(cmd, capture=True, timeout=secs + 60)
                    lst["out"] = (p.stdout or "") + (p.stderr or "")
                except Exception as e:  # noqa: BLE001
                    lst["err"] = repr(e)

            _log(f"[2/4] listener on the rig for {secs:g} s against {ip}")
            th = threading.Thread(target=listen, daemon=True)
            th.start()
            time.sleep(args.baseline)
            with res.forward(ip, 443) as lp:
                for new in names:
                    _log(f"[3/4] rename -> {new!r}")
                    old, sent, closed = asyncio.run(_rename(f"wss://localhost:{lp}/ws", new))
                    renames.append((old or "", new, sent + off, closed + off))
                    _log(f"  {old!r} -> {new!r}; session closed")
                    time.sleep(max(0.0, args.window - (time.time() - sent)))
            th.join(timeout=secs + 90)
    finally:
        res.release()

    out = lst.get("out", "")
    events = []
    for line in out.splitlines():
        if line.startswith("EV "):
            e = json.loads(line[3:])
            try:
                e["records"] = core.parse_records(base64.b64decode(e.pop("b64")))
            except ValueError:
                continue
            events.append(e)
    _log(
        "  listener: "
        + " ".join(ln for ln in out.splitlines() if not ln.startswith("EV "))[:400]
        + f" ({len(events)} packets: {sum(e['src'] == 'mcast' for e in events)} multicast)"
        + (f" error={lst['err']}" if lst.get("err") else "")
    )
    if not skip and renames and not any(e["src"] == "ucast" for e in events):
        skip = "no unicast mDNS answer at all (DUT unreachable from the rig: infra)"
    graded = []
    for i, (old, new, sent, closed) in enumerate(renames):
        until = renames[i + 1][2] if i + 1 < len(renames) else float("inf")
        window = [e for e in events if e["t"] < until]
        graded.append(core.grade_rename(window, old, new, sent, closed))
    serial = "\n".join(res.serial_logs.values())
    goodbyes = core.serial_goodbyes(serial)
    v = core.verdict(graded, skip, goodbyes)
    _log(
        "MDNS_RENAME_JSON "
        + json.dumps(
            {
                "renames": graded,
                "serial_goodbyes": goodbyes,
                **v,
                "timeline": [
                    {
                        "t": round(e["t"], 3),
                        "src": e["src"],
                        "ptr": [(r["ptr"], r["ttl"]) for r in e["records"] if "ptr" in r],
                    }
                    for e in events
                    if any("ptr" in r for r in e["records"])
                ],
            }
        )
    )
    if v["verdict"] == "FAIL":
        _log("----- DUT serial log -----")
        _log(res.serial_tail(400))
    for g in graded:
        _log(
            f"  {g['old']!r} -> {g['new']!r}: unicast new-only at {g['unicast_new_s']} s, "
            f"goodbye at {g['goodbye_s']} s, announce at {g['announce_s']} s "
            f"(multicast observable: {g['multicast_observable']}; times from session close)"
        )
    _log(
        f"RESULT unit={res._unit} verdict={v['verdict']}"
        + (f" skip={v['skip']!r}" if v["skip"] else "")
    )
    for p in v["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if v["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: rename withdraws the old mDNS name")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-123170)")
    ap.add_argument("--bundle", default=default_flashbundle())
    ap.add_argument("--wifi-ssid", help="provision onto this AP instead of the rig's own")
    ap.add_argument("--wifi-pass", default="")
    ap.add_argument("--lease-timeout", type=float, default=60.0)
    ap.add_argument("--baseline", type=float, default=8.0, help="listen before the first rename")
    ap.add_argument("--window", type=float, default=30.0, help="seconds per rename")
    args = ap.parse_args()
    if not args.bundle:
        raise SystemExit("no flash bundle (run via bazel run, or pass --bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
