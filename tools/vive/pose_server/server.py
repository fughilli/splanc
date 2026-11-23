"""Live 3D web viewer for Vive Trackers: tracker and base-station poses.

  bazel run -c opt //tools/vive:pose_server -- --no-open
  python3 tools/vive/pose_server/server.py --lhd <path to lhd> [--port 8765]

Runs a tracking source, parses its stream and serves a three.js page at
http://127.0.0.1:PORT that streams state over server-sent events (/events).
Bound to localhost only. The default source is lhd (`@lighthouse//daemon:lhd`, the
Rust pipeline from fughilli/lighthouse that Splanc's ESP32-P4 player also runs);
`bazel run` passes it with --lhd. --source libsurvive runs survive-cli instead, for
a libsurvive build you have locally (--survive-cli); the notes below on recording and
restarts are about that source.

Forwarded from libsurvive's stream:
  POSE      tracker pose (world frame: gravity-aligned, z up), every one
  VELOCITY  tracker linear/angular velocity
  I         calibrated IMU (accel in g, gyro in rad/s), --record-cal-imu;
            rotated from the IMU frame into the tracker (head) frame POSE uses
  LH_POSE   base-station poses as libsurvive solves them
  A         sweep angles: per base station and axis, which sensors are lit
  CONFIG    tracker JSON config: sensor positions and normals, moved from the
            config's "trackref" frame into the head frame, and the IMU's rotation
  INFO LOG  libsurvive's log lines

Recording (from the page, or POST /record/start {"name", "notes"} and
/record/stop): survive-cli's full stream, raw light and raw IMU included, goes
to captures/vive/<time>_<name>.rec.gz (its CONFIG lines first), next to a copy
of libsurvive's config.json (the base-station calibration playback needs) and
a .json with the notes and timing. Replay with
  survive-cli --playback X.rec.gz --configfile X.config.json --playback-factor 0

Telemetry capabilities: each batch carries `capabilities` (what the source can
measure) and `health`. A field the source can't measure is null, never a zero:
with --source lhd there's no per-sensor light or sweep-angle stream, so `lit` and
`rates.angle` / `rates.hid` are null and `health.optical` is "unavailable" (lhd's
poses carry the number of light hits each solve used, published as
`rates.hits_used` when present). `health.devices[dev].state` keeps three
conditions apart: "tracking" (fresh poses), "no_pose_output" (no pose for
POSE_STALE_S, with no loss reported) and "lost_tracking" (the source said so: lhd's
tracking/lost, or the device went away); `health.summary` is the worst of them.

Also survive-cli doesn't recover when the tracker resets as it's switched
into light mode (macOS), so it's restarted after --restart-after seconds
without a single HID report (the device is gone, not merely untracked), or
from the page. Never while recording: a restart resets libsurvive's clock
and drops ~1 s of data, and a recording must be one unbroken stream.
"""

import argparse
import glob
import gzip
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CLI = os.path.expanduser("~/Projects/git_checkouts/libsurvive/build-hid/survive-cli")
# The repo checkout (captures go under it). `bazel run` starts in the runfiles, so it
# names the checkout in BUILD_WORKSPACE_DIRECTORY.
REPO = os.environ.get("BUILD_WORKSPACE_DIRECTORY") or os.path.dirname(
    os.path.dirname(os.path.dirname(HERE))
)
CAPTURE_DIR = os.path.join(REPO, "captures", "vive")
LIBSURVIVE_CONFIG = os.path.expanduser("~/.config/libsurvive/config.json")
HEADER_OPS = ("CONFIG", "IMU_SCALES")
# libsurvive's SurviveButton ids; a wireless tracker's button bitmask uses the
# same numbering (bit index = id).
BUTTON_NAMES = {
    0: "trigger",
    1: "trackpad",
    2: "thumbstick",
    3: "system",
    4: "A",
    5: "B",
    6: "menu",
    7: "grip",
}
# Feature-report traffic (device config reads, mode switches) happens at startup, before any
# recording; every exchange is kept and replayed at the top of each recording, in order.
HIDFEAT_KEEP = 20000
BATCH_S = 1 / 60.0
LIT_WINDOW_S = 0.25
POSE_STALE_S = 0.5  # s without a pose from a device before it counts as "no pose output"
# What each source can measure. Whatever a source can't is published as null
# ("unavailable"), never as a measured zero or an empty set of lit sensors.
#   optical:         per-sensor hits (`lit`) and the sweep-angle rate (`rates.angle`)
#   hid:             the raw HID report rate (`rates.hid`)
#   tracking_events: explicit tracking started/lost events (else health is from pose age)
#   pose_hits:       light hits used per solve (`rates.hits_used`); lhd turns it on when
#                    its poses carry `used`
CAPABILITIES = {
    "libsurvive": {
        "optical": True,
        "hid": True,
        "pose": True,
        "imu": True,
        "tracking_events": False,
        "pose_hits": False,
    },
    "lhd": {
        "optical": False,
        "hid": False,
        "pose": True,
        "imu": True,
        "tracking_events": True,
        "pose_hits": False,
    },
}
# Rates that need a capability; null when the source lacks it.
RATE_NEEDS = {"angle": "optical", "hid": "hid", "hits_used": "pose_hits"}


