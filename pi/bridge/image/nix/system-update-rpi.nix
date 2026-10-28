# Raspberry Pi side of the system updates (nix/system-update.nix).
#
# Pi 5 (nixos-raspberrypi's generational "kernel" loader): the firmware boots
# kernel + initrd + cmdline.txt straight from the FAT partition, under
# os_prefix=nixos/default/ in config.txt; older generations live next to it in
# nixos/<N>-default/. That allows a real boot-time fallback: the updater keeps
# nixos/default (and config.txt) on the OLD system, and boots the new one ONCE
# through tryboot.txt (`reboot "0 tryboot"`, a Pi 4/5 EEPROM feature). Only when
# the new system passes its health check does it become the default.
#
# Pi 3 / Pi 4 / Zero 2 W boot U-Boot -> extlinux, which has no one-shot entry:
# the generic "reboot" mode (new generation is the default; rollback is done by
# the new system's health check, so a system that can't boot at all can't roll
# itself back).
#
# FAT space (Pi 5): each generation directory holds a copy of the kernel, initrd
# and device trees (~50 MB on 6.12), and the default one is rewritten via a temp
# copy. nixos-raspberrypi keeps 4 older ones by default, which with the 256 MB
# partition (nix/rpi.nix) and ~22 MB of firmware would run out of space by the
# third update. Keep one: default + the newest generation (= the trial one
# during an update), ~125 MB, ~175 MB at peak.
{ config, lib, ... }:
let
  rpi = config.boot.loader.raspberry-pi;
  kernelLoader = rpi.enable && rpi.bootloader == "kernel";
in
{
  config = lib.mkIf config.splancBridge.systemUpdate.enable (lib.mkMerge [
    (lib.mkIf kernelLoader {
      splancBridge.systemUpdate.bootMode = "tryboot";
      boot.loader.raspberry-pi.configurationLimit = 1;
      # The updater writes tryboot.txt from the NEW system's config.txt (so new
      # dtparams/overlays apply to the trial boot too).
      system.systemBuilderCommands = ''
        ln -s ${rpi.configTxtPackage} $out/splanc-rpi-config.txt
      '';
    })
  ]);
}
