# HITL rig — Pi system config: Podman, Tailscale, the reservation daemon, and
# the test container image. Passed to mkSbcProject as an appModule.
#
# Hardware-dependent bits (ESP32 device path, USBIP bind, BT controller, the
# Tailscale auth key) are MVP placeholders — see DESIGN.md "Open items".
{ config, pkgs, lib, ... }:
let
  hitl = pkgs.callPackage ./packages.nix { };
  image = pkgs.callPackage ./container.nix { inherit pkgs; };
  imageRef = "hitl-test:latest"; # matches container.nix name:tag

  apiPort = 8087; # daemon API (reached over the tailnet)
  sshPort = 2222; # published container sshd port

  # ESP32-C6 passthrough (MVP): the serial tty. Hardware-dependent — override to
  # the real node / switch to USBIP once the bus id is known.
  devices = [ "/dev/ttyACM0" ];
in
{
  # Podman for the per-reservation test containers.
  virtualisation.podman.enable = true;
  virtualisation.containers.enable = true;

  # Tailscale — agents reach the rig over the tailnet. MVP: run `tailscale up`
  # once by hand (or set services.tailscale.authKeyFile to a provisioned secret).
  services.tailscale.enable = true;

  # USBIP host modules (attach the dev board into the container) — skeleton;
  # binding the specific bus id is done by a udev rule once known.
  boot.kernelModules = [ "usbip-host" "vhci-hcd" ];

  # The `hitl` CLI is handy on the rig too; usbutils for lsusb/bus ids.
  environment.systemPackages = [ hitl pkgs.usbutils ];

  # Load the test image into Podman at boot.
  systemd.services.hitl-image-load = {
    description = "Load the HITL test container image into podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.podman}/bin/podman load -i ${image}";
    };
  };

  # The reservation daemon.
  systemd.services.hitl-manager = {
    description = "HITL reservation manager";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscaled.service" "hitl-image-load.service" ];
    wants = [ "network-online.target" "hitl-image-load.service" ];
    path = [ pkgs.podman pkgs.iproute2 pkgs.openssh ];
    serviceConfig = {
      ExecStart =
        lib.concatStringsSep " " [
          "${hitl}/bin/hitl-managerd"
          "--addr :${toString apiPort}"
          "--rig ${config.networking.hostName}"
          "--host ${config.networking.hostName}"
          "--image ${imageRef}"
          "--ssh-port ${toString sshPort}"
          "--podman ${pkgs.podman}/bin/podman"
          "--state-dir /var/lib/hitl"
        ]
        + lib.concatMapStrings (d: " --device ${d}") devices;
      StateDirectory = "hitl";
      Restart = "on-failure";
      RestartSec = 3;
      # Runs as root: manages Podman + USB devices. Tighten once the exact
      # device/cap grants are known.
    };
  };

  # Reach the daemon API + the published container sshd over the tailnet.
  networking.firewall.trustedInterfaces = [ "tailscale0" ];
}
