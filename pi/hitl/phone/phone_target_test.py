"""Dry-run tests for the phone targets (phone_target.py) — assert each target's
reachability model + command plan + app URL WITHOUT any hardware. The real launch
path shells out; here we only exercise the pure planning surface, so this runs in
CI/in-container and pins the adb/simctl/devicectl invocations each station will run.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import unittest
from unittest.mock import patch

os.environ.setdefault("HITL_ANDROID_SERIAL", "")  # keep _adb_base() deterministic

from phone_target import (  # noqa: E402
    AndroidDeviceTarget,
    AndroidEmulatorTarget,
    BrowserTarget,
    IosDeviceTarget,
    IosSimulatorTarget,
    StationPorts,
    make_target,
)

PORTS = StationPorts(http=8000, driver=9000, device=8443)


class AppUrlTests(unittest.TestCase):
    def test_browser_loopback_virtual(self) -> None:
        t = BrowserTarget()
        self.assertEqual(t.host_alias, "127.0.0.1")
        self.assertEqual(t.app_url(PORTS), "http://127.0.0.1:8000/?driver=ws://127.0.0.1:9000/")
        # virtual BLE → no &ble=real
        self.assertNotIn("ble=real", t.app_url(PORTS))

    def test_emulator_uses_10_0_2_2_and_rewrites_device_ws(self) -> None:
        t = AndroidEmulatorTarget()
        self.assertEqual(t.host_alias, "10.0.2.2")
        self.assertIn("http://10.0.2.2:8000/?driver=ws://10.0.2.2:9000/", t.app_url(PORTS))
        self.assertEqual(t.rewrite_device_ws("wss://127.0.0.1:8443/ws"), "wss://10.0.2.2:8443/ws")

    def test_real_targets_request_real_ble(self) -> None:
        for t in (AndroidDeviceTarget(), IosDeviceTarget(udid="UDID")):
            self.assertEqual(t.ble_mode, "real")
            self.assertIn("&ble=real", t.app_url(PORTS))


class CommandPlanTests(unittest.TestCase):
    def test_android_device_reverses_all_three_ports_then_opens(self) -> None:
        t = AndroidDeviceTarget()
        plan = t.command_plan(PORTS)
        # loopback via adb reverse → the phone dials 127.0.0.1 for everything
        self.assertEqual(t.host_alias, "127.0.0.1")
        reverses = [c for c in plan if "reverse" in c]
        self.assertEqual(len(reverses), 3)  # http, driver, device
        for p in ("8000", "9000", "8443"):
            self.assertTrue(any(f"tcp:{p}" in c for c in reverses), p)
        # last command opens the app URL via a VIEW intent, with ble=real
        last = plan[-1]
        self.assertIn("am", last)
        self.assertIn("android.intent.action.VIEW", last)
        self.assertTrue(any("ble=real" in a for a in last))
        # device_ws stays loopback (reverse handles it) — no rewrite
        self.assertEqual(t.rewrite_device_ws("wss://127.0.0.1:8443/ws"), "wss://127.0.0.1:8443/ws")

    def test_android_device_plan_wakes_and_uses_pin_when_set(self) -> None:
        # no PIN → wake + swipe only (works for None/Swipe locks)
        plan = AndroidDeviceTarget().command_plan(PORTS)
        joined = [" ".join(c) for c in plan]
        self.assertTrue(any("KEYCODE_WAKEUP" in c for c in joined))
        self.assertFalse(any("input text" in c for c in joined))
        # PIN set → the plan types it + submits, before any reverse/launch
        os.environ["HITL_ANDROID_PIN"] = "1234"
        try:
            joined = [" ".join(c) for c in AndroidDeviceTarget().command_plan(PORTS)]
        finally:
            del os.environ["HITL_ANDROID_PIN"]
        self.assertTrue(any("input text 1234" in c for c in joined))
        pin_i = next(i for i, c in enumerate(joined) if "input text 1234" in c)
        rev_i = next(i for i, c in enumerate(joined) if "reverse" in c)
        self.assertLess(pin_i, rev_i)  # unlock happens before the reverses

    def test_keyguard_state_parses_samsung_and_android_flags(self) -> None:
        parse = AndroidDeviceTarget._keyguard_locked
        self.assertTrue(parse("mDreamingLockscreen=true"))
        self.assertFalse(parse("mDreamingLockscreen=false"))
        self.assertTrue(parse("mShowingLockscreen=false mKeyguardShowing=true"))
        self.assertIsNone(parse("unrecognized window dump"))

    def test_locked_phone_fails_before_reverse_or_launch(self) -> None:
        import subprocess

        def run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, stdout="mDreamingLockscreen=true")

        with (
            patch.dict(os.environ, {"HITL_ANDROID_PIN": ""}),
            patch("phone_target._adb_prefix", return_value=["adb"]),
            patch("phone_target.subprocess.run", side_effect=run) as calls,
            patch("phone_target.time.monotonic", side_effect=[0, 11]),
        ):
            with self.assertRaisesRegex(RuntimeError, "Set HITL_ANDROID_PIN"):
                AndroidDeviceTarget().setup(PORTS)
        self.assertFalse(any("reverse" in c.args[0] for c in calls.call_args_list))

    def test_unlock_waits_for_keyguard_to_dismiss(self) -> None:
        import subprocess

        replies = ["mDreamingLockscreen=true", "mDreamingLockscreen=false"]
        with (
            patch("phone_target._adb_prefix", return_value=["adb"]),
            patch(
                "phone_target.subprocess.run",
                side_effect=lambda argv, **kwargs: subprocess.CompletedProcess(
                    argv, 0, stdout=replies.pop(0)
                ),
            ),
            patch("phone_target.time.sleep"),
        ):
            AndroidDeviceTarget()._wait_unlocked()
        self.assertEqual(replies, [])

    def test_cert_return_activates_original_app_not_an_old_run(self) -> None:
        target = AndroidDeviceTarget()
        target._app_url = "http://127.0.0.1:8000/?driver=ws://127.0.0.1:9000/&ble=real"
        tabs = [
            {"id": "certificate", "url": "https://192.168.60.53/"},
            {"id": "old-run", "url": "http://127.0.0.1:7000/?driver=ws://old/"},
            {
                "id": "app",
                "url": target._app_url + "#/maps",
                "webSocketDebuggerUrl": "ws://debug/app",
            },
        ]
        with (
            patch("phone_target._adb_prefix", return_value=["adb"]),
            patch(
                "phone_target.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, stdout="9222\n"),
            ) as adb,
            patch(
                "phone_target.urllib.request.urlopen",
                side_effect=[
                    io.BytesIO(json.dumps(tabs).encode()),
                    io.BytesIO(b"Target activated"),
                ],
            ) as http,
            patch.object(target, "_reload_app_tab") as reload,
        ):
            target._foreground_app()
        self.assertEqual(http.call_args_list[1].args[0], "http://127.0.0.1:9222/json/activate/app")
        reload.assert_called_once_with("ws://debug/app")
        self.assertEqual(adb.call_args_list[-1].args[0], ["adb", "forward", "--remove", "tcp:9222"])

    def test_previous_run_cleanup_closes_only_local_driver_tabs(self) -> None:
        tabs = [
            {"id": "old", "url": "http://127.0.0.1:7000/?driver=ws://old/#/maps"},
            {"id": "personal", "url": "https://example.com/?driver=normal"},
            {"id": "local", "url": "http://localhost:7000/"},
            {"id": "cert", "url": "https://192.168.60.53/"},
        ]
        with (
            patch("phone_target._adb_prefix", return_value=["adb"]),
            patch(
                "phone_target.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, stdout="9222\n"),
            ) as adb,
            patch(
                "phone_target.urllib.request.urlopen",
                side_effect=[
                    io.BytesIO(json.dumps(tabs).encode()),
                    io.BytesIO(b"Target closed"),
                ],
            ) as http,
        ):
            AndroidDeviceTarget()._close_previous_driver_tabs()
        self.assertEqual(http.call_args_list[1].args[0], "http://127.0.0.1:9222/json/close/old")
        self.assertEqual(http.call_count, 2)
        self.assertIn("--remove", adb.call_args_list[-1].args[0])

    def test_missing_app_tab_fails_and_removes_debug_forward(self) -> None:
        target = AndroidDeviceTarget()
        target._app_url = "http://127.0.0.1:8000/?driver=ws://127.0.0.1:9000/"
        with (
            patch("phone_target._adb_prefix", return_value=["adb"]),
            patch(
                "phone_target.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, stdout="9222\n"),
            ) as adb,
            patch("phone_target.urllib.request.urlopen", return_value=io.BytesIO(b"[]")),
        ):
            with self.assertRaisesRegex(RuntimeError, "lost the app tab"):
                target._foreground_app()
        self.assertIn("--remove", adb.call_args_list[-1].args[0])

    def test_android_provision_ble_takes_the_journeys_device_name(self) -> None:
        # connect.json passes `deviceName` (None when unresolved); the Android
        # tap-driven handler must accept it and pin the chooser to it when set.
        import sys
        import types

        seen = []

        class FakeProvisioner:
            def provision(self, ssid, password, name, timeout):
                seen.append(name)
                return True

        fake = types.ModuleType("android_ble_provision")
        fake.AndroidBleProvisioner = FakeProvisioner
        with patch.dict(sys.modules, {"android_ble_provision": fake}):
            t = AndroidDeviceTarget()
            r = t.provision_ble(ssid="ap", password="pw", deviceName=None)
            self.assertTrue(r["provisioned"])
            t.provision_ble(ssid="ap", password="pw", deviceName="Led Widget ED4555")
        self.assertEqual(seen[1], "Led Widget ED4555")

    def test_ios_sim_serverurl_via_run_endpoint_loopback(self) -> None:
        t = IosSimulatorTarget()
        plan = t.command_plan(PORTS)
        self.assertEqual(t.host_alias, "127.0.0.1")
        run = " ".join(plan[-1])
        # The real server's single /run?task= endpoint, not per-task routes.
        self.assertIn("/run?", run)
        self.assertIn("task=cap-sync%2Cios-run", run)
        self.assertIn("target=booted", run)
        # server.url carries the station app URL (loopback) with ?driver=; url-encoded.
        self.assertIn("server_url=", run)
        self.assertIn("127.0.0.1%3A8000", run)
        self.assertIn("driver%3D", run)

    def test_ios_device_build_install_launch(self) -> None:
        t = IosDeviceTarget(udid="00008110-DEADBEEF")
        plan = t.command_plan(PORTS)
        # One chained /run: cap-sync (bakes server.url) -> build -> install -> launch.
        self.assertEqual(len(plan), 1)
        run = " ".join(plan[0])
        self.assertIn("/run?", run)
        self.assertIn("task=cap-sync%2Cdevice-build%2Cdevice-install%2Cdevice-launch", run)
        self.assertIn("target=00008110-DEADBEEF", run)
        self.assertIn("bundle=dev.splanc.app", run)
        # The app URL (with &ble=real) is threaded as server_url, NOT a launch url=.
        self.assertIn("server_url=", run)
        self.assertNotIn("url%3D&", run)
        self.assertIn("ble%3Dreal", run)  # url-encoded &ble=real inside server_url

    def test_ios_device_dials_station_ip_when_set(self) -> None:
        os.environ["HITL_STATION_IP"] = "100.64.0.9"
        try:
            self.assertEqual(IosDeviceTarget().host_alias, "100.64.0.9")
        finally:
            del os.environ["HITL_STATION_IP"]


class FactoryTests(unittest.TestCase):
    def test_make_target_by_name(self) -> None:
        self.assertIsInstance(make_target("browser"), BrowserTarget)
        self.assertIsInstance(make_target("android-phone"), AndroidDeviceTarget)
        self.assertIsInstance(make_target("ios-sim"), IosSimulatorTarget)

    def test_make_target_from_env(self) -> None:
        os.environ["HITL_PHONE_TARGET"] = "ios-phone"
        try:
            self.assertIsInstance(make_target(), IosDeviceTarget)
        finally:
            del os.environ["HITL_PHONE_TARGET"]

    def test_emulator_real_ble_override(self) -> None:
        t = make_target("android-emu", ble_mode="real")
        self.assertEqual(t.ble_mode, "real")
        self.assertIn("&ble=real", t.app_url(PORTS))

    def test_unknown_target_errors(self) -> None:
        with self.assertRaises(SystemExit):
            make_target("nope")


if __name__ == "__main__":
    unittest.main()