def frame_from_config(entry):
    """(R, t) of trackref_from_frame for a config "head"/"imu" entry, built the
    way libsurvive's solve_vive_pose does: columns plus_x, plus_z x plus_x,
    plus_z (R maps frame coordinates to trackref)."""
    x, z = entry.get("plus_x"), entry.get("plus_z")
    if not x or not z:
        return None
    y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
    cols = []
    for v in (x, y, z):
        n = sum(c * c for c in v) ** 0.5 or 1.0
        cols.append([c / n for c in v])
    R = [[cols[c][r] for c in range(3)] for r in range(3)]
    return R, entry.get("position", [0.0, 0.0, 0.0])


def mat_t_vec(R, v):
    """R^T v."""
    return [sum(R[r][c] * v[r] for r in range(3)) for c in range(3)]


def mat_vec(R, v):
    return [sum(R[r][c] * v[c] for c in range(3)) for r in range(3)]


def head_frames(cfg):
    """From a tracker's JSON config: a function taking trackref points to the
    head frame (what POSE is), and the rotation taking IMU vectors to it."""
    head = frame_from_config(cfg.get("head", {})) or ([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0])
    imu = frame_from_config(cfg.get("imu", {})) or head
    Rh, th = head
    Ri, _ = imu

    def point(p):
        return mat_t_vec(Rh, [p[i] - th[i] for i in range(3)])

    def imu_vec(v):
        return mat_t_vec(Rh, mat_vec(Ri, v))

    return point, imu_vec, (lambda n: mat_t_vec(Rh, n))


