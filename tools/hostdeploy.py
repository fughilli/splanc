#!/usr/bin/env python3
"""hostdeploy — run repo build/deploy commands on the HOST for the container agent.

The claude-container agent can't run the macOS-side `bazel run …deploy_live` (it
needs the host's builder VM + SSH to the rig). This tiny watcher bridges that: you
start it once on the host, and the agent submits commands through the shared repo
mount (`.hostdeploy/`). Output streams to a log both sides read; completion writes
a status file.

Usage (on the HOST, from the repo root — leave it running):

    python3 tools/hostdeploy.py

Then the container drives it (see tools/hostrun.sh) by writing
`.hostdeploy/request.json`:

    {"id": "<unique>",
     "argv": ["bazel","run","//pi/hitl:hitl_la.deploy_live","--","hitl-rig-2","--keep-builder"],
     "env": {"SBC_HOSTNAME_OVERRIDE": "hitl-rig-la-1"}}

Safety: only commands whose program (argv[0]) is in ALLOWED run, and always in the
repo root. It's a build/deploy driver, not a shell.
"""
import json
import os
import pathlib
import shlex
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent  # repo root (tools/..)
BOX = ROOT / ".hostdeploy"
ALLOWED = {"bazel", "bazelisk", "nix", "git"}  # argv[0] allowlist


def log(msg: str) -> None:
    print(f"[hostdeploy] {msg}", flush=True)


def run(req: dict) -> None:
    rid = str(req.get("id"))
    argv = req.get("argv") or []
    env = {**os.environ, **(req.get("env") or {})}
    statusf = BOX / f"{rid}.status"
    logf = BOX / f"{rid}.log"
    if not argv or argv[0] not in ALLOWED:
        statusf.write_text(json.dumps({"rc": -1, "error": f"argv[0] not allowed: {argv[:1]}"}))
        log(f"REJECTED #{rid}: {argv[:1]} not in {sorted(ALLOWED)}")
        return
    pretty = " ".join(shlex.quote(a) for a in argv)
    log(f"running #{rid}: {pretty}")
    envnote = " ".join(f"{k}={v}" for k, v in (req.get("env") or {}).items())
    with open(logf, "w") as lf:
        lf.write(f"$ {envnote + ' ' if envnote else ''}{pretty}\n")
        lf.flush()
        rc = subprocess.call(argv, cwd=str(ROOT), env=env, stdout=lf, stderr=subprocess.STDOUT)
    statusf.write_text(json.dumps({"rc": rc}))
    log(f"done #{rid} rc={rc}")


def main() -> int:
    BOX.mkdir(exist_ok=True)
    reqf = BOX / "request.json"
    alivef = BOX / "alive"
    log(f"watching {BOX} (repo {ROOT}); allowlist={sorted(ALLOWED)}. Ctrl-C to stop.")
    seen = None
    while True:
        try:
            alivef.write_text(str(time.time()))
            if reqf.exists():
                req = json.loads(reqf.read_text())
                if req.get("id") != seen:
                    seen = req.get("id")
                    run(req)
        except KeyboardInterrupt:
            log("stopping.")
            return 0
        except Exception as e:  # keep the watcher alive across a bad request
            log(f"error: {e}")
        time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
