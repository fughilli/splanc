# Raspberry Pi side of the system updates (nix/system-update.nix).
#
# Every board (Pi 3, Pi 4, Pi 5, Zero 2 W) boots with nixos-raspberrypi's
# generational "kernel" loader (nix/rpi.nix): the firmware boots kernel +
# initrd + cmdline.txt straight from the FAT partition, under
# os_prefix=nixos/default/ in config.txt; older generations live next to it in
# nixos/<N>-default/. That allows a real boot-time fallback: the updater keeps
# nixos/default (and config.txt) on the OLD system, and boots the new one ONCE
# through tryboot.txt (`reboot "0 tryboot"`, a firmware feature on every
# model). Only when the new system passes its health check does it become the
# default. Any reset before that (kernel panic -> panic=10, the watchdog, which
# nix/boot-watchdog.nix arms from stage 1 on, a power cut) boots the old one.
#
# Cards flashed with 1.2 or older (Pi 3 / Pi 4 / Zero 2 W) boot U-Boot -> extlinux,
# and their updater (the OLD system's) installs a release in "reboot" mode:
# `<new>/bin/switch-to-configuration boot`, then a plain reboot. The first
# release with the kernel loader turns that into a trial boot as well
# (splanc-install-bootloader below): while config.txt still boots U-Boot and the
# running system is not the one being installed, it installs the generational
# layout next to U-Boot (nixos/), writes the new config.txt as tryboot.txt
# instead of config.txt, and sets the reboot parameter to "0 tryboot" (systemd
# passes /run/systemd/reboot-param to the kernel on a reboot without one). The
# card boots the kernel loader once; a reset falls back to U-Boot and the old
# system, whose updater then rolls back as for any update that didn't come up.
# The new system's commit (its own switch-to-configuration boot, now from the
# new system) writes the kernel loader's config.txt.
#
# FAT space: each generation directory holds a copy of the kernel, initrd and
# device trees (~50 MB on 6.12), and the default one is rewritten via a temp
# copy. nixos-raspberrypi keeps 4 older ones by default, which with the 256 MB
# partition (nix/rpi.nix) and ~22 MB of firmware would run out of space by the
# third update. Keep one: default + the newest generation (= the trial one
# during an update), ~125 MB, ~175 MB at peak. Migrating a U-Boot card stages
# the layout first (firmware + 2 generations, ~125 MB) on the same partition.
{ config, lib, pkgs, ... }:
let
  rpi = config.boot.loader.raspberry-pi;
  kernelLoader = rpi.enable && rpi.bootloader == "kernel";

  # The kernel loader's own installer (what nixos-raspberrypi sets as
  # installBootLoader), with the U-Boot migration in front of it.
  installer = pkgs.writeShellScript "splanc-install-bootloader" ''
    set -eu
    export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep ]}
    top="$1"
    # (overridable for the flake's migrate-* checks)
    fw=''${SPLANC_FIRMWARE_DIR:-${rpi.firmwarePath}}
    booted="$(readlink -f "''${SPLANC_BOOTED_SYSTEM:-/run/booted-system}" || true)"
    rundir=''${SPLANC_SYSTEMD_RUN_DIR:-/run/systemd}
    if [ -f "$fw/config.txt" ] && grep -q '^kernel=u-boot' "$fw/config.txt" \
      && [ "$booted" != "$(readlink -f "$top")" ]; then
      echo "splanc-install-bootloader: U-Boot card: installing the kernel loader as a one-shot trial (tryboot.txt)"
      stage="$fw/.splanc-kernel-loader.tmp"
      rm -rf "$stage" "$fw/nixos.old" "$fw/tryboot.txt"
      mkdir -p "$stage"
      ${rpi.firmwarePopulateCmd} -c "$top" -f "$stage"
      if [ -e "$fw/nixos" ]; then mv "$fw/nixos" "$fw/nixos.old"; fi
      mv "$stage/nixos" "$fw/nixos"
      cp "$stage/config.txt" "$fw/tryboot.txt.tmp"
      sync
      mv "$fw/tryboot.txt.tmp" "$fw/tryboot.txt"
      rm -rf "$stage" "$fw/nixos.old"
      sync
      # The old updater reboots without --reboot-argument: make it a tryboot.
      if [ -d "$rundir" ]; then printf '0 tryboot' > "$rundir/reboot-param"; fi
      exit 0
    fi
    exec ${rpi.firmwarePopulateCmd} -f "$fw" -c "$top"
  '';
in
{
  config = lib.mkIf config.splancBridge.systemUpdate.enable (lib.mkMerge [
    (lib.mkIf kernelLoader {
      splancBridge.systemUpdate.bootMode = "tryboot";
      boot.loader.raspberry-pi.configurationLimit = 1;
      system.build.installBootLoader = lib.mkForce "${installer}";
      system.build.splancInstallBootLoader = installer;
      # The updater writes tryboot.txt from the NEW system's config.txt (so new
      # dtparams/overlays apply to the trial boot too).
      system.systemBuilderCommands = ''
        ln -s ${rpi.configTxtPackage} $out/splanc-rpi-config.txt
      '';
    })
  ]);
}
