"""Monte Carlo accuracy of the camera flip-timing method (docs/design/mesh-hitl-rig.md
§7.5): for each camera/LED condition, many trials of two DUTs at a random true skew,
analysed by flip_cv exactly as on the rig; the error of the measured skew per 1 s
window and per 10 s capture, and of single flips.

    bazel run //pi/hitl/meshbench:accuracy -- --trials 40 --out /tmp/meshbench-acc
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
import time

import camsim
import flip_cv as fc
import numpy as np


@dataclasses.dataclass
class Cond:
    name: str
    label: str
    fps: float = 120.0
    exposure_frac: float = 0.95
    line_time: float = 0.0
    line_time_assumed: float | None = None
    rows: tuple = (0.0, 0.0)
    gamma: float = 1.0
    calibrate_gamma: bool = False
    measured_levels: bool = False
    jitter: float = 0.0
    pwm_hz: float | None = None
    start_jitter: float = 0.0
    drift_ppm: tuple = (0.0, 0.0)
    frames: bool = False  # render images (+ MJPEG) instead of the series fast path
    jpeg: int | None = None


CONDS = [
    Cond("gs120", "global shutter 120 fps, E 95 %"),
    Cond("gs120_jit", "+ 1 ms render jitter (FreeRTOS tick)", jitter=0.001),
    Cond("gs120_pwm", "+ 1 kHz PWM restart on turn-on", pwm_hz=1000.0),
    Cond("gs120_drift", "+/-30 ppm DUT clocks", drift_ppm=(30.0, -30.0)),
    Cond("gs120_camjit", "300 us camera start jitter", start_jitter=300e-6),
    Cond("gs120_e50", "exposure 50 %", exposure_frac=0.5),
    Cond("gs90", "global shutter 90 fps", fps=90.0),
    Cond("gs60_lv", "60 fps, measured levels", fps=60.0, measured_levels=True),
    Cond(
        "rs120",
        "rolling 120 fps, rows 100/900, line time known",
        line_time=8e-6,
        rows=(100.0, 900.0),
    ),
    Cond(
        "rs120_err",
        "rolling, line time 2 % off",
        line_time=8e-6,
        line_time_assumed=8.16e-6,
        rows=(100.0, 900.0),
    ),
    Cond("gamma", "gamma 2.2 not linearised", gamma=2.2),
    Cond("gamma_cal", "gamma 2.2 + response LUT", gamma=2.2, calibrate_gamma=True),
    Cond("mjpeg", "full frames + MJPEG q85 + ROI detect", frames=True, jpeg=85),
]


def trial(c: Cond, seed: int, duration: float = 10.0) -> dict:
    rng = np.random.default_rng(seed)
    true = float(rng.uniform(-0.004, 0.004))
    base = float(rng.uniform(0, 0.0625))
    a = camsim.DutModel(
        "a", offset=base, drift_ppm=c.drift_ppm[0], jitter=c.jitter, pwm_hz=c.pwm_hz
    )
    b = camsim.DutModel(
        "b", offset=base + true, drift_ppm=c.drift_ppm[1], jitter=c.jitter, pwm_hz=c.pwm_hz
    )
    cam = camsim.CameraModel(
        fps=c.fps,
        exposure=c.exposure_frac / c.fps,
        line_time=c.line_time,
        gamma=c.gamma,
        start_jitter=c.start_jitter,
        jpeg_quality=c.jpeg,
    )
    rows = {("a", i): c.rows[0] for i in range(3)}
    rows.update({("b", i): c.rows[1] for i in range(3)})
    lt_assumed = c.line_time if c.line_time_assumed is None else c.line_time_assumed
    camera = fc.Camera(cam.E, lt_assumed)
    response = None
    if c.calibrate_gamma:
        rel = np.linspace(0, 1.0, 41)
        response = fc.Response.from_sweep(rel, cam._encode(rel))
    lohi = None
    if c.measured_levels:
        on = cam.sensor(np.ones(60), 40.0, rng)
        off = cam.sensor(np.zeros(60), 40.0, rng)
        lohi = {
            (n, i): (float(np.median(off)), float(np.median(on))) for n in "ab" for i in range(3)
        }
    if c.frames:
        layout = {
            (d.name, i): (30 + 25 * i, 30 + 50 * k) for k, d in enumerate((a, b)) for i in range(3)
        }
        frames, s = camsim.render_frames([a, b], layout, cam, duration, rng)
        rois = fc.detect_rois(frames)
        if len(rois) != 6:
            return {"ok": False}
        strips = [fc.Strip("a", rois[0:3]), fc.Strip("b", rois[3:6])]
        res_all = fc.analyse(frames, s, camera, strips, response=response)
        res_w = fc.analyse(frames, s, camera, strips, window=1.0, response=response)
        truth_flips = None
    else:
        s, ser, truth = camsim.series([a, b], cam, duration, rng, rows=rows)
        strips = [
            fc.Strip(
                n,
                [
                    fc.Roi(f"{n}{i}", np.zeros(1, int), np.zeros(1, int), rows[(n, i)])
                    for i in range(3)
                ],
            )
            for n in "ab"
        ]
        res_all = fc.analyse(None, s, camera, strips, series=ser, response=response, lohi=lohi)
        res_w = fc.analyse(
            None, s, camera, strips, series=ser, window=1.0, response=response, lohi=lohi
        )
        truth_flips = np.array([t for t, _ in truth[("a", 0)]])

    def truth_at(t):
        def off(d):
            return d.offset + t * d.drift_ppm * 1e-6 / (1 + d.drift_ppm * 1e-6)

        # render jitter and PWM add a mean latency common to both DUTs: cancels
        return off(b) - off(a)

    w = res_all["windows"][0]
    t_ref = 0.5 * (w["t0"] + w["t1"])
    err_all = (w["skew_s"]["b"] - truth_at(t_ref)) if w["skew_s"]["b"] is not None else np.nan
    err_w = []
    untrusted = 0
    for ww in res_w["windows"]:
        if not all(
            p.offsets[0] is not None and p.offsets[0].trusted for p in ww["phases"].values()
        ):
            untrusted += 1
            continue
        tr = 0.5 * (ww["t0"] + ww["t1"])
        if ww["skew_s"]["b"] is not None:
            err_w.append(ww["skew_s"]["b"] - truth_at(tr))
    flip_err, gaps, nflips = [], 0, 0
    if truth_flips is not None and not c.pwm_hz and not c.jitter:
        for f in res_all["flips"][("a", 0)]:
            nflips += 1
            if f.kind == "gap":  # only bounded by the gap; the fit drops these
                gaps += 1
                continue
            flip_err.append(f.t - truth_flips[np.argmin(np.abs(truth_flips - f.t))])
    return {
        "ok": True,
        "err_all": err_all,
        "err_w": err_w,
        "untrusted": untrusted,
        "windows": len(res_w["windows"]),
        "flip_err": flip_err,
        "gaps": gaps,
        "nflips": nflips,
    }


def run(conds, trials: int, seed0: int = 1000) -> dict:
    out = {}
    for c in conds:
        t = time.time()
        n = max(4, trials // 4) if c.frames else trials
        rs = [trial(c, seed0 + k) for k in range(n)]
        rs = [r for r in rs if r["ok"]]
        ea = np.array([r["err_all"] for r in rs], dtype=float)
        ew = np.array([e for r in rs for e in r["err_w"]], dtype=float)
        fe = np.array([e for r in rs for e in r["flip_err"]], dtype=float)
        unt = sum(r["untrusted"] for r in rs) / max(1, sum(r["windows"] for r in rs))
        nfl = sum(r["nflips"] for r in rs)
        gap_pct = 100.0 * sum(r["gaps"] for r in rs) / nfl if nfl else None
        out[c.name] = {
            "label": c.label,
            "trials": len(rs),
            "win1s_bias_us": float(np.nanmean(ew) * 1e6) if ew.size else None,
            "win1s_std_us": float(np.nanstd(ew) * 1e6) if ew.size else None,
            "win1s_p95_abs_us": float(np.nanpercentile(np.abs(ew), 95) * 1e6) if ew.size else None,
            "cap10s_p95_abs_us": float(np.nanpercentile(np.abs(ea), 95) * 1e6) if ea.size else None,
            "flip_p95_abs_us": float(np.percentile(np.abs(fe), 95) * 1e6) if fe.size else None,
            "untrusted_pct": 100.0 * unt,
            "gap_flip_pct": gap_pct,
            "win1s_err_us": (ew * 1e6).tolist(),
            "secs": round(time.time() - t, 1),
        }
        print(
            f"{c.name:12s} p95 |err| 1 s {out[c.name]['win1s_p95_abs_us']:.1f} us, 10 s "
            f"{out[c.name]['cap10s_p95_abs_us']:.1f} us, untrusted {out[c.name]['untrusted_pct']:.1f} % "
            f"({out[c.name]['secs']} s)",
            flush=True,
        )
    return out


def table(res: dict) -> str:
    rows = [
        "| Condition | 1 s window: bias / sd / p95 abs (us) | 10 s capture p95 abs (us) "
        "| one flip in an exposure, p95 abs (us) | flips in a gap | untrusted windows |",
        "|---|---|---|---|---|---|",
    ]
    for k, r in res.items():
        f = lambda v: "-" if v is None else f"{v:.0f}" if abs(v) >= 10 else f"{v:.1f}"  # noqa: E731
        gap = "-" if r["gap_flip_pct"] is None else f"{r['gap_flip_pct']:.0f} %"
        rows.append(
            f"| {r['label']} | {f(r['win1s_bias_us'])} / {f(r['win1s_std_us'])} / {f(r['win1s_p95_abs_us'])} "
            f"| {f(r['cap10s_p95_abs_us'])} | {f(r['flip_p95_abs_us'])} | "
            f"{gap} | {r['untrusted_pct']:.0f} % |"
        )
    return "\n".join(rows)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--trials", type=int, default=40)
    ap.add_argument("--out", default="/tmp/meshbench-acc")
    ap.add_argument("--only", default=None, help="comma-separated condition names")
    a = ap.parse_args(argv)
    conds = [c for c in CONDS if not a.only or c.name in a.only.split(",")]
    res = run(conds, a.trials)
    os.makedirs(a.out, exist_ok=True)
    json.dump(res, open(os.path.join(a.out, "accuracy.json"), "w"), indent=1)
    open(os.path.join(a.out, "accuracy.md"), "w").write(table(res) + "\n")
    print(table(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
