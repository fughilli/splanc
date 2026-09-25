"""HTTP ingestion regression; no KiCad process or routing changes required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

class ServerIngestionTest(unittest.TestCase):
    def test_missing_label_replays_as_inspectable_phase_and_snapshots_work(self):
        repo = Path(os.environ.get("PNR_VIEWER_TEST_REPO", Path(__file__).resolve().parents[3]))
        prefs = repo / "output/pnr-settings.json"
        before = prefs.read_bytes()
        with tempfile.TemporaryDirectory(prefix="viewer-schema-") as tmp:
            root = Path(tmp) / "live"
            for directory in ("events", "geometry"):
                (root / directory).mkdir(parents=True)
            sha = "a" * 64
            geometry = dict(frame="mm-y-up", width=70, height=55, parts=[], tracks=[], vias=[], zones=[])
            (root / "geometry" / (sha + ".json")).write_text(json.dumps(geometry))
            event = dict(schema="pnr-live-event-v1", id="event-01", time=1, kind="phase_complete",
                         candidate="underbody123/start02", iteration="probe", board="cached-board.kicad_pcb",
                         board_sha256=sha, data=dict(opens=181, violations=0, scope="Signal-only screening"))
            (root / "events/event-01.json").write_text(json.dumps(event))
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("server.py")),
                    str(root), "--port", "0", "--repo", str(repo)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                base = process.stdout.readline().strip().removeprefix("Live PnR: ")
                self.assertTrue(base.startswith("http://127.0.0.1:"), base)
                def request(path, body=None):
                    req = Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                  headers={} if body is None else {"Content-Type": "application/json"})
                    with urlopen(req, timeout=5) as response:
                        return json.load(response)
                deadline = time.monotonic() + 5
                while True:
                    state = request("/api/state")
                    if state["revision"] or time.monotonic() > deadline:
                        break
                    time.sleep(.05)
                self.assertEqual(state["errors"], [])
                lane = state["lanes"][event["candidate"]]
                self.assertEqual(lane["opens"], 181)
                self.assertEqual(lane["violations"], 0)
                self.assertEqual(lane["geometry"], geometry)
                self.assertEqual(lane["frames"][0]["label_source"], "unavailable")
                self.assertEqual(lane["frames"][0]["board_sha256"], sha)
                self.assertEqual(request("/api/geometry/" + sha), geometry)
                pin = request("/api/pin", {})
                snapshot = request("/api/snapshot", dict(pin_id=pin["pin_id"],
                    view=dict(lane=event["candidate"], phase="0"),
                    annotations=[dict(bounds=[1, 2, 3, 4])], note="schema regression"))
                saved = request(snapshot["url"])
                self.assertEqual(saved["selected_geometry"] if "selected_geometry" in saved else saved["state"]["selected_geometry"], geometry)
                self.assertEqual(saved["annotations"][0]["bounds"], [1, 2, 3, 4])
                event.update(id="event-02", time=2)
                event["data"].update(name="native-final", opens=0)
                temp = root / "event-02.tmp"
                temp.write_text(json.dumps(event))
                temp.replace(root / "events/event-02.json")
                deadline = time.monotonic() + 5
                while True:
                    state = request("/api/state")
                    if state["revision"] >= 2 or time.monotonic() > deadline:
                        break
                    time.sleep(.05)
                self.assertEqual(state["errors"], [])
                lane = state["lanes"][event["candidate"]]
                self.assertEqual(lane["phase"], "native-final")
                self.assertEqual(lane["opens"], 0)
                self.assertEqual(len(lane["frames"]), 2)
                self.assertEqual(prefs.read_bytes(), before)
            finally:
                process.terminate()
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

if __name__ == "__main__":
    unittest.main()