class Hub:
    """Shared state plus a queue per connected page."""

    def __init__(self, source="libsurvive"):
        self.lock = threading.Lock()
        self.source = source
        self.capabilities = dict(CAPABILITIES[source])
        self.clients = []
        self.lighthouses = {}  # id -> {"id", "mode", "p", "q", "t"}
        self.configs = {}  # dev -> {"points", "normals"} in the head frame
        self.imu_to_head = {}  # dev -> function rotating IMU-frame vectors into the head frame
        self.log = []  # recent log lines
        self.status = {"survive": "starting", "restarts": 0, "source": source}
        self.pending = {"poses": [], "imu": [], "vel": {}, "log": []}
        self.lit = {}  # (dev, lh, axis, sensor) -> host time last hit
        self.counts = {"pose": 0, "imu": 0, "angle": 0, "hid": 0, "hits_used": 0}
        self.rates = {"pose": 0.0, "imu": 0.0, "angle": 0.0, "hid": 0.0, "hits_used": 0.0}
        self.last_pose = 0.0
        self.pose_seen = {}  # dev -> host time of its newest pose
        self.tracking = {}  # dev -> {"state": "started"|"lost"|"disconnected", "reason", "t"} (lhd)
        self.hits = {}  # dev -> light hits the newest pose's solve used (lhd, when it says)
        self.last_hid = 0.0
        self.buttons = {}  # dev -> {"held": set of ids, "presses": n}

    def remove_lighthouse(self, lh_id):
        with self.lock:
            gone = self.lighthouses.pop(lh_id, None)
        if gone is not None:
            self.broadcast({"type": "lighthouse_removed", "id": lh_id})

    def clear_lighthouses(self):
        """A new lhd solves the stations afresh: the old ones (and their world) are gone."""
        with self.lock:
            ids = list(self.lighthouses)
        for lh_id in ids:
            self.remove_lighthouse(lh_id)

    def subscribe(self):
        q = queue.Queue(maxsize=600)
        with self.lock:
            self.clients.append(q)
            snap = {
                "type": "snapshot",
                "lighthouses": list(self.lighthouses.values()),
                "configs": self.configs,
                "log": self.log[-50:],
                "status": self.status,
                "capabilities": dict(self.capabilities),
            }
        q.put(snap)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def broadcast(self, msg):
        with self.lock:
            clients = list(self.clients)
        for q in clients:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass  # a stalled page drops frames rather than holding us up

    def add_log(self, line):
        with self.lock:
            self.log.append(line)
            self.log = self.log[-200:]
            self.pending["log"].append(line)

    def line(self, raw):
        parts = raw.split()
        if len(parts) < 3:
            return
        now = time.time()
        kind = parts[2]
        try:
            if kind == "POSE" and len(parts) >= 10:
                v = [float(x) for x in parts[3:10]]
                with self.lock:
                    self.pending["poses"].append(
                        {"dev": parts[1], "t": float(parts[0]), "ht": now, "p": v[0:3], "q": v[3:7]}
                    )
                    self.counts["pose"] += 1
                    self.pose_seen[parts[1]] = now
                self.last_pose = now
            elif kind == "I" and len(parts) >= 14:
                v = [float(x) for x in parts[5:14]]
                rot = self.imu_to_head.get(parts[1])
                acc, gyro = (rot(v[0:3]), rot(v[3:6])) if rot else (v[0:3], v[3:6])
                with self.lock:
                    self.pending["imu"].append(
                        {
                            "dev": parts[1],
                            "t": float(parts[0]),
                            "acc": acc,
                            "gyro": gyro,
                            "acc_imu": v[0:3],
                            "frame": "head" if rot else "imu",
                        }
                    )
                    self.counts["imu"] += 1
            elif kind == "BUTTON" and len(parts) >= 5:
                # "<t> <dev> BUTTON <event> <id>": event 3 = down, 2 = up (4/5 touch).
                ev, bid = int(parts[3]), int(parts[4])
                if ev in (2, 3):
                    held = set(self.buttons.get(parts[1], {}).get("held", set()))
                    (held.add if ev == 3 else held.discard)(bid)
                    self.set_buttons(parts[1], held)
            elif kind == "HIDIN":
                self.counts["hid"] += 1
                self.last_hid = now
            elif kind == "VELOCITY" and len(parts) >= 9:
                v = [float(x) for x in parts[3:9]]
                with self.lock:
                    self.pending["vel"][parts[1]] = {"v": v[0:3], "w": v[3:6]}
            elif kind == "A" and len(parts) >= 9:
                sensor, acode, lh = int(parts[3]), int(parts[4]), int(parts[8])
                with self.lock:
                    self.lit[(parts[1], lh, acode & 1, sensor)] = now
                    self.counts["angle"] += 1
            elif kind == "LH_POSE" and len(parts) >= 11:
                v = [float(x) for x in parts[3:10]]
                lh_id = parts[10]
                rec = {
                    "id": lh_id,
                    "mode": int(parts[1]),
                    "p": v[0:3],
                    "q": v[3:7],
                    "t": float(parts[0]),
                }
                with self.lock:
                    self.lighthouses[lh_id] = rec
                self.broadcast({"type": "lighthouse", **rec})
            elif kind == "CONFIG":
                cfg = json.loads(raw.split("CONFIG", 1)[1])
                lc = cfg.get("lighthouse_config", {})
                point, imu_vec, normal = head_frames(cfg)
                rec = {
                    "points": [point(p) for p in lc.get("modelPoints", [])],
                    "normals": [normal(n) for n in lc.get("modelNormals", [])],
                    "serial": cfg.get("device_serial_number"),
                    "imu_position": point(cfg.get("imu", {}).get("position", [0, 0, 0])),
                }
                with self.lock:
                    self.configs[parts[1]] = rec
                    self.imu_to_head[parts[1]] = imu_vec
                self.broadcast({"type": "config", "dev": parts[1], **rec})
            elif parts[1] == "INFO" and kind == "LOG":
                self.add_log("%8.3f %s" % (float(parts[0]), raw.split("LOG", 1)[1].strip()))
            elif kind == "DISCONNECT":
                self.add_log("%8.3f %s disconnected" % (float(parts[0]), parts[1]))
        except (ValueError, IndexError):
            pass

    def lhd_event(self, e):
        """One lhd event (@lighthouse//daemon) into the page's state."""
        now = time.time()
        kind = e.get("type")
        if kind == "pose":
            dev = e["serial"]
            with self.lock:
                self.pending["poses"].append(
                    {"dev": dev, "t": e["t"], "ht": now, "p": e["p"], "q": e["q"]}
                )
                self.counts["pose"] += 1
                self.pose_seen[dev] = now
                if "used" in e:
                    # The solve's light hits: real optical evidence, even without `lit`.
                    self.capabilities["pose_hits"] = True
                    self.hits[dev] = int(e["used"])
                    self.counts["hits_used"] += int(e["used"])
            self.last_pose = now
        elif kind == "tracking" and e.get("serial"):
            with self.lock:
                self.tracking[e["serial"]] = {
                    "state": e.get("state"),
                    "reason": e.get("reason"),
                    "t": now,
                }
            self.add_log(
                "%s tracking %s%s"
                % (e["serial"], e.get("state"), " (%s)" % e["reason"] if e.get("reason") else "")
            )
        elif kind == "imu":
            with self.lock:
                self.pending["imu"].append(
                    {
                        "dev": e["serial"],
                        "t": now,
                        "acc": e["acc"],
                        "gyro": e["gyro"],
                        "acc_imu": e["acc"],
                        "frame": "head",
                    }
                )
                self.counts["imu"] += 1
        elif kind == "calibrated":
            for st in e.get("stations", []):
                rec = {
                    "id": str(st["id"]),
                    "mode": st.get("mode") or 0,
                    "p": st["p"],
                    "q": st["q"],
                    "t": now,
                }
                with self.lock:
                    self.lighthouses[rec["id"]] = rec
                self.broadcast({"type": "lighthouse", **rec})
            self.add_log(
                "calibrated (%s): %s"
                % (
                    e.get("reason"),
                    ", ".join(
                        "%s rms %.0f urad" % (s["id"], s["rms"] * 1e6)
                        for s in e.get("stations", [])
                    ),
                )
            )
        elif kind == "station_dropped":
            # lhd dropped the station (no tracker saw it for a while): not in the world any more.
            self.remove_lighthouse(str(e["id"]))
            self.add_log("station %s dropped (%s)" % (e["id"], e.get("why")))
        elif kind == "buttons":
            mask = int(e.get("buttons", 0))
            self.set_buttons(e["serial"], {i for i in range(32) if mask >> i & 1})
        elif kind == "device" and e.get("state") in ("removed", "disconnected") and e.get("serial"):
            with self.lock:
                self.tracking[e["serial"]] = {
                    "state": "disconnected",
                    "reason": e.get("state"),
                    "t": now,
                }
            self.add_log("%s %s %s" % (e.get("name", "device"), e["serial"], e.get("state")))
        elif kind == "device" and e.get("sensors_head"):
            rec = {
                "points": e["sensors_head"],
                "normals": e.get("normals_head", []),
                "serial": e["serial"],
                "imu_position": [0, 0, 0],
            }
            with self.lock:
                self.configs[e["serial"]] = rec
            self.broadcast({"type": "config", "dev": e["serial"], **rec})
            self.add_log("%s %s %s" % (e.get("name"), e["serial"], e.get("state")))
        else:
            # Everything else is a log line on the page.
            self.add_log(
                " ".join(
                    "%s=%s" % (k, v)
                    for k, v in e.items()
                    if k not in ("cov",) and not isinstance(v, list) or k in ("accel",)
                )
            )

    def set_buttons(self, dev, held):
        """New set of held button ids for a device: logs presses and releases."""
        with self.lock:
            b = self.buttons.setdefault(dev, {"held": set(), "presses": 0})
            down, up = held - b["held"], b["held"] - held
            b["held"] = set(held)
            b["presses"] += len(down)
        for i in sorted(down):
            self.add_log("%s button %s pressed" % (dev, BUTTON_NAMES.get(i, "bit %d" % i)))
        for i in sorted(up):
            self.add_log("%s button %s released" % (dev, BUTTON_NAMES.get(i, "bit %d" % i)))

    def flush(self):
        """One batch to every page: new poses and IMU samples, latest velocity,
        which sensors each base station lit recently, and rates."""
        self.broadcast(self.batch(time.time()))

    def health(self, now):
        """Source-specific health, keeping "no optical telemetry", "no pose output" and
        "lost tracking" apart. Call with the lock held."""
        caps = self.capabilities
        if not caps["optical"]:
            optical = "unavailable"
        else:
            optical = "lit" if any(t >= now - LIT_WINDOW_S for t in self.lit.values()) else "dark"
        devices = {}
        for dev in set(self.pose_seen) | set(self.tracking):
            seen = self.pose_seen.get(dev)
            age = None if seen is None else now - seen
            tr = self.tracking.get(dev)
            if tr and tr["state"] in ("lost", "disconnected"):
                state = "lost_tracking"
            elif age is not None and age <= POSE_STALE_S:
                state = "tracking"
            else:
                state = "no_pose_output"
            d = {
                "state": state,
                "pose_age": age,
                "tracking": tr["state"] if tr else None,
                "reason": tr["reason"] if tr else None,
            }
            if caps["pose_hits"]:
                d["hits_used"] = self.hits.get(dev)
            devices[dev] = d
        states = {d["state"] for d in devices.values()}
        summary = next(
            (s for s in ("lost_tracking", "no_pose_output", "tracking") if s in states),
            "no_devices",
        )
        return {"optical": optical, "summary": summary, "devices": devices}

    def batch(self, now):
        """The batch message (and drains what's pending): see flush."""
        with self.lock:
            batch, self.pending = self.pending, {"poses": [], "imu": [], "vel": {}, "log": []}
            cut = now - LIT_WINDOW_S
            lit = {}
            for (dev, lh, axis, sensor), t in list(self.lit.items()):
                if t < cut:
                    del self.lit[(dev, lh, axis, sensor)]
                    continue
                lit.setdefault(dev, {}).setdefault("%d" % lh, [[], []])[axis].append(sensor)
            status = dict(self.status)
            buttons = {
                d: {
                    "held": sorted(b["held"]),
                    "names": [BUTTON_NAMES.get(i, "bit %d" % i) for i in sorted(b["held"])],
                    "presses": b["presses"],
                }
                for d, b in self.buttons.items()
            }
            caps = dict(self.capabilities)
            health = self.health(now)
            rates = {
                k: (v if caps[RATE_NEEDS[k]] else None) if k in RATE_NEEDS else v
                for k, v in self.rates.items()
            }
        if batch["imu"]:
            # The page only draws the newest accel; keep a few for smoothing.
            batch["imu"] = batch["imu"][-4:]
        # Unsupported optical telemetry is null, not an empty (= measured dark) set.
        return {
            "type": "batch",
            "now": now,
            "lit": lit if caps["optical"] else None,
            "rates": rates,
            "status": status,
            "buttons": buttons,
            "capabilities": caps,
            "health": health,
            "last_pose_age": now - self.last_pose if self.last_pose else None,
            **batch,
        }

    def tick_rates(self, dt):
        with self.lock:
            self.rates = {k: v / dt for k, v in self.counts.items()}
            self.counts = {k: 0 for k in self.counts}


