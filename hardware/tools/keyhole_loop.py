#!/usr/bin/env python3
"""Native-DRC-gated repair stage after custom PnR/writeback.

Every attempt is a separate PCB/project checkpoint. Only a strictly improved
native result becomes the next input. This stage has no FreeRouting dependency.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pnr"))
from pnr.route.detail.keyhole import acceptable


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--kicad-python", required=True)
    ap.add_argument("--kicad-cli", required=True)
    ap.add_argument(
        "--net", action="append", default=[], help="signal net; repeat for several"
    )
    ap.add_argument("--width", type=float, default=0.2)
    ap.add_argument("--rounds", type=int, default=4)
    ap.add_argument("--pitch", type=float, default=0.1)
    ap.add_argument(
        "--consolidate-ground-ref",
        action="append",
        default=[],
        help="Run native-gated redundant leaf-via cleanup for this reviewed footprint before routing; repeat",
    )
    ap.add_argument(
        "--region",
        action="append",
        default=[],
        type=Path,
        help="regional fixture JSON; tried after additive repairs",
    )
    ap.add_argument(
        "--reviewed-via-scan",
        type=Path,
        help="Reviewed proximity scan; native-gated cleanup before routing",
    )
    args = ap.parse_args()
    if (
        not args.net
        and not args.region
        and not args.consolidate_ground_ref
        and not args.reviewed_via_scan
    ):
        ap.error("at least one --net, --region or --consolidate-ground-ref is required")
    regions = [json.loads(p.read_text()) for p in args.region]
    args.out_dir.mkdir(parents=True, exist_ok=False)
    current = args.out_dir / "baseline.kicad_pcb"
    shutil.copyfile(args.board, current)
    shutil.copyfile(
        args.board.with_suffix(".kicad_pro"), current.with_suffix(".kicad_pro")
    )
    table = args.board.parent / "fp-lib-table"
    if table.exists():
        # Expand relative library references against the SOURCE project.
        text = table.read_text().replace(
            "${KIPRJMOD}", str(args.board.parent.resolve())
        )
        (args.out_dir / "fp-lib-table").write_text(text)
    script = Path(__file__).with_name("keyhole_repair.py")
    env = dict(os.environ, PYTHONPATH=str(script.parent.parent / "pnr"))

    def drc(board):
        out = board.with_suffix(".drc.json")
        subprocess.run(
            [
                args.kicad_cli,
                "pcb",
                "drc",
                str(board),
                "--format",
                "json",
                "--output",
                str(out),
            ],
            check=True,
        )
        return json.loads(out.read_text())

    baseline = drc(current)
    report = baseline
    events = []
    sequence = 0
    exhausted = set()
    if args.consolidate_ground_ref or args.reviewed_via_scan:
        cleanup = args.out_dir / "ground-consolidation"
        command = [
            args.kicad_python,
            str(script.with_name("consolidate_ground.py")),
            str(current),
            "--out-dir",
            str(cleanup),
            "--kicad-cli",
            args.kicad_cli,
        ]
        if args.reviewed_via_scan:
            command.extend(["--reviewed-scan", str(args.reviewed_via_scan)])
        for ref in args.consolidate_ground_ref:
            command.extend(["--ref", ref])
        with (args.out_dir / "ground-consolidation.log").open("w") as log:
            subprocess.run(
                command, env=env, check=True, stdout=log, stderr=subprocess.STDOUT
            )
        result = json.loads((cleanup / "result.json").read_text())
        # This distinct gate permits equal opens only for a verified via-count
        # reduction. It does not weaken the strict routing-improvement gate.
        if result["accepted"]:
            current = cleanup / "candidate.kicad_pcb"
            report = json.loads(current.with_suffix(".drc.json").read_text())
        events.append(
            dict(
                stage="ground-consolidation",
                accepted=result["accepted"],
                removed_vias=len(result["removed"]),
                opens=len(report["unconnected_items"]),
            )
        )
        (args.out_dir / "progress.json").write_text(
            json.dumps(
                dict(
                    best=str(current.resolve()),
                    initial_opens=len(baseline["unconnected_items"]),
                    opens=len(report["unconnected_items"]),
                    events=events,
                ),
                indent=2,
            )
            + "\n"
        )
        print(json.dumps(events[-1]), flush=True)
    for round_number in range(args.rounds):
        changed = False
        for net in args.net:
            if net in exhausted:
                continue
            sequence += 1
            out = args.out_dir / f"candidate-{sequence:03}.kicad_pcb"
            subprocess.run(
                [
                    args.kicad_python,
                    str(script),
                    str(current),
                    "--out",
                    str(out),
                    "--net",
                    net,
                    "--width",
                    str(args.width),
                    "--pitch",
                    str(args.pitch),
                    "--vias",
                ],
                env=env,
                check=True,
            )
            after = drc(out)
            accepted = acceptable(report, after)
            events.append(
                dict(
                    net=net,
                    board=str(out.resolve()),
                    accepted=accepted,
                    before=len(report["unconnected_items"]),
                    after=len(after["unconnected_items"]),
                )
            )
            if accepted:
                current = out
                report = after
                changed = True
            else:
                exhausted.add(net)
            manifest = dict(
                best=str(current.resolve()),
                initial_opens=len(baseline["unconnected_items"]),
                opens=len(report["unconnected_items"]),
                events=events,
            )
            (args.out_dir / "progress.json").write_text(
                json.dumps(manifest, indent=2) + "\n"
            )
            print(json.dumps(events[-1]), flush=True)
        for region in regions:
            sequence += 1
            region_dir = args.out_dir / f"region-{sequence:03}"
            command = [
                args.kicad_python,
                str(script.with_name("keyhole_region.py")),
                str(current),
                "--out-dir",
                str(region_dir),
                "--source-pad",
                region["source_pad"],
                "--target-pad",
                region["target_pad"],
                "--bounds",
                *map(str, region["bounds"]),
                "--pitch",
                str(region.get("pitch", args.pitch)),
                "--max-orders",
                str(region.get("max_orders", 8)),
                "--max-expansions",
                str(region.get("max_expansions", 10000)),
                "--kicad-cli",
                args.kicad_cli,
            ]
            command.extend(["--max-seconds", str(region.get("max_seconds", 120.0))])
            if region.get("ground_leaf"):
                command.append("--ground-leaf")
            if region.get("preserve_copper"):
                command.append("--preserve-copper")
            if region.get("joint"):
                command.append("--joint")
            if region.get("layers"):
                command.append("--layers")
            if region.get("relocate_vias"):
                command.append("--relocate-vias")
            for net, window in region.get("source_via_windows", {}).items():
                command.extend(["--source-via-window", net, *map(str, window)])
            for net in region["nets"]:
                command.extend(["--net", net])
            with (args.out_dir / f"region-{sequence:03}.log").open("w") as log:
                subprocess.run(
                    command, env=env, check=True, stdout=log, stderr=subprocess.STDOUT
                )
            outcome = json.loads((region_dir / "result.json").read_text())
            accepted = False
            if outcome["accepted"]:
                candidate = region_dir / "candidate.kicad_pcb"
                after = json.loads(candidate.with_suffix(".drc.json").read_text())
                accepted = acceptable(report, after)
                if accepted:
                    current, report = candidate, after
                    changed = True
                    exhausted.clear()  # Reopened copper invalidates additive failure history.
            events.append(
                dict(
                    stage="regional",
                    region=str(region_dir.resolve()),
                    accepted=accepted,
                    status=outcome["status"],
                    opens=len(report["unconnected_items"]),
                )
            )
            (args.out_dir / "progress.json").write_text(
                json.dumps(
                    dict(
                        best=str(current.resolve()),
                        initial_opens=len(baseline["unconnected_items"]),
                        opens=len(report["unconnected_items"]),
                        events=events,
                    ),
                    indent=2,
                )
                + "\n"
            )
            print(json.dumps(events[-1]), flush=True)
        if not changed:
            break
    print("Accepted checkpoint:", current, flush=True)


if __name__ == "__main__":
    main()
