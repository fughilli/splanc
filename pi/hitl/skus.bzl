"""Canonical SKU -> capabilities registry for the HITL fleet.

A SKU is a hardware configuration: a DUT model plus its baked-in peripherals. Every
DUT the daemon hands out advertises its SKU; the daemon looks its capabilities up
here (via the generated, go:embedded skus.json). Tests declare the capabilities
they need (`hitl_test(requires = [...])`) and the fan-out macro runs each test on
every SKU whose capabilities satisfy it. Add a peripheral to a SKU here and matching
tests fan out to it automatically — no per-test change.

This .bzl is the SOURCE OF TRUTH. skus.json is a generated, committed mirror kept in
sync by //pi/hitl:skus_json_sync_test; the daemon go:embeds it (cmd/hitl-managerd).
"""

HITL_SKUS = {
    # ESP32-C6 SuperMini running the player_app firmware, attached over USB.
    "esp32c6": [
        "flash",  # flashable over USB (esptool)
        "jtag",  # built-in USB-JTAG (openocd / gdb)
        "improv",  # Improv-over-BLE WiFi provisioning
        "wss-app",  # serves the LED Mapper app over wss
        "led-strip",  # drives a WS2812 strip (capturable by the FX2 analyzer)
    ],
    # The LED Mapper Raspberry Pi (a network DUT). Its M2 led-server app is still a
    # placeholder, so it advertises only what's real today: Improv provisioning.
    # Add "wss-app", "led-strip", … here as the Pi app lands and tests auto-fan.
    "led-mapper-pi": [
        "improv",
    ],
}

def hitl_skus_with(caps):
    """SKUs whose capabilities are a superset of every cap in `caps`.

    Args:
      caps: list of required capability strings.

    Returns:
      A sorted list of SKU names whose capabilities include every cap in `caps`
      (all SKUs when `caps` is empty).
    """
    want = {c: True for c in caps}
    out = []
    for sku, have in HITL_SKUS.items():
        haveset = {c: True for c in have}
        if all([haveset.get(c, False) for c in want]):
            out.append(sku)
    return sorted(out)
