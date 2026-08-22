#!/usr/bin/env python3
"""One-shot: build the Splanc iOS app and ship it to TestFlight (FUG-92).

    bazel run //tools:ios_testflight            # build → archive → export → upload
    bazel run //tools:ios_testflight -- --build-number 231

Same client/server split as `//tools:ios_deploy` (device deploy) — see that file
and docs/ios-build.md. Xcode lives only on the macOS host, so an `ios_build_server`
runs there and this thin client drives it over HTTP:

  * On the **Mac** it's self-contained: if no build server is reachable it starts
    `tools/ios_build_server.py` as a sidecar, drives it, and shuts it down. One
    command. (A GitHub Actions macOS runner takes this same path.)
  * From the **container** it's a thin client over `host.docker.internal:8099`
    (start `bazel run //tools:ios_build_server` on the Mac first).

The web app + WASM payload (`//web:ios_payload`) is a normal label dep of this
binary, so `bazel run` builds it in THIS invocation; the payload is staged into
web/dist and the server runs the `testflight-prebuilt` chain (cap-sync →
tf-build-number → tf-signing-prep → tf-archive → tf-export → tf-upload) — no
Bazel re-invocation on the server.

CREDENTIALS live in the build server's ENVIRONMENT, never in the request (so no
secret is ever in a URL or the streamed log). Set them where the server runs —
your shell/launchd on the Mac sidecar path, or the GitHub Actions `env:` for the
CI path. They are the SAME names the TestFlight job in
.github/workflows/macos.yaml uses, so one set of secrets serves both:

    APP_STORE_CONNECT_KEY_ID         App Store Connect API key — Key ID
    APP_STORE_CONNECT_ISSUER_ID      …its Issuer ID
    APP_STORE_CONNECT_KEY_P8_BASE64  base64 of the AuthKey_<KeyID>.p8  (or…)
    APP_STORE_CONNECT_KEY_P8_PATH    …a path to the .p8 (or leave the key in
                                     ~/.private_keys/ once)
    APPLE_TEAM_ID                    10-char Developer Team ID
    APPLE_DIST_CERT_P12_BASE64       base64 "Apple Distribution" .p12  — OPTIONAL:
    APPLE_DIST_CERT_PASSWORD         …+ password. Only needed where the keychain
                                     lacks a distribution cert (a fresh CI runner);
                                     a dev Mac that ships device builds already has one.

Client-side (this process) env, all optional:
    IOS_BUILD_SERVER   host:port of a running server (skip the sidecar)
    IOS_BUILD_TOKEN    shared secret if the server was started with --token
    IOS_BUILD_NUMBER   CFBundleVersion for this upload (also settable with
                       --build-number); must be unique + increasing per TestFlight
                       build. On the sidecar/Mac path this is forwarded to the
                       server; when driving a REMOTE server, set it there instead.
"""

from __future__ import annotations

