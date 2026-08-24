# Improv-over-BLE Wi-Fi provisioning for the LED Mapper Pi.
#
# The Pi-side counterpart of the ESP32-C6 firmware's improv_ble.cpp: it
# advertises the SAME Improv BLE GATT service and is provisioned by the SAME
# clients (the web app's net/improv.ts over Web Bluetooth, and the headless
# tools/ble_onboard_server.py test driver) — so a Pi onboards exactly like an
# ESP32. The Python service (improv/improv_ble_provision.py) is a byte-for-byte
# port of improv_codec.h; it hands received credentials to NetworkManager
# (`nmcli device wifi connect`) and reports the joined IP back as the redirect
# URL, the way the firmware reports its STA IP.
{ pkgs, ... }:
let
  # BLE GATT peripheral over BlueZ (bless → dbus-fast, async; no GObject deps).
  pyEnv = pkgs.python3.withPackages (ps: [ ps.bless ]);

  # The service shells out to `nmcli`; wrap it onto PATH (and pass an absolute
  # path too, since a systemd unit's PATH is minimal).
  improvBle = pkgs.runCommand "ledmapper-improv-ble"
    { nativeBuildInputs = [ pkgs.makeWrapper ]; }
    ''
      mkdir -p "$out/bin" "$out/libexec"
      # Both modules land side by side: improv_ble_provision.py imports
      # improv_codec.py, and Python puts the script's own dir on sys.path.
      cp ${./improv/improv_ble_provision.py} "$out/libexec/improv_ble_provision.py"
      cp ${./improv/improv_codec.py} "$out/libexec/improv_codec.py"
      makeWrapper ${pyEnv}/bin/python3 "$out/bin/improv-ble" \
        --add-flags "$out/libexec/improv_ble_provision.py" \
        --prefix PATH : "${pkgs.networkmanager}/bin" \
        --set IMPROV_NMCLI "${pkgs.networkmanager}/bin/nmcli"
    '';
in
{
  # Enable the BlueZ stack (bluetooth.service + bluetoothd). The Pi's own BT
  # firmware is already kept by sbc-base.nix (raspberrypiWirelessFirmware); this
  # brings up hci0 and powers it on at boot so the peripheral can advertise.
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;

  services.sbcApps.improv = {
    description = "LED Mapper Improv-over-BLE Wi-Fi provisioning";
    package = improvBle;
    exec = "bin/improv-ble";
    # Runs as root: it owns org.bluez GATT/advertisement objects and drives
    # NetworkManager over D-Bus (no dedicated-user D-Bus/polkit plumbing needed).
    # NetworkManager itself writes the connection profile, so the strict
    # ProtectSystem sandbox needs no extra ReadWritePaths.
    user = "root";
    createUser = false;
    after = [ "bluetooth.service" "NetworkManager.service" ];
    wants = [ "bluetooth.service" ];
    environment = {
      PYTHONUNBUFFERED = "1";
      IMPROV_DEVICE_NAME = "ledmapper";
    };
  };
}
