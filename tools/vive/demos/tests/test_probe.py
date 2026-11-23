"""Stylus calibration (probe.py) against a hidden truth: pivot, then LED touches with the
stylus at varied orientations while the fixture (and its tracker) moves.

    python3 tools/vive/demos/tests/test_probe.py [-v]
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import calib  # noqa: E402
import frames as fr  # noqa: E402
import probe  # noqa: E402
from ledmap import LedMap  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERBOSE = "-v" in sys.argv


def load_map():
    """The real PixieLamp map when it's here (it stays local: *.csv is ignored), else the
    synthetic cylinder lamp."""
    path = os.path.join(HERE, "pixielamp.csv")
    if os.path.exists(path):
        return LedMap.from_csv(path)
    import synth

    return synth.cylinder_lamp(seed=1)[0]


def log(*a):
    if VERBOSE:
        print(*a, flush=True)


class Scene:
    """Hidden truth: the map in the fixture tracker's frame (T_TF, with scale), the tip
    in the stylus frame, the ball centre's height above each LED along its normal."""

    def __init__(self, ledmap, seed=0, s=1.022, h=0.0127, noise=0.0003):
        self.rng = np.random.default_rng(seed)
        self.ledmap, self.noise = ledmap, noise
        self.c = np.array([0.022, 0.001, -0.130])  # roughly the stylus head's tip
        R = fr.rotvec_to_mat(self.rng.normal(size=3))
        self.T_TF = fr.make_pose(R, [0.05, -0.12, 0.03], s=s)
        self.h = h

    def fixture_pose(self, k):
        """The fixture (with its tracker) drifts around while being probed."""
        return fr.make_pose(
            fr.rotvec_to_mat([0.1 * np.sin(k / 7), 0.05 * np.cos(k / 5), 0.3 * np.sin(k / 11)]),
            [0.3 + 0.05 * np.sin(k / 3), 0.1, 0.8],
        )

    def stylus_at(self, x_T, axis_T, roll):
        """Stylus pose in T with its ball centre at x_T and its tip axis (from the head
        to the ball, S frame c direction) along axis_T."""
        a = self.c / np.linalg.norm(self.c)
        b = axis_T / np.linalg.norm(axis_T)
        v, cth = np.cross(a, b), a @ b
        Rab = fr.rotvec_to_mat(
            v / max(np.linalg.norm(v), 1e-12) * np.arctan2(np.linalg.norm(v), cth)
        )
        R = fr.rotvec_to_mat(b * roll) @ Rab
        return fr.make_pose(R, x_T - R @ self.c)

    def observe(self, M_rel, k):
        """What the trackers report: T_WT and T_WS (with noise on the stylus)."""
        T_WT = self.fixture_pose(k)
        T_WS = T_WT @ M_rel
        T_WS[:3, 3] += self.rng.normal(scale=self.noise, size=3)
        return T_WT, T_WS

    def pivot_samples(self, x_T, n=150, cone_deg=25):
        out = []
        for k in range(n):
            th = np.radians(cone_deg) * np.sqrt(self.rng.uniform())
            ph = self.rng.uniform(0, 2 * np.pi)
            axis = np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), -np.cos(th)])
            T_WT, T_WS = self.observe(self.stylus_at(x_T, axis, self.rng.uniform(-1, 1)), k)
            out.append(probe.relative(T_WT, T_WS))
        return out

    def touch(self, row, k):
        s, R, t = fr.sim_parts(self.T_TF)
        x_T = s * R @ (self.ledmap.p[row] + self.h * self.ledmap.n[row]) + t
        n_T = R @ self.ledmap.n[row]
        # The stylus comes in from outside, up to 40 deg off the LED's normal, any roll.
        tilt = self.rng.normal(size=3)
        tilt -= (tilt @ n_T) * n_T
        axis = -n_T + np.tan(np.radians(self.rng.uniform(0, 40))) * tilt / np.linalg.norm(tilt)
        T_WT, T_WS = self.observe(self.stylus_at(x_T, axis, self.rng.uniform(-np.pi, np.pi)), k)
        return probe.relative(T_WT, T_WS)