class Recorder:
    """Tees survive-cli's stream into a playback-ready recording."""

    def __init__(self, hub, args):
        self.hub, self.args = hub, args
        self.lock = threading.Lock()
        self.header = {}  # (dev, op) -> line, replayed at the top of each recording
        self.hidfeat = []  # every HIDFEAT line so far, in order
        self.f = None
        self.meta = None
        self.base = None
        self.lines = 0

    def feed(self, raw):
        parts = raw.split(None, 3)
        if parts and parts[0] == "OPTION" or len(parts) >= 3 and parts[2] in HEADER_OPS:
            self.header[(parts[1], parts[2] if len(parts) > 2 else "")] = raw
        elif len(parts) >= 3 and parts[2] == "HIDFEAT" and len(self.hidfeat) < HIDFEAT_KEEP:
            self.hidfeat.append(raw)
        if self.f:
            with self.lock:
                if self.f:
                    self.f.write(raw if raw.endswith("\n") else raw + "\n")
                    self.lines += 1

    def start(self, name, notes):
        self.stop()
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", name.strip()) or "session"
        os.makedirs(CAPTURE_DIR, exist_ok=True)
        base = os.path.join(CAPTURE_DIR, time.strftime("%Y%m%d-%H%M%S") + "_" + slug)
        if os.path.exists(LIBSURVIVE_CONFIG):
            shutil.copyfile(LIBSURVIVE_CONFIG, base + ".config.json")
        with self.hub.lock:
            lighthouses = list(self.hub.lighthouses.values())
        self.meta = {
            "name": name,
            "notes": notes,
            "start_ht": time.time(),
            "survive_args": self.args,
            "lighthouses_at_start": lighthouses,
            "files": {
                "recording": os.path.basename(base) + ".rec.gz",
                "config": os.path.basename(base) + ".config.json",
            },
        }
        f = gzip.open(base + ".rec.gz", "wt", compresslevel=3)
        for line in list(self.header.values()) + list(self.hidfeat):
            f.write(line if line.endswith("\n") else line + "\n")
        with self.lock:
            self.f, self.base, self.lines = f, base, 0
        self.write_meta()
        self.hub.add_log("--- recording %s" % os.path.relpath(base, REPO))

    def stop(self):
        with self.lock:
            f, self.f = self.f, None
        if not f:
            return
        f.close()
        self.meta["stop_ht"] = time.time()
        self.meta["seconds"] = round(self.meta["stop_ht"] - self.meta["start_ht"], 2)
        self.meta["lines"] = self.lines
        self.write_meta()
        self.hub.add_log(
            "--- saved %s (%d lines, %.0f s)"
            % (os.path.relpath(self.base, REPO) + ".rec.gz", self.lines, self.meta["seconds"])
        )

    def write_meta(self):
        with open(self.base + ".json", "w") as m:
            json.dump(self.meta, m, indent=1)

    def status(self):
        if not self.f:
            return None
        return {
            "name": self.meta["name"],
            "file": os.path.relpath(self.base, REPO) + ".rec.gz",
            "seconds": round(time.time() - self.meta["start_ht"], 1),
            "lines": self.lines,
        }


