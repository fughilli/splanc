"""Mesh-bench HITL run (docs/design/mesh-hitl-rig.md §9): RF scenarios under a live
mesh, with the real display flip timing measured by the overhead camera and the
16-channel analyser.

    # on hardware: reserve the bench, play a scenario, measure, judge
    bazel run //pi/hitl/meshbench:mesh_bench -- --unit mesh-bench-1 \\
        --scenario link_flap --out /tmp/mesh_bench

    # no hardware: the same pipeline against the controller simulator + camsim
    bazel run //pi/hitl/meshbench:mesh_bench -- --simulate --scenario partition_heal

Flow (hardware): reserve the composite `mesh-bench` unit (controller + DUTs + camera
+ analyser in one atomic reservation) -> probe the instruments (no controller, or
neither camera nor analyser = SKIP, never FAIL) -> the DUT workload (--gate-cmd, or meshed beforehand)
-> upload the rig agent and the compiled timeline -> the agent plays it while the
camera and the analyser record -> fetch -> analyse (flip_cv, la_phase) -> results.json
with HITL_METRIC records (SCHEMA v1, gate `mesh_bench`) -> RESULT line, exit 0 iff
PASS or SKIP. Every failure keeps the DUT serial logs (the Reservation does that).

The DUTs must be meshed and running meshFlipClock.fx on the shared time base:
an operator does that beforehand, or --gate-cmd runs a command in the reservation
container before the scenario, which must print `MESHBENCH READY` once the mesh
has formed. The M3-M5 gates take that role once
they accept a held bench reservation (§9.4).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time

import bench_core as bc
import flip_cv as fc
import la_phase as la
import numpy as np
import scenarios as sc

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = "/tmp/meshbench"


def _log(msg: str) -> None:
    print(f"[mesh_bench] {msg}", flush=True)


def _emit(results: dict) -> None:
    for rec in results.get("metrics", []):
        print(bc.metric_line(rec), flush=True)


def _write(out: str, results: dict) -> None:
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "results.json"), "w") as f:
        json.dump(results, f, indent=1, default=float)
    _log(f"results -> {os.path.join(out, 'results.json')}")


# ------------------------------------------------------------------ analysis


def camera_frame_starts(pts: list, fps: float) -> np.ndarray:
    """Exposure-start times on the camera's own clock from V4L2 timestamps: frame
    numbers from the timestamps (so drops show as gaps), then a line fit, so the
    host's timestamp jitter does not enter (§7.3)."""
    p = np.asarray(pts, dtype=np.float64)
    n = np.round((p - p[0]) * fps).astype(np.int64)
    b, a = np.polyfit(n, p, 1)
    return a + b * n


def layout_strips(layout: dict) -> tuple[list, fc.Roi | None]:
    """layout.json (§10.4): {"strips": [{"dut", "boxes": [[x0,y0,x1,y1] x3]}],
    "syncled": [x0,y0,x1,y1]}."""
    strips = [
        fc.Strip(
            s["dut"], [fc.roi_from_box(f"{s['dut']}.{i}", *b) for i, b in enumerate(s["boxes"])]
        )
        for s in layout["strips"]
    ]
    sync = fc.roi_from_box("syncled", *layout["syncled"]) if layout.get("syncled") else None
    return strips, sync


def analyse_camera(
    video: str,
    frames_meta: dict,
    layout: dict,
    sync_us: list,
    window_s: float,
    lohi: dict | None = None,
    line_time: float = 0.0,
) -> tuple[list, dict]:
    frames = fc._load_video(video)
    fs = camera_frame_starts(frames_meta["pts_s"][: len(frames)], frames_meta["fps"])
    frames = frames[: fs.size]
    E = frames_meta["exposure_us"] * 1e-6
    cam = fc.Camera(E, line_time)
    strips, sync = layout_strips(layout)
    if sync is None:
        raise ValueError("layout has no syncled box: camera time can't be mapped")
    sser = fc.extract_series(frames, [sync])[0]
    xs, noise = fc.normalise(sser)
    sflips = fc.find_flips(xs, fs, cam, sync.row, noise)
    a, b, rms, k = bc.fit_sync([(f.t, f.rising) for f in sflips], sync_us)
    res = fc.analyse(frames, fs, cam, strips, window=window_s, lohi=lohi)
    windows = []
    for w in res["windows"]:
        offs = {res["ref"]: 0.0}
        offs.update(w["skew_s"])
        trusted = all(
            p.offsets[0] is not None and p.offsets[0].trusted for p in w["phases"].values()
        )
        windows.append(bc.Window(int(a + b * 0.5 * (w["t0"] + w["t1"])), offs, trusted, "camera"))
    return windows, {
        "a_us": a,
        "b_us_per_s": b,
        "rms_us": rms,
        "sync_flips": k,
        "frames": int(fs.size),
    }


