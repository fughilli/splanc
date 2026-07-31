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
  # Headless rig: drop the NixOS manual + man-page closure (groff/texinfo/aspell/…),
  # which otherwise dominates the image and deploy download.
  documentation.enable = false;
  documentation.nixos.enable = false;

  # Podman for the per-reservation test containers.
  virtualisation.podman.enable = true;
  virtualisation.containers.enable = true;

  # Tailscale — agents reach the rig over the tailnet, so a move/reflash can't
  # strand it (WiFi alone did, once). The auth key is pre-seeded out of band to
  # authKeyFile (never in git or the nix store, per sbc-base's secrets policy);
  # tailscaled-autoconnect runs `tailscale up` from it on a fresh state dir (e.g.
  # after a reflash) and is a no-op once already logged in. --ssh lets agents SSH
  # to the rig over the tailnet with tailnet identity instead of managed keys.
  services.tailscale = {
    enable = true;
    authKeyFile = "/var/lib/tailscale/authkey";
    extraUpFlags = [ "--ssh" "--hostname=hitl-rig" ];
  };

  # USBIP host modules (attach the dev board into the container / to a remote).
  # Confirmed present in the nixos-raspberrypi kernel (usbip-host/vhci-hcd .ko).
  boot.kernelModules = [ "usbip-host" "vhci-hcd" ];

  # Bluetooth controller (hci0) for BLE central: agents scan/connect to the DUT's
  # GATT from inside the container via bleak, which drives the host bluetoothd
  # over the system D-Bus socket (mounted into the container by the daemon).
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;

  # Let the container's non-root agent open the C6's raw USB (libusb: openocd/gdb
  # over the built-in USB-JTAG); the device nodes are otherwise root-only.
  services.udev.extraRules = ''
    SUBSYSTEM=="usb", ATTR{idVendor}=="303a", MODE="0666"
  '';

  # The container's agent runs as uid 1000; the host needs a matching passwd entry
  # or the system D-Bus rejects its BLE connections (D-Bus won't accept a uid it
  # can't resolve). No login — this exists purely for credential resolution.
  users.groups.hitl-agent.gid = 1000;
  users.users.hitl-agent = {
    uid = 1000;
    group = "hitl-agent";
    isNormalUser = true;
    createHome = false;
    home = "/var/empty";
    shell = "${pkgs.shadow}/bin/nologin";
    description = "uid match for the HITL container agent (D-Bus)";
  };

  # Let the container (its agent user, over the mounted system D-Bus) drive
  # org.bluez for BLE central. Permissive, but this is a single-purpose bench.
  services.dbus.packages = [
    (pkgs.writeTextDir "share/dbus-1/system.d/hitl-bluetooth.conf" ''
      <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
       "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
      <busconfig>
        <policy context="default">
          <allow send_destination="org.bluez"/>
          <allow send_destination="org.bluez" send_interface="org.freedesktop.DBus.Properties"/>
          <allow send_destination="org.bluez" send_interface="org.freedesktop.DBus.ObjectManager"/>
        </policy>
      </busconfig>
    '')
  ];

  # The `hitl` CLI is handy on the rig too; usbutils for lsusb/bus ids, usbip for
  # bind/attach.
  environment.systemPackages = [ hitl pkgs.usbutils pkgs.linuxPackages.usbip ];

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
          # Advertised host (display/fallback); the CLI overrides it with the
          # address it actually used to reach the API. `.local` resolves on the LAN.
          "--host ${config.networking.hostName}.local"
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
  # MVP/testing: also reach them over the LAN (mDNS). Tighten to tailscale-only
  # for production by dropping these.
  networking.firewall.allowedTCPPorts = [ apiPort sshPort ];
}