import argparse
import atexit
import collections
import os
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
    and register teardown. Returns the 'host:port' to drive. Exits on failure.

    The sidecar inherits THIS process's environment, so the ASC/signing vars set
    for `bazel run` reach the build tasks (child_env passes them through)."""
    script = _server_script()
    if script is None:
        raise SystemExit(
            "ios_testflight: can't find tools/ios_build_server.py to start a "
            "sidecar.\nRun the server yourself and set $IOS_BUILD_SERVER, or use "
            "--sidecar never."
        )
    port = _free_port()
    server = f"127.0.0.1:{port}"
    sys.stdout.write(f"ios_testflight: starting build-server sidecar on {server}…\n")

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
                "ios_testflight: build-server sidecar exited during startup:\n" + "".join(ring)
            )
            raise SystemExit(1)
        if _port_open(server):
            sys.stdout.write("ios_testflight: sidecar ready.\n\n")
            _RESOLVED["own"] = True
            return server
        time.sleep(0.25)

    _stop()
    raise SystemExit(
        f"ios_testflight: build-server sidecar didn't come up within 25s:\n{''.join(ring)}"
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


def _stream(url: str) -> int:
    """GET a streaming /run response and echo it to stdout. Returns 0 if the chain
    reported success, 1 otherwise (the server prints a '… failed (exit N)' line
    and stops on any non-zero task)."""
    ok = True
    try:
        with urllib.request.urlopen(url) as resp:  # noqa: S310 (trusted LAN host)
            for raw in resp:
                line = raw.decode("utf-8", "replace")
                if "failed (exit" in line or line.startswith("error:"):
                    ok = False
                sys.stdout.write(line)
                sys.stdout.flush()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace").strip()
        sys.stderr.write(f"\nios_testflight: build server returned HTTP {e.code}: {body}\n")
        if "unknown task" in body and not _RESOLVED["own"]:
            sys.stderr.write(
                "ios_testflight: that server looks stale (it predates the tf-* "
                "tasks). Restart `bazel run //tools:ios_build_server`, or re-run "
                "with --sidecar always to spin up a fresh one.\n"
            )
        return 1
    except urllib.error.URLError as e:
        sys.stderr.write(
            f"\nios_testflight: cannot reach the build server at {_server()}: {e}\n"
            "Is `bazel run //tools:ios_build_server` running on the Mac?\n"
        )
        return 2
    except KeyboardInterrupt:
        sys.stdout.write("\nios_testflight: interrupted.\n")
        return 130
    return 0 if ok else 1


def _stage_payload() -> None:
    """Copy the Bazel-built web payload into web/dist for the build server's
    `cap sync`. //web:ios_payload is a data dep of this binary, so `bazel run
    //tools:ios_testflight` has ALREADY built it — it's handed over via bazel-bin.
    The workspace is shared with the server (the container's /workspace is the Mac
    checkout)."""
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY") or str(Path(__file__).resolve().parents[1])
    src = Path(ws) / "bazel-bin" / "web" / "ios_payload"
    dst = Path(ws) / "web" / "dist"
    if not src.is_dir():
        raise SystemExit(
            f"ios_testflight: {src} is missing — run via `bazel run "
            "//tools:ios_testflight` (it builds //web:ios_payload), or `bazel "
            "build //web:ios_payload` first."
        )
    sys.stdout.write(f"ios_testflight: staging web payload → {dst}\n")
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
        prog="ios_testflight",
        description="Build the Splanc iOS app and upload it to TestFlight.",
    )
    ap.add_argument(
        "--build-number",
        help="CFBundleVersion for this upload (must be unique + increasing per "
        "TestFlight build). Sets $IOS_BUILD_NUMBER for the build; default is the "
        "current epoch seconds. Only honored on the sidecar/Mac path — when "
        "driving a remote server, set IOS_BUILD_NUMBER there.",
    )
    ap.add_argument("--configuration", help="xcodebuild configuration (default Release)")
    ap.add_argument("--scheme", help="xcodebuild scheme (default App)")
    ap.add_argument(
        "--sidecar",
        choices=("auto", "always", "never"),
        default="auto",
        help="start tools/ios_build_server as a sidecar. auto (default): start "
        "one on macOS when none is reachable; always: force a fresh sidecar; "
        "never: only use an existing/$IOS_BUILD_SERVER server",
    )
    args = ap.parse_args()

    # A build number is not a secret, but it must reach the machine that stamps
    # CFBundleVersion. On the sidecar path that's a child of this process, so an
    # env var propagates; warn if we're about to drive a server we didn't start.
    if args.build_number:
        os.environ["IOS_BUILD_NUMBER"] = args.build_number

    _RESOLVED["server"] = _resolve_server(args.sidecar)

    if args.build_number and not _RESOLVED["own"] and not os.environ.get("IOS_BUILD_SERVER"):
        # Reusing a server we didn't start — our IOS_BUILD_NUMBER won't reach it.
        sys.stderr.write(
            "ios_testflight: note — --build-number only applies to a sidecar we "
            "start; this run is driving an already-running server, which will use "
            "its own $IOS_BUILD_NUMBER (or the epoch default).\n"
        )

    params: dict[str, str] = {}
    if args.configuration:
        params["configuration"] = args.configuration
    if args.scheme:
        params["scheme"] = args.scheme

    # Stage the Bazel-built payload, then run the PREBUILT chain (cap-sync onward)
    # — the server never re-invokes Bazel for the app build.
    _stage_payload()
    return _stream(_url("testflight-prebuilt", params))


if __name__ == "__main__":
    raise SystemExit(main())
