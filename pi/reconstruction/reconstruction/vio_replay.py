"""Run the VIO joint pose+LED solver on a REAL recorded capture.

Phase 3 of docs/vio-exploration.md: consumes
  (a) a `?record=1` frames trace (for the DeviceMotion IMU stream), and
  (b) the output of `bazelisk run //web:offline_decode` on that trace
      (id-labeled observations decoded by the canonical M6 pipeline),
solves the map with NO trusted pose, and compares against the production
pose-trusting solver fed the same capture's WebXR poses.

Usage:
    bazelisk run //pi/reconstruction:vio_replay -- \
        <frames.jsonl> <decoded.json> [--frame-hz 10] [--out map.json]

Without wall ground truth the report scores SHAPE CONSISTENCY (§1 criteria —
the wall is planar and grid-regular): plane-fit rms, nearest-neighbor pitch
spread, plus reprojection rms and the IMU-estimate sanity checks (gravity
magnitude comes out of the solve; biases should be small).

IMU frame convention: DeviceMotion reports in the DEVICE frame (x right,
y toward the top edge, z out of the screen). For a portrait-raster rear
camera this coincides with the camera frame of reconstruction/camera.py
(+X right, +Y up, -Z look): the camera looks out the back (-z_device).
rotationRate alpha/beta/gamma are deg/s about z/x/y respectively.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List

import numpy as np
from reconstruction.api import reconstruct
from reconstruction.vio import FrameObservations, ImuSample, solve_vio


def load_imu(trace_path: Path) -> List[ImuSample]:
    samples: List[ImuSample] = []
    for line in trace_path.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("reset"):
            samples = []  # last capture segment wins, matching offline_decode
            continue
        if "imu" not in rec:
            continue
        s = rec["imu"]
        rr = s["rotationRate"]
        ac = s["accel"]
        if rr["alpha"] is None or ac["x"] is None:
            continue
        samples.append(
            ImuSample(
                t=s["t"] / 1000.0,
                # Data-fitted mapping (--diagnose on the 2026-07-08 trace):
                # this device/Chrome delivers rotationRate with alpha/beta/
                # gamma being the CAMERA-frame x/y/z rates directly (0.0097
                # rad error vs WebXR, 4x better than the W3C-spec reading of
                # alpha=z,beta=x,gamma=y). Accel is the identity mapping
                # (1.3 deg). Re-run --diagnose on any new device.
                gyro=np.radians([rr["alpha"], rr["beta"], rr["gamma"]]),
                accel=np.array([ac["x"], ac["y"], ac["z"]], dtype=float),
            )
        )
    samples.sort(key=lambda s: s.t)
    return samples


def load_frames(decoded_path: Path, frame_hz: float) -> List[FrameObservations]:
    dec = json.loads(decoded_path.read_text())
    frames: List[FrameObservations] = []
    min_gap = 1.0 / frame_hz - 1e-4
    last_t = -1e9
    for fr in dec["frames"]:
        t = fr["t"] / 1000.0
        if t - last_t < min_gap:
            continue
        last_t = t
        frames.append(
            FrameObservations(
                t=t,
                k=tuple(fr["k"]),
                obs=[(int(o[0]), float(o[1]), float(o[2])) for o in fr["obs"]],
            )
        )
    return frames


def shape_report(points: np.ndarray) -> dict:
    """§1 shape-consistency scores for a planar grid fixture."""
    centered = points - points.mean(axis=0)
    _u, sv, vt = np.linalg.svd(centered, full_matrices=False)
    plane_rms = float(np.sqrt(np.mean((centered @ vt[2]) ** 2)))
    # Nearest-neighbor pitch spread.
    nn = []
    for i in range(len(points)):
        d = np.linalg.norm(points - points[i], axis=1)
        d[i] = np.inf
        nn.append(d.min())
    nn_arr = np.array(nn)
    return {
        "planeRmsMm": plane_rms * 1000.0,
        "pitchP50Mm": float(np.median(nn_arr)) * 1000.0,
        "pitchSpreadPct": float(100.0 * nn_arr.std() / nn_arr.mean()),
    }


def load_trace_poses(trace_path: Path):
    """(t_seconds, p, q) per recorded frame — the WebXR poses, used ONLY for
    convention diagnosis (rotation is locally reliable even while position
    drifts) and never fed to the solver."""
    out = []
    for line in trace_path.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("reset"):
            out = []
            continue
        if "imu" in rec or "pose" not in rec:
            continue
        out.append((rec["t"] / 1000.0, np.array(rec["pose"]["p"]), rec["pose"]["q"]))
    return out


def _signed_permutations():
    """All 48 signed axis permutations as 3x3 matrices, with labels."""
    import itertools

    axes = ["x", "y", "z"]
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product([1, -1], repeat=3):
            m = np.zeros((3, 3))
            label = []
            for row, (src, sg) in enumerate(zip(perm, signs)):
                m[row, src] = sg
                label.append(("+" if sg > 0 else "-") + axes[src])
            yield m, ",".join(label)


def diagnose_conventions(trace_path: Path) -> None:
    """Fit the DeviceMotion→camera-frame axis mapping from the data.

    Gyro: integrate each candidate mapping of the raw rates over ~0.5 s
    windows and compare with the WebXR relative rotation over the same
    window. Accel: during low-rotation moments the specific force is ≈ −R^T g;
    compare each mapping against the WebXR attitude. Prints the ranked best
    candidates; `load_imu` should encode the winner.
    """
    from reconstruction.camera import quat_to_rotmat
    from reconstruction.vio import so3_exp, so3_log

    poses = load_trace_poses(trace_path)
    raw = []
    for line in trace_path.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("reset"):
            raw = []
            continue
        if "imu" in rec:
            s = rec["imu"]
            rr, ac = s["rotationRate"], s["accel"]
            if rr["alpha"] is None:
                continue
            raw.append(
                (
                    s["t"] / 1000.0,
                    np.radians([rr["beta"], rr["gamma"], rr["alpha"]]),  # x,y,z rates
                    np.array([ac["x"], ac["y"], ac["z"]], dtype=float),
                )
            )
    raw.sort(key=lambda r: r[0])

    # -- gyro mapping ------------------------------------------------------
    windows = []
    step = max(1, len(poses) // 40)
    for i in range(0, len(poses) - 15, step):
        t0, _p0, q0 = poses[i]
        t1, _p1, q1 = poses[i + 15]  # ~0.5 s at 30 fps
        r_rel = quat_to_rotmat(q0).T @ quat_to_rotmat(q1)
        seg = [(t, g) for t, g, _a in raw if t0 <= t < t1]
        if len(seg) < 5:
            continue
        windows.append((t0, t1, r_rel, seg))
    scores = []
    for m, label in _signed_permutations():
        err = 0.0
        for t0, t1, r_rel, seg in windows:
            r = np.eye(3)
            bounds = [t0] + [t for t, _g in seg[1:]] + [t1]
            for (t, g), b0, b1 in zip(seg, bounds[:-1], bounds[1:]):
                r = r @ so3_exp((m @ g) * (b1 - b0))
            err += np.linalg.norm(so3_log(r.T @ r_rel))
        scores.append((err / len(windows), label, m))
    scores.sort(key=lambda s: s[0])
    print("gyro mapping candidates (mean rotation error per 0.5 s window, rad):")
    for err, label, _m in scores[:4]:
        print(f"  [{label}]  {err:.4f}")

    # -- accel mapping -----------------------------------------------------
    g_world = np.array([0.0, -1.0, 0.0])
    acc_scores = []
    pose_at = lambda t: min(poses, key=lambda p: abs(p[0] - t))  # noqa: E731
    quiet = [(t, a) for t, g, a in raw if np.linalg.norm(g) < np.radians(8)]
    for m, label in _signed_permutations():
        errs = []
        for t, a in quiet[:: max(1, len(quiet) // 200)]:
            _tp, _pp, q = pose_at(t)
            pred = -quat_to_rotmat(q).T @ g_world  # expected f direction
            got = m @ a
            n = np.linalg.norm(got)
            if n < 5.0:
                continue
            errs.append(np.degrees(np.arccos(np.clip(np.dot(got / n, pred), -1, 1))))
        if errs:
            acc_scores.append((float(np.median(errs)), label))
    acc_scores.sort(key=lambda s: s[0])
    print("accel mapping candidates (median angle to WebXR-predicted f, deg):")
    for err, label in acc_scores[:4]:
        print(f"  [{label}]  {err:.2f}")


def solve_session_log(
    log_path: Path, profile: bool, max_nfev: int = 80, reject: bool = True, gap_split_s: float = 3.0
) -> int:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    """Re-run the production final solve on a persisted session log — the
    exact code path stop_mapping triggers — optionally under cProfile."""
    from reconstruction.vio_api import reconstruct_vio

    log = json.loads(log_path.read_text())
    detections = log.get("detections", [])
    imu = log.get("imu", [])
    print(f"session log: {len(detections)} records, {len(imu)} imu samples")

    import time

    def run():
        t0 = time.perf_counter()
        out = reconstruct_vio(
            detections,
            imu,
            led_count=log.get("ledCount"),
            max_nfev=max_nfev,
            reject_outliers=reject,
            gap_split_s=gap_split_s,
        )
        dt = time.perf_counter() - t0
        print(
            f"solved {len(out.leds)} LEDs in {dt:.1f} s · "
            f"reproj rms {out.stats.rmsReprojPxGlobal:.2f} px · frame {out.frame}"
        )
        _solve_report(out, detections)
        return out

    if profile:
        import cProfile
        import pstats

        pr = cProfile.Profile()
        pr.enable()
        run()
        pr.disable()
        stats = pstats.Stats(pr)
        stats.sort_stats("cumulative")
        print("\n-- top 18 by cumulative time --")
        stats.print_stats(18)
    else:
        run()
    return 0


def _solve_report(out, detections) -> None:
    """Post-solve diagnostics: worst per-LED residuals + trajectory
    continuity (jumps between consecutive path points vs the observation
    timeline — a jump across an observation GAP is IMU dead-reckoning drift;
    a jump between well-observed frames points at outlier observations)."""
    worst = sorted(out.leds, key=lambda e: -e.rmsReprojPx)[:5]
    print("worst per-LED reproj rms:")
    for e in worst:
        print(
            f"  led {e.id:3d}: {e.rmsReprojPx:6.2f} px · {e.nViews} views · conf {e.confidence:.2f}"
        )

    if not out.trajectory or len(out.trajectory) < 3:
        return
    traj = np.array(out.trajectory)
    par = np.median([e.parallaxDeg for e in out.leds]) if out.leds else 0
    pitch = (
        np.median(
            [
                np.linalg.norm(np.array(a.xyz) - np.array(b.xyz))
                for a, b in zip(out.leds, out.leds[1:])
            ]
        )
        if len(out.leds) > 1
        else 0
    )
    print(
        f"trajectory extent {np.ptp(traj, axis=0).round(4).tolist()} m · "
        f"median parallax {par:.1f}° · neighbor dist p50 {pitch*1000:.1f} mm"
    )
    steps = np.linalg.norm(np.diff(traj, axis=0), axis=1)
    med = float(np.median(steps))
    print(
        f"trajectory: {len(traj)} pts, step p50 {med*1000:.1f} mm, "
        f"p95 {np.percentile(steps, 95)*1000:.1f} mm, max {steps.max()*1000:.1f} mm"
    )
    # Correlate the largest steps with gaps in the observation timeline.
    times = sorted({float(d["tCaptureMs"]) for d in detections})
    gaps = sorted(
        ((t1 - t0, t0) for t0, t1 in zip(times, times[1:])),
        reverse=True,
    )[:5]
    print("largest observation gaps (dead-reckoning-only stretches):")
    for g, t0 in gaps:
        print(f"  {g/1000:5.2f} s starting at t={(t0-times[0])/1000:6.2f} s")
    jumps = np.argsort(steps)[-5:][::-1]
    print("largest trajectory steps at path indices:", [int(j) for j in jumps])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "trace", type=Path, help="frames.jsonl trace, OR a session log with --session-log"
    )
    ap.add_argument("decoded", type=Path, nargs="?", help="offline_decode output json")
    ap.add_argument("--frame-hz", type=float, default=10.0, help="visual keyframe rate")
    ap.add_argument("--px-sigma", type=float, default=1.0)
    ap.add_argument("--max-nfev", type=int, default=80)
    ap.add_argument("--out", type=Path, default=None, help="write the VIO map json here")
    ap.add_argument(
        "--diagnose", action="store_true", help="fit IMU axis conventions from the trace and exit"
    )
    ap.add_argument(
        "--session-log",
        action="store_true",
        help="treat the input as a persisted session log and re-run the production final solve",
    )
    ap.add_argument(
        "--profile", action="store_true", help="run under cProfile (with --session-log)"
    )
    ap.add_argument(
        "--no-reject", action="store_true", help="skip outlier rejection (with --session-log)"
    )
    ap.add_argument(
        "--gap-split", type=float, default=3.0, help="segment split threshold, s (1e9 disables)"
    )
    args = ap.parse_args(argv)

    if args.session_log:
        return solve_session_log(
            args.trace,
            args.profile,
            max_nfev=args.max_nfev,
            reject=not args.no_reject,
            gap_split_s=args.gap_split,
        )
    if args.diagnose:
        diagnose_conventions(args.trace)
        return 0
    if args.decoded is None:
        ap.error("decoded json is required unless --session-log/--diagnose")

    imu = load_imu(args.trace)
    frames = load_frames(args.decoded, args.frame_hz)
    dec = json.loads(args.decoded.read_text())
    n_obs = sum(len(f.obs) for f in frames)
    print(
        f"inputs: {len(frames)} keyframes @ ~{args.frame_hz} Hz, {n_obs} observations, "
        f"{len(imu)} IMU samples"
    )

    # ---- VIO joint solve (no pose input) -----------------------------------
    result = solve_vio(frames, imu, px_sigma=args.px_sigma, max_nfev=args.max_nfev)
    ids = sorted(result.led_positions.keys())
    vio_pts = np.array([result.led_positions[j] for j in ids])
    vio_shape = shape_report(vio_pts)
    g_mag = float(np.linalg.norm(result.gravity))
    path_len = float(np.sum(np.linalg.norm(np.diff(result.positions, axis=0), axis=1)))
    print("\n== VIO joint solve (poses + LEDs from pixels + IMU only) ==")
    print(f"  solved LEDs: {len(ids)}  reproj rms {result.rms_reproj_px:.2f} px")
    print(
        f"  plane rms {vio_shape['planeRmsMm']:.1f} mm · pitch p50 "
        f"{vio_shape['pitchP50Mm']:.1f} mm · pitch spread {vio_shape['pitchSpreadPct']:.1f} %"
    )
    print(
        f"  gravity |g| {g_mag:.2f} m/s² (prior 9.81) · "
        f"gyro bias {np.linalg.norm(result.gyro_bias):.4f} rad/s · "
        f"accel bias {np.linalg.norm(result.accel_bias):.3f} m/s²"
    )
    print(f"  trajectory path length {path_len:.2f} m over {frames[-1].t - frames[0].t:.1f} s")

    # ---- Baseline: production solver trusting the recorded WebXR poses -----
    records = dec["records"]
    out_map = reconstruct(records, led_count=dec["codeParams"]["ledCount"])
    base = {e.id: np.array(e.xyz) for e in out_map.leds}
    base_ids = sorted(base.keys())
    print("\n== Baseline: pose-trusting solver on the recorded WebXR poses ==")
    if len(base_ids) >= 4:
        base_pts = np.array([base[j] for j in base_ids])
        base_shape = shape_report(base_pts)
        print(
            f"  solved LEDs: {len(base_ids)}  global reproj rms "
            f"{out_map.stats.rmsReprojPxGlobal:.2f} px"
        )
        print(
            f"  plane rms {base_shape['planeRmsMm']:.1f} mm · pitch p50 "
            f"{base_shape['pitchP50Mm']:.1f} mm · pitch spread {base_shape['pitchSpreadPct']:.1f} %"
        )
    else:
        print(f"  solved only {len(base_ids)} LEDs")

    if args.out:
        args.out.write_text(
            json.dumps(
                {
                    "leds": [
                        {"id": int(j), "xyz": [float(x) for x in result.led_positions[j]]}
                        for j in ids
                    ],
                    "gravity": [float(x) for x in result.gravity],
                    "rmsReprojPx": result.rms_reproj_px,
                    "shape": vio_shape,
                },
                indent=2,
            )
        )
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
