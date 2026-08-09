#!/usr/bin/env python3
"""Run the HITL harness suite on a tailnet-connected host, driven over HTTP.

The dev container can reach the tailnet but its DUTs kept dropping WiFi, so the
on-hardware suite is flaky there. Run THIS on a machine where the rigs work (a
laptop on the tailnet), and curl it from anywhere to run the tests one at a time:

    python3 pi/hitl/scripts/hitl_shim.py           # binds 0.0.0.0:8091
    #   (or:  bazel run //pi/hitl:hitl_shim )

    curl        http://<host>:8091/                # usage + targets + defaults
    curl -N     http://<host>:8091/run?target=e2e  # run one, stream output
    curl -N    'http://<host>:8091/run?target=map_upload&server=hitl-rig-1'
    curl -N    'http://<host>:8091/run?target=rename_wss&args=--device-ws wss://10.0.0.5/ws'
    curl -N     http://<host>:8091/runall          # every target, in order

Each /run shells out to `bazel run -c opt //pi/hitl/harness:<target> -- <args>`
in the repo, streaming combined stdout/stderr and finishing with the exit code
(0 = pass). The five harness py_tests all run bare now; args are overridable per
request:

    ?target=  short name (e2e) or a full //label
    ?args=    shell-split; REPLACES the target's defaults (appended after `--`)
    ?extra=   shell-split; APPENDED to whatever args are used
    ?server=  convenience → `--server <rig>` (unless already present)

One run at a time (the bench is shared); a second /run gets 503 while busy.
Endpoints answer GET or POST so netcat works too. Stdlib only — no deps.
"""

from __future__ import annotations

