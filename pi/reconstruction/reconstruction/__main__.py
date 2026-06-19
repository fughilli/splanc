"""CLI for M3 reconstruction.

    python -m reconstruction <session_log.json> -o <map.json> [--csv <map.csv>]

The session log is JSON of the form ``{"ledCount": N, "detections": [...]}`` (a
bare ``[...]`` list of DetectionRecords is also accepted). Output is an
OutputMap (design doc §7.5) and, optionally, a flat CSV.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from reconstruction.api import reconstruct


def _load_detections(path: Path):
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data, None
    if isinstance(data, dict):
        detections = data.get("detections", [])
        return detections, data.get("ledCount")
    raise ValueError("session log must be a JSON list or object")


def _write_csv(output_map, path: Path) -> None:
    lines = ["id,x,y,z,confidence,n_views"]
    for e in output_map.leds:
        x, y, z = e.xyz
        lines.append(f"{e.id},{x:.6f},{y:.6f},{z:.6f},{e.confidence:.4f},{e.nViews}")
    path.write_text("\n".join(lines) + "\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="reconstruction", description=__doc__)
    parser.add_argument("session_log", type=Path, help="input detection log (JSON)")
    parser.add_argument("-o", "--output", type=Path, required=True, help="output map (JSON)")
    parser.add_argument("--csv", type=Path, default=None, help="also write a flat CSV")
    parser.add_argument("--huber-delta", type=float, default=1.5)
    parser.add_argument("--min-views", type=int, default=2)
    parser.add_argument("--min-parallax-deg", type=float, default=5.0)
    parser.add_argument("--led-count", type=int, default=None)
    args = parser.parse_args(argv)

    detections, led_count = _load_detections(args.session_log)
    if args.led_count is not None:
        led_count = args.led_count

    output_map = reconstruct(
        detections,
        led_count=led_count,
        huber_delta=args.huber_delta,
        min_views=args.min_views,
        min_parallax_deg=args.min_parallax_deg,
    )

    args.output.write_text(output_map.model_dump_json(indent=2))
    if args.csv is not None:
        _write_csv(output_map, args.csv)

    n_mapped = len(output_map.leds)
    print(
        f"reconstructed {n_mapped} LEDs "
        f"({len(output_map.unmapped)} unmapped); "
        f"global RMS reproj = {output_map.stats.rmsReprojPxGlobal:.3f} px, "
        f"median parallax = {output_map.stats.medianParallaxDeg:.1f}°",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
