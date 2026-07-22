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

import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from ledmapper_protocol import ErrorMessage

from . import proto_wire
from .clock import now_ms
from .codebook import DEFAULT_BIT_PERIOD_MS
from .debug import led_report, session_overview
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
    solver_dir: Optional[Path] = None,
    pulse_dir: Optional[Path] = None,
    fx_compiler_dir: Optional[Path] = None,
    fx_vm_dir: Optional[Path] = None,
    default_led_count: int = 1024,
    bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
    symbols: int = 2,
    context: Optional[ServerContext] = None,
    run_solver_benchmark: bool = True,
) -> FastAPI:
    """Build the FastAPI app.

    ``context`` lets tests inject a :class:`ServerContext` (e.g. with a stub
    reconstructor or a deterministic id factory); by default a real one is built
    from a :class:`SessionManager` + :class:`MapStore` + :class:`ReconstructionRunner`.

    ``solver_dir`` serves the wasm solver bundle (//solver:solver_wasm_pkg)
    at /solver/ for the phone's in-browser final solve. ``pulse_dir`` serves
    the wasm effects Sim (//firmware/pulse:pulse_web) at /pulse/ for the
    effects-simulator workspace (effects.html). ``fx_compiler_dir`` and
    ``fx_vm_dir`` serve the wasm effects compiler (//fx_compiler:fx_compiler_web)
    at /fx-compiler/ and the preview VM (//firmware/fx_vm:fx_vm_web) at /fx-vm/
    for the effects-editor workspace (editor.html).
    """
    maps = MapStore(maps_dir)
    if context is None:
        context = ServerContext(
            SessionManager(session_dir),
            ReconstructionRunner(maps),
            default_led_count=default_led_count,
            bit_period_ms=bit_period_ms,
            symbols=symbols,
            map_store=maps,
        )
        if run_solver_benchmark:
            # Host solver-placement score (§7 welcome.solverBenchMs): measure
            # once, off the startup path — welcome carries null until done.
            import threading

            from . import native_solver

            def _bench(ctx: ServerContext = context) -> None:
                ctx.solver_bench_ms = native_solver.benchmark()

            threading.Thread(target=_bench, name="solver-bench", daemon=True).start()

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

    # -- ground-truth relay (dev-only; §7-external) -------------------------
    # The virtual LED wall publishes its exact layout here (pitch-normalized,
    # including ragged last rows); the capture app's result view fetches it so
    # the truth overlay always matches what the wall actually displays.
    app.state.truth = None

    @app.post("/truth")
    async def post_truth(request: Request):
        app.state.truth = await request.json()
        return {"ok": True}

    @app.get("/truth")
    async def get_truth():
        if app.state.truth is None:
            raise HTTPException(status_code=404, detail="no ground truth published")
        return app.state.truth

    # Raw per-frame blob recording (capture page `?record=1`): the full
    # detector output stream, for offline diagnosis of what the CV stage
    # actually sees. Appends JSONL; a `reset` payload starts a new file.
    # DeviceMotion samples ride along as {"imu": {...}} lines (raw units, see
    # the client's reset record) — the input the VIO exploration's offline
    # joint pose+LED solver consumes (docs/vio-exploration.md).
    @app.post("/debug/frames")
    async def post_frames(request: Request):
        payload = await request.json()
        path = Path(session_dir) / "frames-latest.jsonl"
        mode = "w" if payload.get("reset") else "a"
        with path.open(mode) as f:
            if payload.get("reset"):
                f.write(
                    json.dumps({k: v for k, v in payload.items() if k not in ("frames", "imu")})
                    + "\n"
                )
            for frame in payload.get("frames", []):
                f.write(json.dumps(frame) + "\n")
            for sample in payload.get("imu", []):
                f.write(json.dumps({"imu": sample}) + "\n")
        return {"ok": True}

    # -- solver diagnostics (dev-only; §7-external) -------------------------
    # Reads the ACTIVE session, falling back to the most recently persisted
    # session log, so a study works both mid-walk and just after stop.

    def _study_detections():
        snap = context.sessions.snapshot()
        if snap is not None:
            _sid, led_count, detections, _imu = snap
            return detections, led_count, "active"
        logs = sorted(
            Path(session_dir).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )
        if not logs:
            return None, None, None
        data = json.loads(logs[0].read_text())
        return data.get("detections", []), data.get("ledCount"), logs[0].name

    @app.get("/debug/led/{led_id}")
    async def debug_led(led_id: int):
        detections, _led_count, source = _study_detections()
        if detections is None:
            raise HTTPException(status_code=404, detail="no session (active or persisted)")
        live_map = context.live.latest_map
        report = led_report(detections, led_id, live_map, list(context.live.history))
        report["source"] = source
        return report

    @app.get("/debug/session")
    async def debug_session():
        detections, led_count, source = _study_detections()
        if detections is None:
            raise HTTPException(status_code=404, detail="no session (active or persisted)")
        overview = session_overview(detections, led_count)
        overview["source"] = source
        return overview

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        handler = ConnectionHandler(context)
        # Each message is handled in its own task so a SLOW handler cannot
        # starve the receive loop — concretely: stop_mapping awaits the final
        # reconstruction (seconds), while the phone keeps polling
        # get_solve_status on the same socket for the progress bar. Ordering
        # is still effectively FIFO for the fast handlers (they contain no
        # awaits, so tasks created in order complete in order); sends are
        # serialized by a lock. Tasks are not cancelled on disconnect — an
        # in-flight final solve must still persist its map; its send just
        # fails quietly on the closed socket.
        import asyncio

        send_lock = asyncio.Lock()
        pending: set = set()

        async def dispatch(frame: bytes, recv_ms: float) -> None:
            # Binary protobuf on the wire (proto-comms); the handler still
            # speaks the flat-JSON §7 shape — proto_wire is the boundary.
            try:
                flat = proto_wire.decode_client(frame)
            except Exception:
                responses = [
                    ErrorMessage(type="error", code="bad_message", message="undecodable frame")
                ]
            else:
                responses = await handler.handle(json.dumps(flat), recv_ms=recv_ms)
            try:
                async with send_lock:
                    for response in responses:
                        await websocket.send_bytes(
                            proto_wire.encode_server(json.loads(response.model_dump_json()))
                        )
            except Exception:
                pass  # client went away; the work itself is already done

        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                frame = message.get("bytes")
                if frame is None:
                    # Text frames are the pre-protobuf wire — reject loudly.
                    async with send_lock:
                        await websocket.send_bytes(
                            proto_wire.encode_server(
                                {
                                    "type": "error",
                                    "code": "bad_message",
                                    "message": "expected binary protobuf frame",
                                }
                            )
                        )
                    continue
                task = asyncio.create_task(dispatch(frame, now_ms()))
                pending.add(task)
                task.add_done_callback(pending.discard)
        except WebSocketDisconnect:
            return

    # The wasm solver bundle (phone-side final solve). Mounted before "/" so
    # the app's static mount cannot shadow it.
    if solver_dir is not None and Path(solver_dir).is_dir():
        app.mount("/solver", StaticFiles(directory=str(solver_dir)), name="solver")

    # The wasm effects Sim (effects-simulator workspace). Mounted before "/".
    if pulse_dir is not None and Path(pulse_dir).is_dir():
        app.mount("/pulse", StaticFiles(directory=str(pulse_dir)), name="pulse")

    # The wasm effects compiler + preview VM (effects-editor workspace).
    # Mounted before "/" so the app's static mount cannot shadow them.
    if fx_compiler_dir is not None and Path(fx_compiler_dir).is_dir():
        app.mount(
            "/fx-compiler", StaticFiles(directory=str(fx_compiler_dir)), name="fx-compiler"
        )
    if fx_vm_dir is not None and Path(fx_vm_dir).is_dir():
        app.mount("/fx-vm", StaticFiles(directory=str(fx_vm_dir)), name="fx-vm")

    # Static web app last, so the API routes above take precedence. Falls back
    # to a Phase-0 hello page when no built web app is present.
    if web_root is not None and Path(web_root).is_dir():
        app.mount("/", StaticFiles(directory=str(web_root), html=True), name="web")
    else:

        @app.get("/", response_class=HTMLResponse)
        async def index():
            return _HELLO_PAGE

    return app
