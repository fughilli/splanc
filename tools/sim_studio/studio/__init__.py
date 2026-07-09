"""LED Mapper — Sim Studio.

An interactive 3D tool to generate LED fixtures, fly a camera around to
synthesize captures, and watch the real M3 solver converge against ground truth.
Reuses M9 (fixtures, noise), the shared M3 camera model, and M3 reconstruction —
so it debugs the actual algorithm.

    bazelisk run //tools/sim_studio:serve -- --port 8090
    # then open http://127.0.0.1:8090
"""

from __future__ import annotations

from .app import create_app
from .sim import StudioSession

__all__ = ["create_app", "StudioSession"]
