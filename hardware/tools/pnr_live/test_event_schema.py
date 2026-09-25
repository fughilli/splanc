import copy
import unittest
from event_schema import phase_frame

class PhaseFrameTest(unittest.TestCase):
    def setUp(self):
        self.event = dict(id="event-01", board_sha256="a" * 64,
                          data=dict(name="power", opens=0, violations=0))

    def test_named_phase_preserves_zero_counts_and_identity(self):
        frame = phase_frame(self.event)
        self.assertEqual(frame, dict(name="power", label_source="name",
                         board_sha256="a" * 64, event_id="event-01", opens=0, violations=0))

    def test_probe_without_name_keeps_native_results(self):
        del self.event["data"]["name"]
        self.event["data"].update(opens=181, scope="Signal-only screening")
        before = copy.deepcopy(self.event)
        frame = phase_frame(self.event)
        self.assertEqual(frame["name"], "Completed phase (label unavailable)")
        self.assertEqual(frame["label_source"], "unavailable")
        self.assertEqual(frame["opens"], 181)
        self.assertEqual(self.event, before)

    def test_legacy_phase_alias_and_empty_label(self):
        self.event["data"].update(name="  ", phase="signal")
        self.assertEqual(phase_frame(self.event)["name"], "signal")
        self.assertEqual(phase_frame(self.event)["label_source"], "phase")

    def test_missing_native_counts_remain_errors(self):
        for field in ("opens", "violations"):
            event = copy.deepcopy(self.event)
            del event["data"][field]
            with self.assertRaises(KeyError):
                phase_frame(event)

    def test_missing_board_identity_remains_error(self):
        del self.event["board_sha256"]
        with self.assertRaises(KeyError):
            phase_frame(self.event)

if __name__ == "__main__":
    unittest.main()
