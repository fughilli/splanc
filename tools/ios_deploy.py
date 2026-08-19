#!/usr/bin/env python3
"""One-shot: compile the Splanc iOS app and load it onto a paired iPhone (FUG-92).

Works two ways off the same command:

    bazel run //tools:ios_deploy                 # build → install → launch
    bazel run //tools:ios_deploy -- --log        # …and stream the device console

  * On the **Mac**, it's fully self-contained: if no build server is already
    running it starts `tools/ios_build_server.py` as a sidecar, drives it, then
    shuts it down. One command, no separate terminal.
  * From the **container**, it's a thin client over `host.docker.internal:8099`
    (start `bazel run //tools:ios_build_server` on the Mac first, as before) —
    the container never starts a sidecar (it has no Xcode toolchain).

Which path it takes is auto-detected (override with `--sidecar`):
  1. `$IOS_BUILD_SERVER` set        → use it as-is (no sidecar)
  2. a server already reachable     → use it (container: host.docker.internal;
     Mac: 127.0.0.1:8099)
  3. else, on macOS                 → start a sidecar build server on localhost
  4. else (container, none running) → the usual "start the server on the Mac" error

The web app + WASM payload (`//web:ios_payload`) is a normal label dep of this
binary, so `bazel run` builds it in THIS invocation — no re-invoking Bazel from
the build server. Xcode/CocoaPods still live only on the macOS host, so those
steps run in `tools/ios_build_server.py`. This script:

  1. finds the paired iPhone (auto-detects the single connected device, or takes
     `--target <UDID|name>` / $IOS_DEPLOY_TARGET),
  2. stages the Bazel-built payload into web/dist, then runs the `deploy-prebuilt`
     chain on the host — cap-sync → device-build → device-install → device-launch
     — streaming the log live (the app build already happened, as a label dep), and
  3. with `--log`, swaps the final launch for a console-attached relaunch
     (`deploy-prebuilt-log`) so the app's stdout/stderr + forwarded JS console
     stream back until you Ctrl-C.

The device deploy goes through devicectl (CoreDevice), so a Wi-Fi-paired iPhone
works as well as a USB one (enable it once in Xcode → Devices and Simulators →
"Connect via network"). The iPhone must be awake + unlocked during install.

Config (env, all optional):
    IOS_BUILD_SERVER   host:port of the build server — set this to use a specific
                       running server and skip the sidecar entirely
    IOS_BUILD_TOKEN    shared secret if the server was started with --token
    IOS_DEPLOY_TARGET  device UDID/name to deploy to (skips auto-detect)
"""

from __future__ import annotations

import argparse
import atexit
import collections
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Where the container reaches the Mac host; also the sidecar port on the Mac.
CONTAINER_SERVER = "host.docker.internal:8099"
LOCAL_SERVER = "127.0.0.1:8099"
DEFAULT_SERVER = LOCAL_SERVER if sys.platform == "darwin" else CONTAINER_SERVER

# Resolved once in main(): the server to drive and whether we started it ("own").
_RESOLVED: dict = {"server": None, "own": False}

# A real iOS device line from `xcrun xctrace list devices` carries an OS-version
# group AND a UDID group, e.g.  "Kfir's iPhone (18.5) (00008130-000A...)". The
# Mac has only a UDID group (no version) so it won't match. `xctrace` groups
# output under "== <Section> ==" headers — Devices / Devices Offline / Simulators
# — and we only ever auto-target the online "Devices" section (see _parse_devices).
_DEVICE_RE = re.compile(r"^(.*?) \(\d[\d.]*\) \(([0-9A-Fa-f][0-9A-Fa-f-]+)\)\s*$")
_SECTION_RE = re.compile(r"^== (.+?) ==\s*$")


def _server() -> str:
    return _RESOLVED["server"] or os.environ.get("IOS_BUILD_SERVER", DEFAULT_SERVER)


def _hostport(s: str) -> tuple[str, int]:
    host, _, port = s.partition(":")
    return host, int(port or "8099")


def _port_open(server: str, timeout: float = 0.6) -> bool:
    """True if something is already accepting connections at host:port."""
    host, port = _hostport(server)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _server_script() -> Path | None:
    """Locate tools/ios_build_server.py — via BUILD_WORKSPACE_DIRECTORY under
    `bazel run`, or as this file's sibling for a plain `python3 tools/…` run."""
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    for cand in (
        Path(ws) / "tools" / "ios_build_server.py" if ws else None,
        Path(__file__).resolve().parent / "ios_build_server.py",
    ):
        if cand and cand.exists():
            return cand
    return None


