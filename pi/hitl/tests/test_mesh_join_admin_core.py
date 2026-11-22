"""Unit tests for the mesh M7 mesh_join_admin HITL's pure logic (mesh_join_admin_core)."""

from __future__ import annotations

import copy
import unittest

import mesh_join_admin_core as core
import pytest

MEMBERSHIP = (
    "[mesh] membership phase=member mode=closed epoch=2 admin_key=1 site_secret=1 persist=1 "
    "key=0011223344556677 devkey=1 revoked=1 pending=1 gw_session=7 roster=1 synced=0 mesh_s=900 "
    "groups=3.7 pend1170=8899aabbccddeeff"
)
ADMIN = (
    "[mesh] admin grants_ok=0 grants_bad=0 confirms=0 accepted=0 held=0 bad_mac=0 stale=0 "
    "admitted=1 bad_proofs=0 joins_pending=1 rejoin_revoked=4 joined=0 untrusted=1 refused=0 "
    "epochs_signed=0 epochs_sent=3 epochs_unsigned=2 epochs_refused=0 crypto_jobs=2 "
    "crypto_us_max=41000 crypto_us_last=39000"
)


def good() -> dict:
    rounds = {"sent": 6, "ok": 6}
    return {
        "baseline": {"fps_min": 80},
        "form": {"formed": True, "fps_min": 80},
        "unapproved": {"c_phase": "joining", "c_epoch": 0, "listed": True},
        "locked": {
            "send_error": "MESH_SEND_LOCKED",
            "admit_error": "MESH_ADMIN_LOCKED",
            "b_send_error": "MESH_SEND_LOCKED",
            "bad_grant_error": "MESH_ADMIN_BAD_GRANT",
            "forged_untrusted": 1,
            "forged_dispatched": 0,
        },
        "unlock": {"error": "MESH_ADMIN_OK", "b_synced": True},
        "admit": {"error": "MESH_ADMIN_OK", "c_member": True, "c_synced": True},
        "control": {"rounds": dict(rounds), "fps_min": 79},
        "epoch": {
            "b_refused": True,
            "forged_sent": True,
            "forged_taken": [],
            "a_originated": True,
            "followed": ["b", "c"],
        },
        "revoke": {"error": "MESH_ADMIN_OK", "rekeyed": ["a", "b"]},
        "revoked": {"rounds": dict(rounds), "rejoin_refused": 3},
        "reboot": {
            "restored": {"a": {"epoch": 2, "revoked": 1}, "b": {"epoch": 2, "revoked": 1}},
            "resets": 3,
            "fps_min": 30,
        },
        "after_reboot": {"rounds": dict(rounds), "rejoin_refused": 2},
    }


class ParseTest(unittest.TestCase):
    def test_membership_merges_both_lines(self) -> None:
        m = core.membership(
            [
                "[mesh] info id=3170 phase=member",
                "[mesh] gw sends=3 ctl_in=5",
                "noise",
                MEMBERSHIP,
                ADMIN,
            ]
        )
        self.assertEqual((m["id"], m["gw_ctl_in"]), ("3170", 5))
        self.assertEqual(m["phase"], "member")
        self.assertEqual((m["epoch"], m["revoked"], m["rejoin_revoked"]), (2, 1, 4))
        self.assertEqual(m["pending_keys"], {"1170": "8899aabbccddeeff"})
        self.assertEqual(m["groups"], "3.7")
        self.assertEqual(m["key"], "0011223344556677")
        self.assertEqual(core.membership([])["pending_keys"], {})

    def test_logs(self) -> None:
        lines = [
            "[mesh] crypto job=1 us=38000",
            "[mesh] crypto job=2 us=41000",
            "[mt] timebase gen=2 origin=3170 local_ms=5 shift=0",
            "[mt] epoch heard gen=2 origin=3170 mesh=9",
        ]
        self.assertEqual(core.crypto_us(lines), [38000, 41000])
        self.assertEqual(core.timebase_origins(lines), {"3170"})
        self.assertEqual(core.heard_origins(lines), {"3170"})

    def test_replies(self) -> None:
        self.assertEqual(core.admin_error({"type": "mesh", "admin": {"op": 2}}), "MESH_ADMIN_OK")
        self.assertEqual(
            core.admin_error({"type": "mesh", "admin": {"error": "MESH_ADMIN_LOCKED"}}),
            "MESH_ADMIN_LOCKED",
        )
        self.assertIsNone(core.admin_error({"type": "welcome"}))
        self.assertIsNone(core.send_error({"type": "playback_state"}))
        self.assertEqual(
            core.send_error({"type": "mesh", "result": {"error": "MESH_SEND_LOCKED"}}),
            "MESH_SEND_LOCKED",
        )
        r = {"members": [{"node": 5}, {"node": 6, "status": "MESH_MEMBER_MISSING"}]}
        self.assertEqual(core.member_status(r), {5: "MESH_MEMBER_OK", 6: "MESH_MEMBER_MISSING"})
        sends = [
            {"members": {5: "MESH_MEMBER_OK", 6: "MESH_MEMBER_MISSING"}},
            {"members": {5: "MESH_MEMBER_OK", 6: "MESH_MEMBER_OK"}},
        ]
        self.assertEqual(core.rounds_ok(sends, {5}, {6}), 1)
        self.assertEqual(core.rounds_ok(sends, {5, 6}, set()), 1)


