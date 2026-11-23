"""End-to-end smoke test of the app over HTTP, in --synthetic mode (simulated tracker and
fixture, OSC only to the simulated fixture and the dry-run log). Runs in real time,
about a minute: rub -> fit -> touches until converged -> mount -> live -> plane.

    python3 tools/vive/demos/tests/test_app_synthetic.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import frames as fr  # noqa: E402


def strict_json(b):
    """Parse like a browser's JSON.parse: bare NaN/Infinity is an error."""

    def bad(c):
        raise ValueError("non-JSON constant %s" % c)

    return json.loads(b, parse_constant=bad)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class AppSynthetic(unittest.TestCase):
    def setUp(self):
        self.port = free_port()
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "osc.log")
        self.proc = subprocess.Popen(
            [
                sys.executable,
                os.path.join(HERE, "app.py"),
                "--synthetic",
                "--port",
                str(self.port),
                "--osc-log",
                self.log,
                "--mount-name",
                "synthetic-test",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            # Under Bazel numpy and scipy are on this sys.path only.
            env=dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path)),
        )
        for _ in range(100):
            try:
                self.get("/state")
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("app did not start")

    def tearDown(self):
        self.proc.terminate()
        self.proc.wait(5)
        self.proc.stdout.close()
        self.tmp.cleanup()
        p = os.path.join(HERE, "mounts", "synthetic-test.json")
        if os.path.exists(p):
            os.remove(p)

    def get(self, path):
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (self.port, path), timeout=5) as r:
            return strict_json(r.read())

    def post(self, path, body=None):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path),
            data=json.dumps(body or {}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            out = strict_json(r.read())
        self.assertTrue(out["ok"], out)
        return out

    def wait(self, cond, timeout, what):
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = self.get("/state")
            if cond(s):
                return s
            time.sleep(0.2)
        self.fail(
            "timed out waiting for %s: mode %s, %d touches, conv %s, events %s"
            % (
                what,
                s["mode"],
                len(s["touches"]),
                json.dumps(s.get("conv")),
                json.dumps(s["events"][-4:]),
            )
        )

    def test_full_flow(self):
        self.post("/api/mode", {"mode": "rub"})
        self.wait(lambda s: s["rubs"] > 1800, 30, "rubs")
        self.post("/api/mode", {"mode": "idle"})
        s = self.wait(lambda s: s["fit"] is not None and not s["fitting"], 30, "rub fit")
        print("rub fit: rub rms %.2f mm" % s["fit"]["rub_rms_mm"])
        self.post("/api/mode", {"mode": "touch"})
        s = self.wait(lambda s: s["converged"] and not s["fitting"], 120, "convergence")
        print(
            "converged after %d touches, touch rms %.2f mm, s %.4f"
            % (len(s["touches"]), s["fit"]["touch_rms_mm"], s["fit"]["s"])
        )
        self.assertLess(s["fit"]["touch_rms_mm"], 3)
        self.post("/api/mode", {"mode": "mount"})
        time.sleep(1.5)  # the simulated tracker moves onto the fixture
        self.post("/api/mount_record")
        s = self.wait(lambda s: s["mode"] == "live" and s["mount"] is not None, 20, "mount record")
        self.assertTrue(os.path.exists(os.path.join(HERE, "mounts", "synthetic-test.json")))
        # A plane through the fixture's centre, tilted; the simulated fixture lights what the preview predicts.
        T_WF = np.array(s["T_WF"])
        centre = fr.apply(T_WF, np.array(self.get("/map")["p"]).mean(0))
        n = np.array([0.2, -0.3, 1.0])
        self.post("/api/params", {"width": 0.006, "halo": 0.02, "glow": [1, 0.4, 0.1]})
        self.post("/api/plane", {"n": n.tolist(), "d": float(n @ centre)})
        time.sleep(0.5)
        s = self.get("/state")
        p = np.array(self.get("/map")["p"])
        nF, dF = np.array(s["plane"]["n_F"]), s["plane"]["d_F"]
        preview = set(np.nonzero(np.abs(p @ nF - dF) < s["plane"]["width"])[0].tolist())
        fixture = set(s["fake"]["lit"])
        print("live: preview lit %d, simulated fixture lit %d" % (len(preview), len(fixture)))
        self.assertGreater(len(preview), 5)
        # The fixture has the plane from <= 1/120 s earlier while the fixture is moving; allow a few at the edge.
        self.assertLessEqual(len(preview ^ fixture), max(4, len(preview) // 4))
        self.assertIn("/plane", s["osc"]["values"])
        self.assertNotIn("/pick", s["osc"]["values"])
        with open(self.log) as f:
            log = f.read()
        self.assertIn("/pick", log)
        self.assertIn("/plane", log)
        self.assertIn("/width 0.006", log)
        # Sphere: centred on the fixture, radius through its middle; /sphere replaces /plane.
        r = 0.6 * np.linalg.norm(p - p.mean(0), axis=1).max()
        self.post("/api/sphere", {"c": centre.tolist(), "r": r})
        self.post("/api/shape", {"shape": "sphere"})
        time.sleep(0.5)
        s = self.get("/state")
        cF, rF = np.array(s["sphere"]["c_F"]), s["sphere"]["r_F"]
        preview = set(
            np.nonzero(np.abs(np.linalg.norm(p - cF, axis=1) - rF) < s["plane"]["width"])[
                0
            ].tolist()
        )
        fixture = set(s["fake"]["lit"])
        print(
            "live sphere: preview lit %d, simulated fixture lit %d" % (len(preview), len(fixture))
        )
        self.assertGreater(len(preview), 5)
        self.assertLessEqual(len(preview ^ fixture), max(4, len(preview) // 4))
        self.assertIn("/sphere", s["osc"]["values"])
        self.assertNotIn("/plane", s["osc"]["values"])


if __name__ == "__main__":
    unittest.main()
