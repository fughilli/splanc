# A SECOND hitl-reserved instance for amd-rig: the PHONE bench (android-phone +
# android-emu units).
#
# NETWORK MODEL (validated live on amd-rig 2026-09-20): --net-host + a HOST adb server.
# A bridge container can't reach a host adb server (adb binds 127.0.0.1; podman here has no
# host.containers.internal). So — like the SDR bench — the reservation envs run --net-host and
# use ONE host adb server at 127.0.0.1:5037 (authorized once by the persistent bench key, so no
# re-tap). Each env targets its serial: the real phone (R95N90G5WSB, on the host USB, seen by
# the host adb server) or an emulator it boots in-env (net-host + /dev/kvm), which registers
# with the same host server as emulator-5554. No per-env adb server ⇒ no port-5037 collisions,
# and no USB passthrough of the non-tty phone.
#
# ADDITIVE module: imported ALONGSIDE nix/hitl-sdr.nix on amd-rig. hitl-sdr.nix owns the shared
# system bits (podman, tailscale, the hitl-agent user, the C6 udev rule for 303a); this module
# only ADDS the phone daemon + the host adb key/server + image-load + kvm udev + firewall ports.
# Distinct API port (8088), state dir (/var/lib/hitl-phone), catalog, and image
# (hitl-phone:latest) from the SDR daemon.
{ hitlSrc }:
{ config, pkgs, lib, ... }:
let
  hitl = pkgs.callPackage ./packages.nix { src = hitlSrc; };
  # The phone reservation image: adb (client) + the x86_64 emulator SDK + a harness python.
  phoneImage = pkgs.callPackage ./container.nix {
    inherit pkgs;
    withAndroid = true;
  };
  phoneImageRef = "hitl-phone:latest";
  phoneCatalog = ../reserve/catalog-phone.json;
  adbDir = "/var/lib/hitl-phone/adb"; # the bench signing key (adbkey/.pub)
  adbHome = "/var/lib/hitl-phone/adbhome"; # HOME for the host adb server (uses adbDir's key)

  apiPort = 8088; # SECOND daemon's API (SDR daemon owns 8087)
  sshPortBase = 2300; # published env sshd ports (SDR daemon uses 2222+)
  maxUnits = 4; # android-phone + android-emu (+ headroom for restarts)
  unitPorts = lib.genList (i: sshPortBase + i) maxUnits;
in
{
  # The bench's stable adb signing key. Generated once (world-read: a lab-bench key, not a
  # production secret); the phone authorizes it a SINGLE time. Also stages it into the adb
  # server's HOME so the server signs with it. NOTE: an already-authorized key placed at
  # ${adbDir}/adbkey is kept (the guard skips regeneration) — that's how the live tap persists.
  systemd.services.hitl-phone-adbkey = {
    description = "Prepare the phone bench's stable adb signing key";
    wantedBy = [ "multi-user.target" ];
    before = [ "hitl-phone-adb.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      StateDirectory = "hitl-phone";
      ExecStart = pkgs.writeShellScript "hitl-phone-adbkey" ''
        set -eu
        mkdir -p ${adbDir} ${adbHome}/.android
        [ -f ${adbDir}/adbkey ] || ${pkgs.android-tools}/bin/adb keygen ${adbDir}/adbkey
        chmod 0644 ${adbDir}/adbkey ${adbDir}/adbkey.pub 2>/dev/null || true
        # The host adb server signs with $HOME/.android/adbkey — stage the bench key there.
        install -m600 ${adbDir}/adbkey ${adbHome}/.android/adbkey
        [ -f ${adbDir}/adbkey.pub ] && install -m644 ${adbDir}/adbkey.pub ${adbHome}/.android/adbkey.pub || true
      '';
    };
  };

  # The host adb server: reservation envs reach it at 127.0.0.1:5037 over --net-host. It holds
  # the phone's authorization (the bench key) and multiplexes the real phone + any in-env
  # emulator. Runs as root so it can open the phone's raw USB.
  systemd.services.hitl-phone-adb = {
    description = "HITL phone bench host adb server";
    wantedBy = [ "multi-user.target" ];
    after = [ "hitl-phone-adbkey.service" "network.target" ];
    wants = [ "hitl-phone-adbkey.service" ];
    environment.HOME = adbHome;
    serviceConfig = {
      # nodaemon keeps it foreground for systemd; default listen is 127.0.0.1:5037.
      ExecStart = "${pkgs.android-tools}/bin/adb server nodaemon";
      Restart = "always";
      RestartSec = 3;
    };
  };

  # Load the phone image into podman on boot / after a deploy that changed it (separate service
  # so the two daemons' images are managed independently).
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
        $pm ps -aq --filter label=hitl-phone | xargs -r $pm rm -f 2>/dev/null || true
        $pm untag ${phoneImageRef} 2>/dev/null || true
        $pm load -i ${phoneImage}
      '';
    };
  };

  # Open /dev/kvm to the emulator env (the in-env x86_64 emulator runs under KVM, reached via
  # the android-emu unit's `kvm` component → podman --device). No phone-USB rule: the phone is
  # driven through the host adb server, not passed into the container.
  services.udev.extraRules = ''
    KERNEL=="kvm", GROUP="kvm", MODE="0666"
  '';

  # The phone reservation daemon — --net-host (like the SDR bench) so envs share the host's
  # loopback (127.0.0.1:5037 adb server) and bind their per-unit sshd port via HITL_SSH_PORT.
  # The C6s reach their env as /dev/ttyACM0 (component `devices`); /dev/kvm via the kvm component.
  systemd.services.hitl-manager-phone = {
    description = "HITL reservation manager (phone bench)";
    wantedBy = [ "multi-user.target" ];
    after = [
      "network-online.target"
      "tailscaled.service"
      "hitl-image-load-phone.service"
      "hitl-phone-adb.service"
    ];
    wants = [ "network-online.target" "hitl-image-load-phone.service" "hitl-phone-adb.service" ];
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
        "--privileged=false"
        # No raw-USB isolation tree: the C6 tty is passed as a component device, and the phone
        # is driven via the host adb server (not passed into the env).
        "--raw-usb=false"
        # Host networking: the env reaches the host adb server on 127.0.0.1:5037, serves the app
        # + driver WS on the host, and `adb reverse`s them to the phone. Per-unit sshd ports
        # avoid collisions (the env's sshd binds HITL_SSH_PORT). Same model as the SDR bench.
        "--net-host"
        "--mount /run/dbus/system_bus_socket:/run/dbus/system_bus_socket"
        "--state-dir /var/lib/hitl-phone"
        "--broker-url http://127.0.0.1:${toString apiPort}"
      ];
      StateDirectory = "hitl-phone";
      Restart = "on-failure";
      RestartSec = 3;
    };
  };

  # Reach the daemon API + the published env sshd ports over the tailnet/LAN.
  networking.firewall.allowedTCPPorts = [ apiPort ] ++ unitPorts;

  # The agent uid (hitl-agent, 1000, from hitl-sdr.nix) needs the kvm group so the in-env
  # emulator can open /dev/kvm.
  users.users.hitl-agent.extraGroups = [ "kvm" ];
}
