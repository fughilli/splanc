"""Pose input, behind one small interface so the source can change (the Rust tracking
daemon will replace the pose server).

A source calls `on_pose(PoseSample)` from its own thread. Every sample is in W, this
app's world: gravity-aligned, right-handed, metres, +Z up (libsurvive's world). A
source whose world is +Y up (SteamVR) must convert with frames.STEAMVR_TO_W.
The pose is the tracker's reporting frame T (libsurvive "head": origin at the 1/4"
mount, +Z out of the base).

Sources:
  SseSource        GET <url>/events from tools/vive/pose_server/server.py (read-only).
                   "batch" messages carry poses: [{dev, t, ht, p:[x,y,z], q:[w,x,y,z]}]
                   and buttons: {dev: {held, names, presses}} (presses is a running count).
  ReplaySource     POSE lines `<t> <dev> POSE x y z qw qx qy qz` from a text or .gz file
                   (survive-cli --record-stdout output, or a .rec.gz that has them).
  SyntheticSource  a scripted simulated tracker (synth.py) for the whole demo offline.
"""

import gzip
import json
import threading
import time
import urllib.request
from dataclasses import dataclass

import frames as fr
import numpy as np


@dataclass
class PoseSample:
    dev: str
    t: float  # source timestamp, seconds
    p: np.ndarray  # position in W
    q: np.ndarray  # (w, x, y, z), T -> W

    def matrix(self):
        return fr.pose_from_pq(self.p, self.q)


class PoseSource:
    """Interface: start(on_pose, on_button) begins delivering samples from a thread;
    stop() ends it; status() describes it for the UI. A source that sees the tracker's
    buttons calls on_button(dev, n) for n new presses (after the poses that preceded them)."""

    name = "none"

    def start(self, on_pose, on_button=None):
        raise NotImplementedError

    def stop(self):
        pass

    def status(self):
        return {"source": self.name}


