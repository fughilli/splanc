# Host-side sigrok toolchain for the rig's shared logic analyzer (an FX2/fx2lafw
# "Saleae clone", VID:PID 0925:3881 bare → 1d50:608c after firmware upload).
#
# sigrok-cli pulls in libsigrok + libsigrokdecode. The decoders this rig needs —
# `rgb_led_ws281x` (WS2812, the ESP32-C6 player_app DUT) and `rgb_led_spi`
# (APA102/SK9822, the pi/led_driver path) — are BUILT IN to libsigrokdecode
# ≥0.5.3, so no out-of-tree decoder has to be vendored (verified against 0.5.3).
#
# The bare FX2 needs fx2lafw firmware uploaded on first use; sigrok-firmware-fx2lafw
# provides it, and libsigrok finds it via SIGROK_FIRMWARE_DIR (exported into the
# daemon service — see hitl-app.nix).
{ pkgs }:
{
  # Packages to put on the daemon's PATH / systemPackages (analyzer rig only).
  packages = [ pkgs.sigrok-cli pkgs.sigrok-firmware-fx2lafw ];
  # sigrok-cli binary the daemon shells out to (--analyzer-sigrok).
  cli = "${pkgs.sigrok-cli}/bin/sigrok-cli";
  # Firmware search dir libsigrok uploads to the FX2 from.
  firmwareDir = "${pkgs.sigrok-firmware-fx2lafw}/share/sigrok-firmware";
}
