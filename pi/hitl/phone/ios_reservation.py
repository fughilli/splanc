#!/usr/bin/env python3
"""Reservation-driven iOS journey runner — drive the Mac iOS bench from the container.

This is the hands-off entrypoint the container/CI uses: it RESERVES the `ios-phone`
unit on the Mac over the tailnet (hitl_client.Reservation), ships the phone-HITL
harness + its data into the reserved (scoped-SSH) session, and runs `phone_e2e` ON
THE MAC. The Mac is where the station must run: the real iPhone reaches the served
app + driver WS over the LAN, and the launchd `ios-build-server` (hitl-darwin.nix)
builds/installs/launches the Capacitor app there. So the container is the
orchestrator; the Mac executes host-natively. No human runs anything on the Mac.

Mirrors the rig lane's "ship the harness into the reservation and run it with the
session's python" pattern (pi/hitl/harness/provision.py), adapted for the darwin
runner (no container — a scoped `ssh hitl@mac` session with python3+websockets,
node/pnpm/cap, esptool, devicectl on PATH; see nix/hitl-darwin.nix).

    bazel run //pi/hitl/phone:ios_reservation -- \
        --server http://mac-mini:8087 --journeys smoke --ble-mode virtual

Env markers the reserved session injects (per the catalog / darwin runner): the
iPhone UDID (HITL_IOS_UDID), the C6 adapter serial (HITL_ADAPTER_SERIAL) and the
signing keychain (HITL_SIGN_*, via the build server's env). Real device identifiers
stay OUT of this file — they come from the reservation, not the repo.
"""

from __future__ import annotations

import argparse
import os
import shlex
import sys
import tarfile
import tempfile

REMOTE_ROOT = "/tmp/hitl-ios"


