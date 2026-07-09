"""Sim Studio HTTP API + static front-end host.

A thin FastAPI layer over :class:`StudioSession`. One session per server process
(it's a single-user debug tool). The Three.js front-end (``web/``) is served at
``/`` and talks to the ``/api`` endpoints below.

  POST /api/scene    {fixture, leds, scale}                 → scene (ground truth)
  POST /api/capture  {eye, target, hfov, imgW, imgH, noise} → capture summary
  POST /api/solve    {minViews, minParallaxDeg, huberDelta} → map + per-LED error
  POST /api/reset                                           → clear captures
  GET  /api/fixtures                                        → fixture names
  GET  /api/state                                           → counts
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .sim import FIXTURES, StudioSession, noise_from_dict

WEB_DIR = Path(__file__).resolve().parent / "web"


class SceneRequest(BaseModel):
    fixture: str = "cube"
    leds: int = 64
    scale: float = 1.0


class NoiseSpec(BaseModel):
    pixelNoisePx: float = 0.0
    poseNoiseDeg: float = 0.0
    poseNoisePosM: float = 0.0
    dropoutProb: float = 0.0


class CaptureRequest(BaseModel):
    eye: List[float]
    target: List[float]
    hfov: float = 70.0
    imgW: int = 1280
    imgH: int = 720
    seed: int = 0
    noise: Optional[NoiseSpec] = None


class SolveRequest(BaseModel):
    minViews: int = 2
    minParallaxDeg: float = 5.0
    huberDelta: float = 1.5


def create_app(web_dir: Optional[Path] = None) -> FastAPI:
    app = FastAPI(title="LED Mapper — Sim Studio", version="0.1.0")
    app.state.session = StudioSession()

    @app.get("/api/fixtures")
    async def fixtures():
        return {"fixtures": FIXTURES}

    @app.get("/api/state")
    async def state():
        return app.state.session.state()

    @app.post("/api/scene")
    async def scene(req: SceneRequest):
        try:
            return app.state.session.set_scene(req.fixture, req.leds, req.scale)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/capture")
    async def capture(req: CaptureRequest):
        if len(req.eye) != 3 or len(req.target) != 3:
            raise HTTPException(status_code=400, detail="eye and target must be 3-vectors")
        try:
            return app.state.session.capture(
                req.eye,
                req.target,
                hfov_deg=req.hfov,
                img_w=req.imgW,
                img_h=req.imgH,
                noise=noise_from_dict(req.noise.model_dump() if req.noise else None),
                seed=req.seed,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post("/api/solve")
    async def solve(req: SolveRequest):
        try:
            return app.state.session.solve(
                min_views=req.minViews,
                min_parallax_deg=req.minParallaxDeg,
                huber_delta=req.huberDelta,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post("/api/reset")
    async def reset():
        app.state.session.reset_captures()
        return app.state.session.state()

    web = Path(web_dir) if web_dir else WEB_DIR
    if web.is_dir():
        app.mount("/", StaticFiles(directory=str(web), html=True), name="web")

    return app
