# Splanc MAX over-the-air updates: the on-Pi updater and its rollback
# (docs/design/max-ota.md). In short:
#
#   * The update unit is a whole NixOS system (closure) + a ONE-SHOT trial boot.
#     The player (unprivileged) drops a signed request in the updater's inbox; the
#     root updater (`splanc-max-ota`, //pi/max_ota) downloads the image itself,
#     checks it against the signed manifest, imports it into /nix/store, writes
#     /boot/extlinux/splanc-trial.conf and arms the flag /boot/firmware/splanc-trial.
#   * U-Boot (built here with a trial-aware bootcmd) clears the flag BEFORE it
#     loads the new kernel, then boots the trial entry. extlinux.conf — what boots
#     after any reset or power cut — still names the old system.
#   * In the trial, splanc-ota-health waits for the player to prove healthy (its
#     /run/ledmapper/health) and only then makes the new system the default
#     (nix-env --set + switch-to-configuration boot). Past the deadline it reboots,
#     and the old system comes back by itself.
#
# Device state survives every update untouched: Wi-Fi (NetworkManager's
# system-connections), the identity (/var/lib/sbc/hostname, applied at runtime
# below), SSH host keys, the deploy key (persisted below) and /var/lib/ledmapper.
{ config, lib, pkgs, sbcBuildData ? { }, ... }:
let
  stateDir = "/var/lib/splanc-ota";

  updaterBin = sbcBuildData."splanc-max-ota" or (throw
    "splanc-max-ota missing from build_data — add //pi/max_ota:splanc_max_ota_musl "
  + "to sbc_application(build_data=…).");
  updater = pkgs.runCommand "splanc-max-ota" { } ''
    install -Dm755 ${updaterBin} "$out/bin/splanc-max-ota"
  '';

  # The release version this system is (manifest number = M*1e6 + m*1e3 + p),
  # stamped by the release workflow / the HITL image builds via the environment
  # (the flake is evaluated --impure). A developer deploy is 0.0.0-dev = version 0,
  # which any release may update.
  envVersion = builtins.getEnv "SPLANC_MAX_VERSION";
  version = if envVersion != "" then envVersion else "0.0.0-dev";

  # The board this closure is for (one artifact per board): the nixos-raspberrypi
  # variant -> the name in asset names and in ota_status.board.
  board = {
    "3" = "pi3";
    "4" = "pi4";
    "5" = "pi5";
    "02" = "zero2w";
  }.${config.boot.loader.raspberry-pi.variant} or "unknown";

  # The name a FRESH unit takes (no /var/lib/sbc/hostname yet): the sbc-deploy
  # commissioning `--hostname` ($SBC_HOSTNAME_OVERRIDE, read --impure like every
  # sbc seam), else "ledmapper". After that, /var/lib/sbc/hostname is the identity.
  seedName =
    let o = builtins.getEnv "SBC_HOSTNAME_OVERRIDE";
    in if o != "" then o else "ledmapper";

  toolPath = [ pkgs.curl pkgs.zstd config.nix.package pkgs.coreutils pkgs.systemd ];

  # U-Boot with the one-shot trial in front of the stock boot. U-Boot 2025.01's
  # rpi_arm64_defconfig boots through standard boot (BOOTSTD_DEFAULTS: bootcmd is
  # `bootflow scan`, no distro_bootcmd), so the trial lives in PREBOOT, which runs
  # first and returns unless it boots: read the flag file on the FAT firmware
  # partition (mmc 0:1); first byte '1' = armed -> write it back as '0' FIRST
  # (fatwrite), then sysboot the trial entry from the root partition (mmc 0:2).
  # Anything failing — no flag, '0', no trial conf, a missing kernel — returns to
  # the stock bootcmd, i.e. extlinux.conf, i.e. the old system. The stock preboot
  # ("pci enum; usb start;") stays in front. "splanc-trial" in the binary is how
  # the updater knows this U-Boot is in place (pi-v1.0.0's stock U-Boot would
  # ignore the flag; the updater then refuses with bootloader_unsupported).
  trialPreboot = lib.concatStringsSep "; " [
    "pci enum"
    "usb start"
    "if load mmc 0:1 \${scriptaddr} splanc-trial && itest.b *\${scriptaddr} == 0x31"
    "then mw.b \${scriptaddr} 0x30 1"
    "fatwrite mmc 0:1 \${scriptaddr} splanc-trial \${filesize}"
    "sysboot mmc 0:2 any \${pxefile_addr_r} /boot/extlinux/splanc-trial.conf"
    "fi"
  ];
  uboot = pkgs.buildUBoot {
    defconfig = "rpi_arm64_defconfig";
    extraMeta.platforms = [ "aarch64-linux" ];
    filesToInstall = [ "u-boot.bin" ];
    extraConfig = ''
      CONFIG_CMD_FS_GENERIC=y
      CONFIG_CMD_MEMORY=y
      CONFIG_CMD_FAT=y
      CONFIG_FAT_WRITE=y
      CONFIG_CMD_ITEST=y
      CONFIG_CMD_SYSBOOT=y
      CONFIG_USE_PREBOOT=y
      CONFIG_PREBOOT="${trialPreboot}"
    '';
  };

  svc = extra: {
    path = toolPath;
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${updater}/bin/splanc-max-ota ${extra}";
      StandardOutput = "journal";
      StandardError = "journal";
    };
  };
