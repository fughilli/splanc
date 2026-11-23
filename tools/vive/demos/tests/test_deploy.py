"""The page's Deploy button: the demo deploys the right effect through the Splanc MCP server
(splanc_mcp.py), by library id when the library has it, as source the first time. Runs
against a fake MCP server on localhost that answers in both reply styles (JSON, SSE).

    python3 tools/vive/demos/tests/test_deploy.py
"""

import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import splanc_mcp  # noqa: E402

TOKEN = "test-token"


class FakeMcp:
    """Splanc MCP stand-in: one player at 10.0.0.5, a library, and a log of tool calls."""

    def __init__(self, library=(), sse=False):
        self.library = dict(library)  # name -> id
        self.sse = sse
        self.calls = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                if self.headers.get("Authorization") != "Bearer " + TOKEN:
                    return self.send_error(401)
                msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if msg["method"] != "initialize" and self.headers.get("Mcp-Session-Id") != "s1":
                    return self.send_error(400, "no session")
                if "id" not in msg:
                    self.send_response(202)
                    self.end_headers()
                    return
                result = fake.handle(msg["method"], msg.get("params", {}))
                body = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result})
                if fake.sse:
                    body = "event: message\ndata: %s\n\n" % body
                data = body.encode()
                self.send_response(200)
                self.send_header(
                    "Content-Type", "text/event-stream" if fake.sse else "application/json"
                )
                self.send_header("Mcp-Session-Id", "s1")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/mcp" % self.server.server_port

    def handle(self, method, params):
        if method == "initialize":
            return {
                "protocolVersion": splanc_mcp.PROTOCOL,
                "capabilities": {},
                "serverInfo": {"name": "fake"},
            }
        name, args = params["name"], params["arguments"]
        self.calls.append((name, args))
        if name in ("list_players", "refresh_players"):
            out = [{"players": [{"id": "AA:BB", "name": "Lamp", "host": "10.0.0.5"}]}]
        elif name == "search_effects":
            out = [{"results": [{"id": i, "name": n} for n, i in self.library.items()]}]
        elif name == "deploy_effect":
            out = [
                {"results": [{"ok": True}], "summary": "ok on all 1"},
                {"library": {"id": "fx_new"}},
            ]
        else:
            return {"content": [{"type": "text", "text": "unknown tool"}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(o)} for o in out]}

    def stop(self):
        self.server.shutdown()


def wait(deployer, timeout=5.0):
    end = time.time() + timeout
    while deployer.state()["state"] == "running" and time.time() < end:
        time.sleep(0.01)
    return deployer.state()


class Deploy(unittest.TestCase):
    def tearDown(self):
        self.mcp.stop()

    def deployer(self, **kw):
        self.done = []
        client = splanc_mcp.Client(self.mcp.url, TOKEN)
        return splanc_mcp.Deployer("10.0.0.5", client=client, on_deployed=self.done.append, **kw)

    def test_library_entry_by_id(self):
        self.mcp = FakeMcp(library={"Tracker demo: P4 pose (pick, plane, sphere)": "fx_abc"})
        d = self.deployer()
        d.start("tracker_demo_pose")
        st = wait(d)
        self.assertEqual(st["state"], "ok", st)
        args = dict(self.mcp.calls)["deploy_effect"]
        self.assertEqual(args["library_id"], "fx_abc")
        self.assertNotIn("source", args)
        self.assertEqual(
            (args["players"], args["activate"], args["effect_id"]),
            ("AA:BB", True, "tracker_demo_pose"),
        )
        self.assertEqual(self.done, ["tracker_demo_pose"])

    def test_first_deploy_goes_up_as_source(self):
        self.mcp = FakeMcp(sse=True)
        d = self.deployer()
        d.start("led_pick")
        st = wait(d)
        self.assertEqual(st["state"], "ok", st)
        args = dict(self.mcp.calls)["deploy_effect"]
        self.assertNotIn("library_id", args)
        self.assertEqual(args["name"], "Tracker calibration: LED pick")
        self.assertIn("void", args["source"])

    def test_unknown_player_is_an_error(self):
        self.mcp = FakeMcp()
        d = splanc_mcp.Deployer("10.9.9.9", client=splanc_mcp.Client(self.mcp.url, TOKEN))
        d.start("plane_slice")
        st = wait(d)
        self.assertEqual(st["state"], "error")
        self.assertIn("10.9.9.9", st["message"])
        self.assertNotIn("deploy_effect", dict(self.mcp.calls))

    def test_bad_token(self):
        self.mcp = FakeMcp()
        d = splanc_mcp.Deployer("10.0.0.5", client=splanc_mcp.Client(self.mcp.url, "wrong"))
        d.start("plane_slice")
        st = wait(d)
        self.assertEqual(st["state"], "error")
        self.assertIn("401", st["message"])


class Choice(unittest.TestCase):
    def test_effect_for(self):
        self.assertEqual(splanc_mcp.effect_for(True, "probe", "plane"), "tracker_demo_pose")
        self.assertEqual(splanc_mcp.effect_for(True, "live", "sphere"), "tracker_demo_pose")
        self.assertEqual(splanc_mcp.effect_for(False, "touch", "plane"), "led_pick")
        self.assertEqual(splanc_mcp.effect_for(False, "live", "plane"), "plane_slice")
        self.assertEqual(splanc_mcp.effect_for(False, "idle", "sphere"), "sphere_shell")

    def test_every_effect_has_its_source(self):
        for name, fname, _, _ in splanc_mcp.EFFECTS.values():
            self.assertTrue(os.path.exists(os.path.join(HERE, "effects", fname)), fname)

    def test_not_configured(self):
        d = splanc_mcp.Deployer("10.0.0.5", config="/nonexistent/mcp.json")
        env = {
            k: os.environ.pop(k) for k in ("SPLANC_MCP_URL", "SPLANC_MCP_TOKEN") if k in os.environ
        }
        try:
            self.assertFalse(d.state()["configured"])
            with self.assertRaises(ValueError):
                d.start("plane_slice")
        finally:
            os.environ.update(env)


if __name__ == "__main__":
    unittest.main()