class Survive:
    def __init__(self, hub, cli, args, recorder):
        self.hub, self.cli, self.args, self.recorder = hub, cli, args, recorder
        self.proc = None
        self.started = 0.0
        self.lock = threading.Lock()

    def start(self):
        with self.lock:
            self._stop()
            # Raw light and raw IMU are what playback needs; the page itself uses
            # the calibrated IMU and the angles.
            # --record-rawhid (our libsurvive patch) adds every HID report byte for byte.
            cmd = [
                self.cli,
                "--record-stdout",
                "--record-rawhid",
                "1",
                "--record-rawlight",
                "1",
                "--record-imu",
                "1",
                "--record-cal-imu",
                "1",
                "--record-angle",
                "1",
            ] + self.args
            self.proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                errors="replace",
                start_new_session=True,
            )
            self.started = time.time()
            self.hub.status["survive"] = "running"
            self.hub.add_log("--- started survive-cli %s" % " ".join(self.args))
            threading.Thread(target=self.read, args=(self.proc,), daemon=True).start()

    def read(self, proc):
        for raw in proc.stdout:
            self.recorder.feed(raw)
            self.hub.line(raw)
        if proc is self.proc:
            self.hub.status["survive"] = "exited (%s)" % proc.wait()
            self.hub.add_log("--- survive-cli exited")

    def _stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.proc = None

    def stop(self):
        with self.lock:
            self._stop()

    def restart(self, why):
        self.hub.add_log("--- restarting survive-cli: %s" % why)
        self.hub.status["restarts"] += 1
        self.start()


