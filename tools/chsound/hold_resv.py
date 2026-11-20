#!/usr/bin/env python3
"""Hold a c6-sdr reservation in the background. Writes resv.json (endpoint, key path, id).
Release: touch STOP file (resv.stop). Never kill -9 this while queued."""
import json
import os
import shutil
import sys
import time

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pi", "hitl", "harness")
)
os.environ.setdefault("HITL_SERIAL_CAPTURE", "0")
os.environ.setdefault("HITL_SERVER", "http://amd-rig:8087")
import hitl_client  # noqa: E402

D = os.environ.get("CHSOUND_RESV_DIR", os.path.expanduser("~/.chsound-resv"))
os.makedirs(D, exist_ok=True)
stop = os.path.join(D, "resv.stop")
if os.path.exists(stop):
    os.remove(stop)
r = hitl_client.Reservation(
    device=sys.argv[1] if len(sys.argv) > 1 else "c6-sdr", owner="chsound-agent"
)
r.acquire()
try:
    shutil.copy(r._keyfile, os.path.join(D, "id"))
    os.chmod(os.path.join(D, "id"), 0o600)
    json.dump(
        {
            "id": r.id,
            "host": r.host,
            "port": r.port,
            "user": r.user,
            "endpoint": r.endpoint,
            "server": r.server,
            "unit": r._unit,
            "key": os.path.join(D, "id"),
        },
        open(os.path.join(D, "resv.json"), "w"),
        indent=1,
    )
    print("HELD", r.id, r.user, r.host, r.port, flush=True)
    while not os.path.exists(stop):
        time.sleep(2)
finally:
    r.release()
    try:
        os.remove(os.path.join(D, "resv.json"))
    except OSError:
        pass
    print("RELEASED", flush=True)