import argparse
import os
import shlex
import socket
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Short name -> the harness label + any default args. All five run bare now (the
# wss tests default to accepting the self-signed cert; fx_bench defaults its
# output to the sandbox and checks against its golden), so these are empty —
# kept as the hook for per-target defaults, and everything is overridable per
# request anyway.
HARNESS = "//pi/hitl/harness"
TARGETS: dict[str, list[str]] = {
    "e2e": [],  # reserve -> flash -> improv -> time-sync + rename
    "map_upload": [],  # wss sharded upload + read-back
    "mapping_trigger": [],  # reserve -> flash -> mapping-sequence trigger
    "fx_bench": [],  # calibration sweep + golden margin check
    "rename_wss": [],  # rename -> wss stays up
}
# The order /runall uses (fast/foundational first).
ORDER = ["e2e", "map_upload", "mapping_trigger", "rename_wss", "fx_bench"]

CFG: dict = {}
_RUN_LOCK = threading.Lock()


def _log(msg: str) -> None:
    print(msg, flush=True)


def _default_workspace() -> str:
    # Under `bazel run` the launcher sets $BUILD_WORKSPACE_DIRECTORY to the real
    # checkout; as a plain script fall back to the repo root above this file.
    return os.environ.get("BUILD_WORKSPACE_DIRECTORY") or str(Path(__file__).resolve().parents[3])


def child_env() -> dict:
    # Strip anything a wrapping `bazel run` injected so the nested bazel starts
    # from a clean environment.
    env = dict(os.environ)
    for k in list(env):
        if k.startswith(("BAZEL", "TEST_", "RUNFILES", "BUILD_WORK")) or k in (
            "JAVA_RUNFILES",
            "RUN_UNDER_RUNFILES",
        ):
            env.pop(k, None)
    return env


def resolve_label(target: str) -> str:
    """Short name (e2e) or a full //label -> a //pi/hitl/harness label."""
    if target.startswith("//") or target.startswith("@"):
        return target
    if target in TARGETS:
        return f"{HARNESS}:{target}"
    raise KeyError(target)


def build_args(target: str, args: str | None, extra: str | None, server: str | None) -> list[str]:
    """The args to pass after `--`: explicit ?args override the defaults; ?extra
    appends; ?server adds --server unless already present."""
    if args is not None:
        final = shlex.split(args)
    else:
        final = list(TARGETS.get(target, []))
    if extra:
        final += shlex.split(extra)
    if server and "--server" not in final:
        final += ["--server", server]
    return final


class Handler(BaseHTTPRequestHandler):
    server_version = "hitl-shim/1.0"

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def log_message(self, fmt: str, *args) -> None:
        _log("%s - %s" % (self.address_string(), fmt % args))

    def _write(self, data) -> bool:
        if isinstance(data, str):
            data = data.encode("utf-8", "replace")
        try:
            self.wfile.write(data)
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def _begin_stream(self) -> None:
        # HTTP/1.0 default: no Content-Length, body streams until we close —
        # exactly what `curl -N` / netcat want.
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _text(self, text: str, code: int = 200) -> None:
        body = text.encode("utf-8", "replace")
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

        def get(k, d=None):
            return q.get(k, [d])[0]

        try:
            if route == "/":
                self._usage()
            elif route == "/run":
                self._run(get("target"), get("args"), get("extra"), get("server"))
            elif route == "/runall":
                self._runall(get("server"))
            else:
                self._text(f"no such endpoint: {route}\n", 404)
        except KeyError as e:
            self._text(f"unknown target {e}; known: {', '.join(TARGETS)}\n", 404)
        except Exception as e:  # noqa: BLE001 — report anything to the client
            self._text(f"error: {e}\n", 500)

    def _usage(self) -> None:
        lines = [__doc__ or "", ""]
        lines.append(f"workspace : {CFG['workspace']}")
        lines.append(f"bazel     : {CFG['bazel']} {' '.join(CFG['bazel_args'])}")
        lines.append("targets   :")
        for name in ORDER:
            lines.append(f"  {name:<16} default args: {' '.join(TARGETS[name]) or '(none)'}")
        self._text("\n".join(lines) + "\n")

    def _bazel_cmd(self, label: str, run_args: list[str]) -> list[str]:
        return [CFG["bazel"], "run", *CFG["bazel_args"], label, "--", *run_args]

    def _stream_one(self, target: str, run_args: list[str]) -> int:
        label = resolve_label(target)
        cmd = self._bazel_cmd(label, run_args)
        self._write(f"[hitl-shim] $ {' '.join(shlex.quote(c) for c in cmd)}\n")
        self._write(f"[hitl-shim]   cwd={CFG['workspace']}\n\n")
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=CFG["workspace"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=child_env(),
                bufsize=1,
                text=True,
            )
        except OSError as e:
            self._write(f"[hitl-shim] cannot launch '{CFG['bazel']}': {e}\n")
            return 127
        assert proc.stdout is not None
        for line in proc.stdout:
            if not self._write(line):
                proc.terminate()  # client hung up — abort the run
                proc.wait()
                return 130
        rc = proc.wait()
        self._write(f"\n[hitl-shim] {target} exit {rc}\n")
        return rc

    def _run(self, target, args, extra, server) -> None:
        if not target:
            self._text(
                f"usage: /run?target=<{'|'.join(TARGETS)}>[&args=..&extra=..&server=..]\n", 400
            )
            return
        resolve_label(target)  # validate (raises KeyError -> 404)
        run_args = build_args(target, args, extra, server)
        if not _RUN_LOCK.acquire(blocking=False):
            self._text("busy: a HITL run is already in progress (the bench is shared)\n", 503)
            return
        try:
            self._begin_stream()
            self._stream_one(target, run_args)
        finally:
            _RUN_LOCK.release()

    def _runall(self, server) -> None:
        if not _RUN_LOCK.acquire(blocking=False):
            self._text("busy: a HITL run is already in progress (the bench is shared)\n", 503)
            return
        try:
            self._begin_stream()
            results: list[tuple[str, int]] = []
            for name in ORDER:
                self._write(f"\n===== {name} =====\n")
                rc = self._stream_one(name, build_args(name, None, None, server))
                results.append((name, rc))
                if not self._write(""):  # client gone?
                    break
            self._write("\n[hitl-shim] summary:\n")
            for name, rc in results:
                self._write(f"  {name:<16} {'PASS' if rc == 0 else f'FAIL ({rc})'}\n")
        finally:
            _RUN_LOCK.release()


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
    ap = argparse.ArgumentParser(description="HITL harness runner, driven over HTTP.")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8091, help="HTTP port (default 8091)")
    ap.add_argument(
        "--workspace",
        default=_default_workspace(),
        help="repo root to run bazel in (default: $BUILD_WORKSPACE_DIRECTORY or the checkout)",
    )
    ap.add_argument(
        "--bazel", default=os.environ.get("BAZEL", "bazel"), help="bazel/bazelisk binary"
    )
    ap.add_argument(
        "--bazel-arg",
        action="append",
        default=None,
        help="bazel arg before the target (repeatable; default matches the CI HITL job)",
    )
    args = ap.parse_args()

    CFG.update(
        workspace=args.workspace,
        bazel=args.bazel,
        # Match .github/workflows/hitl.yaml: -c opt, and serialize repo fetching
        # so the firmware build's Nix toolchains don't race the store's SQLite.
        bazel_args=(
            args.bazel_arg
            if args.bazel_arg is not None
            else [
                "-c",
                "opt",
                "--experimental_worker_for_repo_fetching=off",
                "--loading_phase_threads=1",
            ]
        ),
    )

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    lan = _lan_ip() if args.host in ("0.0.0.0", "::") else args.host
    _log(f"hitl-shim on http://{args.host}:{args.port}  (reachable: http://{lan}:{args.port})")
    _log(f"  workspace {CFG['workspace']}")
    _log(f"  bazel     {CFG['bazel']} {' '.join(CFG['bazel_args'])}")
    _log(f"  targets   {', '.join(ORDER)}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
