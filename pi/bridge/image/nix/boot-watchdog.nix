# The hardware watchdog from the very start of stage 1 (pi/bridge/README.md,
# "Safe boots"): splanc-wdt (pi/bridge/splash/splanc-wdt.c, built with the
# splash in nix/packages.nix) is stage 1's first hook, right after the initrd's
# kernel modules load (before the splash). It arms
# /dev/watchdog0 and pets it while the boot makes progress, until systemd (PID 1,
# RuntimeWatchdogSec from nix/system-update.nix) takes the device over, or until
# splanc.boot_deadline= (180 s after boot; 600 s more on the first boot). A
# boot that stalls before systemd (initrd, root mount, stage 2 activation) then
# resets the board, and with tryboot (nix/system-update-rpi.nix) a stalled
# trial boot comes back as the old system.
#
# Turned off per boot by splanc.wdt=0, or by systemd.watchdog_device=<other>.
{ config, lib, pkgs, ... }:
let
  cfg = config.splancBridge.bootWatchdog;
  bp = pkgs.callPackage ./packages.nix { };
in
{
  options.splancBridge.bootWatchdog.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "Arm the hardware watchdog in stage 1 (splanc-wdt), handed over to systemd.";
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.systemd.watchdog.runtimeTime != null;
        message = "splancBridge.bootWatchdog hands the watchdog to systemd: set systemd.watchdog.runtimeTime";
      }
      {
        assertion = !config.boot.initrd.systemd.enable;
        message = "splancBridge.bootWatchdog starts from the scripted stage 1 (boot.initrd.systemd.enable = false)";
      }
    ];
    boot.initrd.extraUtilsCommands = ''
      copy_bin_and_libs ${bp.splash}/bin/splanc-wdt
    '';
    # Before the splash (mkBefore = 500): nothing in stage 1 runs unguarded.
    boot.initrd.preDeviceCommands = lib.mkOrder 400 ''
      splanc-wdt start || true
    '';
  };
}
