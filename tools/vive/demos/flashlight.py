#!/usr/bin/env python3
"""The stylus as a flashlight: a cone of light from its tip along its axis, lighting the
LEDs of every fixture localized in the space (effects/flashlight_pose.glsl on each).

The stylus's button cycles five modes:
  - colour:      rolling the stylus about its own axis turns the hue (one turn = the wheel);
  - saturation:  rolling turns the saturation (one turn = white to full colour);
  - width:       rolling widens or narrows the beam (one turn = x ROLL_FACTOR);
  - persistence: rolling lengthens or shortens the trail the beam leaves (one turn =
                 x ROLL_FACTOR on its time constant; at the short end it's off);
  - fixed:       rolling does nothing.
The beam follows the stylus in every mode.

The tip and axis come from the stylus pivot calibration the main demo saves
(mounts/stylus-<serial>.json, `c_S`: the tip in the stylus tracker's frame). The beam
goes out over OSC to every --fixture: /origin, /dir (world, metres), /width (the
half-angle, rad), /color, /decay (the trail's time constant, s; 0 = none). Fixtures
need their positions in the same world: a P4 player's own tracker (adopting lhd's
stations), or a room pose (set_fixture_pose) in lhd's world.

Stylus validity is its own signal, apart from each fixture's `tracker_ok` (which only
says the FIXTURE knows where it is). /stylus_ok is 1 while the newest stylus pose is
younger than --stale (STALE_S, 0.5 s by default) and 0 otherwise; /stylus_seq changes
with every new pose, and the effect drops the beam by itself when it stops changing
for /stale_after (sent as the same --stale), so a dead driver, network or viewer
also drops it. Without a live stylus the fixtures show the effect's inactive state
(dim blue breathing, no beam), and the console says why and what to check. Poses resuming bring the beam
back; nothing needs redeploying. There is no stationary-beam mode: a beam on the
fixtures always means fresh stylus poses.

    /usr/bin/python3 flashlight.py --stylus LHR-10F97524 --fixture 10.56.103.226 [--fixture ...]
"""

import argparse
import colorsys
import json
import math
import os
import sys
import threading
import time

import frames as fr
import numpy as np
import osc
import poses
import workspace

HERE = os.path.dirname(os.path.abspath(__file__))
MOUNTS = os.path.join(workspace.data_dir(HERE), "mounts")

MODES = ("color", "saturation", "width", "persistence", "fixed")
WIDTH_MIN, WIDTH_MAX = math.radians(2.0), math.radians(60.0)
DECAY_OFF, DECAY_MAX = 0.05, 20.0  # s; at DECAY_OFF the trail is sent as 0 (none)
ROLL_FACTOR = 3.0  # one full turn multiplies (or divides) the width or the decay by this
PARAM_KEEPALIVE = 1.0
STALE_S = 0.5  # s: a stylus pose older than this is stale (beam off); --stale
SEQ_WRAP = 999  # /stylus_seq counts 1..SEQ_WRAP (exact in a float, never the effect's initial 0)


def twist_about(R, axis):
    """The rotation angle of R about `axis` (unit, R's own frame): the twist of its
    swing-twist decomposition, in (-pi, pi]."""
    w, x, y, z = fr.mat_to_quat(R)
    t = x * axis[0] + y * axis[1] + z * axis[2]
    if w < 0.0:  # q and -q are the same rotation; this one keeps the angle in (-pi, pi]
        w, t = -w, -t
    return 2.0 * math.atan2(t, w)


class Flashlight:
    """The beam and its settings from the stylus pose: no I/O, so it's testable."""

    def __init__(self, tip, hue=0.1, sat=1.0, width=math.radians(12.0), decay=DECAY_OFF):
        tip = np.asarray(tip, float)
        self.tip = tip
        self.axis = tip / np.linalg.norm(tip)  # stylus frame: tracker origin -> tip
        self.hue, self.sat, self.width, self.decay = hue, sat, width, decay
        self.mode = 0
        self.prev_R = None

    @property
    def mode_name(self):
        return MODES[self.mode]

    def press(self):
        self.mode = (self.mode + 1) % len(MODES)
        return self.mode_name

    def color(self):
        return colorsys.hsv_to_rgb(self.hue % 1.0, self.sat, 1.0)

    def decay_sent(self):
        """The trail time constant for the effect: 0 (none) at the short end."""
        return 0.0 if self.decay <= DECAY_OFF * 1.0001 else self.decay

    def lose(self):
        """The stylus pose went stale: the next pose starts a new roll baseline, so a gap
        never counts as a roll."""
        self.prev_R = None

    def update(self, M):
        """A new stylus pose (4x4, world <- stylus): applies the roll since the last one
        to the mode's parameter; returns (origin, dir) in the world."""
        R = M[:3, :3]
        if self.prev_R is not None:
            turns = twist_about(self.prev_R.T @ R, self.axis) / (2.0 * math.pi)
            mode = MODES[self.mode]
            if mode == "color":
                self.hue = (self.hue + turns) % 1.0
            elif mode == "saturation":
                self.sat = min(max(self.sat + turns, 0.0), 1.0)
            elif mode == "width":
                self.width = min(max(self.width * ROLL_FACTOR**turns, WIDTH_MIN), WIDTH_MAX)
            elif mode == "persistence":
                self.decay = min(max(self.decay * ROLL_FACTOR**turns, DECAY_OFF), DECAY_MAX)
        self.prev_R = R.copy()
        origin = M[:3, :3] @ self.tip + M[:3, 3]
        return origin, R @ self.axis