def analyse_la(vcd_text: str, la_map: dict, step_us: list, window_s: float) -> tuple[list, dict]:
    """la_map: {"D0": "c6-1", ..., "D12": "sync"} (env HITL_LA_MAP); step_us: the
    controller time of every timeline step (t0 + t_rel). SYNC toggles once per
    commit and the analyser starts before play with no commit in between, so its
    edges pair in order with the steps."""
    chans, t_end = la.parse_vcd(vcd_text)
    sync_name = next((k for k, v in la_map.items() if v == "sync"), None)
    data = {la_map[k]: v for k, v in chans.items() if k in la_map and la_map[k] != "sync"}
    if sync_name is None or sync_name not in chans:
        raise ValueError("no SYNC channel in the analyser capture")
    st, _ = chans[sync_name]
    a, b, rms = la.sync_map(st, step_us)
    windows = []
    t = 0.0
    while t + window_s <= t_end:
        r = la.analyse(data, window=(t, t + window_s))
        offs = {r["ref"]: 0.0}
        offs.update(r["skew_s"])
        windows.append(
            bc.Window(
                int(a + b * (t + window_s / 2)),
                offs,
                all(v is not None for v in offs.values()),
                "la",
            )
        )
        t += window_s
    return windows, {"a_us": a, "b_us_per_s": b, "rms_us": rms}


# ------------------------------------------------------------------ hardware


def _fetch(res, remote_path: str) -> bytes:
    argv = res._ssh_base() + [f"{res.user}@{res.host}", "cat", remote_path]
    p = subprocess.run(argv, capture_output=True, timeout=300)
    if p.returncode:
        raise FileNotFoundError(remote_path)
    return p.stdout


