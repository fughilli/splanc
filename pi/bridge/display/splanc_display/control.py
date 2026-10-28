"""Client for the bridge's control socket (newline-delimited JSON over AF_UNIX).

-> {"cmd": "new_pairing_code"} | {"cmd": "revoke_all"} | {"cmd": "identify"}
   | {"cmd": "clients"} | {"cmd": "revoke", "grant": "<client id>"}
<- {"ok": true, ...} | {"ok": false, "error": "..."}
"""

from __future__ import annotations

import json
import socket
from typing import Optional

from . import status as st

COMMANDS = ("new_pairing_code", "revoke_all", "identify", "clients", "revoke")


class ControlError(Exception):
    pass


def send(cmd: str, path: Optional[str] = None, timeout: float = 5.0, **args) -> dict:
    """Send one command, return the decoded reply. Raises ControlError."""
    path = path or st.control_path()
    req = dict(args, cmd=cmd)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(path)
            s.sendall((json.dumps(req) + "\n").encode())
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
    except FileNotFoundError:
        raise ControlError("bridge is not running (no control socket)")
    except ConnectionRefusedError:
        raise ControlError("bridge is not accepting commands")
    except socket.timeout:
        raise ControlError("bridge did not answer")
    except OSError as e:
        raise ControlError(f"control socket: {e.strerror or e}")
    line = buf.split(b"\n", 1)[0].strip()
    if not line:
        raise ControlError("bridge closed the connection without answering")
    try:
        reply = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ControlError("bridge sent an unreadable reply")
    if not isinstance(reply, dict):
        raise ControlError("bridge sent an unexpected reply")
    if reply.get("ok") is not True:
        raise ControlError(str(reply.get("error") or "bridge refused the command"))
    return reply
