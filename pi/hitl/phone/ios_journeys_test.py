"""Offline tests for the iOS CI rep's argv construction (no reservation/hardware)."""

from __future__ import annotations

import unittest

from ios_journeys import ci_argv


class CiArgvTests(unittest.TestCase):
    def test_defaults_reserve_the_mac_and_run_smoke_virtually(self) -> None:
        argv = ci_argv({}, [])
        self.assertEqual(
            argv,
            [
                "--server",
                "http://mac-mini:8087",
                "--owner",
                "ios-ci",
                "--journeys",
                "smoke",
                "--ble-mode",
                "virtual",
            ],
        )

    def test_env_configures_the_rep(self) -> None:
        argv = ci_argv(
            {
                "HITL_IOS_SERVER": "http://mac:9",
                "HITL_OWNER": "gh-123",
                "HITL_IOS_JOURNEYS": "smoke,connect",
                "HITL_IOS_BLE_MODE": "real",
                "HITL_IOS_FLASH_C6": "1",
            },
            [],
        )
        self.assertEqual(argv[argv.index("--server") + 1], "http://mac:9")
        self.assertEqual(argv[argv.index("--owner") + 1], "gh-123")
        self.assertEqual(argv[argv.index("--journeys") + 1], "smoke,connect")
        self.assertEqual(argv[argv.index("--ble-mode") + 1], "real")
        self.assertIn("--flash-c6", argv)

    def test_cli_args_come_last_so_they_override(self) -> None:
        argv = ci_argv({}, ["--journeys", "connect"])
        self.assertEqual(argv[-2:], ["--journeys", "connect"])


if __name__ == "__main__":
    unittest.main()
