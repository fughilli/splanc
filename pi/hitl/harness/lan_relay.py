"""A TCP relay that gives a browser on the far side of an ssh tunnel the SAME
socket semantics it would have on the DUT's LAN.

An `ssh -L` straight to the DUT hides what the browser path depends on: the tunnel's
local end stays open while the far end's TCP is half-open (the DUT rebooted under it),
and sshd never probes it, so the browser never sees the close a phone on the LAN does.
This relay runs INSIDE the reservation container (stdlib python3 only), next to the
DUT's network, and for every accepted connection:

  * dials the DUT with the kernel's normal connect behaviour (a rebooting DUT = SYNs
    that go unanswered; the browser's own connect timeout decides when to give up);
  * arms TCP keepalive on the DUT-side socket with Chromium's values (idle 45 s,
    interval 45 s), so a half-open connection to a DUT that rebooted is detected the
    way Chrome detects it on a LAN (the DUT's netstack RSTs the probe);
  * propagates a DUT-side close/RST to the browser as an abortive close (RST), and a
    browser-side close to the DUT.

Each connection is logged (`open`/`close` with timestamps, bytes and the reason, and
the sha256 of the certificate the DUT presented) to stdout, which the harness keeps as
evidence of the browser's reconnect attempts and of which TLS identity served each.

A slow Wi-Fi join (the field case: a network the DUT takes a minute or more to rejoin
after a restart) can be emulated with a BLACKOUT: while the epoch time in
/tmp/lan_relay.blackout is in the future, the DUT is "off the network" — new
connections hang (unanswered SYNs: only the browser's own connect timeout ends them),
and a half-open connection's reset is only delivered at the first keepalive probe
after the blackout (Chromium probes every 45 s), exactly what a phone would see.

    python3 lan_relay.py --listen-port 9443 --target 10.42.0.57:443
"""

from __future__ import annotations

import argparse
import hashlib
import select
import socket
import struct
import sys
import threading
import time

CHROME_KEEPALIVE_S = 45
BLACKOUT_FILE = "/tmp/lan_relay.blackout"


def blackout_until() -> float:
    """The end of the current blackout (epoch s), or 0. The file holds `<end>` or
    `<start> <end>`."""
    try:
        with open(BLACKOUT_FILE) as f:
            parts = [float(x) for x in f.read().split()]
    except (OSError, ValueError):
        return 0.0
    if not parts:
        return 0.0
    start, end = (parts[0], parts[1]) if len(parts) > 1 else (0.0, parts[0])
    return end if start <= time.time() < end else 0.0


def cert_sha(buf: bytes) -> str | None:
    """sha256 of the first certificate in a TLS 1.2 server flight (cleartext), or None
    while more bytes are needed / it isn't there."""
    recs = b""
    i = 0
    while i + 5 <= len(buf):
        ctype, ln = buf[i], int.from_bytes(buf[i + 3 : i + 5], "big")
        if i + 5 + ln > len(buf):
            break
        if ctype == 22:
            recs += buf[i + 5 : i + 5 + ln]
        i += 5 + ln
    j = 0
    while j + 4 <= len(recs):
        htype, hl = recs[j], int.from_bytes(recs[j + 1 : j + 4], "big")
        if htype == 11 and j + 4 + hl <= len(recs):
            body = recs[j + 4 : j + 4 + hl]
            if len(body) >= 6:
                cl = int.from_bytes(body[3:6], "big")
                return hashlib.sha256(body[6 : 6 + cl]).hexdigest()
        if j + 4 + hl > len(recs):
            return None
        j += 4 + hl
    return None


def _log(msg: str) -> None:
    sys.stdout.write(f"[relay t={time.time():.3f}] {msg}\n")
    sys.stdout.flush()


def _abort(sock: socket.socket) -> None:
    """Close with RST (SO_LINGER 0), like a peer whose connection was reset."""
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def _keepalive(sock: socket.socket, idle: int) -> None:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    for opt, val in (("TCP_KEEPIDLE", idle), ("TCP_KEEPINTVL", idle), ("TCP_KEEPCNT", 9)):
        if hasattr(socket, opt):
            sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), val)


