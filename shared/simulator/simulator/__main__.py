"""CLI for the M9 simulator.

    python -m simulator --fixture line --leds 64 --noise none --seed 0 -o log.json

Writes a detection log (``{"ledCount", "fixture", "detections": [...]}``) that
``reconstruction`` can consume. With ``--truth <path>`` also writes the
ground-truth positions for offline error evaluation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from simulator.degrade import PRESETS, NoiseModel
from simulator.detection_log import generate_log
from simulator.fixtures import FIXTURES


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="simulator", description=__doc__)
    parser.add_argument("--fixture", choices=sorted(FIXTURES), default="line")
    parser.add_argument("--leds", type=int, default=64)
    parser.add_argument("--noise", choices=sorted(PRESETS), default="none")
    parser.add_argument("--views", type=int, default=60)
    parser.add_argument("--arc-degrees", type=float, default=120.0)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--truth", type=Path, default=None, help="write ground-truth xyz")
    # Per-knob overrides (take precedence over --noise preset when given).
    parser.add_argument("--pixel-noise-px", type=float, default=None)
    parser.add_argument("--pose-noise-deg", type=float, default=None)
    parser.add_argument("--pose-noise-pos-m", type=float, default=None)
    parser.add_argument("--dropout-prob", type=float, default=None)
    args = parser.parse_args(argv)

    base = PRESETS[args.noise]
    noise = NoiseModel(
        pixel_noise_px=(
            args.pixel_noise_px if args.pixel_noise_px is not None else base.pixel_noise_px
        ),
        pose_noise_deg=(
            args.pose_noise_deg if args.pose_noise_deg is not None else base.pose_noise_deg
        ),
        pose_noise_pos_m=(
            args.pose_noise_pos_m if args.pose_noise_pos_m is not None else base.pose_noise_pos_m
        ),
        dropout_prob=args.dropout_prob if args.dropout_prob is not None else base.dropout_prob,
    )

    log, truth = generate_log(
        args.fixture,
        args.leds,
        noise=noise,
        views=args.views,
        arc_degrees=args.arc_degrees,
        scale=args.scale,
        seed=args.seed,
    )
    args.output.write_text(json.dumps(log, indent=2))
    if args.truth is not None:
        args.truth.write_text(json.dumps({"points": truth.tolist()}, indent=2))

    print(
        f"wrote {len(log['detections'])} detections for {args.leds} LEDs "
        f"({args.fixture}, noise={args.noise}, {args.views} views) to {args.output}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
