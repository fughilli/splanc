"""Deploys the demo's effects to the fixture through the Splanc MCP server (the same one an
agent uses), so the page's Deploy button can put the right effect on without an agent.

The server speaks MCP over streamable HTTP: JSON-RPC POSTs, each reply plain JSON or one
SSE event, and a session id from `initialize` on every later request. Its address and
bearer token come from SPLANC_MCP_URL / SPLANC_MCP_TOKEN, or a JSON file
{"url": ..., "token": ...} (default ~/.config/splanc/mcp.json; keep it private, chmod 600).

Each effect is looked up in the library by name and deployed by its id, so deploying
again doesn't fill the library with copies; only an effect not in it yet goes up as source.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.expanduser("~/.config/splanc/mcp.json")
PROTOCOL = "2025-03-26"

# What the demo runs on the fixture: library name, source file, description, tags.
EFFECTS = {
    "tracker_demo_pose": (
        "Tracker demo: P4 pose (pick, plane, sphere)",
        "tracker_demo_pose.glsl",
        "The whole tools/vive/demos --p4 demo in one effect, for a fixture whose pose comes "
        "from its own wired Vive tracker (the Splanc P4 tracker module fills the pool-driven `pose`, "
        "world <- fixture map, and `tracker_ok`). OSC /pick ,f: an LED index blinks that LED white "
        "(probing), -1 shows the live shape, -2 a faint outline. /shape ,f: 0 a plane slice "
        "(/plane ,ffff unit normal + offset), 1 a sphere shell (/sphere ,ffff centre + radius), "
        "in metres in the world frame: a thin orange band with a soft halo. Not tracking: the outline.",
        ["tracker", "p4", "pose", "plane", "sphere", "calibration", "osc", "interactive"],
    ),
    "flashlight_pose": (
        "Tracker flashlight: stylus beam",
        "flashlight_pose.glsl",
        "A flashlight: a cone of light from a point in the world (a Vive stylus's tip, streamed by "
        "tools/vive/demos flashlight.py over OSC /origin /dir /width /color) lights the LEDs "
        "inside it, with a soft edge and a fade with distance. Each LED's world position is the "
        "fixture's own tracker pose when it has one (Splanc P4 tracker module) and its room pose "
        "(led.room) otherwise, so tracked and fixed fixtures share one beam.",
        ["tracker", "p4", "pose", "flashlight", "beam", "interactive", "osc"],
    ),
    "hot_spots_pose": (
        "Tracker hot spots: P4 pose",
        "hot_spots_pose.glsl",
        "A hot-and-cold game for a fixture with its own wired Vive tracker (Splanc P4 tracker module: "
        "pool-driven pose and tracker_ok). Four coloured hot spots in the world frame (spot0..3, "
        "metres; color0..3, black = off): the fixture glows in each spot's colour, brighter the closer "
        "it gets within `range`, the side facing a spot a little more; inside a spot (`radius`) the "
        "whole fixture blinks in its colour. Faint outline while not tracking.",
        ["tracker", "p4", "pose", "game", "hot-cold", "interactive", "blink"],
    ),
    "led_pick": (
        "Tracker calibration: LED pick",
        "led_pick.glsl",
        "Blinks the LED at index `pick` (OSC /pick ,f), dims the rest. For tracker<->fixture calibration.",
        ["tracker", "calibration", "osc"],
    ),
    "plane_slice": (
        "Tracker plane slice",
        "plane_slice.glsl",
        "Lights LEDs within `width` of a plane streamed over OSC /plane ,ffff (unit normal + offset, "
        "metres, map frame).",
        ["tracker", "plane", "osc"],
    ),
    "sphere_shell": (
        "Tracker sphere shell",
        "sphere_shell.glsl",
        "Lights the LEDs within `width` of a sphere's surface, streamed over OSC /sphere ,ffff "
        "(centre xyz + radius, metres, fixture map frame).",
        ["tracker", "sphere", "osc"],
    ),
}


def effect_for(p4, mode, shape):
    """The effect the fixture should run: --p4 runs one for everything; otherwise led_pick
    while calibrating and the live shape's slice the rest of the time."""
    if p4:
        return "tracker_demo_pose"
    if mode in ("rub", "touch", "mount", "pivot", "probe"):
        return "led_pick"
    return "sphere_shell" if shape == "sphere" else "plane_slice"


def load_config(path=None):
    """(url, token), or None when nothing is configured."""
    url, token = os.environ.get("SPLANC_MCP_URL"), os.environ.get("SPLANC_MCP_TOKEN")
    path = path or CONFIG
    if not (url and token) and os.path.exists(path):
        with open(path) as f:
            c = json.load(f)
        url, token = url or c.get("url"), token or c.get("token")
    return (url, token) if url and token else None


class McpError(RuntimeError):
    pass


