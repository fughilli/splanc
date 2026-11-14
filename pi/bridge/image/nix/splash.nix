# The early boot splash (pi/bridge/README.md, "Boot splash"): splanc-splash
# (pi/bridge/splash, built in nix/packages.nix) starts at the very top of stage 1,
# right after the initrd's kernel modules load, and animates the logo on the
# OLED HAT and HDMI until splanc-display takes the screens over from it.
#
#   * initrd: the SPI controller + spidev modules (the only addition to the
#     initrd's module set; the GPIO block and simpledrm are built in), and the
#     static binary (~0.2 MB, frames included) in extraUtils;
#   * preDeviceCommands: `splanc-splash start` forks and returns at once (it
#     never holds up stage 1); the child renames itself "@splanc-splash", which
#     stage 1's kill loop and systemd leave running across switch_root;
#   * splanc-display (nix/bridge.nix) hands over through the abstract socket
#     @splanc-splash once it is loaded and the system is quiet
#     (splanc_display/splash.py).
#
# The scripted stage 1 (this image's) only: systemd-initrd would need a unit
# instead of preDeviceCommands.
{ config, lib, pkgs, ... }:
let
  cfg = config.splancBridge.splash;
  bp = pkgs.callPackage ./packages.nix { };
  # The header's SPI0: the BCM283x/2711 controller, or the Pi 5's RP1 (DesignWare).
  spiModules = {
    pi3 = [ "spi-bcm2835" "spidev" ];
    pi4 = [ "spi-bcm2835" "spidev" ];
    zero2w = [ "spi-bcm2835" "spidev" ];
    pi5 = [ "spi-dw-mmio" "spidev" ];
  }.${config.splancBridge.board} or [ ];
in
{
  options.splancBridge.splash = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start the boot splash from the initrd (kernel cmdline splanc.splash=0 turns it off per boot).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !config.boot.initrd.systemd.enable;
        message = "splancBridge.splash starts from the scripted stage 1 (boot.initrd.systemd.enable = false)";
      }
    ];
    boot.initrd.kernelModules = spiModules;
    boot.initrd.extraUtilsCommands = ''
      copy_bin_and_libs ${bp.splash}/bin/splanc-splash
    '';
    boot.initrd.extraUtilsCommandsTest = ''
      $out/bin/splanc-splash bench 0.1 --no-rt
    '';
    boot.initrd.preDeviceCommands = lib.mkBefore ''
      splanc-splash start || true
    '';
    # `splanc-splash stop` (hand over by hand) and `bench` on the running system.
    environment.systemPackages = [ bp.splash ];
  };
}
