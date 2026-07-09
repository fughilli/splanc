"""LED Mapper Pi web server (M2, design doc §6 M2 / §3).

Serves the web app, runs the WebSocket control plane (the §7 message contract),
manages one capture session at a time, persists detection records to a session
log on disk, triggers reconstruction (M3) when a capture ends, and serves the
resulting maps.

Public surface:

    from server import create_app          # FastAPI ASGI app factory
    from server import SessionManager, MapStore, code_params_for

The transport (FastAPI/uvicorn/WebSocket) is intentionally thin: the session
bookkeeping and the message handling live in transport-agnostic objects
(:class:`SessionManager`, :class:`ConnectionHandler`) so they can be unit-tested
without standing up a socket.
"""

from __future__ import annotations

from .app import ServerContext, create_app
from .codebook import code_params_for
from .handler import ConnectionHandler
from .session import MapStore, SessionManager

__all__ = [
    "create_app",
    "ServerContext",
    "ConnectionHandler",
    "SessionManager",
    "MapStore",
    "code_params_for",
]
