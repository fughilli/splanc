"""Offline tests for the Android CI rep's DUT console handling (no reservation/hardware)."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from unittest import mock

import android_journeys as aj


class _FakeRes:
    """Stands in for hitl_client.Reservation: the journey ssh and the log read-back."""

    def __init__(self, journey, dut_log: str) -> None:
        self.journey = journey
        self.dut_log = dut_log
        self.cmds: list[str] = []

    def ssh(self, cmd: str, capture: bool = False, timeout: float | None = None):
        self.cmds.append(cmd)
        if cmd == f"cat {aj.REMOTE_DUT_LOG}":
            return subprocess.CompletedProcess(cmd, 0, self.dut_log, "")
        return self.journey(cmd, timeout)


class DutExcerptTests(unittest.TestCase):
    def test_short_log_is_printed_whole(self) -> None:
        lines = [f"l{i}" for i in range(150)]
        self.assertEqual(aj.dut_excerpt(lines, failed=False), lines)
        self.assertEqual(aj.dut_excerpt(lines, failed=True), lines)

    def test_pass_keeps_head_and_tail(self) -> None:
        lines = [f"l{i}" for i in range(1000)]
        out = aj.dut_excerpt(lines, failed=False)
        self.assertEqual(out[: aj.DUT_PASS_LINES], lines[: aj.DUT_PASS_LINES])
        self.assertEqual(out[-aj.DUT_PASS_LINES :], lines[-aj.DUT_PASS_LINES :])
        self.assertIn("800 DUT lines omitted", out[aj.DUT_PASS_LINES])

    def test_failure_prints_far_more_than_a_pass(self) -> None:
        lines = [f"l{i}" for i in range(3000)]
        self.assertEqual(aj.dut_excerpt(lines, failed=True), lines)
        big = [f"l{i}" for i in range(20000)]
        out = aj.dut_excerpt(big, failed=True)
        self.assertEqual(len(out), aj.DUT_FAIL_HEAD + 1 + aj.DUT_FAIL_LINES)
        self.assertEqual(out[-1], "l19999")


class RunJourneysLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        env = mock.patch.dict(os.environ, {"TEST_UNDECLARED_OUTPUTS_DIR": self.tmp.name})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self.tmp.cleanup)
        self.saved = os.path.join(self.tmp.name, "android_dut_serial.log")
        self.log = "".join(f"dut line {i}\n" for i in range(1200))

    def _run(self, res):
        return aj._run_journeys(res, "wss://x/ws", "connect", "real", "", "ap", "pw")

    def test_failure_saves_the_whole_dut_log(self) -> None:
        res = _FakeRes(
            lambda c, t: subprocess.CompletedProcess(c, 1, "[phone] boom\n", ""), self.log
        )
        with self.assertRaises(SystemExit):
            self._run(res)
        with open(self.saved) as f:
            self.assertEqual(f.read(), self.log)
        # The journey command no longer truncates the log in-band.
        self.assertNotIn("truncated", res.cmds[0])
        self.assertIn(aj.REMOTE_DUT_LOG, res.cmds[0])

    def test_timeout_still_fetches_the_dut_log(self) -> None:
        def hang(c, t):
            raise subprocess.TimeoutExpired(c, t)

        with self.assertRaises(subprocess.TimeoutExpired):
            self._run(_FakeRes(hang, self.log))
        with open(self.saved) as f:
            self.assertEqual(f.read(), self.log)

    def test_pass_returns_the_passed_journeys_and_saves_the_log(self) -> None:
        ok = subprocess.CompletedProcess("", 0, "[phone] PASS connect\n", "")
        self.assertEqual(self._run(_FakeRes(lambda c, t: ok, self.log)), ["connect"])
        self.assertTrue(os.path.exists(self.saved))


if __name__ == "__main__":
    unittest.main()
