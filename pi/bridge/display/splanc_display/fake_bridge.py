"""A stand-in for ``splanc-agent bridge``: writes status.json, answers control.sock.

For tests and for trying the screens without a relay::

    python3 -m splanc_display.fake_bridge --dir /tmp/fb --cycle 6
    SPLANC_BRIDGE_STATUS=/tmp/fb/status.json SPLANC_BRIDGE_CONTROL=/tmp/fb/control.sock \\
        python3 -m splanc_display.main --hdmi png:/tmp/fb/hdmi.png --oled png:/tmp/fb/oled.png

It follows the same contract as the real bridge: atomic writes (tmp + rename),
newline-delimited JSON commands, ``{"ok": true, ...}`` replies.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import string
import threading
import time

SAMPLE_PLAYERS = [
    {"name": "Living room arch", "host": "splanc-arch.local", "ok": True},
    {"name": "Porch lights", "host": "splanc-porch.local", "ok": True},
    {"name": "Tree wrap", "host": "192.168.1.57", "ok": False},
]


def sample(state: str, now: float, code: str = "K7QX-M2PD", **over) -> dict:
    """A plausible status document for ``state``."""
    doc = {
        "v": 1,
        "state": state,
        "relay": "wss://relay.splanc.io",
        "bridge_id": "br_4f9a2c71",
        "pairing": None,
        "clients": 0,
        "players": [],
        "lan_ip": "192.168.1.42",
        "error": None,
        "updated_at": int(now),
    }
    if state in ("unpaired", "pairing", "paired", "offline"):
        doc["players"] = SAMPLE_PLAYERS
    if state == "pairing":
        doc["pairing"] = {
            "code": code,
            "expires_at": int(now) + 272,
            "url": f"https://splanc.io/pair#{code}",
        }
    if state == "paired":
        doc["clients"] = 2
    if state == "starting":
        doc["lan_ip"] = ""
    if state == "error":
        doc["error"] = "relay rejected this bridge (bad credentials) - run: splanc-bridge logs"
    doc.update(over)
    return doc


def write_atomic(path: str, doc: dict) -> None:
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(doc, f)
    os.replace(tmp, path)


def new_code() -> str:
    alphabet = "".join(c for c in string.ascii_uppercase + string.digits if c not in "01OI")
    pick = "".join(random.choice(alphabet) for _ in range(8))
    return pick[:4] + "-" + pick[4:]


class FakeBridge:
    """Serves the control socket on a thread; ``commands`` records what it got."""

    def __init__(self, status_path: str, control_path: str):
        self.status_path = status_path
        self.control_path = control_path
        self.commands = []
        self.doc = sample("starting", time.time())
        self.fail = None  # set to a string to make every command fail with it
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._sock = None
        self._thread = None

    def set(self, doc: dict) -> None:
        with self._lock:
            self.doc = doc
            write_atomic(self.status_path, doc)

    def start(self) -> "FakeBridge":
        if os.path.exists(self.control_path):
            os.unlink(self.control_path)
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.bind(self.control_path)
        self._sock.listen(8)
        self._sock.settimeout(0.2)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(2)
        if self._sock:
            self._sock.close()
        for p in (self.control_path,):
            try:
                os.unlink(p)
            except OSError:
                pass

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                conn.settimeout(2)
                buf = b""
                try:
                    while b"\n" not in buf:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        buf += chunk
                    reply = self.handle(buf.split(b"\n", 1)[0])
                    conn.sendall((json.dumps(reply) + "\n").encode())
                except OSError:
                    pass

    def handle(self, line: bytes) -> dict:
        try:
            req = json.loads(line.decode())
            cmd = req["cmd"]
        except (ValueError, KeyError, TypeError):
            return {"ok": False, "error": "bad request"}
        self.commands.append(cmd)
        if self.fail:
            return {"ok": False, "error": self.fail}
        now = time.time()
        if cmd == "new_pairing_code":
            code = new_code()
            self.set(sample("pairing", now, code=code, clients=self.doc.get("clients", 0)))
            return {"ok": True, "code": code}
        if cmd == "revoke_all":
            self.set(sample("unpaired", now))
            return {"ok": True, "revoked": 2}
        if cmd == "identify":
            return {"ok": True, "players": len(self.doc.get("players") or [])}
        return {"ok": False, "error": f"unknown command {cmd!r}"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", default="/tmp/splanc-fake-bridge")
    ap.add_argument(
        "--cycle", type=float, default=6.0, help="seconds per state (0 = stay in --state)"
    )
    ap.add_argument("--state", default="pairing")
    a = ap.parse_args(argv)
    os.makedirs(a.dir, exist_ok=True)
    fb = FakeBridge(os.path.join(a.dir, "status.json"), os.path.join(a.dir, "control.sock")).start()
    order = ["starting", "offline", "unpaired", "pairing", "paired", "error"]
    i = order.index(a.state) if a.state in order else 3
    try:
        while True:
            fb.set(sample(order[i], time.time()))
            print("state:", order[i], flush=True)
            if a.cycle <= 0:
                while True:
                    time.sleep(3600)
            time.sleep(a.cycle)
            i = (i + 1) % len(order)
    except KeyboardInterrupt:
        pass
    finally:
        fb.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
