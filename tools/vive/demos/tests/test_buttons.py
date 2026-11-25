"""The tracker-button wizard against the simulated tracker: press to start rubbing, press to
fit (which starts the touches), press on each blinking LED, double-press to skip one, press
to go to mount mode once converged, press to record the mount. Poses are fed on simulated
time (App.clock), so the pre-press window is exact. About 30 s (the fits).

    python3 tools/vive/demos/tests/test_buttons.py
"""

import os
import sys
import time
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import app as appmod  # noqa: E402
import synth  # noqa: E402


class Stream:
    """Stands in for OscStreamer: keeps the latest values."""

    sent = 0

    def __init__(self):
        self.values = {}

    def set(self, addr, *v, keepalive=None):
        self.values[addr] = v

    def clear(self, *addrs):
        for a in addrs:
            self.values.pop(a, None)


class NoSource:
    def status(self):
        return {"source": "test"}


class Sample:
    def __init__(self, t, M):
        self.dev, self.t, self.M = "T", t, M

    def matrix(self):
        return self.M


class Buttons(unittest.TestCase):
    def setUp(self):
        lm, true_p, true_n, geom = synth.cylinder_lamp()
        self.sim = synth.Sim(synth.Truth(geom), true_p, true_n)
        self.app = appmod.App(
            lm, NoSource(), Stream(), "test", device="T", mount_name="button-test"
        )
        self.now = 0.0
        self.app.clock = lambda: self.now
        self.last = None

    def tearDown(self):
        p = os.path.join(appmod.MOUNTS, "button-test.json")
        if os.path.exists(p):
            os.remove(p)

    def feed(self, samples):
        for t, M in samples:
            self.now = t
            self.last = M
            self.app.on_pose(Sample(t, M))

    def press(self, n=1):
        self.app._press(n, self.now)

    def settle(self):
        for _ in range(600):
            if not self.app.fitting:
                return
            time.sleep(0.05)
        self.fail("fit did not finish")

    def kinds(self):
        return [e["kind"] for e in self.app.events]

    def test_sequence(self):
        a = self.app
        self.press()
        self.assertEqual(a.mode, "rub")
        self.feed(self.sim.rub(20.0))
        self.press()  # stop & fit; the fit starts the touches
        self.settle()
        self.assertEqual(a.mode, "touch")
        self.assertIsNotNone(a.pick_row)

        # A press while still moving is rejected and changes nothing.
        target = self.sim.touch_pose(a.pick_row)
        self.feed(self.sim.transit(self.last, target, 0.8))
        self.press()
        self.assertEqual(self.kinds()[-1], "reject")
        self.assertEqual(len(a.touches), 0)

        # Double press skips the LED.
        skipped = a.pick_row
        self.press(2)
        self.assertIn(skipped, a.skip_rows)
        self.assertNotEqual(a.pick_row, skipped)

        for _ in range(14):
            if a.converged and a.pick_row is None:
                break
            target = self.sim.touch_pose(a.pick_row)
            self.feed(self.sim.transit(self.last, target, 0.8))
            self.feed(self.sim.hold(target, 1.0))
            n = len(a.touches)
            self.press()
            self.assertEqual(len(a.touches), n + 1, self.app.events[-1])
            # The press jolts the tracker; the accepted pose came from before it.
            self.feed(self.sim.transit(target, target, 0.2))
            self.settle()
        self.assertTrue(a.converged, a.conv)
        self.assertIsNone(a.pick_row)
        print(
            "converged after %d touches, touch rms %.2f mm"
            % (len(a.touches), a.fit.touch_rms * 1e3)
        )

        self.press()
        self.assertEqual(a.mode, "mount")
        mount = self.sim.mount_pose()
        self.feed(self.sim.transit(self.last, mount, 0.8))
        self.press()
        self.assertTrue(a.mount_armed)
        self.feed(self.sim.hold(mount, 1.6))
        self.assertEqual(a.mode, "live")
        self.assertIsNotNone(a.T_TF)

    def test_double_press_timing(self):
        a = self.app
        a.on_button("T")
        a.on_button("T")  # within DOUBLE_S: one double press
        a.on_button("other")  # not the followed tracker
        time.sleep(appmod.DOUBLE_S + 0.2)
        presses = [e for e in a.events if e["kind"] == "button"]
        self.assertEqual([e["n"] for e in presses], [2])
        a.on_button("T")  # a lone press fires after DOUBLE_S
        time.sleep(appmod.DOUBLE_S + 0.2)
        self.assertEqual([e["n"] for e in a.events if e["kind"] == "button"], [2, 1])
        self.assertEqual(a.mode, "rub")


if __name__ == "__main__":
    unittest.main()
