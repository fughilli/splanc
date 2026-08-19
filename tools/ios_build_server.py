#!/usr/bin/env python3
"""Host-side Capacitor/Xcode build helper for the Splanc iOS wrapper (FUG-92).

Xcode, CocoaPods and the iOS Simulator only exist on the macOS host — the dev
container can't run any of them. So run THIS on the host and drive the iOS build
from inside the container over HTTP, exactly like tools/flash_server.py does for
firmware:

    python3 tools/ios_build_server.py                  # binds 0.0.0.0:8099
    #   (or:  bazel run //tools:ios_build_server)

    # from the container (the host is reachable at host.docker.internal):
    tools/iosctl doctor                                # what's installed?
    tools/iosctl bootstrap                             # one-time: deps + ios/ project
    tools/iosctl rebuild                               # web build → cap sync → xcode build
    tools/iosctl run --sim "iPhone 15"                 # build + launch in the Simulator
    #   ...or with plain curl:
    curl -N host.docker.internal:8099/run?task=rebuild

The server runs a fixed ALLOWLIST of named tasks (below) — it never executes an
arbitrary command from the request, so exposing it on the LAN only ever triggers
a build of THIS repo. Each task streams its stdout/stderr back as it runs (HTTP/1.0
chunkless body, so `curl -N` / netcat show live logs).

Endpoints (GET or POST):

    /                usage + detected toolchain
    /tasks           JSON: the allowlisted tasks and what each runs
    /doctor          versions of node/pnpm/xcodebuild/pod/cap + project state
    /run?task=NAME   run one task (or a comma list: ?task=web-build,cap-sync),
                     streaming output; a non-zero exit stops the chain
                       &target=<name|udid>    ios-run target: sim name, device
                                              name, or device UDID (list-devices)
                       &configuration=Debug   xcodebuild configuration
                       &scheme=App            xcodebuild scheme
                       &bundle=dev.splanc.app app id (device-launch / device-log)

Named tasks:

    doctor         toolchain + project-state report (same as /doctor)
    install        `pnpm install` — pull the Capacitor deps into the workspace
    web-build      `bazel build //web:ios_payload` (hermetic node deps + WASM) → web/dist
    cap-add-ios    `cap add ios` — ONE-TIME: generate web/ios/App (native project)
    ios-config     apply web/ios-config/apply.sh (Info.plist usage strings)
    stage-wasm     (standalone) build + stage the WASM into web/dist — folded into
                   web-build's //web:ios_payload now; kept for manual use
    cap-sync       `cap sync ios` — copy web/dist + resolve plugins (SPM in Cap 8)
    pod-install    `pod install` (only for a CocoaPods setup; Cap 8 uses SPM)
    ios-build      `xcodebuild build` for the simulator (SPM or Pods; no launch)
    ios-run        `cap run ios --target …` — build + launch on a sim OR device (USB)
    device-build   `xcodebuild` a signed device .app (iphoneos SDK; no launch)
    device-install `devicectl device install` the .app on a device (USB or Wi-Fi)
    device-launch  `devicectl device process launch` — start the app on a device
    open-xcode     `cap open ios` — open the project in Xcode on the host
    list-sims      `xcrun simctl list devices available`
    list-devices   `xcrun xctrace list devices` — real devices + sims with UDIDs

The device-* tasks go through devicectl (CoreDevice), so they reach a device
over USB *or* Wi-Fi — unlike ios-run (`cap run`/native-run), which only sees
USB-attached devices. Enable Wi-Fi once in Xcode → Devices and Simulators →
"Connect via network".

Convenience chains (each is just the tasks above, in order, stop-on-failure):

    bootstrap      install → web-build → cap-add-ios → ios-config → cap-sync
    rebuild        web-build → cap-sync → ios-build
    launch         web-build → cap-sync → ios-run                       (USB device/sim)
    deploy-device  web-build → cap-sync → device-build →
                   device-install → device-launch  (wireless-capable; needs &target=UDID)
    deploy-prebuilt  cap-sync → device-build → device-install → device-launch — for
                   `bazel run //tools:ios_deploy`, which already staged web/dist
                   (the payload is its label dep), so the server skips web-build

Nothing here is macOS-specific in the server itself; it simply shells out to the
host's tools. On a non-mac host the Xcode tasks fail cleanly (command not found),
while `install` / `web-build` still work.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _ios_project_exists() -> bool:
    """True once `cap add ios` has generated the native project. Capacitor 8 (SPM)
    produces App.xcodeproj; older CocoaPods setups add an App.xcworkspace — accept
    either."""
    app = Path(CFG["workspace"]) / "web" / "ios" / "App"
    return (app / "App.xcodeproj").exists() or (app / "App.xcworkspace").exists()


def _default_workspace() -> str:
    # Under `bazel run` the launcher exports the real checkout; otherwise this
    # file lives at <repo>/tools/ios_build_server.py, so the repo is its parent's
    # parent.
    return os.environ.get("BUILD_WORKSPACE_DIRECTORY") or str(Path(__file__).resolve().parents[1])


CFG: dict = {}  # populated in main()


def _log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# Task allowlist
#
# A task is (argv, cwd_relative_to_workspace, needs_ios_project). `argv` may
# contain `{sim}`/`{scheme}`/`{configuration}` placeholders, filled only from
# validated query params (see _params). The web app is a pnpm workspace package
# (web/), so the Capacitor CLI is invoked as `pnpm --dir web exec cap …`.
# --------------------------------------------------------------------------- #
# pnpm runs non-interactively here (no TTY over HTTP), so pre-empt the two places
# it would otherwise BLOCK on a prompt or fail:
#   verify-deps-before-run=false — skip the pre-`run`/`exec` deps-status check,
#     which shells out to `pnpm install` and fails on the repo's un-approved
#     @bufbuild/buf build script (unrelated to iOS).
#   confirm-modules-purge=false  — auto-confirm the "remove & reinstall
#     node_modules from scratch?" prompt (e.g. after a pnpm major upgrade on the
#     host); without it `install` hangs forever waiting for a y/n it can't get.
_PNPM_FLAGS = ["--config.verify-deps-before-run=false", "--config.confirm-modules-purge=false"]
PNPM = ["pnpm", *_PNPM_FLAGS]
CAP = ["pnpm", *_PNPM_FLAGS, "--dir", "web", "exec", "cap"]

# `pnpm install` does its real work but pnpm 11 still exits 1 whenever a package
# has an un-approved build script — here the repo's @bufbuild/buf, a Bazel-side
# codegen tool the iOS build never needs. The workspace approve/ignore lists are
# Bazel-coupled (see pnpm-workspace.yaml's allowBuilds), so rather than touch
# shared config we run install and swallow that ONE benign exit — but only when
# ERR_PNPM_IGNORED_BUILDS is the SOLE pnpm error; any other ERR_PNPM still fails.
_INSTALL_SH = (
    f"set -o pipefail; log=$(mktemp); pnpm {' '.join(_PNPM_FLAGS)} install 2>&1 | tee \"$log\"; "
    "rc=${PIPESTATUS[0]}; "
    'if [ "$rc" -ne 0 ] && grep -q ERR_PNPM_IGNORED_BUILDS "$log" '
    '&& [ "$(grep -c ERR_PNPM "$log")" -eq 1 ]; then '
    'echo "[ios-build] install: sole error is ERR_PNPM_IGNORED_BUILDS '
    '(@bufbuild/buf, unused by iOS) — treating as success"; rc=0; fi; '
    'rm -f "$log"; exit $rc'
)

# Web app build via Bazel (rules_js), NOT raw `pnpm build`: node deps resolve
# hermetically from pnpm-lock.yaml, so a new app dependency (e.g. jsqr) is fetched
# by Bazel with no host `pnpm install`. `//web:ios_payload` is the complete payload
# (vite bundle + the four WASM bundles staged in), so this ALSO folds in what
# stage-wasm used to do. It lands read-only in bazel-bin/web/ios_payload; copy into
# web/dist where `cap sync` reads it (webDir: "dist").
#
# This task exists for the container/iosctl path (the server builds the app). The
# `bazel run //tools:ios_deploy` path never calls it — there the payload is a label
# dep of //tools:ios_deploy, built by that outer run and staged by ios_deploy, so
# Bazel is not re-invoked. --output_base is a DEDICATED base (child_env's
# IOS_BAZEL_OUTPUT_BASE) so an iosctl run against a `bazel run`-started server can't
# deadlock on the outer server lock.
_WEB_BUILD_SH = (
    "set -e; "
    ': "${IOS_BAZEL_OUTPUT_BASE:=$HOME/.cache/ledmapper-ios-bazel}"; '
    'echo "[web-build] bazelisk --output_base=$IOS_BAZEL_OUTPUT_BASE build //web:ios_payload"; '
    'bazelisk --output_base="$IOS_BAZEL_OUTPUT_BASE" build //web:ios_payload; '
    'src="bazel-bin/web/ios_payload"; '
    '[ -d "$src" ] || { echo "[web-build] $src missing after build" >&2; exit 1; }; '
    "rm -rf web/dist; mkdir -p web/dist; "
    'cp -RL "$src"/. web/dist/; '
    "chmod -R u+w web/dist; "
    'echo "[web-build] staged $src -> web/dist"'
)

# xcodebuild container select — App.xcworkspace (CocoaPods) if present, else the
# App.xcodeproj that Capacitor 8's SPM integration produces. Placeholders are
# filled by _fill (literal token replace), so the `{scheme}`/`{configuration}`/
# `{sim}` tokens survive into the command while `$C` etc. are left alone.
_IOS_BUILD_SH = (
    "set -e; "
    'if [ -e App.xcworkspace ]; then C="-workspace App.xcworkspace"; '
    'else C="-project App.xcodeproj"; fi; '
    'echo "[ios-build] xcodebuild $C -scheme {scheme} -configuration {configuration}"; '
    # Generic simulator destination — a compile check needs no specific/booted
    # device, so this is immune to which simulators the host has installed (a
    # named device that doesn't exist is a hard xcodebuild error). ios-run/launch
    # still target a concrete `--sim` since they actually boot + install.
    "xcodebuild $C -scheme {scheme} -configuration {configuration} "
    '-sdk iphonesimulator -destination "generic/platform=iOS Simulator" build'
)

# Device build (a real iPhone) — mirrors _IOS_BUILD_SH but targets the iphoneos
# SDK and writes to a fixed -derivedDataPath so `device-install` can find the
# signed .app. `generic/platform=iOS` builds WITHOUT the device attached (only
# install + launch need it), which keeps this robust over a flaky Wi-Fi link;
# `-allowProvisioningUpdates` lets automatic signing register/refresh the
# provisioning profile — the same signing `cap run` already set up over USB.
_DEVICE_BUILD_SH = (
    "set -e; "
    'if [ -e App.xcworkspace ]; then C="-workspace App.xcworkspace"; '
    'else C="-project App.xcodeproj"; fi; '
    'echo "[device-build] xcodebuild $C -scheme {scheme} -configuration {configuration} -sdk iphoneos"; '
    "xcodebuild $C -scheme {scheme} -configuration {configuration} "
    '-sdk iphoneos -destination "generic/platform=iOS" '
    "-derivedDataPath build -allowProvisioningUpdates build"
)


def _tasks() -> dict:
    return {
        "install": {
            "argv": ["bash", "-c", _INSTALL_SH],
            "cwd": ".",
            "desc": "pnpm install — pull Capacitor deps (tolerates the buf ignored-build gate)",
        },
        "web-build": {
            "argv": ["bash", "-c", _WEB_BUILD_SH],
            "cwd": ".",
            "desc": "bazel build //web:dist (hermetic node deps) -> web/dist",
        },
        "cap-add-ios": {
            "argv": [*CAP, "add", "ios"],
            "cwd": ".",
            "desc": "cap add ios — ONE-TIME: generate the native web/ios/App project",
        },
        "ios-config": {
            "argv": ["bash", "web/ios-config/apply.sh"],
            "cwd": ".",
            "needs_ios": True,
            "desc": "apply hand-maintained Info.plist usage strings to the fresh project",
        },
        "stage-wasm": {
            "argv": ["bash", "tools/stage_ios_wasm.sh"],
            "cwd": ".",
            "desc": "build + stage the solver/pulse/fx-compiler/fx-vm WASM into web/dist "
            "(the wrapper has no backend to serve them). Run AFTER web-build.",
        },
        "cap-sync": {
            "argv": [*CAP, "sync", "ios"],
            "cwd": ".",
            "desc": "cap sync ios — copy web/dist + resolve plugins (SPM in Cap 8)",
        },
        "pod-install": {
            "argv": ["pod", "install"],
            "cwd": "web/ios/App",
            "needs_ios": True,
            "desc": "pod install (only for a CocoaPods setup; Cap 8 uses SPM)",
        },
        "ios-build": {
            # Capacitor 8 uses Swift Package Manager → an App.xcodeproj (no Pods,
            # no App.xcworkspace). Pick -workspace only if one exists (older Pods
            # setups), else -project; xcodebuild resolves SPM deps on build.
            "argv": ["bash", "-c", _IOS_BUILD_SH],
            "cwd": "web/ios/App",
            "needs_ios": True,
            "desc": "xcodebuild build for the simulator (SPM or Pods; no launch)",
        },
        "ios-run": {
            "argv": [*CAP, "run", "ios", "--target", "{target}"],
            "cwd": ".",
            "needs_ios": True,
            "desc": "cap run ios — build + launch on --target (sim name, device name, or UDID)",
        },
        # Wireless device deploy (device-build → device-install → device-launch,
        # or the `deploy-device` chain). These go through devicectl (CoreDevice),
        # which reaches a device over USB *or* Wi-Fi — unlike `cap run`/native-run
        # (ios-run), whose device discovery can't see network-connected devices.
        "device-build": {
            "argv": ["bash", "-c", _DEVICE_BUILD_SH],
            "cwd": "web/ios/App",
            "needs_ios": True,
            "desc": "xcodebuild a signed device .app (iphoneos SDK) for wireless deploy",
        },
        "device-install": {
            # Product path matches device-build's -derivedDataPath (relative to cwd).
            "argv": [
                "xcrun",
                "devicectl",
                "device",
                "install",
                "app",
                "--device",
                "{target}",
                "build/Build/Products/{configuration}-iphoneos/App.app",
            ],
            "cwd": "web/ios/App",
            "needs_ios": True,
            "desc": "install the device .app on {target} over USB/Wi-Fi (devicectl)",
        },
        "device-launch": {
            "argv": [
                "xcrun",
                "devicectl",
                "device",
                "process",
                "launch",
                "--terminate-existing",
                "--device",
                "{target}",
                "{bundle}",
            ],
            "cwd": ".",
            "desc": "launch {bundle} on {target} over USB/Wi-Fi (devicectl; no console)",
        },
        "list-devices": {
            "argv": ["xcrun", "xctrace", "list", "devices"],
            "cwd": ".",
            "desc": "list connected devices + simulators (names + UDIDs for --target)",
        },
        "device-log": {
            # Relaunch the app on the device with its stdout/stderr streamed back
            # (print() from native code, and Capacitor's forwarded JS console).
            # Streams until the client disconnects — run in the background and stop.
            "argv": [
                "xcrun",
                "devicectl",
                "device",
                "process",
                "launch",
                "--console",
                "--terminate-existing",
                "--device",
                "{target}",
                "{bundle}",
            ],
            "cwd": ".",
            "desc": "relaunch {bundle} on {target}, streaming its console (logs) back",
        },
        "open-xcode": {
            "argv": [*CAP, "open", "ios"],
            "cwd": ".",
            "needs_ios": True,
            "desc": "cap open ios — open the project in Xcode on the host",
        },
        "list-sims": {
            "argv": ["xcrun", "simctl", "list", "devices", "available"],
            "cwd": ".",
            "desc": "list bootable simulator devices",
        },
    }


# Convenience chains — each expands to a stop-on-failure sequence of tasks above.
# No pod-install: Capacitor 8 resolves iOS deps via Swift Package Manager, so
# `cap sync` is the whole story (pod-install stays available for Pods setups).
# web-build now produces the COMPLETE payload (//web:ios_payload folds in the WASM
# that stage-wasm used to stage), so stage-wasm is no longer in the chains — it
# stays available as a standalone task for manual use.
CHAINS = {
    "bootstrap": ["install", "web-build", "cap-add-ios", "ios-config", "cap-sync"],
    "rebuild": ["web-build", "cap-sync", "ios-build"],
    "launch": ["web-build", "cap-sync", "ios-run"],
    # Wireless-capable device deploy: like `launch` but the last three steps go
    # through devicectl (USB or Wi-Fi) instead of `cap run` (USB only). Needs
    # &target=<device UDID>.
    "deploy-device": ["web-build", "cap-sync", "device-build", "device-install", "device-launch"],
    # Same as deploy-device, but the final step relaunches with the console
    # attached (device-log) so the app's stdout/stderr + forwarded JS console
    # stream back until the client disconnects.
    "deploy-device-log": ["web-build", "cap-sync", "device-build", "device-install", "device-log"],
    # PREBUILT variants: the caller already staged web/dist (the payload is a label
    # dep it built), so skip web-build. This is what `bazel run //tools:ios_deploy`
    # uses — no Bazel re-invocation on the server.
    "deploy-prebuilt": ["cap-sync", "device-build", "device-install", "device-launch"],
    "deploy-prebuilt-log": ["cap-sync", "device-build", "device-install", "device-log"],
}

# Query params we allow into argv templates, with the pattern each must match.
# Kept strict so a template substitution can never inject a shell/argv surprise
# (argv is passed to Popen without a shell, but validate anyway — defence in depth).
_PARAM_RE = {
    # `target` is what `cap run ios --target` accepts: a simulator name, a device
    # name, or a device UDID (hex + dashes on modern iPhones). Apostrophes/spaces
    # in device names are fine — argv is exec'd without a shell — but stay bounded.
    "target": re.compile(r"^[A-Za-z0-9 '._:()+-]{1,80}$"),
    "scheme": re.compile(r"^[A-Za-z0-9_.-]{1,64}$"),
    "configuration": re.compile(r"^[A-Za-z0-9_.-]{1,32}$"),
    "bundle": re.compile(r"^[A-Za-z0-9._-]{1,80}$"),
}
_PARAM_DEFAULT = {
    "target": "iPhone 17",
    "scheme": "App",
    "configuration": "Debug",
    "bundle": "dev.splanc.app",
}


def _params(q: dict) -> dict:
    out = dict(_PARAM_DEFAULT)
    for k, rx in _PARAM_RE.items():
        v = q.get(k, [None])[0]
        if v is None:
            continue
        if not rx.match(v):
            raise ValueError(f"invalid value for {k!r}: {v!r}")
        out[k] = v
    return out


def _fill(argv: list[str], params: dict) -> list[str]:
    # Literal token replace (not str.format): only the exact `{sim}`/`{scheme}`/
    # `{configuration}` placeholders are substituted, leaving any other braces —
    # e.g. `${PIPESTATUS[0]}` in the install script — untouched.
    out = []
    for a in argv:
        for k, v in params.items():
            a = a.replace("{" + k + "}", v)
        out.append(a)
    return out


# --------------------------------------------------------------------------- #
# Toolchain / project introspection
# --------------------------------------------------------------------------- #
def _ver(argv: list[str]) -> str:
    exe = shutil.which(argv[0])
    if not exe:
        return "not found"
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=30, cwd=CFG["workspace"])
        return (
            (out.stdout or out.stderr).strip().splitlines()[0]
            if (out.stdout or out.stderr)
            else "(no output)"
        )
    except Exception as e:  # noqa: BLE001
        return f"error: {e}"


def doctor_report() -> str:
    ws = Path(CFG["workspace"])

    def state(exists: bool, missing_hint: str) -> str:
        return "present" if exists else missing_hint

    dist = state((ws / "web" / "dist" / "index.html").exists(), "MISSING (run web-build)")
    capcfg = state((ws / "web" / "capacitor.config.ts").exists(), "MISSING")
    proj = state(_ios_project_exists(), "MISSING (run cap-add-ios)")
    lines = [
        "Splanc iOS build server — toolchain & project state",
        f"  workspace     : {ws}",
        "",
        "  toolchain:",
        f"    node        : {_ver(['node', '--version'])}",
        f"    pnpm        : {_ver(['pnpm', '--version'])}",
        f"    cap (cli)   : {_ver(['pnpm', '--dir', 'web', 'exec', 'cap', '--version'])}",
        f"    xcodebuild  : {_ver(['xcodebuild', '-version'])}",
        f"    cocoapods   : {_ver(['pod', '--version'])}",
        f"    simctl      : {'present' if shutil.which('xcrun') else 'not found'}",
        "",
        "  project state:",
        f"    web/dist            : {dist}",
        f"    capacitor.config.ts : {capcfg}",
        f"    web/ios/App project : {proj}",
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "ios-build-server/1.0"

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def log_message(self, fmt: str, *args) -> None:
        _log("%s - %s" % (self.address_string(), fmt % args))

    # -- helpers ------------------------------------------------------------ #
    def _write(self, data) -> bool:
        if isinstance(data, str):
            data = data.encode("utf-8", "replace")
        try:
            self.wfile.write(data)
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def _begin_stream(self, content_type: str = "text/plain; charset=utf-8") -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _text(self, text: str, code: int = 200) -> None:
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _dispatch(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        q = urllib.parse.parse_qs(parsed.query)

        # Optional shared-secret gate (CFG['token']); off by default, matching
        # flash_server's host-only-LAN posture. When set, require ?token= or the
        # X-Build-Token header on anything that runs a task.
        try:
            if route == "/":
                self._usage()
            elif route == "/tasks":
                self._json({"tasks": _tasks(), "chains": CHAINS})
            elif route == "/doctor":
                if not self._auth(q):
                    return
                self._text(doctor_report())
            elif route == "/run":
                if not self._auth(q):
                    return
                self._run(q.get("task", [""])[0], q)
            else:
                self._text(f"no such endpoint: {route}\n", 404)
        except ValueError as e:
            self._text(f"error: {e}\n", 400)
        except Exception as e:  # noqa: BLE001
            self._text(f"error: {e}\n", 500)

    def _auth(self, q: dict) -> bool:
        want = CFG.get("token")
        if not want:
            return True
        got = q.get("token", [None])[0] or self.headers.get("X-Build-Token")
        if got == want:
            return True
        self._text("error: bad or missing build token\n", 403)
        return False

    # -- endpoints ---------------------------------------------------------- #
    def _usage(self) -> None:
        self._text(
            f"{__doc__}\n"
            f"workspace : {CFG['workspace']}\n"
            f"tasks     : {', '.join(_tasks())}\n"
            f"chains    : {', '.join(CHAINS)}\n"
        )

    def _run(self, task_arg: str, q: dict) -> None:
        if not task_arg:
            self._text("error: /run needs ?task=NAME (see /tasks)\n", 400)
            return
        # Expand chains and comma-lists into a flat task sequence.
        seq: list[str] = []
        for name in task_arg.split(","):
            name = name.strip()
            if not name:
                continue
            if name == "doctor":
                seq.append("doctor")
            elif name in CHAINS:
                seq.extend(CHAINS[name])
            else:
                seq.append(name)

        tasks = _tasks()
        for name in seq:
            if name != "doctor" and name not in tasks:
                self._text(f"error: unknown task {name!r} (see /tasks)\n", 400)
                return

        params = _params(q)  # validates; raises ValueError → 400
        # Device builds default to Release, simulator builds stay Debug.
        # Swift compiled -Onone is 10-100x slower, and the native capture path's
        # per-pixel reduction runs 30x/s on real hardware — a Debug device build
        # once looked like a 1.7fps architectural failure when it was purely the
        # optimizer being off. Nothing on-device is timed meaningfully in Debug,
        # so pay the compile cost by default and let --configuration override.
        if "configuration" not in q and any(n.startswith("device-") for n in seq):
            params["configuration"] = "Release"
            self_note = True
        else:
            self_note = False

        self._begin_stream()
        if self_note:
            self._write(
                "[ios-build] configuration=Release (device build default; "
                "pass --configuration Debug to override)\n"
            )
        self._write(
            f"[ios-build] workspace={CFG['workspace']}\n[ios-build] plan: {' → '.join(seq)}\n\n"
        )
        for name in seq:
            if name == "doctor":
                self._write(doctor_report() + "\n")
                continue
            rc = self._run_one(name, tasks[name], params)
            if rc != 0:
                self._write(f"\n[ios-build] task {name!r} failed (exit {rc}); stopping.\n")
                return
        self._write("\n[ios-build] all tasks OK.\n")

    def _run_one(self, name: str, task: dict, params: dict) -> int:
        cwd = str(Path(CFG["workspace"]) / task.get("cwd", "."))
        if task.get("needs_ios") and not _ios_project_exists():
            self._write(
                f"[ios-build] {name}: no native project yet — run 'cap-add-ios' "
                "(or the 'bootstrap' chain) first.\n"
            )
            return 1
        argv = _fill(task["argv"], params)
        self._write(f"[ios-build] $ {' '.join(argv)}\n[ios-build]   cwd={cwd}\n\n")
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                stdin=subprocess.DEVNULL,  # no TTY over HTTP — any prompt gets EOF
                # and the tool takes its default instead of hanging forever.
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=child_env(),
                bufsize=1,
                text=True,
            )
        except OSError as e:
            self._write(f"[ios-build] cannot launch {argv[0]!r}: {e}\n")
            return 127
        assert proc.stdout is not None
        for line in proc.stdout:
            if not self._write(line):
                proc.terminate()  # client hung up — abort the build
                return 130
        rc = proc.wait()
        self._write(f"\n[ios-build] {name}: exit {rc}\n")
        return rc


def child_env() -> dict:
    """Strip bazel-injected vars so a task's own tooling starts from a clean env."""
    env = dict(os.environ)
    for k in list(env):
        if k.startswith(("BAZEL", "TEST_", "RUNFILES", "BUILD_WORK")) or k in (
            "JAVA_RUNFILES",
            "RUN_UNDER_RUNFILES",
        ):
            env.pop(k, None)
    # Capacitor/CocoaPods want a UTF-8 locale and a HOME; inherit the host's.
    env.setdefault("LANG", "en_US.UTF-8")
    # Silence the Capacitor CLI's first-run telemetry question so `cap add ios`
    # never waits on a prompt (belt-and-suspenders with stdin=DEVNULL).
    env.setdefault("CAP_DISABLE_TELEMETRY", "true")
    # Dedicated Bazel output base for the nested web-build / stage-wasm builds, so
    # they don't contend for the server lock an outer `bazel run //tools:ios_deploy`
    # (the sidecar's parent) holds — that would deadlock. web-build reads this;
    # stage_ios_wasm.sh passes it through as --output_base when set. (Name doesn't
    # start with BAZEL_, so the strip loop above leaves it alone.)
    env.setdefault("IOS_BAZEL_OUTPUT_BASE", os.path.expanduser("~/.cache/ledmapper-ios-bazel"))
    return env


def _lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Host Capacitor/Xcode build helper for Splanc iOS.")
    ap.add_argument(
        "--host",
        default="0.0.0.0",
        help="bind address (default 0.0.0.0 so the container can reach it)",
    )
    ap.add_argument("--port", type=int, default=8099, help="HTTP port (default 8099)")
    ap.add_argument(
        "--workspace",
        default=_default_workspace(),
        help="repo root to build in (default: this checkout)",
    )
    ap.add_argument(
        "--token",
        default=os.environ.get("IOS_BUILD_TOKEN"),
        help="optional shared secret; when set, /run and /doctor require it "
        "(?token= or X-Build-Token). Default: $IOS_BUILD_TOKEN or none.",
    )
    args = ap.parse_args()

    CFG.update(workspace=str(Path(args.workspace).resolve()), token=args.token)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    lan = _lan_ip()
    _log(f"ios-build-server on {args.host}:{args.port}  (workspace {CFG['workspace']})")
    _log("  from the container:  tools/iosctl doctor")
    _log(f"  or:                  curl -N host.docker.internal:{args.port}/doctor")
    _log(f"  on the LAN:          http://{lan}:{args.port}/")
    if args.token:
        _log("  token auth: ON (pass ?token= or X-Build-Token)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("\nbye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
