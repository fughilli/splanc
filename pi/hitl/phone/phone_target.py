"""Phone targets for the HITL station — bring the app up on a browser / emulator /
real device / iOS simulator, pointed at the app-driver control WS, so the SAME
journeys (journeys/*.json) run everywhere.

A `PhoneTarget` knows three things the journeys don't have to:

  1. **Reachability** — how the phone addresses the station's three local ports (the
     served app, the driver WS, and the forwarded device wss). `host_alias` is what
     the phone dials; `setup()` establishes the mapping (`adb reverse` for a USB
     Android device, nothing for the emulator's built-in `10.0.2.2`, the shared
     loopback for a simulator, the station LAN IP + usbmux for a real iPhone).
  2. **Launch** — how the app is opened at `?driver=…&ble=…` (a Playwright page, an
     `adb` VIEW intent, `simctl openurl`, or `devicectl` via tools/ios_build_server).
  3. **BLE mode** — `virtual` (app-seam mock, CI/emulator) or `real` (the device's OS
     BLE stack pairs with the real C6).

`phone_e2e` selects a target from `HITL_PHONE_TARGET` (exported by the reservation
env on a rig/Mac) or the `--browser`/`--android` flags. The real-device / simulator
targets build an explicit **command plan** (list of argv) so their behaviour is
unit-tested by dry-run without any hardware; only the run path shells out.
"""

from __future__ import annotations

import abc
import os
import subprocess
import sys
from dataclasses import dataclass, field


@dataclass
class StationPorts:
    """The three station-host ports the phone must reach."""

    http: int  # the served web app (SimpleHTTPRequestHandler)
    driver: int  # the app-driver control WS (driver_server)
    device: int = 0  # the forwarded device wss (0 = no device / same host)


class PhoneTarget(abc.ABC):
    """One place the app can run. Subclasses fill in reachability + launch."""

    #: stable id, also the HITL_PHONE_TARGET value (browser/android-emu/android-phone/…)
    name: str = "base"
    #: "virtual" (app-seam mock BLE) or "real" (device OS BLE stack)
    ble_mode: str = "virtual"

    @property
    def host_alias(self) -> str:
        """The host the PHONE dials to reach the station (from the phone's view)."""
        return "127.0.0.1"

    def command_plan(self, ports: StationPorts, app_url: str) -> list[list[str]]:
        """The argv commands `setup()` + `launch()` would run (for dry-run tests).
        Browser/in-process targets return []; device targets return their real argv."""
        return []

    def app_url(self, ports: StationPorts) -> str:
        """The URL to open on the phone: served app + `?driver=`(+`&ble=real`)."""
        alias = self.host_alias
        url = f"http://{alias}:{ports.http}/?driver=ws://{alias}:{ports.driver}/"
        if self.ble_mode == "real":
            url += "&ble=real"
        return url

    def rewrite_device_ws(self, device_ws: str) -> str:
        """Rewrite a `127.0.0.1` device wss to what the PHONE can reach. Default:
        map to host_alias (emulator/LAN); targets that reverse-forward keep loopback."""
        if not device_ws or self.host_alias == "127.0.0.1":
            return device_ws
        return device_ws.replace("127.0.0.1", self.host_alias).replace("localhost", self.host_alias)

    def setup(self, ports: StationPorts) -> None:
        """Establish reachability (e.g. `adb reverse`). Default: nothing needed."""

    async def launch(self, ports: StationPorts) -> None:
        """Bring the app up at `app_url(ports)`. Must be implemented per target."""
        raise NotImplementedError

    async def close(self) -> None:
        """Tear down (close the browser, stop the emulator, remove reverses)."""


