"""Dry-run tests for android_ble_provision.py — the pure view-tree parse + the
chooser-row disambiguation, exercised on captured uiautomator XML, no hardware."""

from __future__ import annotations

import unittest

from android_ble_provision import (
    find_chooser_row,
    find_first_run_button,
    find_network_row,
    parse_connectivity_ssid,
    parse_nodes,
    parse_wifi_ssid,
)

# A trimmed real dump of the app's in-app BLE form (SSID + password + scan button).
FORM_XML = """<hierarchy rotation="0">
<node text="Add device over Bluetooth" class="android.widget.TextView" clickable="false" bounds="[28,373][409,423]" />
<node content-desc="Add device (Bluetooth)" class="android.widget.Button" clickable="true" bounds="[56,563][141,651]" />
<node text="" class="android.widget.EditText" clickable="true" password="false" bounds="[28,541][693,618]" />
<node text="" class="android.widget.EditText" clickable="true" password="true" bounds="[28,651][693,728]" />
<node text="Scan for device" class="android.widget.Button" clickable="true" bounds="[28,761][693,791]" />
</hierarchy>"""

# A crowded OS chooser: several Improv nodes, ours is "E2F5EF".
CHOOSER_XML = """<hierarchy>
<node text="Led Widget CDFD25" class="android.widget.TextView" clickable="true" bounds="[40,300][680,360]" />
<node text="Led Widget E2F5EF" class="android.widget.TextView" clickable="true" bounds="[40,380][680,440]" />
<node text="ledmapper" class="android.widget.TextView" clickable="true" bounds="[40,460][680,520]" />
<node text="Pair" class="android.widget.Button" clickable="true" bounds="[500,600][680,660]" />
</hierarchy>"""


class ParseTests(unittest.TestCase):
    def test_parses_fields_and_button(self) -> None:
        nodes = parse_nodes(FORM_XML)
        edits = [n for n in nodes if "EditText" in n.cls]
        self.assertEqual(len(edits), 2)
        self.assertFalse(edits[0].password)
        self.assertTrue(edits[1].password)
        # SSID field center is the box midpoint
        self.assertEqual(edits[0].center, (360, 579))
        scan = next(n for n in nodes if n.text == "Scan for device")
        self.assertTrue(scan.clickable)
        self.assertEqual(scan.center, (360, 776))

    def test_ble_button_by_desc(self) -> None:
        nodes = parse_nodes(FORM_XML)
        btn = next(n for n in nodes if n.desc == "Add device (Bluetooth)")
        self.assertTrue(btn.clickable)


class ChooserTests(unittest.TestCase):
    def test_picks_matching_row_out_of_crowd(self) -> None:
        row = find_chooser_row(parse_nodes(CHOOSER_XML), "E2F5EF")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.text, "Led Widget E2F5EF")

    def test_no_match_returns_none(self) -> None:
        self.assertIsNone(find_chooser_row(parse_nodes(CHOOSER_XML), "ZZZZZZ"))

    def test_match_is_case_insensitive(self) -> None:
        row = find_chooser_row(parse_nodes(CHOOSER_XML), "e2f5ef")
        assert row is not None
        self.assertEqual(row.text, "Led Widget E2F5EF")


# A Chrome first-run / sign-in wall (ToS accept, then decline sign-in).
TOS_XML = """<hierarchy>
<node text="Welcome to Chrome" class="android.widget.TextView" clickable="false" bounds="[40,200][680,260]" />
<node text="Accept &amp; continue" class="android.widget.Button" clickable="true" bounds="[40,1300][680,1380]" />
</hierarchy>"""

SIGNIN_XML = """<hierarchy>
<node text="Turn on sync?" class="android.widget.TextView" clickable="false" bounds="[40,200][680,260]" />
<node text="Yes, I'm in" class="android.widget.Button" clickable="true" bounds="[360,1300][680,1380]" />
<node text="No thanks" class="android.widget.Button" clickable="true" bounds="[40,1300][340,1380]" />
</hierarchy>"""

# The app's own onboarding — must NOT be mistaken for a first-run wall.
APP_XML = """<hierarchy>
<node content-desc="Add device (Bluetooth)" class="android.widget.Button" clickable="true" bounds="[56,563][141,651]" />
<node text="Scan for device" class="android.widget.Button" clickable="true" bounds="[28,761][693,791]" />
</hierarchy>"""

