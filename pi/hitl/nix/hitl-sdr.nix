# amd-rig — the x86_64 SDR HITL bench system config. A FUNCTION of the
# hitl-reserve module source (`hitlSrc`), returning an appModule for mkSbcProject
# (flake.nix applies it when $SBC_BOARD_FAMILY == "x86_64"). It is the SDR
# counterpart of nix/hitl-app.nix (the Pi rigs): same reservation daemon +
# per-reservation container model, but this host offers ONE composite reservable
# unit — an ESP32-C6 wired next to a HackRF One, reserved together as a single
# atomic unit for reverse-engineering the ESP32's lower-layer WiFi/BT stacks.
#
# Deliberately trimmed vs hitl-app.nix: NO provisioning AP (amd-rig's uplink is
# wired Ethernet; the C6 is driven directly, not onboarded over WiFi), NO FX2
# logic analyzer, NO usbip/Pi-3 quirks. The reservation environment carries the
# ESP32 toolbox AND the SDR toolbox (hackrf CLI + GNU Radio/gr-osmosdr) — see
# nix/container.nix `withSdr`.
#
# BLE-in-reservation is intentionally NOT wired here: the generalized hitl-reserve
# daemon mounts no system D-Bus socket into the environment (BLE/HCI capture is one
# of the pieces PR #165 left on the managerd path, not yet generalized), so shipping
# the onboard RTL8852B BT firmware + a dbus policy would be dead weight. Add both
# when the daemon gains a --mount/dbus seam (follow-up).
{ hitlSrc }:
{ config, pkgs, lib, ... }:
let
  hitl = pkgs.callPackage ./packages.nix { src = hitlSrc; };
  # The reservation environment image, with the SDR toolbox layered onto the ESP32
  # toolbox (withSdr). imageRef must match container.nix's name:tag.
  image = pkgs.callPackage ./container.nix {
    inherit pkgs;
    withSdr = true;
  };
  imageRef = "hitl-sdr:latest";
  # The declarative catalog baked into the image (single source of truth, shared
  # with the //pi/hitl/reserve Bazel consumer). Declares the composite unit.
  catalogFile = ../reserve/catalog-sdr.json;

  apiPort = 8087; # daemon API (reached over the tailnet)
  sshPort = 2222; # published environment sshd port for the composite unit
  # Only one unit here, but open a small range so a future extra unit (or a
  # restart mid-teardown) never lacks a port. Matches the catalog ssh_port_base.
  maxUnits = 4;
  unitPorts = lib.genList (i: sshPort + i) maxUnits;