class Lhd:
    """The Rust pipeline (lhd, @lighthouse//daemon) as the source instead of
    survive-cli: its JSON-line events are translated into the page's messages,
    and recording, pairing and recalibration are commands on its stdin. lhd
    handles device reconnects itself, so there's no watchdog restart."""

    def __init__(self, hub, binary, args):
        self.hub, self.binary, self.args = hub, binary, args
        self.proc = None
        self.started = time.time()
        self.lock = threading.Lock()

    def start(self):
        with self.lock:
            self._stop()
            self.proc = subprocess.Popen(
                [self.binary] + self.args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                errors="replace",
                start_new_session=True,
            )
            self.started = time.time()
            self.hub.status["survive"] = "running"
            self.hub.clear_lighthouses()
            self.hub.add_log("--- started lhd %s" % " ".join(self.args))
            threading.Thread(target=self.read, args=(self.proc,), daemon=True).start()

    def read(self, proc):
        for raw in proc.stdout:
            try:
                e = json.loads(raw)
            except ValueError:
                self.hub.add_log(raw.strip())
                continue
            self.hub.lhd_event(e)
        if proc is self.proc:
            self.hub.status["survive"] = "exited (%s)" % proc.wait()
            self.hub.add_log("--- lhd exited")

    def command(self, obj):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.stdin.write(json.dumps(obj) + "\n")
                    self.proc.stdin.flush()
                    return True
                except (BrokenPipeError, OSError):
                    pass
        return False

    def _stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.proc = None

    def stop(self):
        with self.lock:
            self._stop()

    def restart(self, why):
        self.hub.add_log("--- restarting lhd: %s" % why)
        self.hub.status["restarts"] += 1
        self.start()