@pytest.mark.requirements("PR-40")
class LateFramesTest(unittest.TestCase):
    """PR-40: a late frame is attributed to a flash write in its [ft] window (or the one
    before), else it is CPU work on the render path (crypto) and always fails."""

    LINES = [
        "[ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11",
        "[mesh] crypto job=1 us=53000",
        "[ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11",
        "[mesh] state saved ok us=91000",
        "[ft] r83:11970/12180/25499 w83:1/1/1 dt25 fps=80 sl=11-12",
        "[late] n=1 max=25499 ago_ms=700",
        "[ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11",
        "[ft] r82:11970/12300/40000 w82:1/1/1 dt40 fps=80 sl=11-12",
        "[late] n=2 max=40000 ago_ms=300",
    ]

    def test_attribution(self) -> None:
        late = core.late_frames(self.LINES)
        self.assertEqual([(x["n"], x["save_us"]) for x in late], [(1, 91000), (2, None)])
        self.assertEqual(core.late_counts({"a": late}), (2, 1))

    def test_gate(self) -> None:
        p = good()
        p["unlock"]["late"] = {"a": [{"n": 1, "max_us": 30000, "ago_ms": 5, "save_us": None}]}
        ok, why = core.verdict(p)
        self.assertFalse(ok)
        self.assertTrue(any("not explained by a flash write" in w for w in why), why)
        p = good()
        p["revoke"]["late"] = {"b": [{"n": 1, "max_us": 30000, "ago_ms": 5, "save_us": 90000}]}
        self.assertFalse(core.verdict(p)[0])
        self.assertTrue(core.verdict(p, allow_save_late=True)[0])
        # The effect's start (baseline) and the reboot are exempt.
        p = good()
        p["baseline"]["late"] = {"c": [{"n": 3, "max_us": 30000, "ago_ms": 5, "save_us": None}]}
        self.assertTrue(core.verdict(p)[0])


class VerdictTest(unittest.TestCase):
    def test_pass(self) -> None:
        ok, why = core.verdict(good())
        self.assertTrue(ok, why)

    def test_each_failure_is_named(self) -> None:
        cases = [
            (("form", "formed"), False, "form"),
            (("unapproved", "c_phase"), "member", "unapproved"),
            (("unapproved", "c_epoch"), 1, "without approval"),
            (("locked", "send_error"), None, "mesh_send before a grant"),
            (("locked", "forged_dispatched"), 1, "dispatched"),
            (("unlock", "b_synced"), False, "never synced"),
            (("admit", "c_member"), False, "did not join"),
            (("epoch", "forged_taken"), ["a"], "forged epoch was taken"),
            (("epoch", "followed"), ["b"], "followed by"),
            (("revoke", "rekeyed"), ["a"], "rekeyed"),
            (("revoked", "rejoin_refused"), 0, "rejoin was never refused"),
            (("after_reboot", "rejoin_refused"), 0, "after the reboot"),
        ]
        for (phase, key), value, text in cases:
            p = good()
            p[phase][key] = value
            ok, why = core.verdict(p)
            self.assertFalse(ok, (phase, key))
            self.assertTrue(any(text in w for w in why), (phase, key, why))

    def test_rounds_fps_and_resets(self) -> None:
        p = good()
        p["revoked"]["rounds"] = {"sent": 6, "ok": 4}
        self.assertFalse(core.verdict(p)[0])
        p = good()
        del p["after_reboot"]
        self.assertIn("after_reboot: missing", core.verdict(p)[1])
        p = good()
        p["control"]["fps_min"] = 70
        self.assertFalse(core.verdict(p)[0])
        p = good()
        p["control"]["resets"] = 1
        self.assertFalse(core.verdict(p)[0])
        # The reboot phase may reset and drop frames.
        p = copy.deepcopy(good())
        self.assertTrue(core.verdict(p)[0])
        p["reboot"]["restored"]["b"] = {"epoch": 1, "revoked": 0}
        self.assertFalse(core.verdict(p)[0])


if __name__ == "__main__":
    unittest.main()