# OneUI Wi-Fi settings: our AP is below the fold and carries the SSID in content-desc.
WIFI_LIST_XML = """<hierarchy>
<node text="CoolerKids" class="android.widget.TextView" clickable="false" bounds="[40,300][680,360]" />
<node text="" content-desc="amd-rig-ap, Secured" class="LinearLayout" clickable="true" bounds="[40,380][680,460]" />
<node text="NeighborNet" class="android.widget.TextView" clickable="false" bounds="[40,480][680,540]" />
</hierarchy>"""


class FirstRunTests(unittest.TestCase):
    def test_accepts_tos_first(self) -> None:
        btn = find_first_run_button(parse_nodes(TOS_XML))
        assert btn is not None
        self.assertTrue(btn.text.lower().startswith("accept"))
        self.assertTrue(btn.clickable)

    def test_declines_signin_not_optin(self) -> None:
        # Must pick "No thanks", never "Yes, I'm in".
        btn = find_first_run_button(parse_nodes(SIGNIN_XML))
        assert btn is not None
        self.assertEqual(btn.text.strip().lower(), "no thanks")

    def test_app_screen_has_no_first_run_button(self) -> None:
        self.assertIsNone(find_first_run_button(parse_nodes(APP_XML)))

    def test_modern_combined_welcome_stays_signed_out(self) -> None:
        # Chrome's combined "Make Chrome your own" welcome: the proceed action is
        # "Stay signed out" (also accepts the ToS); must NOT pick "Add account to device".
        xml = """<hierarchy>
<node text="Make Chrome your own" class="android.widget.TextView" clickable="false" bounds="[40,200][680,260]" />
<node text="By continuing you agree to the ToS" class="TextView" clickable="false" bounds="[40,300][680,360]" />
<node text="Add account to device" class="android.widget.Button" clickable="true" bounds="[40,1300][680,1380]" />
<node text="Stay signed out" class="android.widget.Button" clickable="true" bounds="[40,1400][680,1480]" />
</hierarchy>"""
        btn = find_first_run_button(parse_nodes(xml))
        assert btn is not None
        self.assertEqual(btn.text.strip().lower(), "stay signed out")


class WifiTests(unittest.TestCase):
    def test_network_row_matches_content_desc_below_fold(self) -> None:
        row = find_network_row(parse_nodes(WIFI_LIST_XML), "amd-rig-ap")
        assert row is not None
        self.assertTrue(row.clickable)
        self.assertIn("amd-rig-ap", row.desc)

    def test_network_row_absent(self) -> None:
        self.assertIsNone(find_network_row(parse_nodes(WIFI_LIST_XML), "amd-rig-ap-5g"))

    def test_parse_wifi_ssid_connected(self) -> None:
        dump = (
            "mWifiInfo SSID: amd-rig-ap, BSSID: 02:11:22:33:44:55, MAC: 02:00:00:00:00:00, "
            "Supplicant state: COMPLETED, RSSI: -47, Link speed: 72Mbps"
        )
        self.assertEqual(parse_wifi_ssid(dump), "amd-rig-ap")

    def test_parse_wifi_ssid_quoted(self) -> None:
        dump = 'mWifiInfo SSID: "amd-rig-ap", BSSID: 02:11:22:33:44:55, Supplicant state: COMPLETED'
        self.assertEqual(parse_wifi_ssid(dump), "amd-rig-ap")

    def test_parse_wifi_ssid_disconnected(self) -> None:
        dump = "mWifiInfo SSID: <unknown ssid>, BSSID: <none>, Supplicant state: DISCONNECTED"
        self.assertEqual(parse_wifi_ssid(dump), "")

    def test_parse_connectivity_ssid(self) -> None:
        conn = 'NetworkAgentInfo{network{101} WIFI CONNECTED/VALIDATED extra: "amd-rig-ap"}'
        self.assertEqual(parse_connectivity_ssid(conn), "amd-rig-ap")

    def test_parse_connectivity_ssid_none(self) -> None:
        self.assertEqual(
            parse_connectivity_ssid("NetworkAgentInfo{network{5} MOBILE CONNECTED}"), ""
        )


if __name__ == "__main__":
    unittest.main()
