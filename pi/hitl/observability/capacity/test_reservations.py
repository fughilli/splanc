"""Unit tests for reservations.py (journal parsing + attribution). Run: python3 test_reservations.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import reservations as rsv  # noqa: E402

P = "hitl-rig-2 hitl-reserved[1]: 2026/10/20 00:00:00 "


def L(ts, msg):
    return f"2026-10-20T{ts}+00:00 {P}{msg}\n"


JOURNAL = [
    L("00:00:00", "concurrency: host cap=4 per-class=map[esp32c6:4 led-mapper-pi:2]"),
    L(
        "00:00:00",
        'hitl-reserved: host="hitl-rig-2" workspace="splanc" listening on :8087 (0 units)',
    ),
    # queued, activated, released by holder
    L(
        "00:01:00",
        'reserve: id=aaa owner="hitl-harness@runnervm1" unit="" type="esp32c6" caps=[] queued (position 1)',
    ),
    L("00:03:00", "reconcile: id=aaa active unit=c6-003f08 endpoint=hitl-rig-2:2222"),
    L("00:08:00", 'release: id=aaa reason="released by holder" wasActive=true'),
    # active immediately, lease expired
    L(
        "00:02:00",
        'reserve: id=bbb owner="led_capture" unit="" type="esp32c6" '
        "caps=[logic-analyzer-led-strip] active",
    ),
    L("00:02:01", "reconcile: id=bbb active unit=c6-fa0324 endpoint=hitl-rig-2:2223"),
    L("00:40:00", 'release: id=bbb reason="lease expired (no heartbeat)" wasActive=true'),
    # abandoned after a long wait (timeout), then retried by the same owner
    L(
        "00:05:00",
        'reserve: id=ccc owner="netstack-examples" unit="" type="esp32c6" caps=[] queued (position 3)',
    ),
    L("00:45:01", 'release: id=ccc reason="released by holder" wasActive=false'),
    L(
        "00:45:30",
        'reserve: id=ddd owner="netstack-examples" unit="" type="esp32c6" caps=[] queued (position 1)',
    ),
    # pinned Pi request still queued at a daemon restart
    L(
        "00:50:00",
        'reserve: id=eee owner="agent-x" unit="pi-ledmapper-1" type="" caps=[] queued (position 1)',
    ),
    L(
        "01:00:00",
        'hitl-reserved: host="hitl-rig-2" workspace="splanc" listening on :8087 (0 units)',
    ),
    "garbage line\n",
]


class Parse(unittest.TestCase):
    def setUp(self):
        self.recs = {r.id: r for r in rsv.parse_journal(JOURNAL)}

    def test_lifecycle(self):
        a = self.recs["aaa"]
        self.assertEqual((a.rig, a.unit, a.reason), ("hitl-rig-2", "c6-003f08", "holder"))
        self.assertEqual(a.wait, 120)
        self.assertEqual(a.hold, 300)
        b = self.recs["bbb"]
        self.assertEqual(b.wait, 0)  # 'active' on reserve
        self.assertEqual(b.reason, "expired")
        self.assertEqual(b.req_caps, ("logic-analyzer-led-strip",))
        c = self.recs["ccc"]
        self.assertTrue(c.abandoned)
        self.assertIsNone(c.hold)
        self.assertEqual(c.wait, 2401)

    def test_timestamp_formats(self):
        self.assertEqual(rsv._ts("2026-10-20T00:00:00+00:00"), rsv._ts("2026-10-20T00:00:00+0000"))
        self.assertEqual(rsv._ts("2026-10-20T00:00:00Z"), rsv._ts("2026-10-20T02:00:00+02:00"))
        line = (
            '2026-10-20T00:00:00.123456+0000 rig hitl-reserved[1]: x reserve: id=z owner="o" unit="" '
            'type="esp32c6" caps=[] active\n'
        )
        self.assertEqual(len(rsv.parse_journal([line])), 1)

    def test_restart_closes_open_reservations(self):
        e = self.recs["eee"]
        self.assertEqual(e.reason, "restart")
        self.assertTrue(e.abandoned)
        self.assertEqual(self.recs["ddd"].reason, "restart")

    def test_concurrency_timeline(self):
        tl = rsv.concurrency_timeline(JOURNAL, default_host_cap=2)
        self.assertEqual(tl[0][1:], (2, {}))  # before the first logged start
        self.assertEqual(tl[1][1:], (4, {"esp32c6": 4, "led-mapper-pi": 2}))
        self.assertEqual(tl[2][1:], (2, {}))  # a start without the line: old daemon default

    def test_classes(self):
        la = rsv.la_units_from(self.recs.values())
        self.assertEqual(la, {"c6-fa0324"})
        self.assertEqual(rsv.unit_caps_class("c6-fa0324", la), "c6-la")
        self.assertEqual(rsv.unit_caps_class("c6-003f08", la), "c6")
        self.assertEqual(rsv.unit_caps_class("pi-ledmapper-1", la), "pi")
        self.assertEqual(rsv.demand_caps_class(self.recs["bbb"]), "c6-la")
        self.assertEqual(rsv.demand_caps_class(self.recs["aaa"]), "c6")
        self.assertEqual(rsv.demand_caps_class(self.recs["eee"]), "pi")  # pinned unit's type


class Attribution(unittest.TestCase):
    def test_harness_owner_defaults(self):
        src = (
            'ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "led_capture"))\n'
            'ap.add_argument("--owner", default="hitl-fpga-ws281x")\n'
            'ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))\n'
        )
        self.assertEqual(rsv.harness_default_owners([src]), {"led_capture", "hitl-fpga-ws281x"})

    def test_classify(self):
        recs = rsv.parse_journal(JOURNAL)
        runs = [
            {
                "id": 1,
                "event": "push",
                "head_branch": "main",
                "conclusion": "success",
                "jobs": [
                    {
                        "name": "hitl_tests",
                        "started_at": "2026-10-20T00:00:30Z",
                        "completed_at": "2026-10-20T00:30:00Z",
                        "conclusion": "success",
                    }
                ],
            },
            {
                "id": 2,
                "event": "pull_request",
                "head_branch": "x",
                "conclusion": "failure",
                "jobs": [
                    {
                        "name": "hitl_tests",
                        "started_at": "2026-10-20T00:04:00Z",
                        "completed_at": "2026-10-20T01:00:00Z",
                        "conclusion": "failure",
                    }
                ],
            },
        ]
        jobs = rsv.ci_jobs_from_runs(runs)
        rsv.classify(
            recs,
            la_units={"c6-fa0324"},
            jobs=jobs,
            harness_owners={"led_capture", "netstack-examples"},
        )
        r = {x.id: x for x in recs}
        self.assertEqual(
            (r["aaa"].prio_class, r["aaa"].owner_kind, r["aaa"].outcome),
            ("merge-queue", "ci", "passed"),
        )
        self.assertEqual(r["bbb"].outcome, "expired")
        self.assertEqual(r["ccc"].prio_class, "pr-ci")  # newest running job wins
        self.assertEqual(r["ccc"].outcome, "abandoned")
        self.assertEqual((r["eee"].prio_class, r["eee"].owner_kind), ("dev", "agent"))


if __name__ == "__main__":
    unittest.main()