in
{
  environment.systemPackages = [ updater ];
  environment.etc."splanc-max/version".text = version + "\n";
  environment.etc."splanc-max/board".text = board + "\n";

  boot.loader.raspberry-pi.ubootPackage = lib.mkIf (board != "pi5") uboot;

  # A hung kernel or userspace resets the board (the BCM2835 watchdog tops out at
  # ~15 s), and a panic reboots — both land on extlinux.conf's default, so a trial
  # that wedges falls back by itself.
  systemd.watchdog.runtimeTime = "15s";
  systemd.watchdog.rebootTime = "30s";
  boot.kernelParams = [ "panic=10" ];

  # The updater's state (world-readable: the player answers get_ota_status from
  # it) and the inbox the player (group ledmapper) drops requests into.
  systemd.tmpfiles.rules = [
    "d ${stateDir} 0755 root root -"
    "d ${stateDir}/dl 0755 root root -"
    "d ${stateDir}/inbox 0770 root ledmapper -"
  ];

  # Every boot, before the player: enter the trial / notice a rollback / finish a
  # commit. Reboots by itself only to finish an interrupted commit.
  systemd.services.splanc-ota-boot = lib.recursiveUpdate (svc "boot") {
    description = "Splanc MAX OTA: reconcile the update state with what booted";
    wantedBy = [ "multi-user.target" ];
    after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ];
    before = [ "sbc-led-driver.service" "splanc-ota-apply.service" "splanc-ota-health.service" ];
    unitConfig.DefaultDependencies = false;
    serviceConfig.RemainAfterExit = true;
  };

  # The player's request (inbox/request) and, at boot, a download a power cut
  # interrupted: download -> verify -> import -> stage the trial -> reboot.
  systemd.services.splanc-ota-apply = lib.recursiveUpdate (svc "apply") {
    description = "Splanc MAX OTA: download, verify and stage an update";
    wantedBy = [ "multi-user.target" ];
    after = [ "splanc-ota-boot.service" "network-online.target" ];
    wants = [ "network-online.target" ];
    # simple, not oneshot: a long download mustn't hold multi-user.target.
    serviceConfig = {
      Type = "simple";
      Nice = 10;
      IOSchedulingClass = "idle";
    };
  };
  systemd.paths.splanc-ota-apply = {
    description = "Splanc MAX OTA: a request from the player";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathExists = "${stateDir}/inbox/request";
  };

  # During a trial: commit once the player proves healthy, else roll back.
  systemd.services.splanc-ota-health = lib.recursiveUpdate (svc "health") {
    description = "Splanc MAX OTA: keep the new system only if the player proves healthy";
    wantedBy = [ "multi-user.target" ];
    after = [ "splanc-ota-boot.service" ];
    serviceConfig.Type = "simple";
  };

  # The player may write the inbox (its unit sandboxes the rest of /var read-only).
  # ("-": tolerate a first boot where tmpfiles hasn't made it yet.)
  services.sbcApps.led-driver.readWritePaths = [ "-${stateDir}/inbox" ];

  # -- device identity, kept across updates ---------------------------------------
  # An OTA image is built ONCE per board (hostname "ledmapper", the CI deploy key),
  # not per device, so what makes a unit itself lives in /var: the committed
  # hostname (sbc-deploy identity.nix, /var/lib/sbc/hostname) and the root deploy
  # keys. The hostname must not be baked at all: NixOS would own /etc/hostname
  # (systemd-hostnamed re-applies it) and write it into avahi-daemon.conf, so the
  # unit would advertise ledmapper.local instead of its own name. With an empty
  # networking.hostName NixOS leaves both alone: /etc/hostname becomes a stateful
  # file written here from the committed identity, and avahi uses the system
  # hostname (HITL/rig addressing — splanc-max-2.local — keeps working).
  networking.hostName = lib.mkForce "";
  system.activationScripts.splancHostname = lib.stringAfter [ "etc" "var" "sbcIdentity" ] ''
    h=""
    [ -s /var/lib/sbc/hostname ] && h="$(head -n1 /var/lib/sbc/hostname)"
    if [ -z "$h" ]; then
      h=${lib.escapeShellArg seedName}
      mkdir -p /var/lib/sbc && printf '%s\n' "$h" > /var/lib/sbc/hostname
    fi
    if [ -L /etc/hostname ] || [ "$(cat /etc/hostname 2>/dev/null)" != "$h" ]; then
      rm -f /etc/hostname
      printf '%s\n' "$h" > /etc/hostname
    fi
    ${pkgs.nettools}/bin/hostname "$h" 2>/dev/null || true
  '';
  # The unit's mDNS name is how the app, the agent and the HITL rig find it, so keep
  # avahi up and on the right name. Seen on rig-1's splanc-max-2 (two interfaces on
  # one LAN, wlan0 + USB ethernet): avahi killed by a SIGHUP (openresolv's hook)
  # while still starting — systemd counts that as a clean exit and its stale PID
  # file then blocks every restart — and, after an abrupt reset, a name conflict
  # that left it advertising "splanc-max-3.local" for good.
  systemd.services.avahi-daemon.serviceConfig = {
    Restart = lib.mkForce "always";
    RestartSec = "2";
    ExecStartPre = [ "-${pkgs.coreutils}/bin/rm -f /run/avahi-daemon/pid" ];
  };
  systemd.services.splanc-mdns-name = {
    description = "Splanc MAX: keep avahi advertising this unit's own hostname";
    path = [ pkgs.avahi pkgs.dbus pkgs.nettools ];
    serviceConfig.Type = "oneshot";
    script = ''
      h="$(hostname)"
      a="$(dbus-send --system --print-reply=literal --dest=org.freedesktop.Avahi / \
            org.freedesktop.Avahi.Server.GetHostName 2>/dev/null | tr -d ' ')" || exit 0
      if [ -n "$h" ] && [ -n "$a" ] && [ "$a" != "$h" ]; then
        echo "avahi advertises $a.local, not $h.local: renaming" >&2
        avahi-set-host-name "$h"
      fi
    '';
  };
  systemd.timers.splanc-mdns-name = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "90s";
      OnUnitActiveSec = "60s";
    };
  };

  services.openssh.authorizedKeysFiles = [ "/var/lib/sbc/authorized_keys.d/%u" ];
  system.activationScripts.splancDeployKeys = lib.stringAfter [ "var" ] ''
    if [ ! -e /var/lib/sbc/authorized_keys.d/root ]; then
      mkdir -p /var/lib/sbc/authorized_keys.d
      printf '%s\n' ${lib.escapeShellArgs config.users.users.root.openssh.authorizedKeys.keys} \
        > /var/lib/sbc/authorized_keys.d/root
      chmod 0644 /var/lib/sbc/authorized_keys.d/root
    fi
  '';
}
