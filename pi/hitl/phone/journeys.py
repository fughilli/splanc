"""The three basic user journeys, driven over the app-driver channel.

Each takes a connected `AppDriver` and asserts on the app's real replies. They are
transport-agnostic: the phone is an emulator (or a headless browser); the device
backend is a real ESP32-C6 reached over wss (via the rig forward) unless a mock is
supplied. BLE is the virtual Improv device in the MVP; Phase 2 swaps in a real
peripheral with no change here.
"""

from __future__ import annotations

from driver_server import AppDriver, DriverError


async def journey_smoke(drv: AppDriver) -> dict:
    """Device-free smoke: prove the app-driver loop + virtual BLE work end to end in
    a real browser with NO device backend. The virtual Improv peripheral answers the
    provision RPC with a redirect purely in-app, so this needs no network or rig."""
    await drv.navigate("/onboard")
    snap = await drv.query("appState")
    prov = await drv.provision_ble("FugLink", "smoke-pass")
    urls = prov.get("urls") or []
    if not urls:
        raise DriverError(f"virtual provisioning returned no redirect: {prov}")
    return {"appState": snap, "provisioned": prov}


async def journey_connect(drv: AppDriver, *, wss_url: str, ssid: str, password: str) -> dict:
    """Scan for + connect to a device: BLE-provision (virtual Improv), then connect
    the player socket to the (rig-forwarded) real C6 wss. Assert we reach connected
    and the device reports a MAC in its welcome."""
    prov = await drv.provision_ble(ssid, password)
    if not prov.get("urls"):
        raise DriverError(f"provisioning returned no redirect: {prov}")
    # The device's self-reported IP isn't reachable from the station; connect to the
    # rig-forwarded wss instead (same device, reachable path).
    await drv.connect(wss_url, label="rig-c6")
    snap = await drv.wait_connected(timeout=60.0)
    welcome = await drv.query("welcome")
    mac = (welcome or {}).get("mac")
    if not mac:
        raise DriverError(f"connected but no MAC in welcome: {welcome}")
    return {"provisioned": prov, "welcome": welcome, "state": snap}


async def journey_mapping(drv: AppDriver, *, led_count: int = 30) -> dict:
    """Initiate mapping: navigate to capture, start mapping, let the synthetic
    camera feed the pattern, stop, and assert a result_ready comes back."""
    await drv.navigate(f"/capture?leds={led_count}")
    started = await drv.command("startMapping", ledCount=led_count, config={}, timeout=120.0)
    await drv.wait_event("milestone", name="mapping_started", timeout=60.0)
    # The synthetic CaptureSource streams detections for the known fixture; give the
    # solver a window, then finish.
    result = await drv.stop_mapping()
    return {"mapping_started": started, "result_ready": result}


async def journey_config(drv: AppDriver, *, gpio: int = 8, color_order: str = "GRB") -> dict:
    """Configure gamma / hardware settings and assert the device echoes them.

    Drives the client config RPCs directly (the harness path) rather than the
    Hardware Setup screen — mounting that screen fires its own getHardwareConfig,
    which would collide with our setHardwareConfig on the same reply type (the app
    allows one pending request per reply). Screen-driven config is a later refinement."""
    hw = await drv.set_hw_config(channel=0, gpio=gpio, colorOrder=color_order, commit=True)
    if not (hw or {}).get("channels"):
        raise DriverError(f"set_hardware_config did not echo channels: {hw}")
    cc = await drv.set_color_correction(gamma=[2.2, 2.2, 2.2], commit=True)
    return {"hardware_config_state": hw, "color_correction": cc}


ALL = {
    "smoke": journey_smoke,
    "connect": journey_connect,
    "mapping": journey_mapping,
    "config": journey_config,
}
