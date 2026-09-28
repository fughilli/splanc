"""Dry-run tests for the phone targets (phone_target.py) — assert each target's
reachability model + command plan + app URL WITHOUT any hardware. The real launch
path shells out; here we only exercise the pure planning surface, so this runs in
CI/in-container and pins the adb/simctl/devicectl invocations each station will run.
"""

from __future__ import annotations

import os
import unittest

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

    def test_ios_sim_launches_then_openurl_loopback(self) -> None:
        t = IosSimulatorTarget()
        plan = t.command_plan(PORTS)
        self.assertEqual(t.host_alias, "127.0.0.1")
        openurl = plan[-1]
        self.assertEqual(openurl[:4], ["xcrun", "simctl", "openurl", "booted"])
        self.assertIn("http://127.0.0.1:8000/?driver=ws://127.0.0.1:9000/", openurl[-1])

    def test_ios_device_build_install_launch(self) -> None:
        t = IosDeviceTarget(udid="00008110-DEADBEEF")
        plan = t.command_plan(PORTS)
        joined = [" ".join(c) for c in plan]
        self.assertTrue(any("/device-build" in c for c in joined))
        self.assertTrue(any("/device-install" in c and "00008110-DEADBEEF" in c for c in joined))
        launch = joined[-1]
        self.assertIn("/device-launch", launch)
        self.assertIn("ble%3Dreal", launch)  # url-encoded &ble=real in the query

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
