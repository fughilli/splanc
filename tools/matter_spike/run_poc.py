"""D-189 PoC driver (docs/design/matter-on-c6.md §7).

Flash the esp-matter light (a Matter-mode image) on a rig-2 C6,
read its IP + heap from serial, relay Matter UDP through the reservation, commission
from this container with the CHIP python controller, toggle On/Off + Level, and keep
the whole DUT serial log. usage: run_poc.py <bundle.tar> <outdir>

The bundle is a hitl-flash tar (flash.json + bootloader, partition table, otadata,
light.bin) of build_light.sh's output. $MATTER_CTRL_PY is a python with
home-assistant-chip-core + home-assistant-chip-clusters + zeroconf installed; the
CHIP controller also wants a writable /data and libnl-3 / libnl-route-3."""

import os
import re
import subprocess
import sys
import time

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pi", "hitl", "harness")
)
os.environ.setdefault("HITL_SERVER", "http://hitl-rig-2:8087")
os.environ.setdefault("HITL_SKU", "esp32c6")
os.environ.setdefault("HITL_OWNER", "mattersp-poc")
import hitl_client  # noqa: E402 (after the harness sys.path entry)

bundle, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print("[poc]", *a, flush=True)


r = hitl_client.Reservation()
r.acquire()
log("reserved", r.id, r._unit, r.host)
procs = []
try:
    r.scp_to([bundle, os.path.join(here, "rig_relay.py")], "/tmp/")
    p = r.ssh("hitl-flash /tmp/%s --erase-fs" % os.path.basename(bundle), capture=True, timeout=300)
    open(os.path.join(out, "flash.log"), "w").write(p.stdout + p.stderr)
    log("flash rc", p.returncode)
    if p.returncode:
        raise SystemExit("flash failed")
    # Serial: a long monitor in the background on the rig, polled via cat.
    # The reservation's always-on serial capture (serial_capture.py) logs the DUT under /tmp/hitl-serial.
    ip = None
    t0 = time.time()
    while time.time() - t0 < 120:
        s = r.ssh("cat /tmp/hitl-serial/*.log", capture=True, _raw=True).stdout
        m = re.findall(r"\[mattersp\].* ip=(\d+\.\d+\.\d+\.\d+)", s)
        m = [x for x in m if x != "0.0.0.0"]
        if m:
            ip = m[-1]
            break
        time.sleep(5)
    log("DUT ip", ip)
    if not ip:
        raise SystemExit("DUT never got an IP")
    r.ssh(
        "nohup python3 /tmp/rig_relay.py %s 5540 7700 > /tmp/relay.log 2>&1 < /dev/null &" % ip,
        _raw=True,
    )
    time.sleep(2)
    lp = hitl_client._free_local_port()
    fw = subprocess.Popen(
        r._ssh_base()
        + [
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            "%d:127.0.0.1:7700" % lp,
            "%s@%s" % (r.user, r.host),
        ]
    )
    procs.append(fw)
    time.sleep(4)
    lr = subprocess.Popen(
        [sys.executable, os.path.join(here, "local_relay.py"), "15540", str(lp)],
        stdout=open(os.path.join(out, "local_relay.log"), "w"),
        stderr=subprocess.STDOUT,
    )
    procs.append(lr)
    time.sleep(1)
    me = subprocess.run(
        ["sh", "-c", "hostname -I | cut -d' ' -f1"], capture_output=True, text=True
    ).stdout.strip()
    store = os.path.join(out, "repl.json")
    if os.path.exists(store):
        os.remove(store)
    t1 = time.time()
    cl = os.path.join(out, "controller.log")
    try:
        c = subprocess.run(
            [
                os.environ.get("MATTER_CTRL_PY", sys.executable),
                os.path.join(here, "ctrl.py"),
                me,
                "15540",
                "--storage",
                store,
                "--fake-mdns",
                "%s:15540" % me,
            ],
            stdout=open(cl, "w"),
            stderr=subprocess.STDOUT,
            timeout=400,
        )
        log("controller rc", c.returncode, "%.1fs" % (time.time() - t1))
    except subprocess.TimeoutExpired:
        log("controller TIMEOUT")
    for line in open(cl):
        if not line.startswith("[1") and line.strip():
            log("ctrl:", line.rstrip())
    time.sleep(12)  # two more heap lines after the last command
finally:
    try:
        s2 = r.ssh("cat /tmp/relay.log", capture=True, _raw=True).stdout
        open(os.path.join(out, "rig_relay.log"), "w").write(s2)
    except Exception as e:
        log("log fetch failed", e)
    for p in procs:
        p.terminate()
    r.release()
    for k, v in r.serial_logs.items():
        open(os.path.join(out, "dut_serial_%s.log" % k.replace("/", "_")), "w").write(v)
    log("released")
