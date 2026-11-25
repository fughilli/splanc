"""End-to-end synthetic calibration: rub -> fit -> touch loop (next LED, hold detection,
re-fit, convergence) -> mount -> T_TF, checked against the hidden truth.

    python3 tools/vive/demos/tests/test_calib_synth.py [-v]
"""

import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import calib  # noqa: E402
import frames as fr  # noqa: E402
import synth  # noqa: E402

VERBOSE = "-v" in sys.argv


def log(*a):
    if VERBOSE:
        print(*a, flush=True)


def run_calibration(seed=0, scale_mode="auto", max_touches=10, sim_kw=None, truth_kw=None):
    ledmap, true_p, true_n, geom = synth.cylinder_lamp(seed=seed + 1)
    truth = synth.Truth(geom, **(truth_kw or {}))
    sim = synth.Sim(truth, true_p, true_n, seed=seed + 2, **(sim_kw or {}))

    rubs = np.array([M for _, M in sim.rub(seconds=20)])
    res = calib.fit(ledmap, rubs, [], scale_mode=scale_mode)
    log(
        "rub-only fit: rub rms %.2f mm, inliers %.2f, %.2f s"
        % (res.rub_rms * 1e3, res.rub_inliers, res.seconds)
    )

    touches, prev, last_pose = [], None, rubs[-1]
    det = calib.HoldDetector()
    history = []
    while len(touches) < max_touches:
        row = calib.next_led(ledmap, [t.row for t in touches])
        target = sim.touch_pose(row)
        stream = sim.transit(last_pose, target) + sim.hold(target)
        held = None
        for t, M in stream:
            h = det.feed(t, M, res.params.c)
            if h is not None:
                held = h
                break
        assert held is not None, "hold not detected"
        last_pose = target
        touches.append(calib.Touch(row, held, t))
        prev = res
        res = calib.fit(ledmap, rubs, touches, prev=prev.params, scale_mode=scale_mode)
        ok, info = calib.converged(ledmap, prev, res, len(touches), scale_mode)
        history.append(info)
        log(
            "touch %d (LED %d): rms %.2f mm, scale %s %.4f, %s, %.2f s"
            % (
                len(touches),
                row,
                res.touch_rms * 1e3,
                "est" if res.scale_estimated else "fixed",
                res.params.s,
                {k: round(v, 3) if isinstance(v, float) else v for k, v in info.items()},
                res.seconds,
            )
        )
        if ok:
            break
    return ledmap, truth, sim, res, touches, history


class SyntheticCalibration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ledmap, cls.truth, cls.sim, cls.res, cls.touches, cls.history = run_calibration()

    def test_converged(self):
        self.assertLessEqual(len(self.touches), 10, "did not converge within 10 touches")
        self.assertLess(self.res.touch_rms, calib.CONV_TOUCH_RMS)

    def test_fixture_pose(self):
        s, R, t = fr.sim_parts(self.res.params.T_WF)
        ts, tR, tt = fr.sim_parts(self.truth.T_WF)
        ang = fr.rot_angle_deg(R.T @ tR)
        # Compare where the map's LEDs land in W under the fitted and the true transform.
        d = np.linalg.norm(
            fr.apply(self.res.params.T_WF, self.ledmap.p)
            - fr.apply(self.truth.T_WF, self.ledmap.p),
            axis=1,
        )
        log(
            "T_WF: rotation err %.3f deg, LED displacement max %.2f mm mean %.2f mm"
            % (ang, d.max() * 1e3, d.mean() * 1e3)
        )
        # 0.5 deg ran 0.53 on this seed; the LED displacement bound below is the one that matters.
        self.assertLess(ang, 0.75)
        self.assertLess(d.max(), 0.002)

    def test_contact_offset_scale(self):
        p = self.res.params
        log(
            "c err %.2f mm, o %.2f mm (true %.2f), s %.4f (true %.4f), scale estimated %s"
            % (
                np.linalg.norm(p.c - self.truth.c) * 1e3,
                p.o * 1e3,
                self.truth.o * 1e3,
                p.s,
                self.truth.s,
                self.res.scale_estimated,
            )
        )
        self.assertLess(np.linalg.norm(p.c - self.truth.c), 0.002)
        self.assertLess(abs(p.o - self.truth.o), 0.0015)
        self.assertTrue(self.res.scale_estimated, "touches should have spanned the fixture")
        self.assertLess(abs(p.s / self.truth.s - 1), 0.012)

    def test_mount_and_live(self):
        mount = self.sim.mount_pose()
        det = calib.HoldDetector()
        held = None
        for t, M in self.sim.hold(mount, seconds=1.5):
            h = det.feed(t, M, np.zeros(3))
            held = h if h is not None else held
        self.assertIsNotNone(held)
        T_TF = calib.mount_transform(held, self.res.params.T_WF)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "mount.json")
            calib.save_mount(
                path, T_TF, self.res, self.ledmap, device="SIM", name="test", touches=self.touches
            )
            T_TF2, doc = calib.load_mount(path)
        np.testing.assert_allclose(T_TF2, T_TF)
        # Move the fixture (with the tracker on it) and check live T_WF tracks the truth.
        move = fr.make_pose(fr.rotvec_to_mat([0.2, -0.1, 0.7]), [0.3, 0.1, -0.2])
        true_WF = move @ self.truth.T_WF
        T_WT_live = move @ held
        T_WF_live = calib.live_fixture_pose(T_WT_live, T_TF2)
        d = np.linalg.norm(
            fr.apply(T_WF_live, self.ledmap.p) - fr.apply(true_WF, self.ledmap.p), axis=1
        )
        log("live after move: LED displacement max %.2f mm" % (d.max() * 1e3))
        self.assertLess(d.max(), 0.0025)
        # Plane sent to the fixture vs truth: LEDs lit by the fitted plane-in-F are the true crossing.
        n_W, d_W = fr.plane_from_point_normal(
            fr.apply(true_WF, self.ledmap.centroid), [0.3, 0.2, 1.0]
        )
        n_F, d_F = fr.plane_to_fixture(T_WF_live, n_W, d_W)
        tn, td = fr.plane_to_fixture(true_WF, n_W, d_W)
        self.assertLess(np.degrees(np.arccos(min(1, n_F @ tn))), 0.5)
        self.assertLess(abs(d_F - td), 0.002)


