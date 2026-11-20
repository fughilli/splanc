#!/usr/bin/env python3
"""Rig-side agent of the mesh bench: runs INSIDE the mesh-bench reservation container
(docs/design/mesh-hitl-rig.md §9.2), where the controller, camera and analyser are
passed through. Copied there with rfctl.py by hitl_mesh_bench.py; needs only python3,
pyserial, ffmpeg/ffprobe, v4l2-ctl and sigrok-cli (the container toolbox).

  meshbench_rig.py probe
  meshbench_rig.py run --timeline tl.json --duration 40 --out /tmp/mb [--no-camera] [--no-la]

`run`: safe state, clock map, camera + analyser started, timeline played 1.5 s
later, then everything stopped and written to --out:
  ctrl.json   controller info, clock map (host monotonic <-> controller us), the step
              log, status, frame-start edges (FSTI)
  video.mkv   the camera's MJPEG stream as captured (no re-encode)
  frames.json per-frame V4L2 timestamps (host CLOCK_MONOTONIC) from ffprobe
  la.vcd      the analyser capture (sigrok VCD)
The controller is left in the safe state, whatever happens.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rfctl  # noqa: E402


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name) or default


def probe() -> dict:
    out = {"controller": None, "camera": None, "la": None}
    port = env("HITL_RFCTL_TTY")
    if port and os.path.exists(port):
        try:
            with rfctl.Rfctl.open(port) as rf:
                out["controller"] = {
                    "port": port,
                    **rf.info,
                    "selftest": rf.selftest(),
                    "status": rf.status(),
                }
        except Exception as e:  # noqa: BLE001
            out["controller"] = {"port": port, "error": str(e)}
    cam = env("HITL_CAMERA_DEV")
    if cam and os.path.exists(cam):
        out["camera"] = {"dev": cam}
        if shutil.which("v4l2-ctl"):
            p = subprocess.run(
                ["v4l2-ctl", "-d", cam, "--list-formats-ext"], capture_output=True, text=True
            )
            out["camera"]["formats"] = p.stdout[-2000:]
    if shutil.which("sigrok-cli"):
        p = subprocess.run(["sigrok-cli", "--scan"], capture_output=True, text=True, timeout=30)
        drv = env("HITL_LA_DRIVER", "dreamsourcelab-dslogic")
        out["la"] = {
            "driver": drv,
            "found": drv.split(":")[0] in p.stdout,
            "scan": p.stdout[-1000:],
        }
    return out


def camera_setup(dev: str, exposure_us: int, gain: int | None) -> None:
    """Manual exposure, no auto anything (§7.4): the response must not move mid-run."""
    if not shutil.which("v4l2-ctl"):
        return
    ctrls = [
        "auto_exposure=1",  # manual
        f"exposure_time_absolute={max(1, exposure_us // 100)}",
        "white_balance_automatic=0",
        "power_line_frequency=0",
        "exposure_dynamic_framerate=0",
    ]
    if gain is not None:
        ctrls.append(f"gain={gain}")
    for c in ctrls:  # one at a time: a camera lacking one control must not drop the rest
        subprocess.run(["v4l2-ctl", "-d", dev, "-c", c], capture_output=True)


def run(args) -> int:
    os.makedirs(args.out, exist_ok=True)
    timeline = [(int(t), v) for t, v in json.load(open(args.timeline))]
    port = env("HITL_RFCTL_TTY")
    procs = []
    result = {"timeline_steps": len(timeline)}
    rf = rfctl.Rfctl.open(port)
    try:
        rf.cmd("clearfaults")
        rf.safe()
        rf.lease(int((args.duration + 30) * 1000))  # a dead agent leaves the RF safe
        result["info"] = rf.info
        result["devices"] = {k: vars(d) for k, d in rf.devices.items()}
        result["selftest"] = rf.selftest()
        rf.load(timeline)
        mask = int(args.fsti_mask, 0)
        if mask:
            rf.capture(mask, holdoff_us=2000)
        cm0 = rf.clock_map()
        cam = env("HITL_CAMERA_DEV")
        if cam and not args.no_camera:
            camera_setup(cam, args.exposure_us, args.gain)
            vid = os.path.join(args.out, "video.mkv")
            procs.append(
                (
                    "camera",
                    subprocess.Popen(
                        [
                            "ffmpeg",
                            "-nostdin",
                            "-loglevel",
                            "error",
                            "-f",
                            "v4l2",
                            "-input_format",
                            "mjpeg",
                            "-framerate",
                            str(args.fps),
                            "-video_size",
                            args.size,
                            "-i",
                            cam,
                            "-c",
                            "copy",
                            "-t",
                            str(args.duration + 3),
                            vid,
                        ]
                    ),
                )
            )
        if shutil.which("sigrok-cli") and not args.no_la:
            procs.append(
                (
                    "la",
                    subprocess.Popen(
                        [
                            "sigrok-cli",
                            "-d",
                            env("HITL_LA_DRIVER", "dreamsourcelab-dslogic"),
                            "--config",
                            f"samplerate={args.la_rate}",
                            "-C",
                            args.la_channels,
                            "--time",
                            str(int((args.duration + 3) * 1000)),
                            "-O",
                            "vcd",
                            "-o",
                            os.path.join(args.out, "la.vcd"),
                        ]
                    ),
                )
            )
        time.sleep(1.0)  # let both instruments start before the sync code
        t0 = rf.play(delay_us=500_000)
        result["t0_us"] = t0
        end = time.monotonic() + args.duration + 1.0
        edges = []
        while time.monotonic() < end:
            time.sleep(min(1.0, max(0.0, end - time.monotonic())))
            rf.cmd("ping")  # renews the lease
            if mask:
                edges += rf.capread()
        result["status"] = rf.status()
        result["log"] = rf.log(256)
        result["edges"] = edges + (rf.capread() if mask else [])
        cm1 = rf.clock_map()
        result["clock_map"] = [vars(cm0), vars(cm1)]
    finally:
        try:
            rf.stop()
            rf.safe()
            rf.lease(0)
        finally:
            rf.close()
        for name, p in procs:
            try:
                p.wait(timeout=args.duration + 20)
            except subprocess.TimeoutExpired:
                p.terminate()
            result[f"{name}_rc"] = p.returncode
    vid = os.path.join(args.out, "video.mkv")
    if os.path.exists(vid) and shutil.which("ffprobe"):
        p = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "packet=pts_time",
                "-of",
                "csv=p=0",
                vid,
            ],
            capture_output=True,
            text=True,
        )
        ts = [float(x) for x in p.stdout.split() if x.strip()]
        json.dump(
            {"pts_s": ts, "fps": args.fps, "exposure_us": args.exposure_us},
            open(os.path.join(args.out, "frames.json"), "w"),
        )
    json.dump(result, open(os.path.join(args.out, "ctrl.json"), "w"), indent=1)
    print(json.dumps({"ok": True, "out": args.out}))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe")
    r = sub.add_parser("run")
    r.add_argument("--timeline", required=True)
    r.add_argument("--duration", type=float, required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--fps", type=int, default=120)
    r.add_argument("--size", default="1280x800")
    r.add_argument("--exposure-us", type=int, default=7900)
    r.add_argument("--gain", type=int, default=None)
    r.add_argument("--la-rate", default="10m")
    r.add_argument("--la-channels", default="0-15")
    r.add_argument("--fsti-mask", default="0x0fff")
    r.add_argument("--no-camera", action="store_true")
    r.add_argument("--no-la", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "probe":
        print(json.dumps(probe(), indent=1, default=str))
        return 0
    return run(a)


if __name__ == "__main__":
    sys.exit(main())
