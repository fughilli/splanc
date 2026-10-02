#!/usr/bin/env python3
"""Unit tests for the fleet-inventory aggregation (offline: parses the 4 real
catalogs + fleet.json into the flat rows). No network / no bazel:

    python3 test_gen_inventory.py
"""

from __future__ import annotations

import os
import unittest

import gen_inventory as gi

HERE = os.path.dirname(os.path.abspath(__file__))


def _rows():
    fleet = gi.load_json(gi.FLEET_MAP)
    return gi.build_inventory(fleet, gi.RESERVE_DIR)


class TestIdentifier(unittest.TestCase):
    def test_explicit_env_serial(self):
        c = {"env": {"HITL_ADAPTER_SERIAL": "58:E6:C5:11:FC:B0"}}
        self.assertEqual(gi._identifier(c), "58:E6:C5:11:FC:B0")

    def test_suffixed_env_key_matched_by_prefix(self):
        # A rig's 2nd DUT uses HITL_ADAPTER_SERIAL_1 / HITL_TTY_1.
        c = {"env": {"HITL_ADAPTER_SERIAL_1": "58:E6:C5:11:FC:D8", "HITL_TTY_1": "/dev/ttyACM1"}}
        self.assertEqual(gi._identifier(c), "58:E6:C5:11:FC:D8")

    def test_udid_wins_over_other_markers(self):
        c = {"env": {"HITL_IOS_UDID": "00008110-000E5CE10251A01E", "HITL_TTY": "/dev/x"}}
        self.assertEqual(gi._identifier(c), "00008110-000E5CE10251A01E")

    def test_jtag_mac_parsed_from_devices_not_split_on_colon(self):
        # The MAC contains colons and the entry carries a ':/dev/ttyACM0' mount —
        # a naive split(':') would return a fragment.
        c = {
            "devices": [
                "/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_58:E6:C5:F9:83:C8-if00:/dev/ttyACM0"
            ]
        }
        self.assertEqual(gi._identifier(c), "58:E6:C5:F9:83:C8")

    def test_no_identifier(self):
        self.assertEqual(gi._identifier({}), "")


class TestInventory(unittest.TestCase):
    def setUp(self):
        self.rows = _rows()
        self.by_host: dict[str, list[dict]] = {}
        for r in self.rows:
            self.by_host.setdefault(r["host"], []).append(r)

    def _find(self, host, dut):
        for r in self.rows:
            if r["host"] == host and r["dut"] == dut:
                return r
        return None

    def test_all_hosts_present(self):
        # Every host in the map appears — including the Mac, whose metrics push
        # isn't wired yet (the catalog is static, so it shows regardless).
        self.assertEqual(
            set(self.by_host),
            {"hitl-rig-1", "hitl-rig-2", "hitl-rig-3", "amd-rig", "mac-mini"},
        )

    def test_row_schema_stable(self):
        expected = {
            "host",
            "board",
            "unit",
            "dut",
            "type",
            "kind",
            "capabilities",
            "identifier",
            "discovered",
            "pin_only",
            "source",
        }
        for r in self.rows:
            self.assertEqual(set(r), expected)
            self.assertIsInstance(r["capabilities"], str)  # joined for the table
            self.assertIsInstance(r["discovered"], bool)
            self.assertIsInstance(r["pin_only"], bool)

    def test_sdr_composite_components_are_concrete_and_pinned(self):
        c60 = self._find("amd-rig", "c6-0")
        self.assertIsNotNone(c60)
        self.assertEqual(c60["unit"], "c6-sdr")
        self.assertEqual(c60["kind"], "usb")
        self.assertTrue(c60["pin_only"])
        self.assertFalse(c60["discovered"])
        self.assertEqual(c60["identifier"], "58:E6:C5:11:FC:B0")
        self.assertIn("jtag", c60["capabilities"])
        # The HackRF component of the same composite unit.
        sdr = self._find("amd-rig", "sdr-0")
        self.assertEqual(sdr["type"], "hackrf-one")
        self.assertIn("sdr", sdr["capabilities"])

    def test_amd_rig_covers_both_daemons(self):
        # Both the SDR catalog and the phone catalog contribute rows.
        sources = {r["source"] for r in self.by_host["amd-rig"]}
        self.assertEqual(sources, {"catalog-sdr.json", "catalog-phone.json"})
        # The Android phone (a non-USB-passthrough dev device) shows its adb serial.
        android = self._find("amd-rig", "android-dev")
        self.assertEqual(android["identifier"], "R95N90G5WSB")
        self.assertEqual(android["type"], "android-dev")

    def test_mac_ios_unit_metadata(self):
        ios = self._find("mac-mini", "ios-dev")
        self.assertEqual(ios["unit"], "ios-phone")
        self.assertEqual(ios["identifier"], "00008110-000E5CE10251A01E")
        self.assertIn("real-ble", ios["capabilities"])
        self.assertFalse(ios["discovered"])

    def test_pi_rigs_are_discovery_rows(self):
        for host in ("hitl-rig-1", "hitl-rig-2", "hitl-rig-3"):
            c6 = self._find(host, "c6-* (auto)")
            self.assertIsNotNone(c6, host)
            self.assertTrue(c6["discovered"])
            self.assertEqual(c6["type"], "esp32c6")
        # Only rig-3 has the ESP32-C3 (its chip_overrides board).
        self.assertIsNotNone(self._find("hitl-rig-3", "c3-* (auto)"))
        self.assertIsNone(self._find("hitl-rig-1", "c3-* (auto)"))
        self.assertIsNone(self._find("hitl-rig-2", "c3-* (auto)"))

    def test_pi_rigs_carry_shared_logic_analyzer(self):
        la = self._find("hitl-rig-1", "logic-analyzer")
        self.assertIsNotNone(la)
        self.assertEqual(la["unit"], "(shared)")
        self.assertEqual(la["identifier"], "fx2lafw")

    def test_committed_inventory_is_up_to_date(self):
        # Guards against a hand-edited catalog without a regenerate.
        out = gi.render(self.rows)
        with open(gi.OUT_FILE) as f:
            self.assertEqual(f.read(), out, "run gen_inventory.py and commit the result")


if __name__ == "__main__":
    unittest.main(verbosity=2)
