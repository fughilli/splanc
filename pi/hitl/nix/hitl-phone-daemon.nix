# A SECOND hitl-reserved instance for amd-rig: the PHONE bench (android-phone +
# android-emu units), running the ISOLATED multi-DUT model so its two units run
# concurrently without colliding on adb's fixed port 5037 / the emulator console
# ports (bridge networking → each reservation gets its own network namespace).
#
# ADDITIVE module: imported ALONGSIDE nix/hitl-sdr.nix on amd-rig. hitl-sdr.nix owns
# the shared system bits (podman, tailscale, the hitl-agent user, the C6 udev rule for
# 303a); this module only ADDS the phone daemon + its image-load + the phone-specific
# udev (kvm, the Android device) + firewall ports. Distinct API port (8088), state dir
# (/var/lib/hitl-phone), catalog, and image (hitl-phone:latest) from the SDR daemon.
{ hitlSrc }:
{ config, pkgs, lib, ... }:
let
  hitl = pkgs.callPackage ./packages.nix { src = hitlSrc; };
  # The phone reservation image: adb + the x86_64 emulator SDK + a harness python.
  phoneImage = pkgs.callPackage ./container.nix {
    inherit pkgs;
    withAndroid = true;
  };
  phoneImageRef = "hitl-phone:latest";
  phoneCatalog = ../reserve/catalog-phone.json;

  apiPort = 8088; # SECOND daemon's API (SDR daemon owns 8087)
  sshPortBase = 2300; # published env sshd ports (SDR daemon uses 2222+)
  maxUnits = 4; # android-phone + android-emu (+ headroom for restarts)
  unitPorts = lib.genList (i: sshPortBase + i) maxUnits;
in
{
  # Generate a STABLE adb signing key for the phone bench once, on the host. Every
  # phone reservation env mounts this same key (below), so the Android device authorizes
  # it a SINGLE time ("Always allow from this computer") and all future autonomous runs
  # are pre-authorized — no re-tap. adb keygen writes adbkey (+ adbkey.pub); world-read
  # so the container's non-root agent (uid 1000) can offer it (a lab-bench key, not a
  # production secret). To (re)authorize: on the host, `HOME=/var/lib/hitl-phone
  # ${pkgs.android-tools}/bin/adb start-server && adb devices`, then tap Allow on the phone.
  systemd.services.hitl-phone-adbkey = {
    description = "Generate the phone bench's stable adb signing key";
    wantedBy = [ "multi-user.target" ];
    before = [ "hitl-manager-phone.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      StateDirectory = "hitl-phone";
      ExecStart = pkgs.writeShellScript "hitl-phone-adbkey" ''
        set -eu
        d=/var/lib/hitl-phone/adb
        mkdir -p "$d"
        if [ ! -f "$d/adbkey" ]; then
          ${pkgs.android-tools}/bin/adb keygen "$d/adbkey"
        fi
        chmod 0644 "$d/adbkey" "$d/adbkey.pub" 2>/dev/null || true
      '';
    };
  };

  # Load the phone image into podman on boot / after a deploy that changed it. Mirrors
  # hitl-sdr.nix's hitl-image-load, but for the phone image + tag (separate service so
  # the two daemons' images are managed independently).
  systemd.services.hitl-image-load-phone = {
    description = "Load the HITL phone reservation image into podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    restartTriggers = [ "${phoneImage}" ];
    path = [ pkgs.podman ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "hitl-phone-image-load" ''
        set -eu
        pm=${pkgs.podman}/bin/podman
        # Clear stale phone reservation containers + untag the old image first so
        # `podman load` re-points the tag (same dance as hitl-image-load).
        $pm ps -aq --filter label=hitl-phone | xargs -r $pm rm -f 2>/dev/null || true
        $pm untag ${phoneImageRef} 2>/dev/null || true
        $pm load -i ${phoneImage}
      '';
    };
  };

  # Phone-specific udev:
  #  - /dev/kvm open to the agent (the x86_64 emulator runs under KVM; the isolated,
  #    non-privileged env gets it via the unit's `kvm` component → podman --device).
  #  - the Android dev device: create a stable /dev/hitl-android-phone symlink and open
  #    its node so the env's adb can reach it. FILL idVendor/idProduct (or serial) from
  #    the live phone: `lsusb` / `udevadm info` on amd-rig. Google's ADB vendor id is
  #    18d1, but dev phones vary — adjust to the actual device.
  services.udev.extraRules = ''
    KERNEL=="kvm", GROUP="kvm", MODE="0666"
    # FILL: match the reserved Android dev device by its idVendor(:idProduct) or serial.
    SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666", SYMLINK+="hitl-android-phone"
  '';

  # The phone reservation daemon. Isolated model (opposite of the SDR bench): NOT
  # privileged, NOT --net-host, raw-USB isolation ON, per-unit sshd ports published via
  # bridge networking — so android-phone + android-emu run concurrently and adb/emulator
  # (fixed ports) don't collide across reservations. /dev/kvm reaches the emulator env
  # via the unit's kvm component; the Android device via its raw-USB node.
  systemd.services.hitl-manager-phone = {
    description = "HITL reservation manager (phone bench)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscaled.service" "hitl-image-load-phone.service" "hitl-phone-adbkey.service" ];
    wants = [ "network-online.target" "hitl-image-load-phone.service" "hitl-phone-adbkey.service" ];
    restartTriggers = [ "${hitl}/bin/hitl-reserved" "${phoneCatalog}" ];
    unitConfig.StartLimitIntervalSec = 0;
    path = [ pkgs.podman pkgs.iproute2 pkgs.openssh pkgs.getent ];
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${hitl}/bin/hitl-reserved"
        "--addr :${toString apiPort}"
        "--catalog ${phoneCatalog}"
        "--workspace splanc"
        "--host ${config.networking.hostName}"
        "--image ${phoneImageRef}"
        "--podman ${pkgs.podman}/bin/podman"
        # Isolated multi-DUT model: bridge networking (per-unit netns → no adb 5037 /
        # emulator-console collisions), per-unit raw-USB isolation on, unprivileged.
        "--privileged=false"
        "--raw-usb=true"
        # Share the host system D-Bus so the env's BlueZ tooling can drive the host
        # bluetoothd if a lane needs host-side BLE (harmless if absent).
        "--mount /run/dbus/system_bus_socket:/run/dbus/system_bus_socket"
        # The bench's stable adb signing key → every env offers the key the phone
        # authorized once (the entrypoint installs it to ~agent/.android/adbkey).
        "--mount /var/lib/hitl-phone/adb:/run/hitl-adb:ro"
        "--state-dir /var/lib/hitl-phone"
        "--broker-url http://host.containers.internal:${toString apiPort}"
      ];
      StateDirectory = "hitl-phone";
      Restart = "on-failure";
      RestartSec = 3;
    };
  };

  # Reach the second daemon's API + its published env sshd ports over the tailnet/LAN.
  networking.firewall.allowedTCPPorts = [ apiPort ] ++ unitPorts;

  # The agent uid (hitl-agent, 1000, defined in hitl-sdr.nix) needs the kvm group so the
  # emulator can open /dev/kvm inside the (non-privileged) env.
  users.users.hitl-agent.extraGroups = [ "kvm" ];
}
