"""Station side of the app-driver control channel (phone-in-the-loop HITL).

The web/PWA app, loaded with `?driver=ws://<station>:<port>/`, connects BACK to
this server (see web/src/driver/harness.ts) and turns our JSON commands into calls
on the real production functions — `appState.connect`, `provisionViaBle`,
`client.startMapping/stopMapping/setHardwareConfig/setColorCorrection`,
`router.navigate` — streaming app-state transitions + milestones back to us. So we
drive the actual user journeys (scan/connect, mapping, gamma/hardware config) and
assert on the app's real replies, from a plain Python script, against a phone
(emulator now, real device later) and a real ESP32-C6 device backend via the rig.

Wire protocol (one JSON object per WS frame):
  station -> app : {"id", "kind":"command"|"query", "method", "params"}
  app -> station : {"id", "kind":"result"|"error", "ok", "value"|"error"}
                   {"kind":"event", "event":"ready"|"state"|"milestone"|"error", ...}

Uses `websockets` (already a harness dep — see hitl_map_upload.py). Async: journey
scripts are async and run under asyncio.run (mirrors the map-upload harness).
"""

from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any

import websockets


class DriverError(RuntimeError):
    """A driven command failed on the app side, or the app never connected."""


class AppDriver:
    """One connected app. Send commands/queries, await results + events.

    Construct via `AppDriver.serve(port)` (an async context manager that waits for
    the app to connect back and report `ready`). Not thread-safe: drive it from one
    asyncio task, as the journey scripts do.
    """

    def __init__(self) -> None:
        self._ws: websockets.WebSocketServerProtocol | None = None
        self._ids = itertools.count(1)
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._connected: asyncio.Event = asyncio.Event()
        self._ready: asyncio.Event = asyncio.Event()

    # --- lifecycle -------------------------------------------------------
    @classmethod
    def serve(cls, port: int, host: str = "0.0.0.0") -> "_DriverServerCtx":
        return _DriverServerCtx(cls(), host, port)

    async def _on_conn(self, ws: websockets.WebSocketServerProtocol) -> None:
        # One app at a time — the station drives a single phone.
        self._ws = ws
        self._connected.set()
        try:
            async for raw in ws:
                self._dispatch_incoming(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    def _dispatch_incoming(self, msg: dict[str, Any]) -> None:
        kind = msg.get("kind")
        if kind in ("result", "error"):
            fut = self._pending.pop(str(msg.get("id")), None)
            if fut and not fut.done():
                if msg.get("ok"):
                    fut.set_result(msg.get("value"))
                else:
                    fut.set_exception(DriverError(str(msg.get("error"))))
        elif kind == "event":
            if msg.get("event") == "ready":
                self._ready.set()
            self._events.put_nowait(msg)

    async def wait_ready(self, timeout: float = 60.0) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout)
        await asyncio.wait_for(self._ready.wait(), timeout)

    # --- driving ---------------------------------------------------------
    async def _rpc(self, kind: str, method: str, params: dict[str, Any], timeout: float) -> Any:
        if self._ws is None:
            raise DriverError("app not connected")
        mid = f"m{next(self._ids)}"
        fut: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self._ws.send(
            json.dumps({"id": mid, "kind": kind, "method": method, "params": params})
        )
        return await asyncio.wait_for(fut, timeout)

    async def command(self, method: str, timeout: float = 60.0, **params: Any) -> Any:
        return await self._rpc("command", method, params, timeout)

    async def query(self, method: str, timeout: float = 15.0, **params: Any) -> Any:
        return await self._rpc("query", method, params, timeout)

    async def wait_event(self, event: str, timeout: float = 60.0, **match: Any) -> dict[str, Any]:
        """Await the next `event` whose fields match `match` (e.g. name="result_ready")."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise DriverError(f"timed out waiting for event {event} {match}")
            msg = await asyncio.wait_for(self._events.get(), remaining)
            if msg.get("event") != event:
                continue
            if all(msg.get(k) == v for k, v in match.items()):
                return msg

    # --- convenience wrappers (the three journeys use these) -------------
    async def navigate(self, path: str) -> Any:
        return await self.command("navigate", path=path)

    async def connect(self, wss_url: str, label: str | None = None) -> None:
        await self.command("connect", wssUrl=wss_url, label=label)

    async def provision_ble(self, ssid: str, password: str) -> dict[str, Any]:
        return await self.command("provisionBle", ssid=ssid, password=password, timeout=90.0)

    async def start_mapping(self, led_count: int, **config: Any) -> Any:
        return await self.command("startMapping", ledCount=led_count, config=config, timeout=120.0)

    async def stop_mapping(self) -> Any:
        return await self.command("stopMapping", timeout=180.0)

    async def set_hw_config(self, **cfg: Any) -> Any:
        return await self.command("setHardwareConfig", **cfg)

    async def set_color_correction(self, **cc: Any) -> Any:
        return await self.command("setColorCorrection", **cc)

    async def wait_connected(self, timeout: float = 60.0) -> dict[str, Any]:
        """Await the state event where the connection reaches 'connected'."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        # Fast path: already connected.
        snap = await self.query("appState")
        if isinstance(snap, dict) and (snap.get("status") or {}).get("state") == "connected":
            return snap
        while loop.time() < deadline:
            ev = await self.wait_event("state", timeout=deadline - loop.time())
            if (ev.get("status") or {}).get("state") == "connected":
                return ev
        raise DriverError("never reached connected")


class _DriverServerCtx:
    """Async context manager: run the WS server for the driver's lifetime."""

    def __init__(self, driver: AppDriver, host: str, port: int) -> None:
        self._driver = driver
        self._host = host
        self._port = port
        self._server: Any = None

    async def __aenter__(self) -> AppDriver:
        self._server = await websockets.serve(self._driver._on_conn, self._host, self._port)
        return self._driver

    async def __aexit__(self, *exc: Any) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
