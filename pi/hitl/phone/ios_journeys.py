"""Automated iOS phone-HITL journeys — the CI rep on the Mac mini `ios-phone` unit
(real iPhone + real C6 `c6-c`, the Mac's hitl-reserved daemon on :8087).

The iOS counterpart of android_journeys: a thin, env-configured wrapper over the
reservation-driven runner (ios_reservation.py), which reserves the unit, ships the
phone harness + web app + solver + netstack bundle into the reserved session, and
runs phone_e2e ON THE MAC (the launchd ios-build-server signs, installs and launches
the Capacitor app on the iPhone). This process only orchestrates; a non-zero exit
from the remote phone_e2e (any journey failing) fails the test.

Tagged `hitl_ios` (NOT `hitl`) for the same reason Android is tagged `hitl_android`:
there is ONE iOS unit, so it must not ride along on every PR. The HITL workflow runs
it on every periodic (workflow_dispatch) run, and a PR opts in with the `hitl-ios`
label / a `[hitl-ios]` tag / an iOS-affecting path (see .github/workflows/hitl.yaml).

Knobs (env, so CI forwards them with --test_env; CLI args after `--` override):
  HITL_IOS_SERVER     Mac daemon            (default http://mac-mini:8087)
  HITL_IOS_JOURNEYS   comma list            (default: smoke)
  HITL_IOS_BLE_MODE   virtual | real        (default: virtual)
  HITL_IOS_FLASH_C6   1 = flash c6-c first  (needed by real-BLE connect+ journeys)

Run it:
  bazel test -c opt //pi/hitl/phone:ios_journeys
  bazel run  -c opt //pi/hitl/phone:ios_journeys -- --journeys smoke
"""

from __future__ import annotations

import os
import sys

import ios_reservation

DEFAULT_SERVER = "http://mac-mini:8087"
DEFAULT_JOURNEYS = "smoke"
DEFAULT_BLE_MODE = "virtual"


def ci_argv(env: dict[str, str], extra: list[str]) -> list[str]:
    """The ios_reservation argv for this CI rep: env-configured defaults, then any
    explicit CLI args (argparse keeps the LAST occurrence, so `extra` overrides)."""
    argv = [
        "--server",
        env.get("HITL_IOS_SERVER") or DEFAULT_SERVER,
        "--owner",
        env.get("HITL_OWNER") or "ios-ci",
        "--journeys",
        env.get("HITL_IOS_JOURNEYS") or DEFAULT_JOURNEYS,
        "--ble-mode",
        env.get("HITL_IOS_BLE_MODE") or DEFAULT_BLE_MODE,
    ]
    if env.get("HITL_IOS_FLASH_C6") == "1":
        argv.append("--flash-c6")
    return argv + extra


def main() -> int:
    argv = ci_argv(dict(os.environ), sys.argv[1:])
    print(f"[ios-journeys] ios_reservation {' '.join(argv)}", flush=True)
    return ios_reservation.main(argv)


if __name__ == "__main__":
    sys.exit(main())
