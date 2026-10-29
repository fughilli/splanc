"""Host simulator: the real display service with mocked peripherals, in a browser.

    python3 -m splanc_display.sim                  # then open http://127.0.0.1:8737/
    bazel run //pi/bridge:sim -- --port 8737

It runs ``main.App`` unchanged (the menu state machine, animation pacing, boot
logo, status watcher, control client) and swaps only the hardware at its seams:

    SimOled      for luma.oled's sh1106 device (hat.open_device): keeps each 1-bit
                 128x64 frame it is handed, its contrast and hide/show
    SimButtons   for gpiozero.Button (hat.Buttons' factory): the page's HAT keys
                 call when_pressed / when_released, so press/release timing (KEY3
                 hold-to-confirm) goes through the service's own input queue
    SimHdmi      for the /dev/fb0 Framebuffer: keeps the last page drawn

and, for the bridge, either

    --bridge fake  (default) fake_bridge's FakeBridge driven by a small model
                   (fixtures, relay up/down, pairing code, connected sessions,
                   paired clients with names/kinds/last use (add, remove, toggle
                   live, an outdated relay), failing commands), with every knob
                   on the page; the Clients page's revoke works against it. Its
                   updaters are fake_updates.FakeUpdater: updates on offer or
                   not, a check, an install with progress, a failure
                   (screen requests go to its request directory)
    --bridge real  the actual ``splanc-agent bridge`` (Node) with its status file
                   and control socket in a temp dir, against a local
                   ``splanc-agent relay`` it starts (or --relay URL). Fixtures
                   are whatever it discovers on this LAN.

The page (stdlib http.server) streams OLED frames over Server-Sent Events as raw
1-bit framebuffers (1 KiB each), at whatever rate the service draws them. The
clock handed to the service can run slower than real time ("slow-mo"): every
animation, the boot logo and the KEY3 hold scale with it, frame pacing does not.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Dict, List, Optional

from PIL import Image

from . import boot, control, fake_bridge, fake_updates, fonts, main, render_oled
from .hat import KEY_PINS

PIN_KEYS = {pin: key for key, pin in KEY_PINS.items()}
HEARTBEAT = 5.0  # fake bridge status rewrite period (the real one: <= 5 s)
HDMI_VIEW = (640, 360)  # the page's HDMI preview size


def log(*a) -> None:
    print("splanc-sim:", *a, file=sys.stderr, flush=True)


# --- the clock ------------------------------------------------------------------------


class SimClock:
    """A monotonic clock whose rate can change (``speed`` < 1 = slow motion)."""

    def __init__(self, base: Callable[[], float] = time.monotonic):
        self._base = base
        self._lock = threading.Lock()
        self._real0 = base()
        self._sim0 = self._real0
        self._speed = 1.0

    def __call__(self) -> float:
        with self._lock:
            return self._sim0 + (self._base() - self._real0) * self._speed

    @property
    def speed(self) -> float:
        return self._speed

    @speed.setter
    def speed(self, value: float) -> None:
        value = min(4.0, max(0.02, float(value)))
        with self._lock:
            now = self._base()
            self._sim0 += (now - self._real0) * self._speed
            self._real0, self._speed = now, value


# --- mocked peripherals ---------------------------------------------------------------


class Frames:
    """What the screens showed: shared by the devices and the web server."""

    def __init__(self):
        self.cond = threading.Condition()
        self.oled: Optional[Image.Image] = None
        self.oled_seq = 0
        self.oled_times: List[float] = []  # real time of recent frames (fps)
        self.contrast = main.CONTRAST_NORMAL
        self.hidden = False
        self.hdmi: Optional[Image.Image] = None
        self.hdmi_seq = 0
        self._hdmi_png = (-1, b"")

    def _bump(self) -> None:
        self.cond.notify_all()

    def oled_frame(self, img: Image.Image) -> None:
        with self.cond:
            self.oled = img.convert("1").copy()
            self.oled_seq += 1
            t = time.monotonic()
            self.oled_times = [x for x in self.oled_times if t - x < 1.0] + [t]
            self._bump()

    def oled_state(self, contrast=None, hidden=None) -> None:
        with self.cond:
            if contrast is not None:
                self.contrast = contrast
            if hidden is not None:
                self.hidden = hidden
            self.oled_seq += 1
            self._bump()

    def hdmi_frame(self, img: Image.Image) -> None:
        with self.cond:
            self.hdmi = img.copy()
            self.hdmi_seq += 1
            self._bump()

    def fps(self) -> float:
        t = time.monotonic()
        return float(sum(1 for x in self.oled_times if t - x < 1.0))

    def oled_bits(self) -> bytes:
        """The panel's framebuffer: 64 rows of 16 bytes, MSB = leftmost pixel."""
        img = self.oled
        return img.tobytes() if img is not None else bytes(128 * 64 // 8)

    def hdmi_png(self) -> bytes:
        with self.cond:
            seq, img = self.hdmi_seq, self.hdmi
            if self._hdmi_png[0] == seq:
                return self._hdmi_png[1]
        if img is None:
            img = Image.new("RGB", HDMI_VIEW, (0, 0, 0))
        small = img.convert("RGB").resize(HDMI_VIEW, Image.BILINEAR)
        buf = io.BytesIO()
        small.save(buf, "PNG")
        with self.cond:
            self._hdmi_png = (seq, buf.getvalue())
        return buf.getvalue()


class SimOled:
    """luma.oled's device interface (what main.App calls), into ``Frames``.

    ``push_seconds`` emulates the SPI transfer + a slower CPU (main.App paces
    animation frames from the measured render + push cost)."""

    def __init__(self, frames: Frames, push_seconds: float = 0.0):
        self.frames, self.push_seconds = frames, push_seconds
        self.width, self.height = 128, 64

    def display(self, img) -> None:
        if self.push_seconds:
            time.sleep(self.push_seconds)
        self.frames.oled_frame(img)

    def contrast(self, level: int) -> None:
        self.frames.oled_state(contrast=level)

    def hide(self) -> None:
        self.frames.oled_state(hidden=True)

    def show(self) -> None:
        self.frames.oled_state(hidden=False)

    def cleanup(self) -> None:
        pass


class SimHdmi:
    """fb.Framebuffer's interface, into ``Frames``."""

    def __init__(self, frames: Frames, size=(1920, 1080)):
        self.frames, self.size = frames, tuple(size)

    def visible(self) -> bool:
        return True

    def show(self, img: Image.Image) -> bool:
        self.frames.hdmi_frame(img)
        return True

    def changed(self) -> bool:
        return False

    def close(self) -> None:
        pass


class SimButton:
    """gpiozero.Button's interface (when_pressed / when_released / close)."""

    def __init__(self, pin: int):
        self.pin = pin
        self.when_pressed = None
        self.when_released = None
        self.is_pressed = False
        self.closed = False

    def press(self) -> None:
        if not self.is_pressed and not self.closed and self.when_pressed:
            self.is_pressed = True
            self.when_pressed()

    def release(self) -> None:
        if self.is_pressed and not self.closed and self.when_released:
            self.is_pressed = False
            self.when_released()

    def close(self) -> None:
        self.closed = True


class SimButtons:
    """The factory hat.Buttons builds its keys with; the page presses them by name."""

    def __init__(self):
        self.by_pin: Dict[int, SimButton] = {}

    def __call__(self, pin: int) -> SimButton:
        b = SimButton(pin)
        self.by_pin[pin] = b
        return b

    def button(self, key: str) -> SimButton:
        if key not in KEY_PINS:
            raise KeyError(key)
        b = self.by_pin.get(KEY_PINS[key])
        if b is None:
            raise LookupError("the display service has not opened the HAT keys yet")
        return b

    def press(self, key: str) -> None:
        self.button(key).press()

    def release(self, key: str) -> None:
        self.button(key).release()

    def release_all(self) -> None:
        for b in self.by_pin.values():
            b.release()


# --- bridges --------------------------------------------------------------------------


class FakeModel(fake_bridge.FakeBridge):
    """fake_bridge's FakeBridge, its status derived from knobs the way the real
    bridge derives it (agent/src/bridge/lanBridge.ts status())."""

    def __init__(self, status_path: str, control_path: str):
        super().__init__(status_path, control_path)
        self.phase = "starting"  # starting | running | error
        self.relay_up = True
        self.paired = False
        self.clients = 0
        self.pairing: Optional[dict] = None
        self.delay = 0.3  # seconds a command takes (the relay round trip)
        now = time.time()
        self.players: List[dict] = fake_bridge._players(now)
        self._extra = fake_bridge.many_players(now, 30)
        self._added = 0
        # Paired clients (relay grants), the ``paired_clients`` shape; last_used_at
        # is kept as seconds-ago (like _ago) so it stays fresh across heartbeats.
        self.paired_list: List[dict] = []
        self._used_ago: Dict[str, Optional[float]] = {}
        self._client_n = 0
        self.relay_outdated = False
        self._hb_stop = threading.Event()
        self._hb: Optional[threading.Thread] = None
        self._ago: Dict[str, float] = {}  # player key -> seconds since seen
        for p in self.players:
            self._ago[self._key(p)] = now - p.get("seen", now)
        self.updater = fake_updates.FakeUpdater(os.path.dirname(os.path.abspath(status_path)))

    @staticmethod
    def _key(p: dict) -> str:
        return p.get("id") or p.get("host") or p["name"]

    def state(self, now: float) -> str:
        if self.phase == "error":
            return "error"
        if self.phase == "starting":
            return "starting"
        if not self.relay_up:
            return "offline"
        if self.pairing and self.pairing["expires_at"] > now:
            return "pairing"
        return "paired" if self.paired else "unpaired"

    def build(self, now: Optional[float] = None) -> dict:
        now = time.time() if now is None else now
        state = self.state(now)
        players = []
        for p in self.players:
            p = dict(p)
            ago = self._ago.get(self._key(p))
            if ago is not None:
                p["seen"] = int(now - ago)
            if "perf" in p:
                p["perf"] = dict(p["perf"], at=int(now) - 3)
            players.append(p)
        pairing = self.pairing if state == "pairing" else None
        clients = []
        for c in self.paired_list:
            ago = self._used_ago.get(c["id"])
            clients.append(dict(c, last_used_at=None if ago is None else int(now - ago)))
        if self.relay_outdated:
            cstate, clients = "relay_outdated", []
        elif self.phase != "running":
            cstate, clients = "unknown", []
        else:
            cstate = "ok" if self.relay_up else "offline"
        error = None
        if state == "error":
            error = "relay rejected this bridge (bad credentials) - run: splanc-bridge logs"
        elif state == "offline":
            error = "relay unreachable (connect ECONNREFUSED)"
        return fake_bridge.sample(
            state,
            now,
            players=players,
            pairing=pairing,
            clients=self.clients if state in ("paired", "pairing") else 0,
            paired_clients=clients,
            paired_clients_state=cstate,
            error=error,
        )

    def publish(self) -> None:
        self.set(self.build())

    def start(self) -> "FakeModel":
        super().start()
        self.updater.start()
        self.publish()
        self._hb = threading.Thread(target=self._heartbeat, daemon=True)
        self._hb.start()
        return self

    def stop(self) -> None:
        self._hb_stop.set()
        self.updater.stop()
        super().stop()

    def _heartbeat(self) -> None:
        while not self._hb_stop.wait(HEARTBEAT):
            with self._lock:
                self.publish_locked()

    def publish_locked(self) -> None:
        self.doc = self.build()
        fake_bridge.write_atomic(self.status_path, self.doc)

    # --- control socket (FakeBridge._serve calls this) --------------------------------
    def handle(self, line: bytes) -> dict:
        try:
            req = json.loads(line.decode())
            cmd = req["cmd"]
        except (ValueError, KeyError, TypeError):
            return {"ok": False, "error": "bad request"}
        self.commands.append(cmd)
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            return {"ok": False, "error": self.fail}
        if cmd == "status":
            return {"ok": True, "status": self.build()}
        if cmd == "identify":
            return {"ok": True, "players": sum(1 for p in self.players if p.get("ok"))}
        if self.phase != "running" or not self.relay_up:
            return {"ok": False, "error": "the bridge is not connected to the relay"}
        if cmd == "new_pairing_code":
            code = fake_bridge.new_code()
            self.pairing = {
                "code": code,
                "expires_at": int(time.time()) + 300,
                "url": f"https://splanc.io/pair#{code}",
            }
            self.publish()
            return {"ok": True, "code": code}
        if cmd == "revoke_all":
            n = max(self.clients, len(self.paired_list))
            self.paired, self.clients, self.paired_list = False, 0, []
            self.publish()
            return {"ok": True, "revoked": n}
        if cmd == "clients":
            doc = self.build()
            return {
                "ok": True,
                "state": doc["paired_clients_state"],
                "clients": doc["paired_clients"],
            }
        if cmd == "revoke":
            if self.relay_outdated:
                return {"ok": False, "error": "the client list needs a relay update"}
            grant = req.get("grant")
            hit = [c for c in self.paired_list if c["id"] == grant]
            if not hit:
                return {"ok": False, "error": "no paired client with that id"}
            self.paired_list = [c for c in self.paired_list if c["id"] != grant]
            if not self.paired_list:
                self.paired = self.clients > 0
            self.publish()
            return {"ok": True, "revoked": grant, "label": hit[0]["label"]}
        return {"ok": False, "error": f"unknown command {cmd!r}"}

    # --- knobs (the page's bridge panel) ----------------------------------------------
    def snapshot(self) -> dict:
        now = time.time()
        rem = None
        if self.pairing:
            rem = int(self.pairing["expires_at"] - now)
        return {
            "kind": "fake",
            "phase": self.phase,
            "relay_up": self.relay_up,
            "paired": self.paired,
            "clients": self.clients,
            "code": self.pairing["code"] if self.pairing and rem and rem > 0 else None,
            "code_remaining": rem if rem and rem > 0 else None,
            "fail": self.fail,
            "delay": self.delay,
            "state": self.state(now),
            "players": [
                {"key": self._key(p), "name": p["name"], "ok": bool(p.get("ok"))}
                for p in self.players
            ],
            "relay_outdated": self.relay_outdated,
            "updates": self.updater.snapshot(),
            "paired_clients": [
                {
                    "id": c["id"],
                    "label": c["label"],
                    "kind": c["kind"],
                    "live": bool(c.get("live")),
                    "used_ago": self._used_ago.get(c["id"]),
                }
                for c in self.paired_list
            ],
        }

    def _add_client(self, now: float, used_ago=None, live: bool = True) -> None:
        c = fake_bridge.make_client(self._client_n, now, used_ago=used_ago, live=live)
        self._client_n += 1
        c.pop("last_used_at", None)
        self.paired_list.append(c)
        self._used_ago[c["id"]] = used_ago

    def act(self, action: str, arg=None) -> None:
        now = time.time()
        if action.startswith("upd_"):
            return self.updater.act(action, arg)
        if action == "phase":
            if arg not in ("starting", "running", "error"):
                raise ValueError(arg)
            self.phase = arg
        elif action == "relay":
            self.relay_up = bool(arg)
        elif action == "paired":
            self.paired = bool(arg)
            if not self.paired:
                self.clients = 0
                self.paired_list = []
        elif action == "clients":
            self.clients = max(0, int(arg))
            if self.clients:
                self.paired = True
        elif action == "code":  # seconds until it expires; 0 = no code
            secs = int(arg or 0)
            if secs > 0:
                code = fake_bridge.new_code()
                self.pairing = {
                    "code": code,
                    "expires_at": int(now) + secs,
                    "url": f"https://splanc.io/pair#{code}",
                }
            else:
                self.pairing = None
        elif action == "fail":
            self.fail = str(arg) if arg else None
        elif action == "delay":
            self.delay = max(0.0, min(10.0, float(arg)))
        elif action == "add":
            p = self._extra[self._added % len(self._extra)]
            self._added += 1
            p = dict(p, id=f"02:00:5E:30:{self._added // 256:02X}:{self._added % 256:02X}")
            if self._added > len(self._extra):
                p["name"] += f" #{self._added}"
            p.pop("error", None)
            p.update(ok=True, session="live")
            p.setdefault(
                "perf",
                {
                    "fps": 50,
                    "budget_used": 0.4,
                    "overruns": 0,
                    "lagging": False,
                    "heap_free": 60000,
                },
            )
            self.players.append(p)
            self._ago[self._key(p)] = 1
        elif action == "remove":
            self.players = [p for p in self.players if self._key(p) != arg]
        elif action == "toggle":
            for i, p in enumerate(self.players):
                if self._key(p) != arg:
                    continue
                p = dict(p)
                if p.get("ok"):
                    p.update(ok=False, session="none", error="not answering")
                    p.pop("perf", None)
                    self._ago[arg] = 340
                else:
                    p.update(ok=True, session="live")
                    p.pop("error", None)
                    self._ago[arg] = 1
                self.players[i] = p
        elif action == "client_add":  # a new pairing, in use right now
            self._add_client(now, used_ago=1, live=True)
            self.paired = True
        elif action == "client_remove":  # revoked elsewhere (the app, POST /revoke)
            self.paired_list = [c for c in self.paired_list if c["id"] != arg]
        elif action == "client_live":  # toggle: in use now / idle since 2 h
            for c in self.paired_list:
                if c["id"] == arg:
                    c["live"] = not c.get("live")
                    self._used_ago[arg] = 1 if c["live"] else 7200
        elif action == "client_list":  # presets: sample | many | none | outdated
            if arg == "outdated":
                self.relay_outdated = not self.relay_outdated
            else:
                self.paired_list, self._used_ago = [], {}
                for c in (
                    fake_bridge.sample_clients(now)
                    if arg == "sample"
                    else fake_bridge.many_clients(now, 12) if arg == "many" else []
                ):
                    u = c.pop("last_used_at")
                    self._used_ago[c["id"]] = None if u is None else now - u
                    self.paired_list.append(c)
                if self.paired_list:
                    self.paired = True
        elif action == "fixtures":  # preset lists
            self.players = (
                []
                if arg == "none"
                else (
                    fake_bridge.many_players(now, 12)
                    if arg == "many"
                    else fake_bridge._players(now)
                )
            )
            self._ago = {self._key(p): now - p.get("seen", now) for p in self.players}
        else:
            raise ValueError(f"unknown action {action!r}")
        self.publish()


def find_agent(explicit: Optional[str] = None) -> Optional[List[str]]:
    """How to run splanc-agent: --agent, $SPLANC_AGENT, this checkout's Bazel build,
    or one on PATH. Returns the argv prefix, or None."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.normpath(os.path.join(here, "..", "..", "..", ".."))
    cands = [explicit, os.environ.get("SPLANC_AGENT")]
    if os.environ.get("BUILD_WORKSPACE_DIRECTORY"):  # bazel run
        cands.append(
            os.path.join(
                os.environ["BUILD_WORKSPACE_DIRECTORY"], "bazel-bin/agent/dist-mcp/splanc-agent.mjs"
            )
        )
    cands.append(os.path.join(repo, "bazel-bin/agent/dist-mcp/splanc-agent.mjs"))
    for c in cands:
        if not c:
            continue
        if c.endswith((".mjs", ".js")) and os.path.exists(c):
            return ["node", c]
        if os.path.exists(c) and os.access(c, os.X_OK):
            return [c]
    on_path = shutil.which("splanc-agent")
    return [on_path] if on_path else None


class RealBridge:
    """The actual ``splanc-agent bridge``, plus a local relay it pairs through."""

    def __init__(self, workdir: str, agent: List[str], relay: Optional[str] = None):
        self.dir = workdir
        self.agent = agent
        self.status_path = os.path.join(workdir, "status.json")
        self.control_path = os.path.join(workdir, "control.sock")
        self.external_relay = relay
        self.relay_port = 0
        self.relay_proc: Optional[subprocess.Popen] = None
        self.bridge_proc: Optional[subprocess.Popen] = None
        self.logs: List[str] = []
        self._log_lock = threading.Lock()

    def _pump(self, name: str, proc: subprocess.Popen) -> None:
        for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            with self._log_lock:
                self.logs = (self.logs + [f"{name}: {line}"])[-200:]
            log(f"[{name}] {line}")

    def _spawn(self, name: str, args: List[str]) -> subprocess.Popen:
        env = dict(os.environ)
        env.pop("SPLANC_RELAY", None)
        p = subprocess.Popen(
            self.agent + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        threading.Thread(target=self._pump, args=(name, p), daemon=True).start()
        return p

    def _free_port(self) -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def relay_url(self) -> str:
        return self.external_relay or f"http://127.0.0.1:{self.relay_port}"

    def start_relay(self) -> None:
        if self.external_relay or (self.relay_proc and self.relay_proc.poll() is None):
            return
        if not self.relay_port:
            self.relay_port = self._free_port()
        self.relay_proc = self._spawn(
            "relay",
            [
                "relay",
                "--port",
                str(self.relay_port),
                "--data-dir",
                os.path.join(self.dir, "relay"),
            ],
        )

    def stop_relay(self) -> None:
        if self.relay_proc and self.relay_proc.poll() is None:
            self.relay_proc.terminate()
            try:
                self.relay_proc.wait(5)
            except subprocess.TimeoutExpired:
                self.relay_proc.kill()
        self.relay_proc = None

    def start(self) -> "RealBridge":
        self.start_relay()
        time.sleep(0.5 if not self.external_relay else 0)
        self.bridge_proc = self._spawn(
            "bridge",
            [
                "bridge",
                "--relay",
                self.relay_url(),
                "--status",
                self.status_path,
                "--control",
                self.control_path,
                "--state-dir",
                os.path.join(self.dir, "state"),
                "--live-port",
                "0",
            ],
        )
        return self

    def stop(self) -> None:
        for p in (self.bridge_proc, self.relay_proc):
            if p and p.poll() is None:
                p.send_signal(signal.SIGTERM)
        for p in (self.bridge_proc, self.relay_proc):
            if p:
                try:
                    p.wait(5)
                except subprocess.TimeoutExpired:
                    p.kill()

    def snapshot(self) -> dict:
        try:
            with open(self.status_path) as f:
                state = json.load(f).get("state")
        except (OSError, ValueError):
            state = None
        with self._log_lock:
            logs = self.logs[-12:]
        return {
            "kind": "real",
            "state": state,
            "relay": self.relay_url(),
            "relay_up": bool(self.relay_proc and self.relay_proc.poll() is None)
            or bool(self.external_relay),
            "local_relay": not self.external_relay,
            "bridge_running": bool(self.bridge_proc and self.bridge_proc.poll() is None),
            "log": logs,
        }

    def act(self, action: str, arg=None) -> None:
        if action == "relay":
            if self.external_relay:
                raise ValueError("--relay is external; stop it there")
            (self.start_relay if arg else self.stop_relay)()
        elif action in ("new_pairing_code", "revoke_all", "identify"):
            control.send(action, path=self.control_path)
        else:
            raise ValueError(f"unknown action {action!r}")


# --- the simulator --------------------------------------------------------------------


def load_boot_frames():
    """The build's boot_frames.bin, else rendered now from the checkout's logo."""
    frames = boot.load()
    if frames is not None:
        return frames
    here = os.path.dirname(os.path.abspath(__file__))
    tools = os.path.normpath(os.path.join(here, "..", "..", "tools"))
    svg = os.path.normpath(
        os.path.join(here, "..", "..", "..", "..", "web/public/icons/splanc.svg")
    )
    if not (os.path.exists(os.path.join(tools, "gen_boot_frames.py")) and os.path.exists(svg)):
        log("no boot_frames.bin and no logo to render one from: no boot animation")
        return None
    sys.path.insert(0, tools)
    try:
        import gen_boot_frames

        return boot.unpack(gen_boot_frames.pack(gen_boot_frames.build_frames(svg)))
    except Exception as e:  # never stop the sim over the logo
        log(f"boot frames: {e}")
        return None
    finally:
        sys.path.remove(tools)


class Sim:
    """The display service + mocked peripherals + a bridge, restartable."""

    def __init__(
        self,
        bridge,
        hdmi_size=(1920, 1080),
        push_seconds: float = 0.0,
        boot_frames="auto",
    ):
        self.bridge = bridge
        self.hdmi_size = hdmi_size
        self.push_seconds = push_seconds
        self.clock = SimClock()
        self.frames = Frames()
        self.buttons = SimButtons()
        self.boot_frames = load_boot_frames() if boot_frames == "auto" else boot_frames
        self.app: Optional[main.App] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._key_lock = threading.Lock()
        self.restarts = 0

    def _make_app(self) -> main.App:
        return main.App(
            hdmi="sim",
            oled="sim",
            clock=self.clock,
            status_path=self.bridge.status_path,
            control_path=self.bridge.control_path,
            button_factory=self.buttons,
            boot_frames=self.boot_frames,
            oled_device=lambda: SimOled(self.frames, self.push_seconds),
            hdmi_device=lambda: SimHdmi(self.frames, self.hdmi_size),
            **self._update_paths(),
        )

    def _update_paths(self) -> dict:
        """The fake updaters' files; none for --bridge real (no updater there)."""
        up = getattr(self.bridge, "updater", None)
        if up is None:
            missing = os.path.join(os.path.dirname(self.bridge.status_path), "no-updater")
            return dict(
                system_update_status=missing,
                agent_update_status=missing,
                update_request=missing,
            )
        return dict(
            system_update_status=up.system_path,
            agent_update_status=up.agent_path,
            update_request=up.request_dir,
        )

    def start(self) -> "Sim":
        with self._lock:
            self.app = self._make_app()
            self._thread = threading.Thread(target=self.app.run, daemon=True, name="display")
            self._thread.start()
        # The service opens the panel and its keys on its first step: be ready to press.
        end = time.monotonic() + 2.0
        while len(self.buttons.by_pin) < len(KEY_PINS) and time.monotonic() < end:
            time.sleep(0.005)
        return self

    def stop(self) -> None:
        with self._lock:
            app, t = self.app, self._thread
            self.app = self._thread = None
        if app is not None:
            self.buttons.release_all()
            app.stop.set()
            app.wake.set()
            t.join(5)

    def set_fonts(self, name: str) -> None:
        """Switch the OLED font set live (the next frame uses it)."""
        fonts.set_active(name)
        app = self.app
        if app is not None:
            app._oled_key = None  # redraw even if nothing else changed
            app.wake.set()

    def font_sheet(self, scale: int = 3) -> bytes:
        """The current screen in every font set, side by side (PNG)."""
        from PIL import ImageDraw

        app = self.app
        if app is None:
            raise LookupError("the display service is not running")
        st, view = app.status, app.ui.view()
        names = list(fonts.SETS)
        tw, th, lab = 128 * scale, 64 * scale, 18
        label_font = fonts.ttf("sans", 13)
        cols = 2
        rows = (len(names) + cols - 1) // cols
        out = Image.new("RGB", (cols * (tw + 8) + 8, rows * (th + lab + 8) + 8), (21, 23, 26))
        dr = ImageDraw.Draw(out)
        for i, name in enumerate(names):
            img = render_oled.render(st, view, frames=self.boot_frames, font_set=name)
            tile = Image.new("RGB", img.size, (0, 0, 0))
            tile.paste((90, 170, 255), mask=img.convert("L"))
            r, c = divmod(i, cols)
            x, y = 8 + c * (tw + 8), 8 + r * (th + lab + 8)
            on = name == fonts.active().name
            dr.text(
                (x, y),
                name + ("  (shown)" if on else ""),
                font=label_font,
                fill=(90, 170, 255) if on else (200, 200, 200),
            )
            out.paste(tile.resize((tw, th), Image.NEAREST), (x, y + lab))
        buf = io.BytesIO()
        out.save(buf, "PNG")
        return buf.getvalue()

    def restart(self) -> None:
        """Like `systemctl restart splanc-display`: a fresh service, boot logo first."""
        self.stop()
        self.buttons.by_pin.clear()
        self.restarts += 1
        self.start()

    def press(self, key: str) -> None:
        with self._key_lock:
            self.buttons.press(key)

    def release(self, key: str) -> None:
        with self._key_lock:
            self.buttons.release(key)

    def tap(self, key: str, hold: float = 0.05) -> None:
        self.press(key)
        time.sleep(hold)
        self.release(key)

    def info(self) -> dict:
        app = self.app
        view = None
        if app is not None:
            try:
                v = app.ui.view()
                view = {
                    "page": v.page,
                    "overlay": v.overlay,
                    "key": v.key,
                    "sel": v.sel,
                    "animating": v.animating,
                    "dimmed": v.dimmed,
                    "asleep": v.asleep,
                }
            except Exception:  # the UI thread is mid-update; skip this one
                view = None
        return {
            "view": view,
            "speed": self.clock.speed,
            "fps": self.frames.fps(),
            "frame_interval_ms": round(app.frame_interval() * 1000, 1) if app else None,
            "contrast": self.frames.contrast,
            "hidden": self.frames.hidden,
            "oled_seq": self.frames.oled_seq,
            "hdmi_seq": self.frames.hdmi_seq,
            "restarts": self.restarts,
            "fonts": {
                "active": fonts.active().name,
                "default": fonts.DEFAULT_SET,
                "sets": [
                    {"name": f.name, "label": f.label, "license": f.license, "summary": f.summary}
                    for f in fonts.SETS.values()
                ],
            },
            "bridge": self.bridge.snapshot(),
        }


# --- the web page ---------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    sim: Sim = None  # set by serve()
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: SSE keeps connections busy
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode())

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            from .sim_page import PAGE

            return self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        if path == "/state":
            return self._json(self.sim.info())
        if path == "/oled.bin":
            return self._send(200, self.sim.frames.oled_bits(), "application/octet-stream")
        if path == "/oled.png":
            img = self.sim.frames.oled or Image.new("1", (128, 64))
            buf = io.BytesIO()
            img.convert("L").resize((512, 256), Image.NEAREST).save(buf, "PNG")
            return self._send(200, buf.getvalue(), "image/png")
        if path == "/fontsets.png":
            try:
                return self._send(200, self.sim.font_sheet(), "image/png")
            except LookupError as e:
                return self._json({"ok": False, "error": str(e)}, 503)
        if path == "/hdmi.png":
            return self._send(200, self.sim.frames.hdmi_png(), "image/png")
        if path == "/events":
            return self._events()
        self._send(404, b"not found", "text/plain")

    def _events(self) -> None:
        """Server-Sent Events: one ``frame`` per OLED frame drawn (+ state ~2/s)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        fr = self.sim.frames
        seen, last_info = -1, 0.0
        try:
            while True:
                with fr.cond:
                    if fr.oled_seq == seen:
                        fr.cond.wait(0.5)
                    seq, bits = fr.oled_seq, fr.oled_bits()
                    contrast, hidden, hdmi = fr.contrast, fr.hidden, fr.hdmi_seq
                out = b""
                if seq != seen:
                    seen = seq
                    msg = {
                        "seq": seq,
                        "bits": base64.b64encode(bits).decode(),
                        "contrast": contrast,
                        "hidden": hidden,
                        "hdmi": hdmi,
                    }
                    out += b"event: frame\ndata: " + json.dumps(msg).encode() + b"\n\n"
                now = time.monotonic()
                if now - last_info >= 0.5:
                    last_info = now
                    out += b"event: info\ndata: " + json.dumps(self.sim.info()).encode() + b"\n\n"
                if out:
                    self.wfile.write(out)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._json({"ok": False, "error": "bad json"}, 400)
        try:
            if path == "/key":
                key, action = body.get("key"), body.get("action", "tap")
                if action == "press":
                    self.sim.press(key)
                elif action == "release":
                    self.sim.release(key)
                elif action == "tap":
                    self.sim.tap(key)
                else:
                    raise ValueError(action)
            elif path == "/release_all":
                self.sim.buttons.release_all()
            elif path == "/restart":
                self.sim.restart()
            elif path == "/fonts":
                self.sim.set_fonts(str(body.get("name")))
            elif path == "/speed":
                self.sim.clock.speed = float(body.get("speed", 1.0))
            elif path == "/bridge":
                self.sim.bridge.act(body.get("action"), body.get("arg"))
            else:
                return self._json({"ok": False, "error": "not found"}, 404)
        except (KeyError, LookupError, ValueError, TypeError, control.ControlError) as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        self._json({"ok": True, "state": self.sim.info()})


def serve(sim: Sim, host: str = "127.0.0.1", port: int = 8737) -> ThreadingHTTPServer:
    handler = type("SimHandler", (Handler,), {"sim": sim})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True, name="http").start()
    return srv


def main_cli(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-display-sim", description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1", help="listen address (0.0.0.0: the LAN)")
    ap.add_argument("--port", type=int, default=8737)
    ap.add_argument("--bridge", choices=("fake", "real"), default="fake")
    ap.add_argument("--agent", help="real: splanc-agent (a .mjs or an executable)")
    ap.add_argument("--relay", help="real: use this relay instead of starting a local one")
    ap.add_argument("--state", default="running", help="fake: starting|running|error at start")
    ap.add_argument("--hdmi-size", default="1920x1080", help="the simulated HDMI mode")
    ap.add_argument(
        "--push-ms",
        type=float,
        default=0.0,
        help="extra ms per OLED frame (emulate SPI + a slow Pi; slows the frame pacing)",
    )
    ap.add_argument("--speed", type=float, default=1.0, help="clock rate (0.25 = slow motion)")
    ap.add_argument(
        "--fonts",
        default=None,
        help=f"OLED font set ({', '.join(fonts.SETS)}; default {fonts.DEFAULT_SET}); F on the page cycles",
    )
    ap.add_argument("--dir", help="where status.json/control.sock live (default: a temp dir)")
    a = ap.parse_args(argv)

    # AF_UNIX paths are short (104 bytes on macOS): keep the temp dir near the root.
    workdir = a.dir or tempfile.mkdtemp(prefix="splanc-sim-", dir="/tmp")
    os.makedirs(workdir, exist_ok=True)
    if a.bridge == "real":
        agent = find_agent(a.agent)
        if agent is None:
            log(
                "--bridge real needs splanc-agent: `bazel build //agent:mcp` "
                "(bazel-bin/agent/dist-mcp/splanc-agent.mjs), --agent PATH or $SPLANC_AGENT"
            )
            return 2
        bridge = RealBridge(workdir, agent, relay=a.relay).start()
    else:
        bridge = FakeModel(
            os.path.join(workdir, "status.json"), os.path.join(workdir, "control.sock")
        )
        bridge.phase = a.state
        bridge.start()
    if a.fonts:
        fonts.set_active(a.fonts)
    w, h = (int(x) for x in a.hdmi_size.lower().split("x"))
    sim = Sim(bridge, hdmi_size=(w, h), push_seconds=a.push_ms / 1000.0)
    sim.clock.speed = a.speed
    sim.start()
    srv = serve(sim, a.host, a.port)
    log(f"bridge={a.bridge}, status {bridge.status_path}")
    log(f"open http://{'127.0.0.1' if a.host in ('0.0.0.0', '') else a.host}:{srv.server_port}/")
    done = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: done.set())
    signal.signal(signal.SIGTERM, lambda *_: done.set())
    done.wait()
    srv.shutdown()
    sim.stop()
    bridge.stop()
    if not a.dir:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