# --- browser (CI; in this container) ----------------------------------------
class BrowserTarget(PhoneTarget):
    """Headless Chromium serving the built app — the CI lane (works in-container)."""

    name = "browser"
    ble_mode = "virtual"

    def __init__(self) -> None:
        self._pw = None
        self._browser = None

    async def launch(self, ports: StationPorts) -> None:
        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=True, args=["--no-sandbox", "--ignore-certificate-errors"]
        )
        page = await self._browser.new_page()
        if os.environ.get("PHONE_PAGE_LOG", "1") != "0":
            page.on("console", lambda m: print(f"[page:{m.type}] {m.text}", file=sys.stderr))
            page.on("pageerror", lambda e: print(f"[page:error] {e}", file=sys.stderr))
        await page.goto(self.app_url(ports))

    async def close(self) -> None:
        if self._browser is not None:
            await self._browser.close()
        if self._pw is not None:
            await self._pw.stop()


# --- Android (emulator + real device) ---------------------------------------
def _adb_prefix(resolve: bool = True) -> list[str]:
    """`adb` argv prefix, honoring HITL_ANDROID_SERIAL (a specific reserved device).
    `resolve=False` keeps a literal `adb` (for command plans / dry-run tests, no SDK
    needed); `resolve=True` resolves the real binary from the Nix SDK or PATH."""
    if resolve:
        from launcher import _sdk_tool

        adb = _sdk_tool("platform-tools", "adb")
    else:
        adb = "adb"
    serial = os.environ.get("HITL_ANDROID_SERIAL")
    return [adb, "-s", serial] if serial else [adb]


class AndroidEmulatorTarget(PhoneTarget):
    """A booted AVD; the app opens in the emulator's Chrome. The emulator reaches the
    station host at its built-in loopback alias 10.0.2.2 (no reverse needed)."""

    name = "android-emu"

    def __init__(self, ble_mode: str = "virtual") -> None:
        self.ble_mode = ble_mode
        self._emu = None

    @property
    def host_alias(self) -> str:
        return "10.0.2.2"

    def command_plan(self, ports: StationPorts, app_url: str = "") -> list[list[str]]:
        return [
            [
                "adb",
                "shell",
                "am",
                "start",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                app_url or self.app_url(ports),
            ],
        ]

    async def launch(self, ports: StationPorts) -> None:
        import launcher

        self._emu = launcher.boot_android_avd()
        launcher.adb(
            "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", self.app_url(ports)
        )

    async def close(self) -> None:
        if self._emu is not None:
            self._emu.terminate()


class AndroidDeviceTarget(PhoneTarget):
    """A real Android device on USB (adb). `adb reverse` maps the device's loopback to
    the station host, so the phone dials everything at 127.0.0.1 (reversed) — the
    served app, the driver WS, and the forwarded device wss. Real Web Bluetooth
    (Chrome) provisions the real C6, so ble=real."""

    name = "android-phone"
    ble_mode = "real"

    def __init__(self) -> None:
        self._reversed: list[int] = []

    @property
    def host_alias(self) -> str:
        return "127.0.0.1"  # via adb reverse

    def command_plan(self, ports: StationPorts, app_url: str = "") -> list[list[str]]:
        base = _adb_prefix(resolve=False)
        plan = [
            base + ["reverse", f"tcp:{p}", f"tcp:{p}"]
            for p in (ports.http, ports.driver, ports.device)
            if p
        ]
        plan.append(
            base
            + [
                "shell",
                "am",
                "start",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                app_url or self.app_url(ports),
            ]
        )
        return plan

    def setup(self, ports: StationPorts) -> None:
        for p in (ports.http, ports.driver, ports.device):
            if not p:
                continue
            subprocess.run(_adb_prefix() + ["reverse", f"tcp:{p}", f"tcp:{p}"], check=True)
            self._reversed.append(p)

    async def launch(self, ports: StationPorts) -> None:
        subprocess.run(
            _adb_prefix()
            + [
                "shell",
                "am",
                "start",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                self.app_url(ports),
            ],
            check=True,
        )

    async def close(self) -> None:
        for p in self._reversed:
            subprocess.run(_adb_prefix() + ["reverse", "--remove", f"tcp:{p}"], check=False)
        self._reversed.clear()


