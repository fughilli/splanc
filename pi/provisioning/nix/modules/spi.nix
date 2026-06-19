# SPI / board hardware enablement for SK9822 / APA102 (DotStar) LEDs.
#
# Design doc §5: LEDs are driven over HARDWARE SPI (spidev), not bit-banged.
# This enables the SPI controller in the device tree and grants the service
# user access to /dev/spidev*.
#
# The dtparam/dtoverlay knobs below are applied via the Raspberry Pi config
# that the nixos-raspberrypi flake wires into the firmware boot config. The
# exact option path can differ between board generations (Pi 4 BCM2711 vs Pi 5
# RP1); both expose hardware SPI0 on the 40-pin header (MOSI=GPIO10, SCLK=GPIO11).
#
# UNVERIFIED: the precise `hardware.raspberry-pi` / `boot.loader` option names
# depend on the pinned nixos-raspberrypi revision. The intent (enable spidev,
# load the spi overlay, expose /dev/spidev0.0) is what matters; adjust the
# option path to match the flake if eval fails.
{ config, lib, pkgs, ... }:
{
  # Enable the SPI master in the device tree. nixos-raspberrypi surfaces the
  # firmware config.txt knobs under `hardware.raspberry-pi.config`. We set the
  # equivalent of:
  #   dtparam=spi=on
  # which is the standard way to turn on hardware SPI0 for SK9822/APA102.
  hardware.raspberry-pi.config = lib.mkDefault {
    all = {
      base-dt-params = {
        # dtparam=spi=on
        spi = {
          enable = true;
          value = "on";
        };
      };
    };
  };

  # Ship spidev tooling for debugging on the Pi.
  environment.systemPackages = with pkgs; [
    # `spidev_test` / python spidev are handy for bringing up M1.
    python3Packages.spidev or null
  ];

  # Create an `spi` group and give it ownership of the SPI character devices,
  # so the ledmapper service user (member of `spi`) can open them without root.
  users.groups.spi = { };
  users.groups.gpio = { };

  services.udev.extraRules = ''
    # SK9822/APA102 over hardware SPI0. MOSI=GPIO10, SCLK=GPIO11.
    SUBSYSTEM=="spidev", KERNEL=="spidev0.0", GROUP="spi", MODE="0660"
    SUBSYSTEM=="spidev", KERNEL=="spidev0.1", GROUP="spi", MODE="0660"
    # GPIO access for sync/debug lines.
    SUBSYSTEM=="gpio", GROUP="gpio", MODE="0660"
  '';
}
