# Improv-over-BLE WiFi provisioning for the bridge (splanc_image/improv.py):
# the Splanc phone app's "Add device over Bluetooth" puts the bridge onto a new
# WiFi network, as it does a player. The network is stored like the flasher's
# (a NetworkManager keyfile from the flasher's own renderer, 0600 root in
# /etc/NetworkManager/system-connections), added next to the known ones and
# deduplicated by SSID; NetworkManager then roams between them.
#
# The BLE side is the LED Mapper Pi's Improv service
# (pi/provisioning/nix/improv: bless GATT peripheral over BlueZ + the C6
# firmware's codec), reused as is; only the join is bridge-specific.
#
# Advertises whenever the service runs (always), like the Pi player's sbc-improv:
# moving the bridge to a venue whose network it doesn't know is exactly when
# it's on no network, and re-provisioning a connected bridge must work too.
{ config, lib, pkgs, ... }:
let
  # bless -> dbus-fast (async D-Bus; no GObject stack). Its own small env: the
  # display's pyEnv doesn't need BLE, and this one doesn't need Pillow/luma.
  pyEnv = pkgs.python3.withPackages (ps: [ ps.bless ]);

  improvPy = pkgs.runCommand "splanc-bridge-improv-py" { nativeBuildInputs = [ pyEnv ]; } ''
    mkdir -p $out/splanc_image $out/splanc_flasher
    # The Pi player's Improv GATT service + codec (top-level modules, as there).
    cp ${../../../provisioning/nix/improv/improv_ble_provision.py} $out/improv_ble_provision.py
    cp ${../../../provisioning/nix/improv/improv_codec.py} $out/improv_codec.py
    # The flasher's keyfile renderer (stdlib only), so both paths write the same bytes.
    cp ${../../flasher/splanc_flasher/__init__.py} $out/splanc_flasher/__init__.py
    cp ${../../flasher/splanc_flasher/bootfiles.py} $out/splanc_flasher/bootfiles.py
    cp ${../splanc_image/__init__.py} $out/splanc_image/__init__.py
    cp ${../splanc_image/wifi_profiles.py} $out/splanc_image/wifi_profiles.py
    cp ${../splanc_image/improv.py} $out/splanc_image/improv.py
    python3 -m compileall -q $out
    # Smoke: everything imports with this exact environment (bless included).
    PYTHONPATH=$out python3 -c 'import splanc_image.improv, improv_ble_provision'
  '';
in
{
  # BlueZ (bluetoothd) with the adapter powered at boot so the peripheral can
  # advertise. The Pi's BT firmware is already in the image (sbc-base keeps
  # raspberrypiWirelessFirmware).
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;

  systemd.services.splanc-improv = {
    description = "Splanc bridge Improv-over-BLE WiFi provisioning";
    # Started when a Bluetooth adapter shows up (systemd's udev rules pull in
    # bluetooth.target then): no adapter (the QEMU test VM), no service.
    wantedBy = [ "bluetooth.target" ];
    wants = [ "bluetooth.service" ];
    # After flash-config: it sets the hostname, which is the advertised name.
    after = [ "bluetooth.service" "NetworkManager.service" "splanc-flash-config.service" ];
    unitConfig.StartLimitIntervalSec = 0;
    environment = {
      PYTHONPATH = "${improvPy}";
      PYTHONUNBUFFERED = "1";
      PYTHONDONTWRITEBYTECODE = "1";
      IMPROV_NMCLI = "${config.networking.networkmanager.package}/bin/nmcli";
    };
    serviceConfig = {
      Type = "simple";
      # Root: it owns org.bluez GATT/advertisement objects, drives NetworkManager
      # over D-Bus and writes its keyfile store (as splanc-flash-config does).
      ExecStart = "${pyEnv}/bin/python3 -m splanc_image.improv";
      Restart = "always";
      RestartSec = 5;
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ReadWritePaths = [ "/etc/NetworkManager/system-connections" ];
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectControlGroups = true;
      ProtectClock = true;
      RestrictNamespaces = true;
      RestrictRealtime = true;
      LockPersonality = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_NETLINK" ];
    };
  };
}
