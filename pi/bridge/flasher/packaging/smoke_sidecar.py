"""Smoke-test the frozen sidecar: it starts, speaks the JSON-lines protocol and
validates a form (packaging/build_app.*, before electron-builder).

    python smoke_sidecar.py <path to splanc-flasher-sidecar[.exe]>
"""

import json
import subprocess
import sys

cmds = '{"cmd":"ping"}\n{"cmd":"validate","form":{"ssid":"Home","psk":"password1"}}\n'
r = subprocess.run([sys.argv[1]], input=cmds.encode(), capture_output=True, timeout=120)
sys.stdout.write(r.stdout.decode(errors="replace"))
sys.stderr.write(r.stderr.decode(errors="replace"))
events = []
for line in r.stdout.decode(errors="replace").splitlines():
    try:
        events.append(json.loads(line))
    except ValueError:
        pass
types = [e.get("type") for e in events]
ok = (
    r.returncode == 0
    and "ready" in types
    and "pong" in types
    and any(e.get("type") == "validation" and e.get("errors") == {} for e in events)
)
print("sidecar smoke test:", "ok" if ok else f"FAILED (exit {r.returncode}, events {types})")
sys.exit(0 if ok else 1)
