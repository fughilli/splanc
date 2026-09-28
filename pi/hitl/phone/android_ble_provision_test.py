"""Dry-run tests for android_ble_provision.py — the pure view-tree parse + the
chooser-row disambiguation, exercised on captured uiautomator XML, no hardware."""

from __future__ import annotations

import unittest

from android_ble_provision import find_chooser_row, parse_nodes

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


if __name__ == "__main__":
    unittest.main()
