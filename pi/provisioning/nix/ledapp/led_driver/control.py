"""Local control socket between M1 (driver) and M2 (server) (design doc §3).

The driver process owns the SPI bus and the pattern clock; the server talks to it
over a Unix domain socket using a newline-delimited JSON command protocol. Keeping
this a separate process means the server can be restarted without dropping the
pattern, and the driver can run at real-time priority (M4 systemd unit).

Commands (client → driver) and replies (driver → client), one JSON object per
line:

    {"cmd":"start","codeParams":{…}}   → {"ok":true,"patternClockEpoch":<ms>}
    {"cmd":"stop"}                      → {"ok":true}
    {"cmd":"get_clock"}                 → {"ok":true,"epoch":…,"bitPeriodMs":…,"cycleLen":…}
    {"cmd":"set_debug","mode":"single","args":{"ledId":5}} → {"ok":true}
    <anything invalid>                  → {"ok":false,"error":"…"}
"""

from __future__ import annotations

import json
import os
import socket
import threading
from typing import Optional

from ledmapper_protocol import CodeParams

from .driver import LedDriver


def _dispatch(driver: LedDriver, msg: dict) -> dict:
    """Apply one parsed command to the driver and return the reply dict."""
    cmd = msg.get("cmd")
    if cmd == "start":
        params = CodeParams.model_validate(msg["codeParams"])
        epoch = driver.start(params)
        return {"ok": True, "patternClockEpoch": epoch}
    if cmd == "stop":
        driver.stop()
        return {"ok": True}
    if cmd == "get_clock":
        return {"ok": True, **driver.get_clock()}
    if cmd == "set_debug":
        driver.set_debug(msg["mode"], msg.get("args"))
        return {"ok": True}
    raise ValueError(f"unknown command {cmd!r}")


def handle_line(driver: LedDriver, line: str) -> str:
    """Parse one request line, dispatch, and return the reply line (JSON)."""
    try:
        msg = json.loads(line)
        reply = _dispatch(driver, msg)
    except Exception as exc:  # malformed / invalid → structured error, keep serving
        reply = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return json.dumps(reply)


class ControlServer:
    """Serves :class:`LedDriver` over a Unix domain socket."""

    def __init__(self, driver: LedDriver, socket_path: str):
        self.driver = driver
        self.socket_path = socket_path
        self._sock: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        """Bind the socket and accept connections on a background thread."""
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        parent = os.path.dirname(self.socket_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.bind(self.socket_path)
        self._sock.listen(8)
        self._sock.settimeout(0.5)
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name="led-control", daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                self._serve_conn(conn)

    def _serve_conn(self, conn: socket.socket) -> None:
        buf = b""
        conn.settimeout(0.5)
        while not self._stop.is_set():
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                reply = handle_line(self.driver, line.decode())
                try:
                    conn.sendall((reply + "\n").encode())
                except OSError:
                    return

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None
        if self._sock is not None:
            self._sock.close()
            self._sock = None
        if os.path.exists(self.socket_path):
            try:
                os.unlink(self.socket_path)
            except OSError:
                pass


class ControlClient:
    """Thin client M2 uses to drive M1 over the control socket."""

    def __init__(self, socket_path: str, timeout: float = 5.0):
        self.socket_path = socket_path
        self.timeout = timeout

    def _request(self, msg: dict) -> dict:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(self.timeout)
            s.connect(self.socket_path)
            s.sendall((json.dumps(msg) + "\n").encode())
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        line = buf.split(b"\n", 1)[0]
        return json.loads(line.decode())

    def start(self, code_params: CodeParams) -> float:
        reply = self._request({"cmd": "start", "codeParams": code_params.model_dump()})
        if not reply.get("ok"):
            raise RuntimeError(reply.get("error", "start failed"))
        return reply["patternClockEpoch"]

    def stop(self) -> None:
        self._request({"cmd": "stop"})

    def get_clock(self) -> dict:
        return self._request({"cmd": "get_clock"})

    def set_debug(self, mode: str, args: Optional[dict] = None) -> None:
        self._request({"cmd": "set_debug", "mode": mode, "args": args})