def _start_sidecar() -> str:
    """Start ios_build_server on a free localhost port, wait until it's ready,
    and register teardown. Returns the 'host:port' to drive. Exits on failure."""
    script = _server_script()
    if script is None:
        raise SystemExit(
            "ios_deploy: can't find tools/ios_build_server.py to start a sidecar.\n"
            "Run the server yourself and set $IOS_BUILD_SERVER, or use "
            "--sidecar never."
        )
    port = _free_port()
    server = f"127.0.0.1:{port}"
    sys.stdout.write(f"ios_deploy: starting build-server sidecar on {server}…\n")

    proc = subprocess.Popen(
        [sys.executable, str(script), "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    # Keep the last lines of server output so a startup failure is debuggable
    # without spamming the deploy log on success.
    ring: collections.deque[str] = collections.deque(maxlen=60)
    threading.Thread(target=lambda: [ring.append(ln) for ln in proc.stdout], daemon=True).start()

    def _stop() -> None:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    atexit.register(_stop)

    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            sys.stderr.write(
                "ios_deploy: build-server sidecar exited during startup:\n" + "".join(ring)
            )
            raise SystemExit(1)
        if _port_open(server):
            sys.stdout.write("ios_deploy: sidecar ready.\n\n")
            _RESOLVED["own"] = True
            return server
        time.sleep(0.25)

    _stop()
    raise SystemExit(
        f"ios_deploy: build-server sidecar didn't come up within 25s:\n{''.join(ring)}"
    )


def _resolve_server(mode: str) -> str:
    """Decide which build server to drive; may start a sidecar. `mode` is one of
    auto|always|never (from --sidecar)."""
    env = os.environ.get("IOS_BUILD_SERVER")
    if env:  # explicit target wins — never second-guess it
        return env
    if mode == "always":
        return _start_sidecar()
    if _port_open(DEFAULT_SERVER):  # reuse a server that's already up
        return DEFAULT_SERVER
    if mode != "never" and sys.platform == "darwin":
        return _start_sidecar()
    # Container with nothing running (or --sidecar never): fall through to the
    # default so _stream prints the "start the server on the Mac" guidance.
    return DEFAULT_SERVER


def _url(task: str, params: dict[str, str]) -> str:
    q = {"task": task, **{k: v for k, v in params.items() if v}}
    token = os.environ.get("IOS_BUILD_TOKEN")
    if token:
        q["token"] = token
    return f"http://{_server()}/run?{urllib.parse.urlencode(q)}"


def _stream(url: str, sink=None) -> int:
    """GET a streaming /run response, echo it to stdout (and optionally capture).
    Returns 0 if the chain reported success, 1 otherwise (the server prints a
    '[ios-build] task … failed' line and stops on any non-zero task)."""
    ok = True
    try:
        with urllib.request.urlopen(url) as resp:  # noqa: S310 (trusted LAN host)
            for raw in resp:
                line = raw.decode("utf-8", "replace")
                if "failed (exit" in line or line.startswith("error:"):
                    ok = False
                sys.stdout.write(line)
                sys.stdout.flush()
                if sink is not None:
                    sink.append(line)
    except urllib.error.HTTPError as e:
        # The server WAS reached but rejected the request — its body says why
        # (e.g. "unknown task 'deploy-device-log'"). Surface it verbatim instead
        # of the misleading "cannot reach" text.
        body = e.read().decode("utf-8", "replace").strip()
        sys.stderr.write(f"\nios_deploy: build server returned HTTP {e.code}: {body}\n")
        if "unknown task" in body and not _RESOLVED["own"]:
            sys.stderr.write(
                "ios_deploy: that server looks stale (it predates this task). "
                "Restart `bazel run //tools:ios_build_server`, or re-run with "
                "--sidecar always to spin up a fresh one.\n"
            )
        return 1
    except urllib.error.URLError as e:
        sys.stderr.write(
            f"\nios_deploy: cannot reach the build server at {_server()}: {e}\n"
            "Is `bazel run //tools:ios_build_server` running on the Mac?\n"
        )
        return 2
    except KeyboardInterrupt:
        # Expected when detaching from a --log stream; not an error.
        sys.stdout.write("\nios_deploy: detached from console.\n")
        return 0
    return 0 if ok else 1


def _parse_devices(text: str) -> dict[str, list[tuple[str, str]]]:
    """Group `xctrace list devices` lines by their "== Section ==" header,
    returning {section: [(name, udid), …]} for real devices only (the Mac and
    the section headers themselves don't match _DEVICE_RE)."""
    out: dict[str, list[tuple[str, str]]] = {}
    section = ""
    for line in text.splitlines():
        hdr = _SECTION_RE.match(line.strip())
        if hdr:
            section = hdr.group(1)
            continue
        m = _DEVICE_RE.match(line.strip())
        if m:
            out.setdefault(section, []).append((m.group(1).strip(), m.group(2)))
    return out


def _detect_target() -> str:
    """Ask the host which real devices are attached and pick the paired iPhone.
    Only auto-targets ONLINE devices (the "Devices" section); a device that's
    only in "Devices Offline" gets a targeted "wake it" message rather than a
    silent deploy that fails at install."""
    captured: list[str] = []
    sys.stdout.write("ios_deploy: no --target given — detecting paired device…\n")
    rc = _stream(_url("list-devices", {}), sink=captured)
    if rc != 0:
        raise SystemExit(rc)

    sections = _parse_devices("".join(captured))
    online = sections.get("Devices", [])
    offline = sections.get("Devices Offline", [])

    if not online:
        if offline:
            listing = "\n".join(f"    {name}  {udid}" for name, udid in offline)
            raise SystemExit(
                "ios_deploy: your device is offline (locked, asleep, or not "
                "connected):\n" + listing + "\n"
                "Wake + unlock the iPhone (and keep it unlocked during install), "
                "or plug in via USB. To force it anyway, pass --target <UDID>."
            )
        raise SystemExit(
            "ios_deploy: no paired device found. Plug in / Wi-Fi-pair an iPhone "
            "(Xcode → Devices and Simulators), or pass --target <UDID>.\n"
            "See connected devices with:  tools/iosctl devices"
        )

    # Prefer an iPhone by name; fall back to the first online device otherwise.
    iphones = [d for d in online if "iphone" in d[0].lower()]
    chosen = iphones or online
    if len(chosen) > 1:
        listing = "\n".join(f"    {name}  {udid}" for name, udid in chosen)
        raise SystemExit("ios_deploy: multiple paired devices — pass --target <UDID>:\n" + listing)
    name, udid = chosen[0]
    sys.stdout.write(f"ios_deploy: deploying to {name} ({udid})\n\n")
    return udid


def _stage_payload() -> None:
    """Copy the Bazel-built web payload into web/dist for the build server's
    `cap sync`. //web:ios_payload is a data dep of this binary, so `bazel run
    //tools:ios_deploy` has ALREADY built it (no Bazel re-invocation on the
    server) — it's handed over as a normal label dep via bazel-bin. The workspace
    is shared with the server (the container's /workspace is the Mac checkout)."""
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY") or str(Path(__file__).resolve().parents[1])
    src = Path(ws) / "bazel-bin" / "web" / "ios_payload"
    dst = Path(ws) / "web" / "dist"
    if not src.is_dir():
        raise SystemExit(
            f"ios_deploy: {src} is missing — run via `bazel run //tools:ios_deploy` "
            "(it builds //web:ios_payload), or `bazel build //web:ios_payload` first."
        )
    sys.stdout.write(f"ios_deploy: staging web payload → {dst}\n")
    # bazel outputs are read-only; copy then make writable so `cap sync` can work.
    subprocess.run(
        [
            "bash",
            "-c",
            'rm -rf "$1"; mkdir -p "$1"; cp -RL "$2"/. "$1"/; chmod -R u+w "$1"',
            "_",
            str(dst),
            str(src),
        ],
        check=True,
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="ios_deploy",
        description="Compile the Splanc iOS app and load it onto a paired iPhone.",
    )
    ap.add_argument(
        "--log",
        action="store_true",
        help="after installing, relaunch with the device console attached and "
        "stream its logs (Ctrl-C to detach)",
    )
    ap.add_argument(
        "--target",
        default=os.environ.get("IOS_DEPLOY_TARGET"),
        help="device UDID or name to deploy to (default: $IOS_DEPLOY_TARGET, "
        "else auto-detect the single paired device)",
    )
    ap.add_argument("--configuration", help="xcodebuild configuration (default Release for device)")
    ap.add_argument("--scheme", help="xcodebuild scheme (default App)")
    ap.add_argument("--bundle", help="app bundle id to launch (default dev.splanc.app)")
    ap.add_argument(
        "--sidecar",
        choices=("auto", "always", "never"),
        default="auto",
        help="start tools/ios_build_server as a sidecar. auto (default): start "
        "one on macOS when none is reachable; always: force a fresh sidecar; "
        "never: only use an existing/$IOS_BUILD_SERVER server",
    )
    args = ap.parse_args()

    _RESOLVED["server"] = _resolve_server(args.sidecar)

    target = args.target or _detect_target()

    params = {"target": target}
    if args.configuration:
        params["configuration"] = args.configuration
    if args.scheme:
        params["scheme"] = args.scheme
    if args.bundle:
        params["bundle"] = args.bundle

    # Stage the Bazel-built payload, then run the PREBUILT chain (cap-sync onward)
    # — the server never re-invokes Bazel for the app build.
    _stage_payload()
    chain = "deploy-prebuilt-log" if args.log else "deploy-prebuilt"
    return _stream(_url(chain, params))


if __name__ == "__main__":
    raise SystemExit(main())