class SseSource(PoseSource):
    def __init__(self, url="http://127.0.0.1:8765", world_up="z"):
        self.lighthouses = {}  # station id (str) -> (p, q), world <- station
        self.url = url.rstrip("/") + "/events"
        self.name = "sse " + self.url
        self.world_up = world_up  # "z" (libsurvive) or "y" (SteamVR-style, converted)
        self.running = False
        self.state = "idle"
        self.count = 0
        self.error = None
        self.presses = {}  # dev -> last running press count seen
        self.devices = (
            {}
        )  # dev -> the viewer's per-device health (state, reason, pose_age), if it sends one

    def _convert(self, p, q):
        p, q = np.asarray(p, float), np.asarray(q, float)
        if self.world_up == "y":
            M = fr.STEAMVR_TO_W
            R = M @ fr.quat_to_mat(q)
            return M @ p, fr.mat_to_quat(R)
        return p, q

    def _run(self, on_pose, on_button):
        while self.running:
            try:
                self.state = "connecting"
                req = urllib.request.Request(self.url, headers={"Accept": "text/event-stream"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    self.state = "connected"
                    self.error = None
                    for raw in r:
                        if not self.running:
                            break
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            msg = json.loads(line[5:])
                        except ValueError:
                            continue
                        if msg.get("type") == "lighthouse_removed":
                            # lhd dropped it (or restarted and solves afresh): the P4 stops
                            # getting it and forgets it too.
                            self.lighthouses.pop(str(msg["id"]), None)
                            continue
                        if msg.get("type") in ("snapshot", "lighthouse"):
                            # lhd's base stations (world <- station), for --p4: the P4
                            # adopts them so its world is this one. A snapshot is the whole
                            # set: stations from before (an older calibration) go.
                            if msg["type"] == "snapshot":
                                self.lighthouses = {}
                            for lh in (
                                msg.get("lighthouses", []) if msg["type"] == "snapshot" else [msg]
                            ):
                                p, q = self._convert(lh["p"], lh["q"])
                                self.lighthouses[str(lh["id"])] = (p, q)
                            continue
                        if msg.get("type") != "batch":
                            continue
                        self.devices = (msg.get("health") or {}).get("devices") or {}
                        for ps in msg.get("poses", []):
                            p, q = self._convert(ps["p"], ps["q"])
                            self.count += 1
                            on_pose(PoseSample(str(ps["dev"]), float(ps["t"]), p, q))
                        for dev, b in (msg.get("buttons") or {}).items():
                            n = int(b.get("presses", 0))
                            # The first count seen (on connect) is a baseline, not presses.
                            prev = self.presses.get(dev, n)
                            self.presses[dev] = n
                            if n > prev and on_button is not None:
                                on_button(str(dev), n - prev)
            except Exception as e:  # noqa: BLE001 - keep retrying whatever goes wrong
                self.error = str(e)
            self.state = "disconnected"
            if self.running:
                time.sleep(1.0)

    def start(self, on_pose, on_button=None):
        self.running = True
        threading.Thread(
            target=self._run, args=(on_pose, on_button), daemon=True, name="sse"
        ).start()

    def stop(self):
        self.running = False

    def status(self):
        return {
            "source": self.name,
            "state": self.state,
            "samples": self.count,
            "error": self.error,
            "devices": self.devices,
        }


def read_pose_lines(path):
    """[(t, dev, p, q)] from POSE lines in a text or gzip file."""
    op = gzip.open if path.endswith(".gz") else open
    out = []
    with op(path, "rt", errors="replace") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 10 and parts[2] == "POSE":
                try:
                    v = [float(x) for x in parts[3:10]]
                except ValueError:
                    continue
                out.append((float(parts[0]), parts[1], np.array(v[:3]), np.array(v[3:7])))
    return out


class ReplaySource(PoseSource):
    def __init__(self, path, speed=1.0, loop=True):
        self.path, self.speed, self.loop = path, speed, loop
        self.name = "replay " + path
        self.samples = read_pose_lines(path)
        self.running = False
        self.count = 0

    def _run(self, on_pose):
        if not self.samples:
            return
        while self.running:
            t0, w0 = self.samples[0][0], time.monotonic()
            for t, dev, p, q in self.samples:
                if not self.running:
                    return
                delay = (t - t0) / self.speed - (time.monotonic() - w0)
                if delay > 0:
                    time.sleep(delay)
                self.count += 1
                on_pose(PoseSample(dev, t, p, q))
            if not self.loop:
                return

    def start(self, on_pose, on_button=None):
        self.running = True
        threading.Thread(target=self._run, args=(on_pose,), daemon=True, name="replay").start()

    def stop(self):
        self.running = False

    def status(self):
        return {"source": self.name, "samples": self.count, "total": len(self.samples)}


class SyntheticSource(PoseSource):
    """Simulated tracker that follows the app: it rubs while the app records rubs, goes to
    and holds on the LED the (fake) fixture is blinking (/pick), sits mounted on the
    fixture once asked, and then the fixture+tracker slowly turn so the slice moves.

    `script` is polled for what to do: a callable returning one of
    "idle", "rub", "touch", "mount", "live"; `pick_row` returns the row being blinked."""

    name = "synthetic"

    def __init__(self, sim, script, pick_row, rate=120.0, dev="SIM0"):
        self.sim, self.script, self.pick_row = sim, script, pick_row
        self.rate, self.dev = rate, dev
        self.running = False
        self.count = 0
        self.mode = "idle"
        self.mounted = None

    def _emit(self, on_pose, M):
        self.count += 1
        on_pose(PoseSample(self.dev, time.monotonic(), M[:3, 3].copy(), fr.mat_to_quat(M[:3, :3])))
        time.sleep(1.0 / self.rate)

    def _run(self, on_pose):
        sim = self.sim
        rest = sim.touch_pose(0)
        rest[:3, 3] += [0.15, 0.1, 0.05]  # off to the side
        cur = rest
        t_live = 0.0
        while self.running:
            mode = self.script()
            self.mode = mode
            if mode == "rub":
                for _, M in sim.rub(seconds=0.5):
                    self._emit(on_pose, M)
                    cur = M
            elif mode == "touch" and self.pick_row() is not None:
                row = self.pick_row()
                target = sim.touch_pose(row)
                for _, M in sim.transit(cur, target, seconds=0.8):
                    self._emit(on_pose, M)
                cur = target
                # Hold until the app picks another LED (or leaves touch mode).
                while self.running and self.script() == "touch" and self.pick_row() == row:
                    for _, M in sim.hold(target, seconds=0.1):
                        self._emit(on_pose, M)
            elif mode in ("mount", "live"):
                if self.mounted is None:
                    self.mounted = sim.mount_pose()
                    for _, M in sim.transit(cur, self.mounted, seconds=0.8):
                        self._emit(on_pose, M)
                if mode == "mount":
                    for _, M in sim.hold(self.mounted, seconds=0.1):
                        self._emit(on_pose, M)
                    cur = self.mounted
                else:
                    # The fixture (with the tracker on it) turns slowly about its own up axis
                    # and rocks a little, as if someone were holding it.
                    t_live += 1.0 / self.rate
                    s, R, t = fr.sim_parts(sim.truth.T_WF)
                    pivot = t
                    move = fr.make_pose(
                        fr.rotvec_to_mat(
                            [0.25 * np.sin(0.7 * t_live), 0.15 * np.sin(0.5 * t_live), 0.4 * t_live]
                        )
                    )
                    move[:3, 3] = pivot - move[:3, :3] @ pivot
                    cur = move @ self.mounted
                    self._emit(on_pose, sim._noisy(cur))
            else:
                for _, M in sim.hold(cur if cur is not None else rest, seconds=0.1):
                    self._emit(on_pose, M)

    def start(self, on_pose, on_button=None):
        self.running = True
        threading.Thread(target=self._run, args=(on_pose,), daemon=True, name="synthetic").start()

    def stop(self):
        self.running = False

    def status(self):
        return {"source": self.name, "samples": self.count, "mode": self.mode}