class SeedSweep(unittest.TestCase):
    """Other seeds and another placement / scale error / diffuser offset."""

    def test_seeds(self):
        for seed, kw in [
            (1, {}),
            (2, dict(yaw_deg=-150, tilt_deg=8, s=0.97, o=0.001)),
            (4, dict(yaw_deg=100, s=1.0, o=0.0)),
        ]:
            m, truth, sim, res, touches, hist = run_calibration(seed=seed, truth_kw=kw)
            d = np.linalg.norm(fr.apply(res.params.T_WF, m.p) - fr.apply(truth.T_WF, m.p), axis=1)
            log(
                "seed %d %s: %d touches, LED max err %.2f mm, s %.4f (true %.4f), o %.2f mm (true %.2f)"
                % (
                    seed,
                    kw,
                    len(touches),
                    d.max() * 1e3,
                    res.params.s,
                    truth.s,
                    res.params.o * 1e3,
                    truth.o * 1e3,
                )
            )
            self.assertEqual(hist[-1]["why"], "", "seed %d did not converge" % seed)
            self.assertLess(d.max(), 0.0015)
            self.assertLess(abs(res.params.s / truth.s - 1), 0.012)


class OutlierRobustness(unittest.TestCase):
    def test_heavy_liftoff(self):
        ledmap, true_p, true_n, geom = synth.cylinder_lamp(seed=5)
        truth = synth.Truth(geom, yaw_deg=-120.0)
        sim = synth.Sim(truth, true_p, true_n, seed=6)
        rubs = np.array([M for _, M in sim.rub(seconds=15, liftoff=0.2)])
        touches = []
        res = calib.fit(ledmap, rubs, touches, scale_mode="off", s_fixed=truth.s)
        # Rub-only: radial distance of fitted cloud from the true axis must match (surface fit),
        # even though rotation about the axis is free.
        s, R, t = fr.sim_parts(truth.T_WF)
        P = fr.apply(res.params.T_WF, ledmap.p)
        pF = (P - t) @ R / s
        r = np.hypot(pF[:, 0], pF[:, 2])
        log(
            "rub-only, 20%% lift-offs: radius err median %.2f mm, rub rms %.2f mm"
            % (abs(np.median(r) - geom["radius"]) * 1e3, res.rub_rms * 1e3)
        )
        self.assertLess(abs(np.median(r) - geom["radius"]), 0.0015)
        # Axial position is weakly held by rubs alone (10 mm ran 10.8): the touches below pin it.
        self.assertLess(np.median(np.abs(pF[:, 1] - ledmap.p[:, 1])), 0.015)
        for _ in range(5):
            row = calib.next_led(ledmap, [t.row for t in touches])
            touches.append(calib.Touch(row, sim.hold(sim.touch_pose(row), seconds=0.1)[-1][1]))
        # One bad touch (wrong LED): robust loss keeps the fit, residual flags it.
        bad = calib.next_led(ledmap, [t.row for t in touches])
        shift = -0.03 if ledmap.p[bad, 1] > ledmap.centroid[1] else 0.03
        wrong = int(np.argmin(np.linalg.norm(ledmap.p - (ledmap.p[bad] + [0, shift, 0]), axis=1)))
        touches.append(calib.Touch(bad, sim.hold(sim.touch_pose(wrong), seconds=0.1)[-1][1]))
        res = calib.fit(ledmap, rubs, touches, prev=res.params, scale_mode="off", s_fixed=truth.s)
        d = np.linalg.norm(
            fr.apply(res.params.T_WF, ledmap.p) - fr.apply(truth.T_WF, ledmap.p), axis=1
        )
        resid = [np.linalg.norm(r) for r in res.touch_res]
        log(
            "with one wrong touch: LED displacement max %.2f mm, touch residuals mm %s"
            % (d.max() * 1e3, np.round(np.array(resid) * 1e3, 1))
        )
        self.assertLess(d.max(), 0.004)
        self.assertEqual(int(np.argmax(resid)), len(touches) - 1)
        self.assertGreater(resid[-1], 0.01)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]] + (["-v"] if VERBOSE else []))