class Probe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ledmap = load_map()

    def test_robust_pivot_ignores_jiggle(self):
        """A pivot with the approach, the lift-off and pose jumps mixed in (40 % junk): the
        plain solve's RMS fails the check, the robust one keeps the tip within a millimetre."""
        sc = Scene(self.ledmap, seed=3)
        x = np.array([0.1, 0.0, 0.05])
        good = sc.pivot_samples(x, n=300)
        rng = np.random.default_rng(7)
        junk = []
        for k in range(200):
            M = good[k % len(good)].copy()
            M[:3, 3] += (
                rng.normal(scale=0.02, size=3) if k % 2 else np.array([0, 0, 0.03]) * (k / 200)
            )
            junk.append(M)
        Ms = good[:150] + junk + good[150:]
        c_plain, _, rms_plain, _ = probe.pivot(Ms)
        c, q, rms, spread, inl, sig = probe.pivot_robust(Ms)
        log(
            "robust pivot: plain c err %.1f mm (rms %.1f); robust c err %.2f mm, rms %.2f mm, kept %d/%d"
            % (
                np.linalg.norm(c_plain - sc.c) * 1e3,
                rms_plain * 1e3,
                np.linalg.norm(c - sc.c) * 1e3,
                rms * 1e3,
                inl.sum(),
                len(Ms),
            )
        )
        self.assertLess(np.linalg.norm(c - sc.c), 0.001)
        self.assertIsNotNone(
            probe.pivot_ok(len(Ms), rms_plain, spread)
        )  # the plain one is rejected
        self.assertIsNone(
            probe.pivot_ok(int(inl.sum()), rms, spread, inliers=(int(inl.sum()), len(Ms)))
        )

    def test_pivot_recovers_the_tip(self):
        sc = Scene(self.ledmap)
        c, q, rms, spread = probe.pivot(sc.pivot_samples(np.array([0.1, 0.0, 0.05])))
        log(
            "pivot: c err %.2f mm, rms %.2f mm, spread %.0f deg"
            % (np.linalg.norm(c - sc.c) * 1e3, rms * 1e3, spread)
        )
        self.assertLess(np.linalg.norm(c - sc.c), 0.002)
        self.assertIsNone(probe.pivot_ok(150, rms, spread))

    def test_stylus_calibration(self):
        sc = Scene(self.ledmap, seed=3)
        s, R, t = fr.sim_parts(sc.T_TF)
        # Pivot on the first LED (the tip sits on it the same way as a touch).
        row0 = calib.next_led(self.ledmap, [], reachable_only=False)
        x0 = s * R @ (self.ledmap.p[row0] + sc.h * self.ledmap.n[row0]) + t
        piv = sc.pivot_samples(x0)
        c0, *_ = probe.pivot(piv)
        touches, prev, k = [], None, 200
        for i in range(12):
            row = calib.next_led(
                self.ledmap, [row0] + [r for r, _ in touches], reachable_only=False
            )
            touches.append((row, sc.touch(row, k)))
            k += 1
            if len(touches) + 1 < probe.MIN_TOUCHES:
                continue
            est = calib.should_estimate_scale(
                self.ledmap,
                [calib.Touch(r, None, 0) for r in [row0] + [r for r, _ in touches]],
                "auto",
            )
            cur = probe.fit(
                self.ledmap,
                touches,
                [(row0, piv)],
                c0,
                est,
                prev=prev if prev and prev.scale_estimated == est else None,
            )
            ok, info = probe.converged(self.ledmap, prev, cur, len(touches) + 1)
            err = np.linalg.norm(
                fr.apply(cur.T_TF, self.ledmap.p) - fr.apply(sc.T_TF, self.ledmap.p), axis=1
            )
            log(
                "%2d touches: LED err max %.2f mm, rms %.2f mm, h %.2f mm, s %.4f, c err %.2f mm, conv %s %s"
                % (
                    len(touches),
                    err.max() * 1e3,
                    cur.rms * 1e3,
                    cur.h * 1e3,
                    cur.s,
                    np.linalg.norm(cur.c - sc.c) * 1e3,
                    ok,
                    info.get("why", ""),
                )
            )
            prev = cur
            if ok:
                break
        self.assertTrue(ok, info)
        err = np.linalg.norm(
            fr.apply(cur.T_TF, self.ledmap.p) - fr.apply(sc.T_TF, self.ledmap.p), axis=1
        )
        self.assertLess(err.max(), 0.001)
        # h and s trade off on a rounded fixture (pushing LEDs out along their normals
        # looks like scaling); the LED positions above are what matters.
        self.assertLess(abs(cur.h - sc.h), 0.001)
        self.assertLess(abs(cur.s - 1.022), 0.006)
        self.assertLess(np.linalg.norm(cur.c - sc.c), 0.001)


