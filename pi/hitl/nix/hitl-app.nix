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
  sshPort = 2222; # published container sshd port for the first DUT

  # ESP32-C6 passthrough (MVP): the serial tty. Hardware-dependent — override to
  # the real node / switch to USBIP once the bus id is known.
  devices = [ "/dev/ttyACM0" ];

  # DUTs on this rig. Each DUT gets its own container, published sshd port, and
  # /dev nodes, run concurrently. A node mapping is "host" or "host:container";
  # pin each DUT's serial tty to /dev/ttyACM0 inside the container so the toolbox
  # (hitl-flash/monitor, which default to /dev/ttyACM0) works on every DUT.
  #
  # Default: auto-discover. The daemon enumerates the ESP32-C6 boards attached to
  # the host by their stable /dev/serial/by-id/* symlinks and builds one DUT per
  # board (sequential name/port from sshPort, tty pinned to /dev/ttyACM0, JTAG
  # serial filled in) — so plugging in a second board Just Works with no config.
  #
  # To pin an explicit set instead, set autoDiscover = false and list each board
  # by its stable by-id path on a distinct port, e.g.:
  #   duts = [
  #     { name = "c6-0"; sshPort = 2222;
  #       devices = [ "/dev/serial/by-id/usb-1a86_…-if00:/dev/ttyACM0" ];
  #       env = { HITL_ADAPTER_SERIAL = "…"; }; }  # optional: select this board's USB-JTAG
  #     { name = "c6-1"; sshPort = 2223;
  #       devices = [ "/dev/serial/by-id/usb-1a86_…-if00:/dev/ttyACM0" ]; }
  #   ];
  autoDiscover = true;
  # Ports opened for discovered DUTs (they're assigned at runtime, sequentially
  # from sshPort, so we open a fixed range up front).
  discoverMaxDuts = 8;

  # Run reservation containers UNprivileged so each is confined to its own DUT's
  # tty (mounted as /dev/ttyACM0) plus the USB bus — a privileged container
  # bind-mounts the whole host /dev, leaking every DUT's /dev/ttyACM* into every
  # container. Flip back to true only to debug a device/cap the confined path is
  # missing. (HARDWARE-GATED: verify sshd + esptool + openocd still work here.)
  privilegedContainers = false;
  duts = [
    { name = "c6-0"; sshPort = sshPort; devices = devices; }
  ];

  # One --dut JSON flag per DUT for the daemon; a distinct sshd port each.
  dutFlags = lib.concatMapStringsSep " "
    (d: "--dut " + lib.escapeShellArg (builtins.toJSON {
      name = d.name;
      ssh_port = d.sshPort;
      devices = d.devices;
      env = d.env or { };
    }))
    duts;
  # DUT config passed to the daemon: live discovery, or the explicit --dut list.
  # Discovery polls /dev/serial/by-id, so boards hot-plugged after boot attach
  # without a restart; --discover-max-duts must match the opened port range below.
  dutArgs =
    if autoDiscover
    then "--discover --ssh-port ${toString sshPort} --discover-max-duts ${toString discoverMaxDuts}"
    else dutFlags;
  # sshd ports to open in the firewall: the discovery range, or the explicit ports.
  dutPorts =
    if autoDiscover
    then lib.genList (i: sshPort + i) discoverMaxDuts
    else map (d: d.sshPort) duts;

  # Provisioning AP: the onboard WiFi radio is a DEDICATED, always-on 2.4 GHz
  # access point (the rig's uplink is Ethernet, so the radio isn't shared with a
  # STA). DUTs are ImprovBLE-provisioned onto it — no external WiFi. A dedicated
  # radio means a fixed 2.4 GHz channel and none of the single-radio AP+STA
  # co-channel fragility. SSID is unique per rig; the PSK is world-readable in the
  # store (same posture as wifi.yaml) and the harness fetches both from the daemon
  # (`hitl wifi`), so it's never typed by hand.
  # AP interface. On the analyzer rig it's a DEDICATED USB WiFi radio (RTL8851BU),
  # renamed to ap0 by the systemd .link below — the Pi 3's onboard brcmfmac can't
  # reliably host an AP, so the USB radio owns the AP and wlan0 is free for STA.
  # The Pi 5 rig keeps its single-radio wlan0 AP. (isAnalyzerRig is defined below;
  # nix `let` bindings are order-independent.)
  apIface = if isAnalyzerRig then "ap0" else "wlan0";
  apConn = "hitl-ap";
  apChannel = 6; # fixed 2.4 GHz channel; the C6 is 2.4-only
  apSsid = "hitl-${config.networking.hostName}";
  apPsk = "hitl-${config.networking.hostName}-provision"; # ≥8 chars; override for a fixed one

  # Shared logic analyzer (an FX2/fx2lafw "Saleae clone") — present only on the Pi
  # 3 logic-analyzer rig variant. sbc-deploy injects the board via $SBC_BOARD at
  # (impure) eval, so this single appModule yields BOTH a lean Pi 5 rig image (no
  # sigrok closure, capture broker dormant) and a Pi 3 image with capture wired —
  # no second flake. Fail-safe: an unset/other board leaves the analyzer off.
  #
  # The FX2 is a RIG-LEVEL instrument the daemon owns (never passed into a
  # container): the daemon serves captures over POST /capture, mapping each DUT to
  # its channel subset so one 8-channel analyzer taps several DUTs (a couple of
  # channels each). See internal/analyzer and DESIGN.md.
  sigrok = import ./sigrok.nix { inherit pkgs; };
  isAnalyzerRig = builtins.getEnv "SBC_BOARD" == "raspberry-pi-3";
  # Dedicated USB AP radio for the analyzer rig: the out-of-tree rtw89 (RTL8851BU)
  # driver + WiFi firmware built against this kernel (see rtl8851bu.nix). Paired
  # with usb_modeswitch (the dongle boots as a CD-ROM) and a .link that renames it
  # to ap0. rtw89 is mac80211-based, so it supports hostapd AP cleanly.
  rtl8851bu = config.boot.kernelPackages.callPackage ./rtl8851bu.nix { };
  # DUT → analyzer channels. The sole DUT's WS2812 DIN (the C6's GPIO20 / PIN20)
  # is wired to the analyzer's CH6 = D6 on hitl-rig-la-1. Add per-DUT entries
  # (keyed by the discovered c6-<serial> name, e.g. "c6-1a2b3c" = { channels =
  # [ "D1" ]; ... }) as boards are wired to more channels.
  analyzerChannelMap = builtins.toJSON {
    "default" = { channels = [ "D6" ]; protocol = "ws2812"; };
  };
  analyzerArgs = lib.optionals isAnalyzerRig [
    "--analyzer-driver"
    "fx2lafw"
    "--analyzer-sigrok"
    sigrok.cli
    "--analyzer-samplerate"
    "24m"
    "--analyzer-channel-map"
    (lib.escapeShellArg analyzerChannelMap)
  ];
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
  boot.kernelModules = [ "usbip-host" "vhci-hcd" ]
    # rtw89 is built with -DCONFIG_RTW89_LEDS_MC, so rtw89_core_git needs
    # led-class-multicolor's symbols; load it first so the driver resolves them.
    ++ lib.optionals isAnalyzerRig [ "led-class-multicolor" "rtw89_8851bu_git" ];

  # Dedicated USB AP radio (RTL8851BU / rtw89) on the analyzer rig. A post-boot
  # module (not initrd/kernel), so it rides the deploy_live layer — no SD reimage.
  # udev autoloads it once usb_modeswitch flips the dongle into WiFi mode.
  boot.extraModulePackages = lib.optionals isAnalyzerRig [ rtl8851bu ];

  # rtw89 loads rtw8851b_fw-1.bin from /lib/firmware/rtw89; our driver derivation
  # ships it (nixpkgs' linux-firmware predates 8851BU). No WiFi without it.
  hardware.firmware = lib.optionals isAnalyzerRig [ rtl8851bu ];

  # Stable name for the USB AP radio: rename the rtw89 AP interface (driver
  # rtw89_8851bu_git, the usb_driver's KBUILD_MODNAME) to ap0 so the AP profile
  # targets it regardless of wlanN enumeration order. Applied by systemd-udevd.
  systemd.network.links = lib.optionalAttrs isAnalyzerRig {
    "10-hitl-ap" = {
      matchConfig.Driver = "rtw89_8851bu_git";
      linkConfig.Name = "ap0";
    };
  };

  # Bluetooth controller (hci0) for BLE central: agents scan/connect to the DUT's
  # GATT from inside the container via bleak, which drives the host bluetoothd
  # over the system D-Bus socket (mounted into the container by the daemon).
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;

  # Let the container's non-root agent open the C6's raw USB (libusb: openocd/gdb
  # over the built-in USB-JTAG); the device nodes are otherwise root-only.
  services.udev.extraRules = ''
    SUBSYSTEM=="usb", ATTR{idVendor}=="303a", MODE="0666"
  '' + lib.optionalString isAnalyzerRig ''
    # FX2/fx2lafw logic analyzer, both the bare-clone VID:PID and the fx2lafw one
    # it re-enumerates to after firmware upload. World-writable on this
    # single-purpose bench; the daemon (root) owns it, this is belt-and-suspenders.
    SUBSYSTEM=="usb", ATTR{idVendor}=="0925", ATTR{idProduct}=="3881", MODE="0666"
    SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="608c", MODE="0666"
    # Dedicated USB AP dongle (RTL8851BU): it enumerates as a CD-ROM (0bda:1a2b);
    # StandardEject flips it into WiFi mode (re-enumerates as 0bda:b851) so the
    # rtw89_8851bu_git driver binds and the .link renames it to ap0.
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="1a2b", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 0bda -p 1a2b -K"
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
  environment.systemPackages = [ hitl pkgs.usbutils pkgs.linuxPackages.usbip ]
    # sigrok-cli + fx2lafw firmware, and usb-modeswitch for the USB AP dongle.
    ++ lib.optionals isAnalyzerRig (sigrok.packages ++ [ pkgs.usb-modeswitch ]);

  # Load the test image into Podman at boot (and on every deploy — the ExecStart
  # store path changes with the image, so switch-to-configuration re-runs this).
  systemd.services.hitl-image-load = {
    description = "Load the HITL test container image into podman";
    wantedBy = [ "multi-user.target" ];
    before = [ "hitl-manager.service" ];
    after = [ "network.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      # `podman load` will NOT move ${imageRef} to the freshly-built image while the
      # tag is still held by an old image that a (stale) reservation container
      # references — the container keeps running the old image and container.nix
      # changes silently never reach the rig. Clear stale hitl containers and untag
      # the old image first, then load. Reservation containers are ephemeral and
      # recreated per reservation, so removing them on a redeploy is safe.
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

  # Provisioning AP — an always-on NetworkManager AP on the dedicated WiFi radio
  # (wlan0). autoconnect=true with a high priority so it owns wlan0 on boot and
  # stays up (the uplink is Ethernet; nothing else should claim the radio — any
  # STA profile that could is dropped, see below). A fixed 2.4 GHz channel (the
  # C6's band) since there's no STA to co-channel with. ipv4.method=shared → NM's
  # built-in dnsmasq gives DHCP + NAT on 10.42.0.0/24 (gw 10.42.0.1), NAT'd out
  # via Ethernet.
  networking.networkmanager.ensureProfiles.profiles.${apConn} = {
    connection = {
      id = apConn;
      type = "wifi";
      interface-name = apIface;
      autoconnect = "true";
      autoconnect-priority = "999";
    };
    wifi = {
      mode = "ap";
      ssid = apSsid;
      band = "bg";
      channel = toString apChannel;
    };
    wifi-security = {
      key-mgmt = "wpa-psk";
      proto = "rsn";
      psk = apPsk;
    };
    ipv4.method = "shared";
    ipv6.method = "ignore";
  };

  # Let the rig's reservation containers reach DUTs on the AP. NM's shared mode
  # (ipv4.method=shared) installs a private nft table `nm-shared-<iface>` whose
  # filter_forward chain ends in `oifname <iface> reject` — it blocks every NEW
  # connection forwarded INTO the AP subnet (shared mode expects clients to reach
  # OUT, not to be reached). That silently drops podman-bridge → wlan0 → DUT, so an
  # agent's container can't poke the device. NM regenerates that table on every AP
  # (re)activation, so re-insert an allow for the podman bridge on each `up` via a
  # dispatcher (idempotent). Scope is the local podman bridge only, not arbitrary
  # forwarding into the AP.
  networking.networkmanager.dispatcherScripts = [{
    type = "basic";
    source = pkgs.writeShellScript "hitl-ap-container-forward" ''
      iface="$1"; action="$2"
      [ "$iface" = "${apIface}" ] || exit 0
      case "$action" in up | dhcp4-change | connectivity-change) ;; *) exit 0 ;; esac
      tbl="nm-shared-${apIface}"
      rule='iifname "podman0" oifname "${apIface}" accept'
      ${pkgs.nftables}/bin/nft list chain ip "$tbl" filter_forward 2>/dev/null | grep -qF "$rule" \
        || ${pkgs.nftables}/bin/nft insert rule ip "$tbl" filter_forward \
             iifname "podman0" oifname "${apIface}" accept 2>/dev/null || true
    '';
  }];

  # The radio is AP-only. autoconnect-priority=999 above means NM always brings
  # the AP up on wlan0 in preference to any (baked or seeded) STA profile — an AP
  # connection can always activate, so it wins the device over a lower-priority
  # STA. The uplink is Ethernet, so no STA is needed here.

  # The reservation daemon.
  systemd.services.hitl-manager = {
    description = "HITL reservation manager";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscaled.service" "hitl-image-load.service" ];
    wants = [ "network-online.target" "hitl-image-load.service" ];
    # networkmanager (nmcli) toggles the AP; iw/iproute2 create the AP vif on
    # demand; sigrok-cli (analyzer rig only) captures the DUT's tapped LED line.
    path = [ pkgs.podman pkgs.iproute2 pkgs.openssh ]
      ++ lib.optionals isAnalyzerRig sigrok.packages;
    serviceConfig = {
      ExecStart =
        lib.concatStringsSep " " ([
          "${hitl}/bin/hitl-managerd"
          "--addr :${toString apiPort}"
          "--rig ${config.networking.hostName}"
          # Advertised host (display/fallback); the CLI overrides it with the
          # address it actually used to reach the API. `.local` resolves on the LAN.
          "--host ${config.networking.hostName}.local"
          "--image ${imageRef}"
          "--podman ${pkgs.podman}/bin/podman"
          "--privileged=${lib.boolToString privilegedContainers}"
          "--state-dir /var/lib/hitl"
          # Reservation containers reach the daemon's shared analyzer over the
          # podman host gateway; keep the port in sync with --addr above.
          "--container-capture-url http://host.containers.internal:${toString apiPort}"
          # The AP is always-on (NM autoconnect); the daemon only advertises its
          # creds in /status for the harness (`hitl wifi`). It does NOT toggle the
          # AP — no --ap-conn — so per-reservation AP control (internal/ap) stays
          # dormant, ready for the future multi-DUT design.
          "--ap-ssid ${apSsid}"
          "--ap-psk ${apPsk}"
          dutArgs
        ] ++ analyzerArgs); # --analyzer-* only on the logic-analyzer rig
      # libsigrok uploads fx2lafw firmware to the bare FX2 from here (analyzer rig).
      Environment = lib.optionals isAnalyzerRig [ "SIGROK_FIRMWARE_DIR=${sigrok.firmwareDir}" ];
      StateDirectory = "hitl";
      Restart = "on-failure";
      RestartSec = 3;
      # Runs as root: manages Podman + USB devices. Tighten once the exact
      # device/cap grants are known.
    };
  };

  # Reach the daemon API + the published container sshd over the tailnet. Trust the
  # provisioning-AP interface too, so the DUT gets DHCP and the container can reach
  # it (DHCP/DNS from NM's shared-mode dnsmasq + the ws tunnel to the DUT).
  networking.firewall.trustedInterfaces = [ "tailscale0" apIface ];
  # MVP/testing: also reach them over the LAN (mDNS). Tighten to tailscale-only
  # for production by dropping these. One published sshd port per DUT.
  networking.firewall.allowedTCPPorts = [ apiPort ] ++ dutPorts;
}
