"""flashlight.py: the beam follows the stylus tip and axis, the button cycles the modes,
and rolling about the stylus axis (only that) turns the mode's parameter. The stylus
gate: /stylus_ok and /stylus_seq follow the stylus pose's freshness, apart from any
fixture tracker, with an actionable status when there's no live stylus.

    python3 tools/vive/demos/tests/test_flashlight.py
"""

import math
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import flashlight as fl  # noqa: E402
import poses  # noqa: E402

TIP = [0.0217, 0.0022, 0.1845]  # the saved stylus calibration's c_S


def rot(axis, angle):
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * K @ K


def pose(R, t=(0.0, 0.0, 0.0)):
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = t
    return M


class Twist(unittest.TestCase):
    def test_pure_roll_is_all_twist(self):
        ax = np.array(TIP) / np.linalg.norm(TIP)
        for a in (0.3, -1.0, 3.0):
            self.assertAlmostEqual(fl.twist_about(rot(ax, a), ax), a, places=9)

    def test_swing_alone_is_no_twist(self):
        ax = np.array([0.0, 0.0, 1.0])
        self.assertAlmostEqual(fl.twist_about(rot([1.0, 0.0, 0.0], 0.8), ax), 0.0, places=9)


class Beam(unittest.TestCase):
    def test_the_beam_leaves_the_tip_along_the_axis(self):
        light = fl.Flashlight(TIP)
        R = rot([0.0, 1.0, 0.0], 0.5)
        o, d = light.update(pose(R, (1.0, 2.0, 3.0)))
        np.testing.assert_allclose(o, R @ np.array(TIP) + [1.0, 2.0, 3.0], atol=1e-12)
        np.testing.assert_allclose(d, R @ (np.array(TIP) / np.linalg.norm(TIP)), atol=1e-12)

    def test_the_button_cycles_the_modes(self):
        light = fl.Flashlight(TIP)
        self.assertEqual(light.mode_name, "color")
        self.assertEqual(
            [light.press() for _ in range(5)],
            ["saturation", "width", "persistence", "fixed", "color"],
        )

    def press_to(self, light, mode):
        while light.mode_name != mode:
            light.press()

    def roll_in_steps(self, light, total, steps=40):
        # From wherever the stylus is now: a jump back to the start would count as roll.
        base = np.eye(3) if light.prev_R is None else light.prev_R.copy()
        for k in range(steps + 1):
            light.update(pose(base @ rot(light.axis, total * k / steps)))

    def test_color_mode_turns_the_hue_one_wheel_per_turn(self):
        light = fl.Flashlight(TIP, hue=0.1)
        width = light.width
        self.roll_in_steps(light, math.pi / 2)  # a quarter turn
        self.assertAlmostEqual(light.hue, 0.35, places=6)
        self.assertEqual(light.width, width)
        self.roll_in_steps(light, -math.pi)  # back half a turn: wraps below 0
        self.assertAlmostEqual(light.hue, 0.85, places=6)

    def test_width_mode_scales_the_half_angle_and_clamps(self):
        light = fl.Flashlight(TIP, width=math.radians(10.0))
        self.press_to(light, "width")
        hue = light.hue
        self.roll_in_steps(light, 2 * math.pi)
        self.assertAlmostEqual(math.degrees(light.width), 30.0, places=4)
        self.assertEqual(light.hue, hue)
        self.roll_in_steps(light, 6 * math.pi, steps=120)
        self.assertAlmostEqual(light.width, fl.WIDTH_MAX)
        self.roll_in_steps(light, -20 * math.pi, steps=400)
        self.assertAlmostEqual(light.width, fl.WIDTH_MIN)

    def test_fixed_mode_and_pointing_change_nothing(self):
        light = fl.Flashlight(TIP)
        self.press_to(light, "fixed")
        hue, width = light.hue, light.width
        self.roll_in_steps(light, 2.0)
        self.assertEqual((light.hue, light.width), (hue, width))
        # Pointing around (swing, no roll) in colour mode leaves the hue alone.
        self.press_to(light, "color")
        base = light.prev_R.copy()
        tilt = np.cross(light.axis, [1.0, 0.0, 0.0])
        for k in range(30):
            light.update(pose(base @ rot(tilt, 0.05 * k)))
        self.assertAlmostEqual(light.hue, hue, places=9)

    def test_full_colour_by_default_and_saturation_mode_clamps(self):
        light = fl.Flashlight(TIP, hue=0.0)
        self.assertEqual(light.color(), (1.0, 0.0, 0.0))
        self.press_to(light, "saturation")
        self.roll_in_steps(light, -math.pi / 2)  # a quarter turn back
        self.assertAlmostEqual(light.sat, 0.75, places=6)
        self.roll_in_steps(light, -4 * math.pi, steps=160)
        self.assertEqual(light.sat, 0.0)
        self.assertEqual(light.color(), (1.0, 1.0, 1.0))

    def test_persistence_starts_off_scales_and_turns_off_again(self):
        light = fl.Flashlight(TIP)
        self.assertEqual(light.decay_sent(), 0.0)
        self.press_to(light, "persistence")
        self.roll_in_steps(light, 4 * math.pi, steps=80)  # two turns: x9
        self.assertAlmostEqual(light.decay_sent(), fl.DECAY_OFF * 9, places=6)
        self.roll_in_steps(light, 20 * math.pi, steps=400)
        self.assertAlmostEqual(light.decay_sent(), fl.DECAY_MAX)
        self.roll_in_steps(light, -40 * math.pi, steps=800)
        self.assertEqual(light.decay_sent(), 0.0)


