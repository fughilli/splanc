"""`bazel run //pi/bridge:sim`: the display service on mocked peripherals, in a browser.

See splanc_display/sim.py (or run it directly: python3 -m splanc_display.sim).
"""

from splanc_display.sim import main_cli

if __name__ == "__main__":
    raise SystemExit(main_cli())
