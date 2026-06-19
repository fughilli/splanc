"""LED Mapper simulator (M9).

Synthetic ground truth for the reconstruction/CV pipelines (design doc §10.1).
Detection-log mode emits DetectionRecord-shaped observations for a known
fixture and a virtual walk, with injectable degradations, deterministic given a
seed.

    from simulator import generate_log, NoiseModel
    log, truth = generate_log("cube", 64, noise=NoiseModel(), seed=0)
"""

from __future__ import annotations

from .degrade import NOMINAL, NONE, PRESETS, NoiseModel
from .detection_log import generate_log
from .fixtures import make_fixture

__all__ = [
    "generate_log",
    "make_fixture",
    "NoiseModel",
    "NONE",
    "NOMINAL",
    "PRESETS",
]