class Client:
    """A minimal MCP client: initialize once, then tools/call."""

    def __init__(self, url, token, timeout=90.0, opener=urllib.request.urlopen):
        self.url, self.token, self.timeout, self.opener = url, token, timeout, opener
        self.session = None
        self.next_id = 1

    def _post(self, msg):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer " + self.token,
            "MCP-Protocol-Version": PROTOCOL,
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(self.url, json.dumps(msg).encode(), headers, method="POST")
        try:
            with self.opener(req, timeout=self.timeout) as r:
                self.session = r.headers.get("Mcp-Session-Id") or self.session
                body = r.read().decode("utf-8", "replace")
                ctype = r.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            raise McpError("Splanc MCP: HTTP %d %s" % (e.code, e.reason)) from None
        except urllib.error.URLError as e:
            raise McpError("Splanc MCP unreachable: %s" % e.reason) from None
        if "id" not in msg:
            return None
        if "text/event-stream" in ctype:
            # The reply is the event whose data carries our id.
            for chunk in body.split("\n\n"):
                data = "\n".join(
                    line[5:].lstrip() for line in chunk.splitlines() if line.startswith("data:")
                )
                if data:
                    reply = json.loads(data)
                    if reply.get("id") == msg["id"]:
                        break
            else:
                raise McpError("Splanc MCP: no reply in the event stream")
        else:
            reply = json.loads(body)
        if "error" in reply:
            raise McpError("Splanc MCP: %s" % reply["error"].get("message", reply["error"]))
        return reply.get("result")

    def _request(self, method, params):
        i, self.next_id = self.next_id, self.next_id + 1
        return self._post({"jsonrpc": "2.0", "id": i, "method": method, "params": params})

    def connect(self):
        self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": {"name": "splanc-tracker-demo", "version": "1"},
            },
        )
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool, args):
        """A tool's result: its text parts parsed as JSON (a list when there are several)."""
        if self.session is None:
            self.connect()
        res = self._request("tools/call", {"name": tool, "arguments": args})
        parts = []
        for c in res.get("content", []):
            if c.get("type") == "text":
                try:
                    parts.append(json.loads(c["text"]))
                except ValueError:
                    parts.append(c["text"])
        if res.get("isError"):
            raise McpError("%s: %s" % (tool, "; ".join(str(p) for p in parts) or "failed"))
        return parts[0] if len(parts) == 1 else parts


def player_for(client, host):
    """The player at `host` (the --fixture address): its id, since players are named by
    name, MAC or room, not by address."""
    found = client.call("list_players", {})
    players = found.get("players", []) if isinstance(found, dict) else []
    for p in players:
        if p.get("host") == host:
            return p["id"], p.get("name") or p["id"]
    found = client.call("refresh_players", {})
    for p in found.get("players", []) if isinstance(found, dict) else []:
        if p.get("host") == host:
            return p["id"], p.get("name") or p["id"]
    raise McpError("no Splanc player at %s (list_players)" % host)


def deploy(client, effect, host):
    """Deploys `effect` (a key of EFFECTS) to the player at `host` and makes it the running
    one. Returns a one-line summary."""
    name, fname, desc, tags = EFFECTS[effect]
    player, pname = player_for(client, host)
    found = client.call("search_effects", {"query": name, "tags": tags[:1], "limit": 20})
    lib = next(
        (
            r["id"]
            for r in (found.get("results", []) if isinstance(found, dict) else [])
            if r.get("name") == name
        ),
        None,
    )
    args = {"players": player, "activate": True, "effect_id": effect}
    if lib:
        args["library_id"] = lib
    else:
        with open(os.path.join(HERE, "effects", fname)) as f:
            args.update(source=f.read(), name=name, description=desc, tags=tags)
    out = client.call("deploy_effect", args)
    res = out[0] if isinstance(out, list) else out
    if isinstance(res, dict) and "summary" in res and not res["summary"].startswith("ok"):
        raise McpError("deploy_effect: %s" % res["summary"])
    return "%s on %s (%s)" % (effect, pname, "library " + lib if lib else "new library entry")


class Deployer:
    """Runs deploys off the HTTP thread (one at a time) and keeps the last outcome for /state."""

    def __init__(self, host, config=None, client=None, on_deployed=None):
        self.host = host
        self.on_deployed = (
            on_deployed  # called after a deploy went through, e.g. to re-send the uniforms
        )
        self.config_path = config
        self.client = client
        self.lock = threading.Lock()
        self.status = {"state": "idle"}

    def configured(self):
        return self.client is not None or load_config(self.config_path) is not None

    def start(self, effect):
        with self.lock:
            if self.status["state"] == "running":
                raise ValueError("a deploy is already running")
            if not self.host:
                raise ValueError("no --fixture: nothing to deploy to")
            if self.client is None:
                cfg = load_config(self.config_path)
                if cfg is None:
                    raise ValueError(
                        "Splanc MCP not configured: set SPLANC_MCP_URL and SPLANC_MCP_TOKEN "
                        "or write %s" % (self.config_path or CONFIG)
                    )
                self.client = Client(*cfg)
            self.status = {"state": "running", "effect": effect, "t": time.time()}
        threading.Thread(target=self._run, args=(effect,), daemon=True, name="deploy").start()

    def _run(self, effect):
        try:
            msg = deploy(self.client, effect, self.host)
            st = {"state": "ok", "effect": effect, "message": msg}
            if self.on_deployed:
                self.on_deployed(effect)
        except Exception as e:  # noqa: BLE001 - shown on the page
            self.client.session = None  # start a fresh session next time
            st = {"state": "error", "effect": effect, "message": str(e)}
        st["t"] = time.time()
        with self.lock:
            self.status = st

    def state(self):
        with self.lock:
            return dict(self.status, configured=self.configured())
