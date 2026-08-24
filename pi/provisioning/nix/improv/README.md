# Improv-over-BLE Wi-Fi provisioning (Pi side)

The Raspberry Pi counterpart of the ESP32-C6 firmware's Improv BLE onboarding
(`firmware/player_app/improv_ble.cpp`). It advertises the **same** Improv BLE
GATT service + characteristics and speaks the **same** binary RPC, so a Pi is
provisioned by the **same** clients as an ESP32:

- the web app over Web Bluetooth (`web/src/net/improv.ts`), and
- the headless test driver `tools/ble_onboard_server.py`.

## Files

- `improv_codec.py` — dependency-free port of `firmware/player_app/improv_codec.h`
  (`[cmd, len, data…, checksum]`). `improv_codec_test.py` pins its bytes against
  `tools/ble_onboard_server.py`, so the Pi cannot drift from the firmware / app.
- `improv_ble_provision.py` — the GATT peripheral (via `bless` → BlueZ/dbus-fast,
  async) + the `AUTHORIZED → PROVISIONING → PROVISIONED` state machine. On a
  wifi-settings RPC it runs `nmcli device wifi connect` and reports the joined IP
  back as the redirect URL, exactly as the firmware reports its STA IP.
- `../improv.nix` — enables `hardware.bluetooth`, packages the service (wrapping
  `nmcli` onto PATH), and runs it as the `sbc-improv` systemd unit (as root, to
  own the org.bluez objects and drive NetworkManager over D-Bus). Wired into the
  flake via `appModules`.

## Test the codec locally

    python3 pi/provisioning/nix/improv/improv_codec_test.py

## Verify on a running board

    # discover it (improv:true, name "ledmapper")
    curl 'http://<host-with-BT>:8091/scan?seconds=8'
    # provision it onto a network
    curl -X POST 'http://<host-with-BT>:8091/provision?ssid=SSID&pass=SECRET'

    # on the board:
    journalctl -u sbc-improv -f
