"""End-to-end mesh-bench simulation (docs/design/mesh-hitl-rig.md §9.3): the real
controller core (rfctl_sim, virtual clock) plays a scenario; a toy mesh-time model
reacts to the link states; camsim renders what the camera and the analyser would
record; the real analysis turns it back into results. This is the harness's
regression test without hardware, and the template for a real run.

Toy mesh-time model (not the firmware; a stand-in with the same failure shapes):
  * nodes connected to node 0's component (over links that are up) stay at their
    base offset (time-sync error + render phase);
  * a node cut off drifts at its own clock error (ppm) from the moment it is cut;
  * when it reconnects it slews back at 0.5 ms/s (mesh.md §6.2's low-confidence
    slew), or steps if more than 50 ms off.
"""

from __future__ import annotations

import dataclasses
from typing import Sequence

import bench_core as bc
import camsim
import flip_cv as fc
import la_phase as la
import numpy as np
import rfctl
import scenarios as sc

SLEW_S_PER_S = 0.5e-3
STEP_OVER_S = 0.050


def _components(up: set, nodes: Sequence[int]) -> dict:
    parent = {n: n for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for p in up:
        a, b = int(p[0]), int(p[1])
        parent[find(a)] = find(b)
    return {n: find(n) for n in nodes}


def link_states(timeline, bench: sc.Bench, edge_db: float | None = None):
    """[(t_rel_us, set of up pairs)] after each step. A pair is up while its loss
    (every leak path, for a cut pair on the node model) is under the 1M DSSS edge
    at the bench's TX power (default sc.BENCH_TX_DBM + 99 dB)."""
    if edge_db is None:
        edge_db = sc.BENCH_TX_DBM + 99.0
    state: dict = {}
    out = []
    for t, v in timeline:
        state.update(v)
        up = {p for p in bench.pairs if bench.path_loss(state, p) < edge_db}
        out.append((t, up))
    return out


def offset_model(states, nodes, base: dict, ppm: dict, t_end_us: int, dt_us: int = 10_000):
    """Per node: (times_s, extra offset_s) sampled every dt on the controller clock."""
    ts = np.arange(0, t_end_us + dt_us, dt_us)
    extra = {n: np.zeros(ts.size) for n in nodes}
    k = 0
    cur_up: set = set()
    off = {n: 0.0 for n in nodes}
    for i, t in enumerate(ts):
        while k < len(states) and states[k][0] <= t:
            cur_up = states[k][1]
            k += 1
        comp = _components(cur_up, nodes)
        dt = dt_us / 1e6
        for n in nodes:
            if comp[n] != comp[nodes[0]]:
                off[n] += ppm[n] * 1e-6 * dt
            elif abs(off[n]) > STEP_OVER_S:
                off[n] = 0.0
            elif off[n] != 0.0:
                step = min(abs(off[n]), SLEW_S_PER_S * dt)
                off[n] -= np.sign(off[n]) * step
            extra[n][i] = off[n]
    return ts / 1e6, extra


@dataclasses.dataclass
class SimConfig:
    scenario: str = "link_flap"
    params: dict = dataclasses.field(default_factory=dict)
    nodes: int = 4
    fps: float = 120.0
    window_s: float = 1.0
    seed: int = 0
    cam_ppm: float = 35.0
    render_jitter_s: float = 0.0008
    la_nodes: Sequence[int] = (0, 1)
    base_offsets_ms: Sequence[float] = (0.0, 0.3, -0.2, 0.5)
    ppm: Sequence[float] = (0.0, 18.0, -25.0, 9.0)


def run(cfg: SimConfig, out_dir: str | None = None) -> dict:
    rng = np.random.default_rng(cfg.seed)
    with rfctl.Rfctl.sim(virtual=True) as rf:
        bench = sc.Bench(rf.devices)
        scen = sc.LIBRARY[cfg.scenario](bench, **cfg.params)
        comp = sc.compile(scen, bench)
        rf.load(comp.timeline)
        t0 = rf.play(delay_us=100_000)
        end_us = comp.timeline[-1][0] + 1_000_000
        rf.sim_advance(100_000 + end_us)
        log = rf.log(256)
        st = rf.status()
    controller = {
        "steps": st["steps"],
        "late_max_us": st["late_max_us"],
        "faults": st["faults"],
        "t0": t0,
        "log_tail": log[-8:],
    }
    nodes = list(range(cfg.nodes))
    states = link_states(comp.timeline, bench)
    t_model, extra = offset_model(states, nodes, {}, dict(zip(nodes, cfg.ppm)), end_us)

    # the camera's clock: its own origin and rate against the controller's
    cam_origin = 0.4321
    cam_rate = 1 + cfg.cam_ppm * 1e-6

    def to_cam(t_ctrl_s):
        return cam_origin + t_ctrl_s * cam_rate

    duts = []
    for n in nodes:
        base = cfg.base_offsets_ms[n] * 1e-3
        ex = extra[n]
        duts.append(
            camsim.DutModel(
                f"n{n}",
                offset=to_cam(0.0) + base,
                jitter=cfg.render_jitter_s,
                offset_fn=lambda t, ex=ex: np.interp((t - cam_origin) / cam_rate, t_model, ex),
            )
        )
    cam = camsim.CameraModel(fps=cfg.fps, ppm=0.0)
    duration = end_us / 1e6
    # the camera starts before play, so it sees the whole sync start code
    s, ser, _ = camsim.series(duts, cam, duration + 0.5, rng, t0=to_cam(-0.5))
    # the sync LED: toggles at the controller's sync instants
    sync_cam = np.array([to_cam(t / 1e6) for t in comp.sync_us])
    st_sync = (np.arange(sync_cam.size) % 2 == 0).astype(float)
    lt = np.concatenate([[sync_cam[0] - 10.0], sync_cam])
    stv = np.concatenate([[0.0], st_sync])
    frac = camsim.on_fraction(lt, stv, s, cam.E)
    sync_series = cam.sensor(frac, 40.0, rng)

    camera = fc.Camera(cam.E)
    xs, noise = fc.normalise(sync_series)
    sflips = fc.find_flips(xs, s, camera, 0.0, noise)
    a_fit, b_fit, sync_rms, k = bc.fit_sync([(f.t, f.rising) for f in sflips], comp.sync_us)

    strips = [
        fc.Strip(
            d.name,
            [fc.Roi(f"{d.name}.{i}", np.zeros(1, int), np.zeros(1, int), 0.0) for i in range(3)],
        )
        for d in duts
    ]
    res = fc.analyse(None, s, camera, strips, series=ser, window=cfg.window_s)
    cam_windows = []
    for w in res["windows"]:
        offs = {res["ref"]: 0.0}
        offs.update(w["skew_s"])
        trusted = all(
            p.offsets[0] is not None and p.offsets[0].trusted for p in w["phases"].values()
        )
        t_mid = 0.5 * (w["t0"] + w["t1"])
        cam_windows.append(bc.Window(int(a_fit + b_fit * t_mid), offs, trusted, "camera"))

    # the analyser on the tapped nodes
    la_windows = []
    chans = {}
    for n in cfg.la_nodes:
        d = duts[n]
        lt_d, pt, idx = d.frames(to_cam(0.0), to_cam(duration), rng)
        keep = (lt_d > to_cam(0.0)) & (lt_d < to_cam(duration))
        states_d = np.stack([d.led_states(idx[keep], i) for i in range(3)], axis=1)
        colours = [[(255 * int(v), 0, 0) for v in row] for row in states_d]
        chans[d.name] = la.synth_wire(lt_d[keep], colours, sample_rate=10e6, data_lead=140e-6)
    for w0 in np.arange(0.0, duration - cfg.window_s + 1e-9, cfg.window_s):
        lo, hi = to_cam(w0), to_cam(w0 + cfg.window_s)
        r = la.analyse(chans, window=(lo, hi))
        offs = {r["ref"]: 0.0}
        offs.update(r["skew_s"])
        la_windows.append(
            bc.Window(
                int((w0 + cfg.window_s / 2) * 1e6),
                offs,
                all(v is not None for v in offs.values()),
                "la",
            )
        )

    infra = {"controller": True, "camera": True, "la": True}
    results = bc.build_results(
        {"name": scen.name, "params": scen.params, "duration_s": scen.duration, "simulated": True},
        comp.marks,
        controller,
        {"camera": cam_windows, "la": la_windows},
        infra,
        rig="sim",
        extra={
            "warnings": comp.warnings,
            "camera_map": {"a_us": a_fit, "b_us_per_s": b_fit, "rms_us": sync_rms, "sync_flips": k},
        },
    )
    if out_dir:
        import json
        import os

        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "results.json"), "w") as f:
            json.dump(results, f, indent=1, default=float)
    return results
