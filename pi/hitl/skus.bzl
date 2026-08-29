"""Canonical SKU -> capabilities registry for the HITL fleet.

A SKU strictly describes the HARDWARE CONFIGURATION of a DUT: the board model plus
its baked-in / wired peripherals (an output path, an attached FPGA, …). It does NOT
describe the bench INSTRUMENTATION around the DUT — whether a logic analyzer is
present, and where it's tapped, is rig wiring that varies between two otherwise
identical DUTs, so the daemon advertises those `logic-analyzer-*` capabilities
per-DUT (from the analyzer broker's channel map), NOT from this registry.

Every DUT the daemon hands out advertises its SKU; the daemon looks the SKU's
peripheral capabilities up here (via the generated, go:embedded skus.json) and
unions in the per-DUT instrumentation caps. Tests declare the capabilities they
need (`hitl_test(requires = [...])`) and the fan-out macro runs each test on every
SKU whose capabilities satisfy it. Add a peripheral to a SKU here and matching
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
    # The LED Mapper Raspberry Pi (a network DUT), running the unified Rust player.
    # There is ONE Pi SKU: whether an spi_ws281x FPGA is wired to it is a per-DUT
    # peripheral capability, not a distinct SKU (an FPGA-less Pi is the same board).
    # The currently-deployed fleet is FPGA-wired — the Pi's player streams over SPI
    # (--output=fpga) and the FPGA fans out to WS2812 strips — so this SKU carries
    # the FPGA output path. If a strip-only (no-FPGA) Pi is ever added, split the
    # peripheral caps out to a per-DUT seed override rather than forking the SKU.
    # (Instrumentation — the FX2 tapping the SPI wire and/or the strip outputs — is
    # advertised per-DUT by the daemon as logic-analyzer-spi / logic-analyzer-led-strip,
    # NOT listed here; see the module docstring.)
    "led-mapper-pi": [
        "improv",  # Improv-over-BLE WiFi provisioning (still a Pi)
        "wss-app",  # the Rust player serves the LED Mapper app over wss
        "led-strip",  # the FPGA drives WS2812 strips (FX2-capturable)
        "spi-fpga",  # streams to the spi_ws281x FPGA over SPI (SPI wire is tapped)
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
