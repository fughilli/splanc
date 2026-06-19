"""LED Mapper reconstruction (M3).

Recovers per-LED 3D positions from a session's detection records (design doc
§8.3): DLT triangulation init → sparse bundle adjustment with a Huber loss →
outlier rejection → per-LED quality metrics → an :class:`OutputMap` (§7.5).

Public API:

    from reconstruction import reconstruct
    output_map = reconstruct(detections, led_count=1024)

CLI:

    python -m reconstruction <session_log.json> -o <map.json>
"""

from __future__ import annotations

from .api import reconstruct
from .camera import back_project_ray, look_at_quat, project, quat_to_rotmat, rotmat_to_quat

__all__ = [
    "reconstruct",
    "project",
    "back_project_ray",
    "quat_to_rotmat",
    "rotmat_to_quat",
    "look_at_quat",
]