def serve_one(cid: int, client: socket.socket, target: tuple[str, int], idle: int) -> None:
    t0 = time.monotonic()
    # A DUT off the network: the SYN goes unanswered until it's back (or the browser
    # gives up on this attempt and closes it).
    while blackout_until() > 0:
        r, _, _ = select.select([client], [], [], 0.5)
        if r:
            try:
                d = client.recv(1, socket.MSG_PEEK)
            except OSError:
                d = b""
            if not d:
                _log(
                    f"conn={cid} browser gave up after {time.monotonic() - t0:.1f}s (DUT unreachable)"
                )
                client.close()
                return
    up = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _keepalive(up, idle)
    try:
        up.connect(target)
    except OSError as e:
        _log(f"conn={cid} connect-failed after {time.monotonic() - t0:.1f}s: {e}")
        _abort(up)
        _abort(client)
        return
    _log(f"conn={cid} open (connect {time.monotonic() - t0:.2f}s)")
    sent = recv = 0
    why = "?"
    head = b""
    cert_logged = False
    last_io = time.time()
    try:
        while True:
            dark = blackout_until() > 0
            # While dark nothing reaches the DUT and nothing comes back from it.
            r, _, _ = select.select([client] if dark else [client, up], [], [], 1.0)
            if dark and client in r:
                # Browser data for a DUT that's off the network: it would sit in the
                # browser's retransmit queue. Hold it (don't read) — but notice a close.
                try:
                    peek = client.recv(1, socket.MSG_PEEK)
                except OSError:
                    peek = b""
                if not peek:
                    why = "browser closed (DUT unreachable)"
                    break
                time.sleep(0.2)
                continue
            if client in r:
                try:
                    d = client.recv(65536)
                except OSError as e:
                    why = f"browser error {e}"
                    break
                if not d:
                    why = "browser closed"
                    break
                up.sendall(d)
                sent += len(d)
                last_io = time.time()
            if up in r:
                try:
                    d = up.recv(65536)
                except OSError as e:
                    # A reset found by a keepalive probe. After a blackout, a phone only
                    # learns of it at its next probe tick (every `idle` s since the last
                    # traffic), not the moment the DUT is back.
                    now = time.time()
                    ticks = max(1, int(-(-(now - last_io) // idle)))
                    at = last_io + ticks * idle
                    if at > now + 0.5:
                        _log(
                            f"conn={cid} reset seen; delivering at the probe tick in {at - now:.0f}s"
                        )
                        time.sleep(at - now)
                    why = f"dut error {e}"
                    _abort(client)
                    client = None  # type: ignore[assignment]
                    break
                if not d:
                    why = "dut closed"
                    break
                if not cert_logged and len(head) < 16384:
                    head += d
                    sha = cert_sha(head)
                    if sha:
                        cert_logged = True
                        _log(f"conn={cid} cert sha256={sha}")
                client.sendall(d)
                recv += len(d)
                last_io = time.time()
    except OSError as e:
        why = f"io error {e}"
    _log(f"conn={cid} close after {time.monotonic() - t0:.1f}s: {why} up={sent} down={recv}")
    if client is not None:
        try:
            client.close()
        except OSError:
            pass
    _abort(up) if why.startswith("dut error") else up.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen-port", type=int, required=True)
    ap.add_argument("--target", required=True, help="host:port of the DUT")
    ap.add_argument("--keepalive", type=int, default=CHROME_KEEPALIVE_S)
    a = ap.parse_args()
    host, port = a.target.rsplit(":", 1)
    ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", a.listen_port))
    ls.listen(16)
    _log(f"listening 127.0.0.1:{a.listen_port} -> {host}:{port} keepalive={a.keepalive}s")
    cid = 0
    while True:
        c, _ = ls.accept()
        cid += 1
        threading.Thread(
            target=serve_one, args=(cid, c, (host, int(port)), a.keepalive), daemon=True
        ).start()


if __name__ == "__main__":
    main()
