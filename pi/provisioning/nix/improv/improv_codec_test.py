"""Pins the Pi codec bytes against tools/ble_onboard_server.py (the provisioner
side) so the Pi cannot drift from the ESP32 firmware / web app. Run:

    python3 pi/provisioning/nix/improv/improv_codec_test.py
"""

import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import improv_codec as codec  # noqa: E402


def _load_onboard():
    # tools/ble_onboard_server.py imports simplepyble lazily inside functions, so
    # loading the module for its pure codec helpers is safe without BLE deps.
    path = HERE.parents[3] / "tools" / "ble_onboard_server.py"
    spec = importlib.util.spec_from_file_location("ble_onboard_server", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ob = _load_onboard()

    # 1. The provisioner's wifi-settings RPC must parse on the device side, and
    #    round-trip to the same (ssid, pass).
    ssid, pw = "BigVibes", "s3cr3t-pass"
    rpc = ob._build_wifi_rpc(ssid, pw)  # bytes the phone/app writes
    parsed = codec.parse_rpc(rpc)
    assert parsed is not None, "device rejected a valid RPC"
    cmd, data = parsed
    assert cmd == codec.CMD_WIFI_SETTINGS, cmd
    assert codec.parse_wifi(data) == (ssid, pw), codec.parse_wifi(data)

    # Open network (empty password) — the firmware accepts pl == 0.
    rpc0 = ob._build_wifi_rpc("Guest", "")
    cmd0, data0 = codec.parse_rpc(rpc0)
    assert codec.parse_wifi(data0) == ("Guest", ""), codec.parse_wifi(data0)

    # 2. The device's redirect result must decode with the provisioner's parser
    #    back to the exact URL string.
    url = "http://192.168.7.42/"
    result = codec.build_result(codec.CMD_WIFI_SETTINGS, url)
    assert ob._parse_result(result) == [url], ob._parse_result(result)

    # 3. Checksum + structural rejections (mirrors improv_parse_rpc == -1).
    assert codec.parse_rpc(b"\x01") is None  # too short
    bad = bytearray(rpc)
    bad[-1] ^= 0xFF  # corrupt checksum
    assert codec.parse_rpc(bytes(bad)) is None
    # ssid_len that overruns the payload.
    assert codec.parse_wifi(bytes([5, 65, 66, 0])) is None
    assert codec.parse_wifi(bytes([0, 0])) is None  # empty ssid rejected

    print("improv_codec_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