def run_hardware(args) -> int:
    from hitl_client import Reservation  # the harness library

    scenario_params = json.loads(args.params) if args.params else {}
    with Reservation(
        server=args.server, device=args.unit, sku=None if args.unit else "mesh-bench"
    ) as res:
        res.ssh(f"mkdir -p {REMOTE}")
        res.scp_to([os.path.join(HERE, "rfctl.py"), os.path.join(HERE, "meshbench_rig.py")], REMOTE)
        p = res.ssh(f"python3 {REMOTE}/meshbench_rig.py probe", capture=True, timeout=120)
        try:
            probe = json.loads(p.stdout)
        except ValueError:
            probe = {}
        envp = res.ssh("printenv", capture=True, timeout=30).stdout
        rig_env = dict(ln.split("=", 1) for ln in envp.splitlines() if "=" in ln)
        ctrl = probe.get("controller") or {}
        infra = {
            "controller": bool(ctrl) and "error" not in ctrl,
            "camera": bool(probe.get("camera")) and not args.no_camera,
            "la": bool((probe.get("la") or {}).get("found")) and not args.no_la,
        }
        if not infra["controller"] or not (infra["camera"] or infra["la"]):
            results = {"schema": bc.SCHEMA, "infra": infra, "probe": probe}
            v = bc.verdict(results)
            results["verdict"] = {"status": v.status, "reasons": v.reasons}
            _write(args.out, results)
            print(v.line(args.scenario), flush=True)
            return 0
        # the device list comes from the controller itself (its board table)
        with tempfile.TemporaryDirectory() as tmp:
            list_out = res.ssh(
                f'cd {REMOTE} && python3 -c \'import json,os,rfctl; r=rfctl.Rfctl.open(os.environ["HITL_RFCTL_TTY"]);'
                f" print(json.dumps(list(r.devices))); r.close()'",
                capture=True,
                timeout=60,
            ).stdout
            names = json.loads(list_out.strip().splitlines()[-1])
            bench = sc.Bench(
                names, fixed_loss_db=float(rig_env.get("HITL_MESHBENCH_FIXED_DB", 42.0))
            )
            scen = sc.LIBRARY[args.scenario](bench, **scenario_params)
            comp = sc.compile(scen, bench)
            for w in comp.warnings:
                _log(f"warning: {w}")
            tl = os.path.join(tmp, "timeline.json")
            json.dump(comp.timeline, open(tl, "w"))
            res.scp_to([tl], REMOTE)
        gate = None
        if args.gate_cmd:
            gate = subprocess.Popen(
                res._ssh_base()
                + [f"{res.user}@{res.host}", "sh", "-c", shlex.quote(args.gate_cmd)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            t_ready = time.monotonic() + args.gate_ready_s
            for line in gate.stdout:
                print(f"[gate] {line.rstrip()}", flush=True)
                if "MESHBENCH READY" in line:
                    break
                if time.monotonic() > t_ready:
                    break
        flags = ["--no-camera"] if not infra["camera"] else []
        flags += ["--no-la"] if not infra["la"] else []
        cmd = (
            f"python3 {REMOTE}/meshbench_rig.py run --timeline {REMOTE}/timeline.json "
            f"--duration {scen.duration + 1.0:.1f} --out {REMOTE}/out --fps {args.fps} "
            f"--exposure-us {args.exposure_us} --la-rate {args.la_rate} " + " ".join(flags)
        )
        p = res.ssh(cmd, capture=True, timeout=scen.duration + 180)
        _log(p.stdout[-400:] if p.stdout else "rig agent: no output")
        ctrl_json = json.loads(_fetch(res, f"{REMOTE}/out/ctrl.json"))
        measurements, extra = {}, {"probe": probe}
        layout = (
            json.loads(rig_env["HITL_MESHBENCH_LAYOUT_JSON"])
            if rig_env.get("HITL_MESHBENCH_LAYOUT_JSON")
            else None
        )
        if infra["camera"] and layout:
            with tempfile.TemporaryDirectory() as tmp:
                vid = os.path.join(tmp, "video.mkv")
                open(vid, "wb").write(_fetch(res, f"{REMOTE}/out/video.mkv"))
                fm = json.loads(_fetch(res, f"{REMOTE}/out/frames.json"))
                measurements["camera"], extra["camera_map"] = analyse_camera(
                    vid,
                    fm,
                    layout,
                    comp.sync_us,
                    args.window,
                    line_time=float(rig_env.get("HITL_CAMERA_LINE_TIME", 0)),
                )
        if infra["la"] and rig_env.get("HITL_LA_MAP"):
            la_map = dict(kv.split("=") for kv in rig_env["HITL_LA_MAP"].split(","))
            vcd = _fetch(res, f"{REMOTE}/out/la.vcd").decode()
            t0 = int(ctrl_json["t0_us"])
            steps = [t0 + t for t, _ in comp.timeline]
            measurements["la"], extra["la_map"] = analyse_la(vcd, la_map, steps, args.window)
        if gate is not None:
            try:
                gate.wait(timeout=600)
            except subprocess.TimeoutExpired:
                gate.terminate()
            extra["gate_rc"] = gate.returncode
        st = ctrl_json.get("status", {})
        controller = {
            "steps": st.get("steps"),
            "late_max_us": st.get("late_max_us", 0),
            "faults": st.get("faults"),
            "t0": ctrl_json.get("t0_us"),
            "selftest": ctrl_json.get("selftest"),
            "clock_map": ctrl_json.get("clock_map"),
        }
        results = bc.build_results(
            {"name": scen.name, "params": scen.params, "duration_s": scen.duration},
            comp.marks,
            controller,
            measurements,
            infra,
            rig=res.host,
            extra=extra,
        )
        _emit(results)
        _write(args.out, results)
        v = results["verdict"]
        print(bc.Verdict(v["status"], v["reasons"]).line(args.scenario), flush=True)
        return 0 if v["status"] in ("PASS", "SKIP") else 1


def run_simulated(args) -> int:
    import benchsim

    cfg = benchsim.SimConfig(
        scenario=args.scenario,
        params=json.loads(args.params) if args.params else {},
        fps=args.fps,
        window_s=args.window,
        seed=args.seed,
    )
    results = benchsim.run(cfg)
    _emit(results)
    _write(args.out, results)
    v = results["verdict"]
    print(bc.Verdict(v["status"], v["reasons"]).line(args.scenario), flush=True)
    return 0 if v["status"] in ("PASS", "SKIP") else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--scenario", default="link_flap", choices=sorted(sc.LIBRARY))
    ap.add_argument("--params", default=None, help="JSON kwargs for the scenario builder")
    ap.add_argument("--server", default=None)
    ap.add_argument(
        "--unit", default=None, help="the mesh-bench unit (default: any of type mesh-bench)"
    )
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_bench")
    )
    ap.add_argument("--window", type=float, default=1.0, help="analysis window (s)")
    ap.add_argument("--fps", type=float, default=120.0)
    ap.add_argument("--exposure-us", type=int, default=7900)
    ap.add_argument("--la-rate", default="10m")
    ap.add_argument("--no-camera", action="store_true")
    ap.add_argument("--no-la", action="store_true")
    ap.add_argument(
        "--gate-cmd", default=None, help="run in the reservation first; must print MESHBENCH READY"
    )
    ap.add_argument("--gate-ready-s", type=float, default=600.0)
    ap.add_argument(
        "--simulate", action="store_true", help="controller simulator + camsim, no hardware"
    )
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)
    return run_simulated(args) if args.simulate else run_hardware(args)


if __name__ == "__main__":
    sys.exit(main())