in
{
  # Headless bench: drop the NixOS manual + man-page closure.
  documentation.enable = false;
  documentation.nixos.enable = false;

  # Podman for the per-reservation environment containers.
  virtualisation.podman.enable = true;
  virtualisation.containers.enable = true;

  # Tailscale — agents reach amd-rig over the tailnet (its uplink is wired, but the
  # tailnet is how the fleet + agents address it uniformly). The auth key is
  # pre-seeded out of band to authKeyFile (never in git / the nix store, per
  # sbc-base's secrets policy); tailscaled-autoconnect runs `tailscale up` from it
  # on a fresh state dir and is a no-op once logged in. --ssh lets agents SSH in
  # with tailnet identity. The tailnet hostname IS the system hostname (amd-rig).
  services.tailscale = {
    enable = true;
    authKeyFile = "/var/lib/tailscale/authkey";
    extraUpFlags = [ "--ssh" "--hostname=${config.networking.hostName}" ];
  };

  # mDNS: resolve LAN *.local (nssmdns4) + run avahi so a *.local address a client
  # passes reaches the LAN, matching the Pi rigs' behaviour.
  services.avahi = {
    enable = true;
    nssmdns4 = true;
  };

  # `tailscale up` only sets --hostname on a fresh login; pin it on every boot with
  # `tailscale set` (a no-op once correct) so the name sticks across redeploys.
  systemd.services.tailscale-hostname = {
    description = "Pin the tailscale device hostname to the system hostname";
    after = [ "tailscaled.service" "tailscaled-autoconnect.service" ];
    wants = [ "tailscaled.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ts=${config.services.tailscale.package}/bin/tailscale
      for _ in $(seq 1 30); do "$ts" status >/dev/null 2>&1 && break; sleep 2; done
      "$ts" set --hostname=${config.networking.hostName} || true
    '';
  };

  # Let the environment's non-root agent open the reserved boards' raw USB: the C6's
  # built-in USB-JTAG (libusb: openocd/gdb) and the HackRF (libhackrf). Both device
  # nodes are otherwise root-only; the environment runs privileged (single unit) so
  # it sees the whole bus, and these rules make the specific boards world-writable.
  services.udev.extraRules = ''
    # ESP32-C6 built-in USB-JTAG/serial.
    SUBSYSTEM=="usb", ATTR{idVendor}=="303a", MODE="0666"
    # HackRF One (Great Scott Gadgets).
    SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="6089", MODE="0666"
  '';

  # --- WiFi + BT: a full host protocol stack for the agent to drive the ESP -------
  # The RE workflow is "capture the PHY on the SDR while a mature stack drives the
  # real protocol against the ESP". amd-rig has an onboard Realtek RTL8852B combo
  # (PCIe Wi-Fi rtw89_8852be + USB BT hci0), but the slim base image omits their
  # firmware so both are dead. Ship redistributable firmware so rtw89 + the rtl_bt
  # BT half come up. (mkForce in case the base slims it.)
  hardware.enableRedistributableFirmware = lib.mkForce true;

  # Bluetooth: host bluetoothd (BlueZ) powered on at boot; the reservation env
  # drives it over the system D-Bus socket (mounted by the daemon's --mount below),
  # so the agent gets full BlueZ — central AND peripheral, BLE + classic.
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;

  # Wi-Fi radio (wlan*) is left UNMANAGED by NetworkManager so the reservation agent
  # has raw control to run it as an AP (hostapd) or STA (wpa_supplicant) or in
  # monitor mode (iw) — NM would otherwise fight those. amd-rig's uplink is wired
  # Ethernet, so nothing here needs the WiFi radio for connectivity.
  networking.networkmanager.unmanaged = [ "interface-name:wl*" ];

  # Radios can boot soft-blocked; unblock at startup so wlan/hci come up ready.
  systemd.services.hitl-rfkill-unblock = {
    description = "Unblock all rfkill switches (WiFi/BT) for the SDR bench";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-rfkill.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.util-linux}/bin/rfkill unblock all";
    };
  };

  # The reservation env's agent runs as uid 1000; the host needs a matching passwd
  # entry or the system D-Bus rejects its BlueZ connections (D-Bus won't accept a
  # uid it can't resolve). No login — purely for credential resolution. (Same as the
  # Pi rigs' hitl-app.nix.)
  users.groups.hitl-agent.gid = 1000;
  users.users.hitl-agent = {
    uid = 1000;
    group = "hitl-agent";
    isNormalUser = true;
    createHome = false;
    home = "/var/empty";
    shell = "${pkgs.shadow}/bin/nologin";
    description = "uid match for the HITL reservation agent (D-Bus)";
  };

  # Let the reservation env (its agent user, over the mounted system D-Bus) drive
  # org.bluez. Permissive, but this is a single-purpose bench. (Same as hitl-app.nix.)
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

  # `hitl` CLI (handy on the box), usbutils for lsusb/bus ids, the HackRF CLI, and
  # the WiFi/BT stack host-side too (iw/wpa_supplicant/hostapd/bluez) for driving or
  # debugging the radios directly on the box outside a reservation.
  environment.systemPackages = [
    hitl
    pkgs.usbutils
    pkgs.hackrf
    pkgs.iw
    pkgs.wpa_supplicant
    pkgs.hostapd
    pkgs.bluez
    pkgs.util-linux # rfkill
  ];

  # Load the reservation image into Podman at boot and on every deploy (the
  # ExecStart store path changes with the image, so switch-to-configuration re-runs
  # it). Clear stale hitl containers + untag the old image first so `podman load`
  # can move the tag to the freshly-built image (see hitl-app.nix for the why).
  systemd.services.hitl-image-load = {
    description = "Load the HITL SDR environment image into podman";
    wantedBy = [ "multi-user.target" ];
    before = [ "hitl-manager.service" ];
    after = [ "network.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "hitl-image-load" ''
        set -u
        pm=${pkgs.podman}/bin/podman
        ids=$($pm ps -aq --filter label=hitl=1 2>/dev/null || true)
        [ -n "$ids" ] && $pm rm -f $ids 2>/dev/null || true
        $pm untag ${imageRef} 2>/dev/null || true
        $pm load -i ${image}
      '';
    };
  };

  # The reservation daemon (hitl-reserved, from the hitl-reserve module). Reads the
  # baked SDR catalog for its one composite unit. Runs environments PRIVILEGED and
  # with raw-USB isolation OFF: this is a single-unit, single-purpose bench, and the
  # HackRF is a raw-USB SDR with no serial tty (so the tty->port isolation path
  # can't reach it) — privileged exposes the whole /dev/bus/usb, which includes both
  # the C6 and the HackRF, and the udev rules above open their nodes to the agent.
  systemd.services.hitl-manager = {
    description = "HITL reservation manager (SDR bench)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscaled.service" "hitl-image-load.service" ];
    wants = [ "network-online.target" "hitl-image-load.service" ];
    # Force switch-to-configuration to RESTART the daemon whenever its binary or the
    # catalog changes (a live switch once left the OLD daemon running; see hitl-app.nix).
    restartTriggers = [ "${hitl}/bin/hitl-reserved" "${catalogFile}" ];
    unitConfig.StartLimitIntervalSec = 0;
    # getent resolves a *.local address host-side (nss-mdns); podman/openssh for the
    # reservation environment.
    path = [ pkgs.podman pkgs.iproute2 pkgs.openssh pkgs.getent ];
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${hitl}/bin/hitl-reserved"
        "--addr :${toString apiPort}"
        "--catalog ${catalogFile}"
        "--workspace splanc"
        # Canonical host name: used for BOTH the metrics/status `host` label AND the
        # reservation endpoint clients dial. Un-suffixed (MagicDNS resolves the bare
        # name over the tailnet), same convention as the Pi rigs.
        "--host ${config.networking.hostName}"
        "--image ${imageRef}"
        "--podman ${pkgs.podman}/bin/podman"
        # Single-unit bench: privileged (reaches the tty-less HackRF's raw USB),
        # per-unit raw-USB isolation off (nothing to isolate from).
        "--privileged=true"
        "--raw-usb=false"
        # Host networking so the reservation env can drive amd-rig's WiFi radio
        # directly (nl80211: iw/wpa_supplicant/hostapd) — the SDR agent gets a full
        # protocol stack to talk to the ESP while capturing on the HackRF. Safe here
        # because this host has exactly one unit (net-host units would otherwise
        # collide on sshd ports); the env's sshd binds the unit port via HITL_SSH_PORT.
        "--net-host"
        # Share the host system D-Bus socket so the env's BlueZ tooling (bluetoothctl
        # /hitl-ble) drives the host bluetoothd for full BT (BLE + classic, central +
        # peripheral). --mount skips it if absent, so it's harmless when bluetoothd is
        # down. (Same mechanism the Pi rigs use for in-container BLE.)
        "--mount /run/dbus/system_bus_socket:/run/dbus/system_bus_socket"
        "--state-dir /var/lib/hitl"
        "--broker-url http://host.containers.internal:${toString apiPort}"
      ];
      StateDirectory = "hitl";
      Restart = "on-failure";
      RestartSec = 3;
      # Runs as root: manages Podman + USB devices.
    };
  };

  # Reach the daemon API + the published environment sshd over the tailnet. The
  # uplink/LAN is Ethernet; keep the LAN openings too (MVP) — tighten to
  # tailscale-only later by dropping allowedTCPPorts.
  networking.firewall.trustedInterfaces = [ "tailscale0" ];
  networking.firewall.allowedTCPPorts = [ apiPort ] ++ unitPorts;
}