def _runfile(rel: str) -> str | None:
    """Resolve a data dependency from runfiles (or the source tree when run directly)."""
    env = os.environ.get("HITL_" + rel.upper().replace("/", "_").replace(".", "_"))
    if env and os.path.exists(env):
        return env
    try:
        from python.runfiles import runfiles  # type: ignore

        p = runfiles.Create().Rlocation("_main/" + rel)
        if p and os.path.exists(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    # Fallback: relative to this file's repo location.
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", "..", ".."))
    cand = os.path.join(repo, rel)
    return cand if os.path.exists(cand) else None


# Payload manifest: (runfiles-relative source, arcname under REMOTE_ROOT). Everything
# here is OS-INDEPENDENT (python source, JSON, the JS/WASM web bundle, the ESP flash
# bundle), so a payload staged on linux runs unchanged on the Mac's python3.
def payload_manifest() -> list[tuple[str, str]]:
    return [
        # phone-HITL harness sources (the iOS lane's needs; stdlib + websockets only).
        ("pi/hitl/phone/phone_e2e.py", "phone_e2e.py"),
        ("pi/hitl/phone/driver_server.py", "driver_server.py"),
        ("pi/hitl/phone/journey_runner.py", "journey_runner.py"),
        ("pi/hitl/phone/phone_target.py", "phone_target.py"),
        ("pi/hitl/phone/launcher.py", "launcher.py"),
        ("pi/hitl/phone/journeys", "journeys"),
        # Dynamic C6 serial-port discovery (run in-session for flashing).
        ("pi/hitl/harness/serial_discovery.py", "serial_discovery.py"),
        # The built web app + solver deployment the station serves, and the firmware
        # bundle for flashing the C6 (connect+ journeys).
        ("web/dist", "web/dist"),
        ("solver/solver_web", "solver"),
        (
            "firmware/player_app/esp32c6_netstack_flashbundle.tar",
            "firmware/esp32c6_netstack_flashbundle.tar",
        ),
    ]


def stage_payload(dest_tar: str, resolve=_runfile, manifest=None) -> list[str]:
    """Tar the payload into dest_tar. Returns the arcnames actually included (a
    missing optional artifact — e.g. the solver bundle — is skipped, not fatal).
    Directories are added recursively; scp can't recurse, so we ship one tar."""
    manifest = manifest if manifest is not None else payload_manifest()
    included: list[str] = []
    # dereference: the payload is resolved from bazel runfiles, where the journey
    # JSONs (and other data) are SYMLINKS into the container's tree. Without following
    # them the tar carries dangling symlinks that don't exist on the Mac (seen live:
    # journeys/config.json -> FileNotFoundError). Follow them so real content ships.
    with tarfile.open(dest_tar, "w", dereference=True) as tar:
        for rel, arc in manifest:
            src = resolve(rel)
            if not src:
                continue
            tar.add(src, arcname=arc, recursive=True)
            included.append(arc)
    return included


def remote_run_cmd(
    station_ip_expr: str,
    journeys: str,
    ble_mode: str,
    build_port: int,
    ready_timeout: float,
    device_ws: str = "",
    extra: str = "",
) -> str:
    """The shell command run in the reserved Mac session to launch phone_e2e.

    - HITL_STATION_IP is resolved ON THE MAC to its own LAN IP (the iPhone reaches
      the station there); `station_ip_expr` is a shell expression producing it.
    - IOS_BUILD_SERVER points at the loopback launchd ios-build-server.
    - HITL_WEB_DIST / HITL_SOLVER_WEB point phone_e2e at the shipped artifacts so it
      needs no bazel/runfiles on the Mac.
    - HITL_IOS_UDID rides in from the reservation env (not set here).
    - PATH is prepended with the nix system profile bin so `python3` resolves to the
      nix-darwin pyEnv (which has websockets, needed by driver_server) rather than the
      system /usr/bin/python3 that the reserved session's PATH lists first.
    """
    env = [
        "PATH=/run/current-system/sw/bin:$PATH",
        f'HITL_STATION_IP="$({station_ip_expr})"',
        f"IOS_BUILD_SERVER=http://127.0.0.1:{build_port}",
        f"HITL_WEB_DIST={REMOTE_ROOT}/web/dist",
        f"HITL_SOLVER_WEB={REMOTE_ROOT}/solver",
        f"PYTHONPATH={REMOTE_ROOT}",
    ]
    args = [
        "python3",
        f"{REMOTE_ROOT}/phone_e2e.py",
        "--phone-target",
        "ios-phone",
        "--journeys",
        journeys,
        "--ready-timeout",
        str(ready_timeout),
    ]
    if ble_mode:
        args += ["--ble-mode", ble_mode]
    if device_ws:
        args += ["--device-ws", device_ws]
    if extra:
        args += shlex.split(extra)
    quoted = " ".join(shlex.quote(a) if a not in env else a for a in args)
    return f"set -e; cd {REMOTE_ROOT}; " + " ".join(env) + " " + quoted


# The LAN-IP probe: first non-empty of the common Wi-Fi/Ethernet services.
STATION_IP_EXPR = " || ".join(f"ipconfig getifaddr {i} 2>/dev/null" for i in ("en0", "en1", "en2"))


def discover_c6_cmd(serial_env: str = "$HITL_ADAPTER_SERIAL") -> str:
    """Command to resolve the reserved C6's serial port in-session (for flashing).

    Uses the nix pyEnv python (which has pyserial); the reserved session's bare
    `python3` is the system one on macOS and lacks it."""
    return (
        f"/run/current-system/sw/bin/python3 {REMOTE_ROOT}/serial_discovery.py "
        f'--serial {serial_env} --fallback "$HITL_ESP_PORT"'
    )


def _run(args: argparse.Namespace) -> int:
    import hitl_client  # noqa: E402  (harness dep; resolved via imports=["."])

    res = hitl_client.Reservation(
        server=args.server or os.environ.get("HITL_SERVER"),
        owner=args.owner,
        device="ios-phone",
    )
    res.acquire()
    try:
        # 1. Stage + ship the payload as one tar, unpack on the Mac.
        with tempfile.TemporaryDirectory() as td:
            tarpath = os.path.join(td, "hitl-ios-payload.tar")
            included = stage_payload(tarpath)
            print(f"[ios-res] payload: {', '.join(included)}", flush=True)
            # chmod +w before removing: the payload's web/dist + solver come from
            # read-only bazel runfiles, so a prior run's extracted tree has read-only
            # DIRS that a plain `rm -rf` can't clear ("Can't unlink … Permission
            # denied") — leaving stale files the next tar can't overwrite. Make it
            # writable first, and again after extraction so the next run can clean it.
            res.ssh(
                f"chmod -R u+w {REMOTE_ROOT} 2>/dev/null; rm -rf {REMOTE_ROOT}; "
                f"mkdir -p {REMOTE_ROOT}"
            )
            res.scp_to([tarpath], REMOTE_ROOT + "/")
            res.ssh(
                f"cd {REMOTE_ROOT} && tar xf hitl-ios-payload.tar && "
                f"rm -f hitl-ios-payload.tar && chmod -R u+w {REMOTE_ROOT}"
            )

        # 2. Confirm the C6 is discoverable dynamically (informational for smoke;
        #    required for connect+). Never fatal for the device-free smoke lane.
        c6 = res.ssh(discover_c6_cmd(), capture=True, timeout=60)
        port = (c6.stdout or "").strip()
        if port:
            print(f"[ios-res] C6 serial port (dynamic): {port}", flush=True)
        else:
            print(
                f"[ios-res] C6 port not resolved: {(c6.stderr or '').strip()}",
                flush=True,
            )

        # 3. Run phone_e2e on the Mac (streams output back to the container).
        cmd = remote_run_cmd(
            STATION_IP_EXPR,
            journeys=args.journeys,
            ble_mode=args.ble_mode,
            build_port=args.build_port,
            ready_timeout=args.ready_timeout,
            device_ws=args.device_ws,
        )
        print(f"[ios-res] running on the Mac:\n  {cmd}", flush=True)
        cp = res.ssh(cmd, capture=False, timeout=args.timeout)
        return cp.returncode
    finally:
        res.release()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--server",
        default=os.environ.get("HITL_SERVER"),
        help="pin the Mac daemon, e.g. http://mac-mini:8087",
    )
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--journeys", default="smoke", help="comma list (default: smoke)")
    ap.add_argument("--ble-mode", default="", choices=["", "virtual", "real"])
    ap.add_argument("--device-ws", default="", help="C6 wss URL for connect+ journeys")
    ap.add_argument(
        "--build-port", type=int, default=8099, help="loopback ios-build-server port on the Mac"
    )
    ap.add_argument("--ready-timeout", type=float, default=120.0)
    ap.add_argument("--timeout", type=float, default=1800.0, help="overall remote run timeout")
    args = ap.parse_args(argv)
    return _run(args)


if __name__ == "__main__":
    sys.exit(main())
