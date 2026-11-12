"""A browser-preconnect probe of a player's HTTPS slot (runs NEXT TO the DUT, in the
reservation env, so it sees the DUT's own TCP behaviour; a tunnel would terminate TCP
on the rig and hide it). Stdlib only.

Chrome opens spare sockets per navigation (preconnects) and keeps them idle in its
pool, TLS done, no request. The C6 netstack serves one connection and reclaims a
silent pre-WS peer after ~4 s. Reclaimed SILENTLY, the pooled socket still looks alive,
Chrome sends its request into it, gets reset, resends, and gives up
(ERR_TOO_MANY_RETRIES). Reclaimed with an RST, the socket is visibly dead while idle
and the browser simply dials a fresh one.

Each round, like Chrome:
  1. preconnect: TCP + TLS handshake to the DUT, then send nothing for --idle s,
     watching the socket; note whether (and when) the DUT reset it;
  2. use it: if it still looks alive, send GET / on it (what Chrome does with a pooled
     socket); otherwise dial a fresh connection and GET / on that.
Outcomes per round:
  reused_ok    the idle socket was still served (no reclaim happened)
  reset_idle   the DUT reset it while idle, and a fresh connection got its 200
  dead_send    the socket looked alive but the GET on it failed (the bug: Chrome
               would silently resend this)
  fresh_fail   reset while idle, but the fresh connection failed too

    python3 preconnect_probe.py <host> [--port 443] [--idle 7] [--rounds 5]
Prints one JSON line per round and a final `RESULT verdict=PASS|FAIL ...` line.
"""

from __future__ import annotations

import argparse
import json
import select
import socket
import ssl
import sys
import time


def _ctx() -> ssl.SSLContext:
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _connect(host: str, port: int, timeout: float) -> ssl.SSLSocket:
    raw = socket.create_connection((host, port), timeout=timeout)
    return _ctx().wrap_socket(raw, server_hostname=None)


def _get(s: ssl.SSLSocket, host: str, timeout: float) -> int | None:
    s.settimeout(timeout)
    s.sendall(f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
    line = b""
    while not line.endswith(b"\n"):
        b = s.recv(1)
        if not b:
            return None
        line += b
    parts = line.split()
    return int(parts[1]) if len(parts) >= 2 and parts[0].startswith(b"HTTP/") else None


def _idle_watch(s: ssl.SSLSocket, idle: float) -> float | None:
    """Sit idle for `idle` s. Return the time (s) the peer closed / reset the socket,
    or None if it stayed open."""
    t0 = time.monotonic()
    raw = s  # select works on the SSL socket's fd
    while True:
        left = idle - (time.monotonic() - t0)
        if left <= 0:
            return None
        r, _, _ = select.select([raw], [], [], left)
        if r:
            try:
                s.setblocking(False)
                data = s.recv(1)
            except (ssl.SSLWantReadError, BlockingIOError):
                continue  # a TLS record that isn't application data (e.g. a ticket)
            except (ConnectionError, ssl.SSLError, OSError):
                return time.monotonic() - t0
            finally:
                s.setblocking(True)
            if not data:
                return time.monotonic() - t0
            # Unsolicited data would be odd; treat the socket as alive.


def one_round(host: str, port: int, idle: float, timeout: float) -> dict:
    out: dict = {"idle_s": idle}
    try:
        s = _connect(host, port, timeout)
    except Exception as e:  # noqa: BLE001
        return {**out, "outcome": "connect_fail", "error": repr(e)}
    try:
        closed_at = _idle_watch(s, idle)
        out["closed_while_idle_at_s"] = closed_at
        if closed_at is None:
            try:
                st = _get(s, host, timeout)
                out["status"] = st
                out["outcome"] = "reused_ok" if st == 200 else "dead_send"
            except Exception as e:  # noqa: BLE001
                out.update(outcome="dead_send", error=repr(e))
            return out
    finally:
        try:
            s.close()
        except Exception:
            pass
    t0 = time.monotonic()
    try:
        f = _connect(host, port, timeout)
        st = _get(f, host, timeout)
        f.close()
        out.update(status=st, fresh_s=round(time.monotonic() - t0, 2))
        out["outcome"] = "reset_idle" if st == 200 else "fresh_fail"
    except Exception as e:  # noqa: BLE001
        out.update(outcome="fresh_fail", error=repr(e))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("host")
    ap.add_argument("--port", type=int, default=443)
    ap.add_argument("--idle", type=float, default=7.0)
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--timeout", type=float, default=15.0)
    a = ap.parse_args(argv)
    tally: dict[str, int] = {}
    for i in range(a.rounds):
        r = one_round(a.host, a.port, a.idle, a.timeout)
        r["round"] = i
        tally[r["outcome"]] = tally.get(r["outcome"], 0) + 1
        print(json.dumps(r), flush=True)
        time.sleep(1.0)
    bad = tally.get("dead_send", 0) + tally.get("fresh_fail", 0) + tally.get("connect_fail", 0)
    verdict = "PASS" if bad == 0 else "FAIL"
    print(f"RESULT verdict={verdict} " + " ".join(f"{k}={v}" for k, v in sorted(tally.items())), flush=True)
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