class AppFlow(unittest.TestCase):
    """The app's stylus flow driven by the stylus button, poses fed straight in: pivot,
    probe until converged, save the mount, go live; the live fixture pose matches the truth."""

    def test_button_driven_flow(self):
        import tempfile

        import app as appmod
        import osc
        import poses

        ledmap = load_map()
        sc = Scene(ledmap, seed=5)
        clock = [1000.0]
        streamer = osc.OscStreamer(osc.LogTransport())
        a = appmod.App(
            ledmap,
            poses.PoseSource(),
            streamer,
            "test",
            device="FIX",
            stylus="STY",
            mount_name="probe-test",
        )
        a.clock = lambda: clock[0]
        appmod.MOUNTS = tempfile.mkdtemp()
        k = [0]

        def feed(M_rel, n=1):
            for _ in range(n):
                k[0] += 1
                clock[0] += 1 / 120
                T_WT = sc.fixture_pose(k[0])
                T_WS = T_WT @ M_rel
                for dev, M in (("FIX", T_WT), ("STY", T_WS)):
                    a.on_pose(poses.PoseSample(dev, clock[0], M[:3, 3], fr.mat_to_quat(M[:3, :3])))

        def press():
            a.press_dev = "STY"
            a._press_stylus(1, clock[0])

        press()  # idle -> pivot on the pivot fixture
        self.assertEqual(a.mode, "pivot")
        self.assertIsNone(a.pick_row)  # no LED: the pivot isn't on the fixture
        for M_WS in sc.pivot_samples(np.array([0.3, -0.2, 0.1])):  # a point fixed in the world
            clock[0] += 1 / 120
            a.on_pose(poses.PoseSample("STY", clock[0], M_WS[:3, 3], fr.mat_to_quat(M_WS[:3, :3])))
        press()  # pivot done (tip saved) -> idle
        self.assertEqual(a.mode, "idle", a.events[-3:])
        self.assertLess(np.linalg.norm(a.c_tip - sc.c), 0.0005)
        self.assertTrue(os.path.exists(os.path.join(appmod.MOUNTS, "stylus-STY.json")))
        press()  # -> probe
        self.assertEqual(a.mode, "probe", a.events[-3:])
        for _ in range(15):
            if a.pconverged:
                break
            M = sc.touch(a.pick_row, k[0])
            feed(M, 60)  # hold for half a second, then press
            press()
        self.assertTrue(a.pconverged, a.pconv)
        log("app flow: %d touches, %s" % (len(a.ptouches), a.pfit.to_json()))
        press()  # converged -> save the mount, live
        self.assertEqual(a.mode, "live")
        feed(np.eye(4))
        err = np.linalg.norm(
            fr.apply(a.T_WF_live, ledmap.p) - fr.apply(sc.fixture_pose(k[0]) @ sc.T_TF, ledmap.p),
            axis=1,
        )
        self.assertLess(err.max(), 0.001)
        self.assertTrue(os.path.exists(os.path.join(appmod.MOUNTS, "probe-test.json")))


if __name__ == "__main__":
    unittest.main(argv=[a for a in sys.argv if a != "-v"])