class LhdRecorder:
    """Recording when lhd is the source: lhd writes the raw traffic (same
    format), this keeps the page's status and the .json sidecar."""

    def __init__(self, lhd, calibration):
        self.lhd, self.calibration = lhd, calibration
        self.meta = None
        self.base = None

    def start(self, name, notes):
        self.stop()
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", name.strip()) or "session"
        os.makedirs(CAPTURE_DIR, exist_ok=True)
        self.base = os.path.join(CAPTURE_DIR, time.strftime("%Y%m%d-%H%M%S") + "_" + slug)
        if self.calibration and os.path.exists(self.calibration):
            shutil.copyfile(self.calibration, self.base + ".calibration.json")
        self.meta = {
            "name": name,
            "notes": notes,
            "start_ht": time.time(),
            "source": "lhd",
            "files": {"recording": os.path.basename(self.base) + ".rec.gz"},
        }
        self.lhd.command({"cmd": "record", "path": self.base + ".rec.gz"})
        self.write_meta()

    def stop(self):
        if not self.meta or "stop_ht" in self.meta:
            return
        self.lhd.command({"cmd": "stop_record"})
        self.meta["stop_ht"] = time.time()
        self.meta["seconds"] = round(self.meta["stop_ht"] - self.meta["start_ht"], 2)
        self.write_meta()

    def write_meta(self):
        with open(self.base + ".json", "w") as m:
            json.dump(self.meta, m, indent=1)

    def status(self):
        if not self.meta or "stop_ht" in self.meta:
            return None
        return {
            "name": self.meta["name"],
            "file": os.path.relpath(self.base, REPO) + ".rec.gz",
            "seconds": round(time.time() - self.meta["start_ht"], 1),
            "lines": 0,
        }


