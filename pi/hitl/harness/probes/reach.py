"""Probe rig->DUT reachability + the plain-ws :81 handshake, no BLE needed.

Reserve a rig, flash the given bundle, read the DUT's LAN IP off the boot serial,
then from the rig check TCP :80/:81/:443 and run a real WebSocket upgrade against
:81 (ws_handshake.py). A fast way to answer "can the rig reach the player and is
the ws endpoint healthy?" without a full e2e — useful when a ws/connectivity
regression shows up.

  HITL_SERVERS=http://<rig>:8087 HITL_BUNDLE=/path/esp32c6_flashbundle.tar \\
      python3 probes/reach.py

Run from pi/hitl/harness (imports the client libs from the parent dir).
"""
import os
import re
import sys

# Import the harness client libs from the parent directory.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hitl_client import Reservation  # noqa: E402
from hitl_pool import parse_servers  # noqa: E402

base = parse_servers(os.environ["HITL_SERVERS"])[0]
bundle = os.environ["HITL_BUNDLE"]

res = Reservation(base)
res.acquire()
print(f"[diag] reserved {res.host}", flush=True)
try:
    res.scp_to([bundle], "/tmp/")
    remote = "/tmp/" + os.path.basename(bundle)
    fp = res.ssh(f"hitl-flash {remote} --monitor --monitor-seconds 12", capture=True, timeout=180)
    serial = (fp.stdout or "") + (fp.stderr or "")
    m = re.search(r"joined, http://([0-9.]+)/", serial)
    if not m:
        print("[diag] DUT did not report a join on boot; serial tail:", flush=True)
        print(serial[-500:], flush=True)
        raise SystemExit(1)
    ip = m.group(1)
    print(f"[diag] DUT joined on boot at {ip}", flush=True)

    ports = (
        f"echo '-- tcp ports --'; for p in 80 81 443; do "
        f"timeout 5 bash -c 'cat </dev/null >/dev/tcp/{ip}/'$p 2>/dev/null "
        f"&& echo \"port $p OPEN\" || echo \"port $p unreachable\"; done"
    )
    p = res.ssh(ports, capture=True, timeout=60)
    print(p.stdout or "", flush=True)

    # App-layer: does the DUT actually complete the ws upgrade on :81?
    here = os.path.dirname(os.path.abspath(__file__))
    res.scp_to([os.path.join(here, "ws_handshake.py")], "/tmp/")
    print("-- ws upgrade on :81 --", flush=True)
    h = res.ssh(f"python3 /tmp/ws_handshake.py {ip} 81", capture=True, timeout=40)
    print((h.stdout or "") + (h.stderr or ""), flush=True)
finally:
    res.release()
