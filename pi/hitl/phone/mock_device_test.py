"""The mock device plays the code book a real player would: hue code v2 when the
app asks for it, and a restamped epoch on every mid-capture renegotiation."""

import unittest

from mock_device import MockDevice


class MockDeviceCodeBookTests(unittest.TestCase):
    def test_welcome_advertises_the_stagger_pilot(self):
        self.assertIn("hue_stagger_pilot", MockDevice().reply({"type": "hello"})["features"])

    def test_start_mapping_runs_the_requested_stagger_pilot(self):
        dev = MockDevice()
        got = dev.reply(
            {"type": "start_mapping", "options": {"ledCount": 30, "syncPattern": "stagger_pilot"}}
        )
        cp = got["codeParams"]
        self.assertEqual(cp["syncPattern"], "stagger_pilot")
        self.assertEqual(cp["ledCount"], 30)

    def test_stagger_falls_back_to_v1_when_not_advertised(self):
        dev = MockDevice(features=[])
        got = dev.reply(
            {"type": "start_mapping", "options": {"ledCount": 30, "syncPattern": "stagger_pilot"}}
        )
        self.assertEqual(got["codeParams"]["syncPattern"], "on_off")

    def test_configure_keeps_the_sync_pattern_and_restamps_the_epoch(self):
        dev = MockDevice()
        started = dev.reply(
            {"type": "start_mapping", "options": {"ledCount": 30, "syncPattern": "stagger_pilot"}}
        )
        state = dev.reply({"type": "configure", "options": {"symbols": 4}})
        self.assertEqual(state["type"], "pattern_state")
        self.assertTrue(state["active"])
        self.assertEqual(state["codeParams"]["symbols"], 4)
        self.assertEqual(state["codeParams"]["syncPattern"], "stagger_pilot")
        # A new code book (a 4-symbol cycle is shorter) from a new epoch.
        self.assertLess(state["codeParams"]["cycleFrames"], started["codeParams"]["cycleFrames"])
        self.assertGreaterEqual(state["patternClockEpoch"], started["patternClockEpoch"])
        self.assertEqual(dev.reconfigures, 1)

    def test_configure_without_a_capture_is_an_error(self):
        self.assertEqual(MockDevice().reply({"type": "configure", "options": {}})["type"], "error")


if __name__ == "__main__":
    unittest.main()
