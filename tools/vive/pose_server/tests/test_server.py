"""Pose server: the batch's capability/health shape per source.

lhd has no per-sensor light or sweep-angle stream, so those fields must read as
unavailable (null), never as a measured zero; libsurvive does emit them, and its
genuine zeros stay zeros. "No optical telemetry", "no pose output" and "lost
tracking" are separate conditions.

    python3 tools/vive/pose_server/tests/test_server.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

POSE = {
    "type": "pose",
    "serial": "LHR-STYLUS",
    "t": 1.0,
    "p": [0.1, 0.2, 1.0],
    "q": [1.0, 0.0, 0.0, 0.0],
}


def lhd_hub():
    hub = server.Hub(source="lhd")
    hub.lhd_event(
        {
            "type": "calibrated",
            "reason": "FirstStations",
            "stations": [{"id": 12, "mode": 2, "p": [0, 0, 2], "q": [1, 0, 0, 0], "rms": 47e-6}],
        }
    )
    return hub


class LhdAdapter(unittest.TestCase):
    def test_a_dropped_station_leaves_the_world(self):
        hub = lhd_hub()
        q = hub.subscribe()
        self.assertEqual([lh["id"] for lh in q.get_nowait()["lighthouses"]], ["12"])
        hub.lhd_event({"type": "station_dropped", "id": 12, "why": "NotSeen"})
        self.assertEqual(hub.lighthouses, {})
        msgs = [q.get_nowait() for _ in range(q.qsize())]
        self.assertIn({"type": "lighthouse_removed", "id": "12"}, msgs)
        self.assertEqual([lh["id"] for lh in hub.subscribe().get_nowait()["lighthouses"]], [])

    def test_a_new_lhd_starts_without_the_old_stations(self):
        hub = lhd_hub()
        q = hub.subscribe()
        q.get_nowait()
        hub.clear_lighthouses()
        self.assertEqual(hub.lighthouses, {})
        self.assertIn(
            {"type": "lighthouse_removed", "id": "12"}, [q.get_nowait() for _ in range(q.qsize())]
        )

    def test_optical_fields_are_unavailable_not_zero(self):
        hub = lhd_hub()
        for i in range(60):
            hub.lhd_event(dict(POSE, t=1.0 + i / 60))
        hub.lhd_event({"type": "imu", "serial": "LHR-STYLUS", "acc": [0, 0, 1], "gyro": [0, 0, 0]})
        hub.tick_rates(1.0)
        m = hub.batch(server.time.time())
        self.assertIsNone(m["lit"])  # not {} (= nothing lit)
        self.assertIsNone(m["rates"]["angle"])  # not 0 sweep hits
        self.assertIsNone(m["rates"]["hid"])
        self.assertEqual(m["rates"]["pose"], 60.0)  # measured values stay numbers
        self.assertEqual(m["rates"]["imu"], 1.0)
        caps = m["capabilities"]
        self.assertFalse(caps["optical"])
        self.assertFalse(caps["hid"])
        self.assertTrue(caps["pose"] and caps["imu"] and caps["tracking_events"])
        self.assertEqual(m["health"]["optical"], "unavailable")
        self.assertEqual(m["health"]["summary"], "tracking")
        self.assertEqual(m["health"]["devices"]["LHR-STYLUS"]["state"], "tracking")
        self.assertEqual(m["status"]["source"], "lhd")

    def test_snapshot_carries_capabilities(self):
        hub = lhd_hub()
        snap = hub.subscribe().get_nowait()
        self.assertEqual(snap["type"], "snapshot")
        self.assertFalse(snap["capabilities"]["optical"])
        self.assertEqual([lh["id"] for lh in snap["lighthouses"]], ["12"])

    def test_solver_hits_when_lhd_reports_them(self):
        hub = lhd_hub()
        m = hub.batch(server.time.time())
        self.assertFalse(m["capabilities"]["pose_hits"])
        self.assertIsNone(m["rates"]["hits_used"])
        for i in range(10):
            hub.lhd_event(dict(POSE, used=7, gated=1))
        hub.tick_rates(1.0)
        m = hub.batch(server.time.time())
        self.assertTrue(m["capabilities"]["pose_hits"])
        self.assertEqual(m["rates"]["hits_used"], 70.0)
        self.assertEqual(m["health"]["devices"]["LHR-STYLUS"]["hits_used"], 7)
        self.assertIsNone(m["lit"])  # still no per-sensor telemetry

    def test_no_pose_output_is_not_lost_tracking(self):
        hub = lhd_hub()
        hub.lhd_event(POSE)
        hub.lhd_event(
            {"type": "tracking", "serial": "LHR-STYLUS", "state": "started", "rms": 0.001}
        )
        now = server.time.time()
        self.assertEqual(hub.batch(now)["health"]["devices"]["LHR-STYLUS"]["state"], "tracking")
        # Poses stop, no loss reported: no pose output.
        later = now + server.POSE_STALE_S + 1.0
        d = hub.batch(later)["health"]["devices"]["LHR-STYLUS"]
        self.assertEqual(d["state"], "no_pose_output")
        self.assertEqual(d["tracking"], "started")
        self.assertGreater(d["pose_age"], server.POSE_STALE_S)
        # lhd says it lost tracking: a different condition, with its reason.
        hub.lhd_event(
            {"type": "tracking", "serial": "LHR-STYLUS", "state": "lost", "reason": "Occluded"}
        )
        h = hub.batch(later)["health"]
        self.assertEqual(h["devices"]["LHR-STYLUS"]["state"], "lost_tracking")
        self.assertEqual(h["devices"]["LHR-STYLUS"]["reason"], "Occluded")
        self.assertEqual(h["summary"], "lost_tracking")
        self.assertEqual(h["optical"], "unavailable")  # unchanged by tracking either way
        # Tracking resumes.
        hub.lhd_event(
            {"type": "tracking", "serial": "LHR-STYLUS", "state": "started", "rms": 0.001}
        )
        hub.lhd_event(POSE)
        self.assertEqual(hub.batch(server.time.time())["health"]["summary"], "tracking")

    def test_device_gone_is_lost_tracking(self):
        hub = lhd_hub()
        hub.lhd_event(POSE)
        hub.lhd_event(
            {"type": "device", "name": "tracker", "serial": "LHR-STYLUS", "state": "disconnected"}
        )
        d = hub.batch(server.time.time())["health"]["devices"]["LHR-STYLUS"]
        self.assertEqual(d["state"], "lost_tracking")
        self.assertEqual(d["tracking"], "disconnected")

    def test_no_devices(self):
        h = lhd_hub().batch(server.time.time())["health"]
        self.assertEqual(h["summary"], "no_devices")
        self.assertEqual(h["devices"], {})


class LibsurviveSource(unittest.TestCase):
    """A source that does emit optical events: zeros there are measurements."""

    def test_genuine_zero_stays_zero(self):
        hub = server.Hub(source="libsurvive")
        hub.line("1.0 T20 POSE 0.1 0.2 1.0 1 0 0 0")
        hub.tick_rates(1.0)
        m = hub.batch(server.time.time())
        self.assertEqual(m["lit"], {})  # measured: nothing lit
        self.assertEqual(m["rates"]["angle"], 0.0)
        self.assertEqual(m["rates"]["hid"], 0.0)
        self.assertTrue(m["capabilities"]["optical"])
        self.assertFalse(m["capabilities"]["tracking_events"])
        self.assertEqual(m["health"]["optical"], "dark")
        self.assertEqual(m["health"]["devices"]["T20"]["state"], "tracking")

    def test_hits_are_reported(self):
        hub = server.Hub(source="libsurvive")
        # "<t> <dev> A <sensor> <acode> <timecode> <length> <angle> <lh>"
        hub.line("1.0 T20 A 5 1 0 0 0.1 0")
        hub.line("1.0 T20 A 6 0 0 0 0.1 0")
        hub.tick_rates(1.0)
        m = hub.batch(server.time.time())
        self.assertEqual(m["rates"]["angle"], 2.0)
        self.assertEqual(m["lit"], {"T20": {"0": [[6], [5]]}})
        self.assertEqual(m["health"]["optical"], "lit")
        self.assertEqual(m["health"]["summary"], "no_devices")  # light but no pose yet


if __name__ == "__main__":
    unittest.main()
