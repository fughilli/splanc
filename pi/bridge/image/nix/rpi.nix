# Raspberry Pi specifics of the bridge image (the rest is board-independent).
#
#   * Waveshare 1.3" OLED HAT: SPI0 on (sbc-deploy's spi module adds the dtparam
#     and the spi/gpio groups), I2C on for the HAT's I2C mode, and the HAT's keys
#     pulled up from power-on (active low, no pull-ups on the board) — the same
#     config.txt lines pi/bridge/install.sh adds on Raspberry Pi OS.
#   * /dev/gpiochip* for the `gpio` group (lgpio drives the HAT's DC/RST + keys).
#   * The SD image: named after the board, uncompressed (CI compresses it with
#     zstd -19 for the release), with a smaller FAT firmware partition.
{ config, lib, ... }:
{
  hardware.raspberry-pi.config.all = {
    base-dt-params.i2c_arm = {
      enable = true;
      value = "on";
    };
    options.gpio = {
      enable = true;
      value = "6,19,5,26,13,21,20,16=pu";
    };
  };
  hardware.i2c.enable = true;

  services.udev.extraRules = ''
    SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"
  '';

  # nixos-raspberrypi names it nixos-image-rpi<N>-<bootloader>; CI renames the
  # release asset anyway, but a local `nix build` should say what it is.
  image.baseName = lib.mkForce "splanc-bridge-${config.splancBridge.board}";
  sdImage = {
    compressImage = false;
    # The FAT partition holds the Pi firmware, the device trees, the kernel +
    # initrd (Pi 5 boots them directly) and the flasher's few small files. The
    # default (1 GiB) is ~1 GiB of zeros in the raw image the flasher writes.
    firmwareSize = lib.mkForce 256;
  };
}
