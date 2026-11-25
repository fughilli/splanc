# Raspberry Pi specifics of the bridge image (the rest is board-independent).
#
#   * Waveshare 1.3" OLED HAT: SPI0 on (sbc-deploy's spi module adds the dtparam
#     and the spi/gpio groups), I2C on for the HAT's I2C mode, and the HAT's keys
#     pulled up from power-on (active low, no pull-ups on the board) — the same
#     config.txt lines pi/bridge/install.sh adds on Raspberry Pi OS.
#   * /dev/gpiochip* for the `gpio` group (lgpio drives the HAT's DC/RST + keys).
#   * The kernel command line: a quiet boot, the console on the serial port
#     only (see below).
#   * Every board boots the firmware-direct generational "kernel" loader, the
#     Pi 5's default (nixos-raspberrypi's boards default to U-Boot -> extlinux
#     otherwise): one boot path, no U-Boot menu, and a one-shot trial boot
#     (tryboot) for every system update (nix/system-update-rpi.nix).
#   * Firmware start-up: no boot_delay (the firmware's default waits 1 s before
#     loading the kernel) and no camera probe (the bridge has no camera). With
#     the splash only able to start with the initrd, firmware time is dead
#     screen time.
#   * The SD image: named after the board, uncompressed (CI compresses it with
#     zstd -19 for the release), with a smaller FAT firmware partition.
{ config, lib, ... }:
{
  boot.loader.raspberry-pi.bootloader = "kernel";

  # A quiet boot: nothing but the splash on HDMI, ever (hence the mkForce: the
  # whole command line is here, nixos-raspberrypi's console order included).
  #   * /dev/console is the serial port (the last console=): stage 1/2's and
  #     systemd's messages go there;
  #   * tty1 stays a console as well, so there always is one (a stage 1 without
  #     a console dies at its first message: "unable to open an initial
  #     console" -> panic), but nothing shows it: fbcon=map:9 maps every VT to
  #     a framebuffer that doesn't exist, so fbcon never takes over HDMI's
  #     (the splash and splanc-display draw on it directly, from VT 8);
  #   * errors only (loglevel 3; add loglevel=7 to cmdline.txt for a verbose
  #     serial console), no cursor, no penguins; and in config.txt no
  #     firmware rainbow square. The kernel log is complete in `dmesg`.
  boot.consoleLogLevel = 3;
  boot.kernelParams = lib.mkForce (
    [
      "console=tty1"
      "console=serial0,115200n8"
      "fbcon=map:9"
      "quiet"
      "loglevel=${toString config.boot.consoleLogLevel}"
      "vt.global_cursor_default=0"
      "logo.nologo"
    ]
    ++ lib.optional (config.security.lsm != [ ]) "lsm=${lib.concatStringsSep "," config.security.lsm}"
    ++ config.splancBridge.kernelParams
  );

  hardware.raspberry-pi.config.all = {
    base-dt-params.i2c_arm = {
      enable = true;
      value = "on";
    };
    options.gpio = {
      enable = true;
      value = "6,19,5,26,13,21,20,16=pu";
    };
    options.disable_splash = {
      enable = true;
      value = true;
    };
    options.boot_delay = {
      enable = true;
      value = 0;
    };
    options.camera_auto_detect.enable = false;
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
    # The FAT partition holds the Pi firmware and the generations' kernel +
    # initrd + device trees (the firmware boots them directly), and the
    # flasher's few small files. The
    # default (1 GiB) is ~1 GiB of zeros in the raw image the flasher writes.
    firmwareSize = lib.mkForce 256;
  };
}