class StylusWatch:
    """The stylus pose's freshness, on the host clock: "waiting" (no pose yet), "ok" or
    "stale" (none for longer than `stale_s`). The fixture's own tracker plays no part."""

    def __init__(self, stale_s=STALE_S):
        self.stale_s = stale_s
        self.last = None  # host time of the newest stylus pose
        self.count = 0
        self.losses = 0

    def pose(self, now):
        self.last = now
        self.count += 1

    def age(self, now):
        return None if self.last is None else max(0.0, now - self.last)

    def state(self, now):
        if self.last is None:
            return "waiting"
        return "ok" if now - self.last <= self.stale_s else "stale"


class Driver:
    """flashlight.py's logic between the pose source and the OSC streamer (no threads,
    no sockets, an injectable clock), so the stylus gate is testable.

    on_pose/on_button come from the source; tick() runs a few times a second and turns a
    pose that stopped coming into /stylus_ok 0. status() is the console line."""

    def __init__(self, light, streamer, stylus, stale_s=STALE_S, clock=time.monotonic):
        self.light, self.streamer, self.stylus = light, streamer, stylus
        self.watch = StylusWatch(stale_s)
        self.clock = clock
        self.lock = threading.Lock()
        self.seq = 0
        self.ok = None  # the /stylus_ok last sent
        self.others = {}  # other devices' serials -> host time last seen

    def start(self):
        """Settings and an explicit "no stylus yet" before any pose arrives."""
        with self.lock:
            self._send_params()
            self._set_ok(False)
            self.streamer.set("/stylus_seq", float(self.seq))

    def _send_params(self):
        light = self.light
        self.streamer.set("/width", light.width, keepalive=PARAM_KEEPALIVE)
        self.streamer.set("/color", *light.color(), keepalive=PARAM_KEEPALIVE)
        self.streamer.set("/decay", light.decay_sent(), keepalive=PARAM_KEEPALIVE)
        # The effect's own heartbeat timeout, the same threshold as this driver's.
        self.streamer.set("/stale_after", self.watch.stale_s, keepalive=PARAM_KEEPALIVE)

    def _set_ok(self, ok):
        if ok != self.ok:
            self.ok = ok
            self.streamer.set("/stylus_ok", 1.0 if ok else 0.0)

    def on_pose(self, ps):
        now = self.clock()
        if ps.dev != self.stylus:
            self.others[ps.dev] = now
            return None
        with self.lock:
            recovered = self.watch.state(now) != "ok"
            if recovered:
                self.light.lose()  # no roll across the gap
            self.watch.pose(now)
            o, d = self.light.update(ps.matrix())
            self.streamer.set("/origin", *o)
            self.streamer.set("/dir", *d)
            self.seq = self.seq % SEQ_WRAP + 1
            self.streamer.set("/stylus_seq", float(self.seq))
            self._send_params()
            self._set_ok(True)
        return "recovered" if recovered and self.watch.count > 1 else None

    def on_button(self, dev, n):
        if dev != self.stylus:
            return None
        with self.lock:
            for _ in range(n):
                self.light.press()
            return self.light.mode_name

    def tick(self):
        """Returns the stylus state ("waiting", "ok", "stale"); drops /stylus_ok when stale."""
        now = self.clock()
        with self.lock:
            st = self.watch.state(now)
            if st != "ok" and self.ok:
                self.watch.losses += 1
                self.light.lose()
            self._set_ok(st == "ok")
            return st

    def status(self, source=None):
        """(state, one line): the beam's settings while the stylus is live, otherwise
        what is wrong and what to check. `source` is the pose source's status() dict."""
        now = self.clock()
        with self.lock:
            st = self.watch.state(now)
            age = self.watch.age(now)
            light = self.light
            if st == "ok":
                r, g, b = light.color()
                trail = "off" if light.decay_sent() == 0.0 else "%.2f s" % light.decay
                return (
                    st,
                    "LIVE  mode %-11s  width %4.1f deg  colour %.2f %.2f %.2f (sat %.2f)  trail %-7s"
                    % (light.mode_name, math.degrees(light.width), r, g, b, light.sat, trail),
                )
            others = sorted(d for d, t in self.others.items() if now - t <= 5.0)
        source = source or {}
        conn = source.get("state")
        viewer = (source.get("devices") or {}).get(
            self.stylus
        )  # the pose server's health for the stylus
        if conn == "connecting" and not source.get("error"):
            why = "connecting to the pose source %s" % source.get("source", "?")
        elif conn not in (None, "connected"):
            why = (
                "pose source %s is %s%s: start tools/vive/pose_server/server.py (or check --source)"
                % (
                    source.get("source", "?"),
                    conn,
                    " (%s)" % source["error"] if source.get("error") else "",
                )
            )
        elif viewer and viewer.get("state") == "lost_tracking":
            why = (
                "the viewer reports %s's tracking lost (%s): bring it into view of the stations"
                % (self.stylus, viewer.get("reason") or "no reason given")
            )
        elif others:
            why = "poses arrive only from %s: is --stylus %s right, and is that stylus on?" % (
                ", ".join(others),
                self.stylus,
            )
        elif st == "waiting":
            why = (
                "no poses from anyone: switch the stylus on, check the receiver dongle and that the "
                "viewer shows calibrated stations"
            )
        else:
            why = (
                "the stylus stopped tracking: bring it into view of the stations (or check it's on)"
            )
        if st == "waiting":
            head = "NO STYLUS  (no pose from %s yet; beam off, fixtures idle)" % self.stylus
        else:
            head = "STYLUS LOST  (last pose %.1f s ago > %.2f s; beam off, fixtures idle)" % (
                age,
                self.watch.stale_s,
            )
        return st, "%s: %s" % (head, why)