# --- iOS (simulator + real device), via tools/ios_build_server.py ------------
@dataclass
class IosBuildClient:
    """Thin client for the Mac's ios_build_server (build/install/launch). Reused by
    both iOS targets; the base URL is the reservation session's local server."""

    base_url: str = field(
        default_factory=lambda: os.environ.get("IOS_BUILD_SERVER", "http://127.0.0.1:8765")
    )

    def post(self, path: str, **params: str) -> list[str]:
        import urllib.parse

        q = urllib.parse.urlencode(params)
        return ["curl", "-fsS", "-X", "POST", f"{self.base_url}{path}?{q}"]


class IosSimulatorTarget(PhoneTarget):
    """The iOS Simulator (macOS host). Shares the host loopback, so 127.0.0.1 works.
    The Capacitor app is installed + opened via simctl (through ios_build_server).
    The Simulator has no BLE, so ble stays virtual unless an ImpossiBLE bridge is
    wired later."""

    name = "ios-sim"
    ble_mode = "virtual"

    def __init__(self, bundle_id: str | None = None) -> None:
        self.bundle_id = bundle_id or os.environ.get("IOS_BUNDLE_ID", "com.ledmapper.app")
        self._ios = IosBuildClient()

    def command_plan(self, ports: StationPorts, app_url: str = "") -> list[list[str]]:
        url = app_url or self.app_url(ports)
        return [
            self._ios.post("/launch", target="booted"),
            ["xcrun", "simctl", "openurl", "booted", url],
        ]

    async def launch(self, ports: StationPorts) -> None:
        for argv in self.command_plan(ports):
            subprocess.run(argv, check=True)


class IosDeviceTarget(PhoneTarget):
    """A real iPhone on USB (devicectl via ios_build_server). iOS has no Web
    Bluetooth, so the Capacitor app provisions over CoreBluetooth (ble=real) against
    the real C6. The phone is on the LAN, so it dials the station's LAN/tailnet IP
    (HITL_STATION_IP); usbmux port-forwarding is an alternative the server sets up."""

    name = "ios-phone"
    ble_mode = "real"

    def __init__(self, udid: str | None = None) -> None:
        self.udid = udid or os.environ.get("HITL_IOS_UDID", "")
        self._ios = IosBuildClient()

    @property
    def host_alias(self) -> str:
        return os.environ.get("HITL_STATION_IP", "127.0.0.1")

    def command_plan(self, ports: StationPorts, app_url: str = "") -> list[list[str]]:
        url = app_url or self.app_url(ports)
        return [
            self._ios.post("/device-build"),
            self._ios.post("/device-install", target=self.udid or "device"),
            self._ios.post("/device-launch", target=self.udid or "device", url=url),
        ]

    async def launch(self, ports: StationPorts) -> None:
        for argv in self.command_plan(ports):
            subprocess.run(argv, check=True)


_TARGETS: dict[str, type[PhoneTarget]] = {
    "browser": BrowserTarget,
    "android-emu": AndroidEmulatorTarget,
    "android-phone": AndroidDeviceTarget,
    "ios-sim": IosSimulatorTarget,
    "ios-phone": IosDeviceTarget,
}


def make_target(spec: str | None = None, *, ble_mode: str | None = None) -> PhoneTarget:
    """Resolve a PhoneTarget from `spec` (or $HITL_PHONE_TARGET, default browser).
    `ble_mode` overrides the target's default (e.g. force real BLE on the emulator)."""
    key = (spec or os.environ.get("HITL_PHONE_TARGET") or "browser").strip()
    cls = _TARGETS.get(key)
    if cls is None:
        raise SystemExit(f"unknown phone target {key!r}; known: {', '.join(_TARGETS)}")
    if key in ("android-emu",) and ble_mode:
        return cls(ble_mode=ble_mode)  # type: ignore[call-arg]
    target = cls()
    if ble_mode:
        target.ble_mode = ble_mode
    return target
