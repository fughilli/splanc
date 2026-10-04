"""Automated Android phone-HITL journeys — the CI rep that drives the REAL reserved
Samsung phone against a REAL ESP32-C6 end to end, with NO human.

This is the committed, unattended form of the ad-hoc bench scenario that first went
green by hand (flash → provision the C6 → put the phone on the C6's network → run the
user journeys over real Web Bluetooth + a real wss). It runs on the amd-rig PHONE
bench (a SECOND hitl-reserved daemon, :8088 — NOT the Pi pool and NOT amd-rig's SDR
daemon on :8087), which tailnet discovery never reaches (it defaults to :8087), so we
PIN the server and reserve the `android-phone` unit BY NAME.

Topology (why the journey runs IN the reservation env, not here):
  The phone is driven by a HOST adb server on amd-rig (--net-host) and sits on the
  amd-rig controlled AP (`amd-rig-ap`, hitl-amd-ap.nix); the C6 is provisioned onto
  the same AP, so the phone reaches it at the IP in its self-signed cert (intra-BSS
  forwarding is open). The app's http + driver-WS ports are `adb reverse`d to the
  phone. All of that must be co-located with the phone — so `phone_e2e` runs in the
  reservation env over ssh; THIS process only orchestrates (reserve, flash,
  provision, kick the in-env run, parse, release).

Flow:
  1. Reserve `android-phone` on the pinned phone daemon (c6-a + the Samsung phone).
  2. Ship the phone harness + web app + solver + netstack flash bundle into the env.
  3. hitl-flash c6-a with the netstack player (unless --no-flash), with strap-retry.
  4. wire_provision_dut: serial-provision c6-a onto amd-rig-ap (reliable baseline —
     a deterministic DHCP IP for --device-ws, independent of the phone chooser).
  5. Put the phone on amd-rig-ap (join_wifi over the Settings UI).
  6. Run phone_e2e in-env (--phone-target android-phone --ble-mode real): the journey
     does the REAL Web-Bluetooth provision + cert-trust via adb/uiautomator taps and
     then connect/config/mapping over the real wss. A flaky chooser can't fail the rep
     (provision_ble never raises; the DUT is already wire-provisioned + reachable).
  7. Parse the per-journey PASS lines; non-zero exit fails the test.

Run it:
  bazel test //pi/hitl/phone:android_journeys           # reserves amd-rig:8088
  bazel run  //pi/hitl/phone:android_journeys -- \
      --server http://amd-rig:8088 --journeys connect,config --no-flash
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

DEFAULT_SERVER = os.environ.get("HITL_ANDROID_SERVER") or "http://amd-rig:8088"
# The amd-rig controlled AP (hitl-amd-ap.nix). World-readable lab creds (not a secret),
# so they default here; override with --wifi-ssid/--wifi-pass for a different AP.
DEFAULT_SSID = os.environ.get("HITL_WIFI_SSID") or "amd-rig-ap"
DEFAULT_PSK = os.environ.get("HITL_WIFI_PASS") or "amd-rig-provision"
# connect → config → the two deep (synthetic-camera) mapping journeys. config +
# mapping_* each runFlow connect, so connect is exercised several times per run.
DEFAULT_JOURNEYS = "connect,config,mapping_capture,mapping_solve"

REMOTE_ROOT = "/tmp/hitl-android"  # where the shipped bundle lands in the env
# Launch the app EXPLICITLY in Chrome. The bench phone is debloated (Samsung Internet
# removed), so it has no default browser for an http VIEW intent — a bare `am start -d
# <url>` returns "unable to resolve Intent" and the app never loads. phone_target's
# _launch_argv adds `-n <component>` when HITL_ANDROID_BROWSER is set; point it at
# Chrome's IntentDispatcher (the same component android_ble_provision.accept_cert uses).
DEFAULT_BROWSER = (
    os.environ.get("HITL_ANDROID_BROWSER")
    or "com.android.chrome/com.google.android.apps.chrome.IntentDispatcher"
)


def _log(msg: str) -> None:
    print(msg, flush=True)


def _phone_src_dir() -> str:
    """The phone harness source dir (this file's dir in the runfiles tree) — carries
    phone_e2e.py + the driver/journey/target modules + journeys/."""
    return os.path.dirname(os.path.abspath(__file__))


def _runfile(path: str) -> str | None:
    try:
        from python.runfiles import runfiles  # type: ignore

        p = runfiles.Create().Rlocation(path)
        return p if p and os.path.exists(p) else None
    except Exception:  # noqa: BLE001
        return None


def _stage_bundle(include_flash: bool) -> str:
    """Assemble the in-env payload (phone harness + web app + solver + flash bundle)
    into a tar and return its local path. Shipped as one tar because scp(1) here has
    no -r and the phone image has no tar(1) (we extract with python in-env)."""
    stage = tempfile.mkdtemp(prefix="hitl-android-stage-")
    # phone harness (all of pi/hitl/phone, including journeys/)
    shutil.copytree(_phone_src_dir(), os.path.join(stage, "phone"))
    # web app + solver bundle (served to the phone's Chrome). The *_SRC env overrides
    # let the test run outside `bazel test` (point them at bazel-bin/… dirs) for a
    # local verification loop without building every data dep.
    web = os.environ.get("HITL_WEB_DIST_SRC") or _runfile("_main/web/dist")
    solver = os.environ.get("HITL_SOLVER_WEB_SRC") or _runfile("_main/solver/solver_web")
    if not web:
        raise SystemExit("web app not found in runfiles (//web:dist data dep missing)")
    shutil.copytree(web, os.path.join(stage, "web", "dist"))
    if solver:
        shutil.copytree(solver, os.path.join(stage, "solver", "solver_web"))
    else:
        _log("[stage] note: no //solver:solver_web — deep mapping on-device solve will 404")
    if include_flash:
        bundle = os.environ.get("HITL_BUNDLE_SRC") or _runfile(
            "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        )
        if not bundle:
            raise SystemExit("netstack flash bundle not found in runfiles")
        os.makedirs(os.path.join(stage, "fw"))
        shutil.copy(bundle, os.path.join(stage, "fw", "bundle.tar"))
    tar = tempfile.mktemp(prefix="hitl-android-", suffix=".tar")
    subprocess.run(["tar", "cf", tar, "-C", stage, "."], check=True)
    shutil.rmtree(stage, ignore_errors=True)
    return tar


def _ship(res, include_flash: bool) -> None:
    tar = _stage_bundle(include_flash)
    try:
        _log(f"[ship] staging bundle -> {res.host}:{REMOTE_ROOT}")
        res.ssh(f"rm -rf {REMOTE_ROOT} && mkdir -p {REMOTE_ROOT}")
        res.scp_to([tar], "/tmp/hitl-android-bundle.tar")
        # The phone image has python3 but no tar(1) — extract with python.
        res.ssh(
            'python3 -c "import tarfile; '
            f"tarfile.open('/tmp/hitl-android-bundle.tar').extractall('{REMOTE_ROOT}')\""
        )
    finally:
        try:
            os.unlink(tar)
        except OSError:
            pass


def _flash(res, monitor_seconds: float, attempts: int = 3) -> None:
    """hitl-flash c6-a with the shipped netstack bundle, retrying the C6's GPIO9
    USB_BOOT strap flake (mirrors reservation_backend._flash_dut)."""
    from provision import ensure_booted

    remote = f"{REMOTE_ROOT}/fw/bundle.tar"
    last = ""
    for attempt in range(1, attempts + 1):
        proc = res.ssh(
            f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}",
            capture=True,
            timeout=monitor_seconds + 180,
        )
        log = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode == 0:
            try:
                ensure_booted(res, log, monitor_seconds)
                _log(f"[flash] c6-a booted the netstack player (attempt {attempt})")
                return
            except Exception as e:  # noqa: BLE001 — a boot flake is retryable
                last = f"boot check: {e}"
        else:
            lines = log.strip().splitlines()
            last = lines[-1] if lines else f"exit {proc.returncode}"
        _log(f"[flash] attempt {attempt}/{attempts} failed ({last}) — retrying")
    raise SystemExit(f"hitl-flash failed after {attempts} attempts: {last}")


def _join_wifi(res, ssid: str, psk: str) -> None:
    """Put the phone on the C6's AP (Settings-UI taps, in-env where adb lives)."""
    _log(f"[wifi] joining the phone to {ssid!r}")
    cmd = (
        f"cd {REMOTE_ROOT}/phone && PYTHONPATH={REMOTE_ROOT}/phone "
        f"python3 android_ble_provision.py --mode join-wifi "
        f"--ssid {shlex.quote(ssid)} --password {shlex.quote(psk)}"
    )
    proc = res.ssh(cmd, capture=True, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    for line in out.splitlines():
        _log(f"[wifi] {line}")
    if "JOIN OK" not in out:
        _log("[wifi] join did not confirm — continuing (the phone may already be on the AP)")


def _run_journeys(
    res, device_ws: str, journeys: str, ble_mode: str, pin: str, ssid: str, psk: str
) -> list[str]:
    """Run phone_e2e in-env; return the list of journeys that PASSED (parsed from its
    '[phone] PASS <name>' lines). Raises SystemExit if the run errored."""
    env = (
        f"PYTHONPATH={REMOTE_ROOT}/phone "
        f"HITL_WEB_DIST={REMOTE_ROOT}/web/dist "
        f"HITL_SOLVER_WEB={REMOTE_ROOT}/solver/solver_web "
        f"HITL_ANDROID_BROWSER={shlex.quote(DEFAULT_BROWSER)} "
    )
    if pin:
        env += f"HITL_ANDROID_PIN={shlex.quote(pin)} "
    cmd = (
        f"cd {REMOTE_ROOT}/phone && {env}"
        f"python3 phone_e2e.py --phone-target android-phone --ble-mode {ble_mode} "
        f"--device-ws {shlex.quote(device_ws)} "
        f"--wifi-ssid {shlex.quote(ssid)} --wifi-pass {shlex.quote(psk)} "
        f"--journeys {shlex.quote(journeys)}"
    )
    _log(f"[journeys] running in-env: {journeys} (ble={ble_mode}) against {device_ws}")
    proc = res.ssh(cmd, capture=True, timeout=600)
    out = (proc.stdout or "") + (proc.stderr or "")
    passed: list[str] = []
    for line in out.splitlines():
        _log(f"[e2e] {line}")
        if line.startswith("[phone] PASS "):
            passed.append(line.split("[phone] PASS ", 1)[1].strip())
    if proc.returncode != 0:
        raise SystemExit(
            f"phone_e2e exited {proc.returncode}; journeys passed before failure: {passed}"
        )
    return passed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default=DEFAULT_SERVER, help="phone daemon (default amd-rig:8088)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER") or "android-ci")
    ap.add_argument("--unit", default="android-phone", help="unit to reserve by name")
    ap.add_argument(
        "--journeys", default=os.environ.get("HITL_ANDROID_JOURNEYS") or DEFAULT_JOURNEYS
    )
    ap.add_argument("--ble-mode", default="real", choices=["real", "virtual"])
    ap.add_argument("--wifi-ssid", default=DEFAULT_SSID)
    ap.add_argument("--wifi-pass", default=DEFAULT_PSK)
    ap.add_argument("--no-flash", action="store_true", help="skip hitl-flash (use c6-a's firmware)")
    ap.add_argument(
        "--device-ws",
        default="",
        help="skip flash + wire-provision and point the app at an ALREADY-reachable C6 "
        "wss (e.g. wss://192.168.60.141/ws) — a fast local loop on a provisioned DUT",
    )
    ap.add_argument("--monitor-seconds", type=float, default=8.0)
    # These exist only so `bazel test` can pass the fan-out args the other hitl tests
    # take; this test pins its own server/unit, so they're accepted and ignored.
    ap.add_argument("--sku", default="", help=argparse.SUPPRESS)
    ap.add_argument("--require-caps", default="", help=argparse.SUPPRESS)
    args = ap.parse_args()
    ssid, psk = args.wifi_ssid, args.wifi_pass
    pin = os.environ.get("HITL_ANDROID_PIN", "")

    from hitl_client import Reservation
    from provision import dut_target, wire_provision_dut

    _log(f"[reserve] {args.unit!r} on {args.server}")
    res = Reservation(server=args.server, owner=args.owner, device=args.unit)
    res.acquire()
    try:
        # --device-ws short-circuits flash + provision (the DUT is already reachable);
        # otherwise flash (unless --no-flash) and wire-provision c6-a onto the AP.
        include_flash = not args.no_flash and not args.device_ws
        _ship(res, include_flash=include_flash)
        if args.device_ws:
            device_ws = args.device_ws
            _log(f"[provision] skipped (--device-ws); using {device_ws}")
        else:
            if include_flash:
                _flash(res, args.monitor_seconds)
            else:
                _log("[flash] skipped (--no-flash); using c6-a's current firmware")
            _log(f"[provision] wire-provisioning c6-a onto {ssid!r} over serial…")
            redirect = wire_provision_dut(res, ssid, psk, timeout=120.0)
            host, _port = dut_target(redirect, "wss")
            device_ws = f"wss://{host}/ws"
            _log(f"[provision] c6-a reachable at {device_ws} (redirect {redirect})")

        _join_wifi(res, ssid, psk)
        # A beat for the phone's association + DHCP before the app dials the C6.
        time.sleep(5)

        want = [j for j in args.journeys.split(",") if j]
        passed = _run_journeys(res, device_ws, args.journeys, args.ble_mode, pin, ssid, psk)
        missing = [j for j in want if j not in passed]
        if missing:
            raise SystemExit(f"journeys did not all pass: missing {missing} (passed {passed})")
        _log(f"[android-journeys] ALL PASSED: {passed}")
    finally:
        res.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