def load_tip(stylus):
    path = os.path.join(MOUNTS, "stylus-%s.json" % stylus)
    if not os.path.exists(path):
        raise SystemExit("no stylus calibration %s: run the main demo's Pivot step first" % path)
    with open(path) as f:
        return json.load(f)["c_S"]


def parse_target(s):
    host, _, port = s.partition(":")
    return host, int(port or osc.OSC_PORT)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--stylus",
        required=True,
        help="tracker serial of the stylus (its pivot calibration is in mounts/)",
    )
    ap.add_argument(
        "--fixture",
        action="append",
        default=[],
        help="fixture host[:port] for OSC; repeat for several",
    )
    ap.add_argument("--source", default="http://127.0.0.1:8765", help="pose server URL (SSE)")
    ap.add_argument("--world-up", choices=["z", "y"], default="z")
    ap.add_argument(
        "--no-p4-stations",
        action="store_true",
        help="don't send lhd's stations to the fixtures (a P4 adopts them, so it tracks in lhd's world)",
    )
    ap.add_argument(
        "--stale",
        type=float,
        default=STALE_S,
        help="seconds without a stylus pose before the beam goes off (/stylus_ok 0)",
    )
    a = ap.parse_args()
    if not a.fixture:
        ap.error("at least one --fixture")

    light = Flashlight(load_tip(a.stylus))
    transport = osc.Tee(*[osc.UdpTransport(*parse_target(f)) for f in a.fixture])
    streamer = osc.OscStreamer(transport).start()
    drv = Driver(light, streamer, a.stylus, stale_s=a.stale)

    def on_button(dev, n):
        mode = drv.on_button(dev, n)
        if mode:
            print("\nmode: %s" % mode, flush=True)

    def station_sync():
        # As the main demo's --p4 mode: standalone datagrams (the P4 tracker module claims
        # single messages, never bundles), once a second.
        while True:
            for sid, (p, q) in list(source.lighthouses.items()):
                try:
                    transport.send(
                        osc.message_typed(
                            "/lh/station", int(sid), *[float(x) for x in p], *[float(x) for x in q]
                        )
                    )
                except (ValueError, OSError):
                    pass
            time.sleep(1.0)

    drv.start()
    source = poses.SseSource(a.source, world_up=a.world_up)
    source.start(drv.on_pose, on_button)
    if not a.no_p4_stations:
        threading.Thread(target=station_sync, daemon=True, name="p4-stations").start()
    print(
        "flashlight: stylus %s -> %s; mode %s (press the stylus button to change); beam off until the "
        "stylus pose is fresh (stale after %.2f s)"
        % (a.stylus, transport.describe(), light.mode_name, a.stale),
        flush=True,
    )
    last_state, last_print = None, 0.0
    try:
        while True:
            time.sleep(0.1)
            drv.tick()
            state, line = drv.status(source.status())
            now = time.monotonic()
            if state != last_state:
                # A change of state gets its own line, so it stays in the scrollback.
                sys.stdout.write("\n" + line + "\n")
                last_state, last_print = state, now
            elif now - last_print >= 2.0:
                sys.stdout.write("\r" + line)
                last_print = now
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        source.stop()
        streamer.stop()


if __name__ == "__main__":
    main()
