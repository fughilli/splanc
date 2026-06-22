"""FastAPI ASGI app (M2 transport layer, design doc §6 M2).

Wires the §7 WebSocket control plane and the HTTP surface:

  * ``GET /healthz``            — liveness probe.
  * ``WS  /ws``                 — all control + data (§7), one ConnectionHandler each.
  * ``GET /maps/{id}``          — reconstructed OutputMap JSON.
  * ``GET /maps/{id}.csv``      — flat CSV (design doc §7.5).
  * ``/`` (+ assets)            — the built web app (static), or a Phase-0 hello page.

Everything stateful lives in `ServerContext`; this module is just plumbing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .clock import now_ms
from .codebook import DEFAULT_BIT_PERIOD_MS
from .handler import ConnectionHandler, ServerContext
from .reconstruct import ReconstructionRunner
from .session import MapStore, SessionManager

_HELLO_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>LED Mapper</title></head>
<body style="font-family:system-ui;margin:3rem">
<h1>LED Mapper</h1>
<p>Pi server (M2) is up. The web app (M5–M8) is not built into this image yet.</p>
<p>WebSocket control plane: <code>ws://&lt;host&gt;/ws</code> · health: <code>/healthz</code></p>
</body></html>
"""


def create_app(
    *,
    session_dir: Path,
    maps_dir: Path,
    web_root: Optional[Path] = None,
    default_led_count: int = 1024,
    bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
    context: Optional[ServerContext] = None,
) -> FastAPI:
    """Build the FastAPI app.

    ``context`` lets tests inject a :class:`ServerContext` (e.g. with a stub
    reconstructor or a deterministic id factory); by default a real one is built
    from a :class:`SessionManager` + :class:`MapStore` + :class:`ReconstructionRunner`.
    """
    maps = MapStore(maps_dir)
    if context is None:
        context = ServerContext(
            SessionManager(session_dir),
            ReconstructionRunner(maps),
            default_led_count=default_led_count,
            bit_period_ms=bit_period_ms,
        )

    app = FastAPI(title="LED Mapper", version="0.1.0")
    app.state.context = context
    app.state.maps = maps

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    # Declared before "/maps/{map_id}" so the trailing-.csv form wins the match.
    @app.get("/maps/{map_id}.csv")
    async def get_map_csv(map_id: str):
        if not maps.exists(map_id):
            raise HTTPException(status_code=404, detail="map not found")
        return FileResponse(maps.csv_path(map_id), media_type="text/csv")

    @app.get("/maps/{map_id}")
    async def get_map(map_id: str):
        if not maps.exists(map_id):
            raise HTTPException(status_code=404, detail="map not found")
        return FileResponse(maps.json_path(map_id), media_type="application/json")

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        handler = ConnectionHandler(context)
        try:
            while True:
                raw = await websocket.receive_text()
                recv_ms = now_ms()
                for response in await handler.handle(raw, recv_ms=recv_ms):
                    await websocket.send_text(response.model_dump_json())
        except WebSocketDisconnect:
            return

    # Static web app last, so the API routes above take precedence. Falls back
    # to a Phase-0 hello page when no built web app is present.
    if web_root is not None and Path(web_root).is_dir():
        app.mount("/", StaticFiles(directory=str(web_root), html=True), name="web")
    else:

        @app.get("/", response_class=HTMLResponse)
        async def index():
            return _HELLO_PAGE

    return app