class FakeStreamer:
    """Records what OscStreamer.set would send (latest value per address)."""

    def __init__(self):
        self.values = {}
        self.history = []

    def set(self, addr, *floats, keepalive=None):
        v = tuple(float(f) for f in floats)
        self.values[addr] = v
        self.history.append((addr, v))

    def get(self, addr):
        v = self.values.get(addr)
        return None if v is None else (v[0] if len(v) == 1 else v)


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def sample(dev="STY", R=None, t=(0.0, 0.0, 1.0)):
    q = fl.fr.mat_to_quat(np.eye(3) if R is None else R)
    return poses.PoseSample(dev, 0.0, np.asarray(t, float), np.asarray(q, float))


class StylusGate(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.out = FakeStreamer()
        self.drv = fl.Driver(fl.Flashlight(TIP), self.out, "STY", stale_s=0.5, clock=self.clock)
        self.drv.start()

    def advance(self, dt, poses_every=None, dev="STY"):
        """Run the driver for dt seconds: ticks every 0.1 s, a pose every `poses_every`."""
        end = self.clock.t + dt
        next_pose = self.clock.t if poses_every else None
        while self.clock.t < end - 1e-9:
            if next_pose is not None and self.clock.t >= next_pose - 1e-9:
                self.drv.on_pose(sample(dev))
                next_pose += poses_every
            self.drv.tick()
            self.clock.t += min(0.05, end - self.clock.t)
        return self.drv.tick()

    def test_startup_without_a_pose_is_explicitly_inactive(self):
        self.assertEqual(self.out.get("/stylus_ok"), 0.0)
        self.assertEqual(self.out.get("/stylus_seq"), 0.0)
        self.assertEqual(self.out.get("/stale_after"), 0.5)
        self.assertNotIn("/origin", self.out.values)  # never a made-up beam
        self.assertEqual(self.advance(3.0), "waiting")
        state, line = self.drv.status({"source": "sse x", "state": "connected"})
        self.assertEqual(state, "waiting")
        self.assertIn("NO STYLUS", line)
        self.assertIn("no poses from anyone", line)

    def test_source_down_says_so(self):
        _, line = self.drv.status(
            {
                "source": "sse http://127.0.0.1:8765/events",
                "state": "disconnected",
                "error": "Connection refused",
            }
        )
        self.assertIn("is disconnected (Connection refused)", line)
        self.assertIn("pose_server/server.py", line)

    def test_other_trackers_but_not_the_stylus(self):
        # A healthy fixture tracker (or any other device) does not make the stylus valid.
        self.assertEqual(self.advance(1.0, poses_every=1 / 60, dev="FIXTURE"), "waiting")
        self.assertEqual(self.out.get("/stylus_ok"), 0.0)
        _, line = self.drv.status({"state": "connected"})
        self.assertIn("only from FIXTURE", line)
        self.assertIn("--stylus STY", line)

    def test_tracking_then_loss_then_recovery(self):
        self.assertEqual(self.advance(1.0, poses_every=1 / 60), "ok")
        self.assertEqual(self.out.get("/stylus_ok"), 1.0)
        seq = self.out.get("/stylus_seq")
        self.assertGreater(seq, 0.0)
        self.assertIn("/origin", self.out.values)
        state, line = self.drv.status({"state": "connected"})
        self.assertEqual(state, "ok")
        self.assertTrue(line.startswith("LIVE"))

        # Poses stop: fresh until the threshold, then stale and /stylus_ok 0.
        self.assertEqual(self.advance(0.4), "ok")
        self.assertEqual(self.out.get("/stylus_ok"), 1.0)
        self.assertEqual(self.advance(0.3), "stale")
        self.assertEqual(self.out.get("/stylus_ok"), 0.0)
        self.assertEqual(self.out.get("/stylus_seq"), seq)  # the heartbeat stopped too
        self.assertIsNone(self.drv.light.prev_R)  # no roll across the gap
        state, line = self.drv.status(
            {
                "state": "connected",
                "devices": {"STY": {"state": "lost_tracking", "reason": "Occluded"}},
            }
        )
        self.assertEqual(state, "stale")
        self.assertIn("STYLUS LOST", line)
        self.assertIn("tracking lost (Occluded)", line)

        # Poses resume: the gate reopens by itself (nothing redeployed).
        self.assertEqual(self.drv.on_pose(sample()), "recovered")
        self.assertEqual(self.out.get("/stylus_ok"), 1.0)
        self.assertNotEqual(self.out.get("/stylus_seq"), seq)
        self.assertEqual(self.advance(1.0, poses_every=1 / 60), "ok")
        self.assertEqual(self.drv.watch.losses, 1)

    def test_a_gap_is_not_a_roll(self):
        light = self.drv.light
        hue = light.hue
        self.drv.on_pose(sample(R=np.eye(3)))
        self.advance(1.0)  # stale
        # A quarter turn about the stylus axis across the gap: a fresh baseline, not a hue jump.
        self.drv.on_pose(sample(R=rot(light.axis, math.pi / 2)))
        self.assertAlmostEqual(light.hue, hue, places=9)

    def test_heartbeat_wraps_but_never_returns_to_zero(self):
        seen = set()
        for _ in range(2 * fl.SEQ_WRAP + 5):
            self.drv.on_pose(sample())
            seen.add(self.out.get("/stylus_seq"))
        self.assertNotIn(0.0, seen)
        self.assertEqual(max(seen), float(fl.SEQ_WRAP))

    def test_the_effect_declares_the_gate(self):
        with open(os.path.join(HERE, "effects", "flashlight_pose.glsl")) as f:
            src = f.read()
        for name in ("stylus_ok", "stylus_seq", "stale_after", "tracker_ok"):
            self.assertIn("uniform float %s " % name, src)
        # Inactive by default: no beam before the driver says the stylus is live.
        self.assertIn("uniform float stylus_ok : 0.0 .. 1.0 = 0.0;", src)


if __name__ == "__main__":
    unittest.main()