def make_handler(hub, survive, recorder):
    index = os.path.join(HERE, "index.html")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                body = open(index, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/events":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                q = hub.subscribe()
                try:
                    while True:
                        try:
                            msg = q.get(timeout=5)
                            self.wfile.write(
                                b"data: "
                                + json.dumps(msg, separators=(",", ":")).encode()
                                + b"\n\n"
                            )
                        except queue.Empty:
                            self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    hub.unsubscribe(q)
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path == "/restart":
                survive.restart("requested from the page")
            elif self.path == "/pair" and isinstance(survive, Lhd):
                survive.command({"cmd": "pair"})
            elif self.path == "/recalibrate" and isinstance(survive, Lhd):
                survive.command({"cmd": "recalibrate"})
            elif self.path == "/record/start":
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                except ValueError:
                    body = {}
                recorder.start(str(body.get("name", "session")), str(body.get("notes", "")))
            elif self.path == "/record/stop":
                recorder.stop()
            elif self.path == "/pose":
                # A pose tracked somewhere else (e.g. a Splanc P4 player's wired tracker,
                # relayed by tools/vive/demos --p4): {"dev", "p", "q"[, "t"]}, in this
                # viewer's world. Shown like any other tracker.
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                    hub.lhd_event(
                        {
                            "type": "pose",
                            "serial": str(body["dev"]),
                            "t": float(body.get("t", time.time())),
                            "p": [float(x) for x in body["p"]],
                            "q": [float(x) for x in body["q"]],
                        }
                    )
                except (ValueError, KeyError, TypeError):
                    return self.send_error(400)
            else:
                return self.send_error(404)
            self.send_response(204)
            self.end_headers()

    return Handler


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--survive-cli", default=DEFAULT_CLI)
    ap.add_argument(
        "--restart-after",
        type=float,
        default=10.0,
        help="restart survive-cli after this many seconds without any HID report",
    )
    ap.add_argument("--no-open", action="store_true", help="don't open the page in a browser")
    ap.add_argument(
        "--source",
        choices=["libsurvive", "lhd"],
        default="lhd",
        help="libsurvive (survive-cli) or lhd (the Rust pipeline, @lighthouse//daemon:lhd)",
    )
    # lhd comes from the @lighthouse module (fughilli/lighthouse):
    #   bazel build -c opt @lighthouse//daemon:lhd
    ap.add_argument(
        "--lhd",
        default=next(
            iter(
                sorted(
                    glob.glob(
                        os.path.join(REPO, "bazel-bin", "external", "lighthouse*", "daemon", "lhd")
                    )
                )
            ),
            None,
        ),
    )
    ap.add_argument(
        "--calibration",
        default=os.path.expanduser("~/.config/lighthouse/calibration.json"),
        help="lhd: station calibration file (loaded, and rewritten after each calibration)",
    )
    ap.add_argument("--replay", help="lhd: play this recording instead of live devices (real time)")
    ap.add_argument(
        "survive_args",
        nargs="*",
        default=["--lighthouse-gen", "1"],
        help="after --: passed to survive-cli",
    )
    a = ap.parse_args()

    if a.source == "lhd" and not a.lhd:
        ap.error(
            "no lhd binary: bazel run -c opt //tools/vive:pose_server, or "
            "bazel build -c opt @lighthouse//daemon:lhd and pass --lhd"
        )
    if a.lhd:
        a.lhd = os.path.abspath(a.lhd)  # bazel run passes it relative to the runfiles

    hub = Hub(source=a.source)
    if a.source == "lhd":
        os.makedirs(os.path.dirname(a.calibration), exist_ok=True)
        args = ["--calibration", a.calibration] + (["--replay", a.replay] if a.replay else [])
        survive = Lhd(hub, a.lhd, args)
        recorder = LhdRecorder(survive, a.calibration)
        a.restart_after = float("inf")
    else:
        recorder = Recorder(hub, a.survive_args)
        survive = Survive(hub, a.survive_cli, a.survive_args, recorder)
    server = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(hub, survive, recorder))
    server.daemon_threads = True

    def shutdown(*_):
        recorder.stop()
        survive.stop()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def loop():
        last_rates = time.time()
        while True:
            time.sleep(BATCH_S)
            hub.status["recording"] = recorder.status()
            hub.flush()
            now = time.time()
            if now - last_rates >= 1.0:
                hub.tick_rates(now - last_rates)
                last_rates = now
            quiet = now - max(hub.last_hid, survive.started)
            if quiet > a.restart_after and not recorder.status():
                survive.restart("no HID report for %.0f s" % quiet)

    survive.start()
    threading.Thread(target=loop, daemon=True).start()
    url = "http://127.0.0.1:%d/" % a.port
    print("serving", url, flush=True)
    if not a.no_open:
        subprocess.Popen(["open", url])
    server.serve_forever()


if __name__ == "__main__":
    main()
