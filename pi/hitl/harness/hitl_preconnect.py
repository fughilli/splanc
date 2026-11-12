"""HITL: a browser's preconnected socket must not wedge the cert-trust page
(Android Chrome ERR_TOO_MANY_RETRIES).

Flash the netstack player, provision it onto the rig AP, then run
preconnect_probe.py IN the reservation env (next to the DUT, so it sees the DUT's own
TCP behaviour): open a TLS connection, sit idle past the netstack's ~4 s silent-peer
reclaim like a Chrome preconnect, then use it. The DUT must either still serve it or
have reset it while idle; a socket that looks alive but fails on use (a silent
reclaim) is what makes Chrome resend until it gives up, and fails the test.

    bazel run //pi/hitl/harness:preconnect_netstack
    bazel run //pi/hitl/harness:preconnect_netstack -- --no-flash --rounds 8
"""

from __future__ import annotations

import argparse
import os
import sys

from python.runfiles import runfiles


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(path: str) -> str | None:
    try:
        return runfiles.Create().Rlocation(path)
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default=None)
    ap.add_argument("--owner", default=os.environ.get("USER", "preconnect"))
    ap.add_argument(
        "--bundle",
        default=_runfile(
            os.environ.get(
                "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
            )
        ),
    )
    ap.add_argument("--no-flash", action="store_true")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--idle", type=float, default=7.0)
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    a = ap.parse_args(argv)

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    probe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preconnect_probe.py")
    res = Reservation(server=a.server, owner=a.owner)
    res.acquire()
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        if not a.no_flash:
            if not a.bundle or not os.path.exists(a.bundle):
                raise SystemExit(f"no flash bundle: {a.bundle}")
            _log(f"[flash] {os.path.basename(a.bundle)} -> {res.host}")
            res.scp_to([a.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(a.bundle)} --erase-fs --monitor --monitor-seconds 6",
                capture=True,
                timeout=200,
            )
        redirect = provision_dut(res, ssid, password, a.improv_timeout, a.improv_attempts)
        host, port = dut_target(redirect, "wss")
        _log(f"[dut] {host}:{port}")
        res.scp_to([probe], "/tmp/")
        with res.ap_lock("preconnect probe"):
            p = res.ssh(
                f"python3 /tmp/preconnect_probe.py {host} --port {port} "
                f"--rounds {a.rounds} --idle {a.idle:g}",
                capture=True,
                timeout=int(a.rounds * (a.idle + 40) + 60),
            )
        out = (p.stdout or "") + (p.stderr or "")
        for line in out.splitlines():
            _log(f"[probe] {line}")
        verdict = next(
            (ln for ln in out.splitlines() if ln.startswith("RESULT ")),
            "RESULT verdict=FAIL (no result)",
        )
        _log(f"[result] {verdict}")
        return 0 if "verdict=PASS" in verdict else 1
    finally:
        res.release()


if __name__ == "__main__":
    sys.exit(main())
