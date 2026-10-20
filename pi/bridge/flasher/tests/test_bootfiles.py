"""The settings the flasher writes onto the card (and that the image reads back)."""

import configparser
import os

import pytest
from splanc_flasher import bootfiles as bf


def parse_keyfile(text):
    cp = configparser.ConfigParser(interpolation=None, comment_prefixes=("#",), delimiters=("=",))
    cp.optionxform = str
    cp.read_string(text)
    return cp


def glib_unescape(v):
    """GLib g_key_file_get_string()'s unescaping (\\s \\n \\t \\r \\\\)."""
    out, i = [], 0
    while i < len(v):
        c = v[i]
        if c == "\\" and i + 1 < len(v):
            out.append({"s": " ", "n": "\n", "t": "\t", "r": "\r", "\\": "\\"}[v[i + 1]])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def ssid_from_bytes(v):
    assert v.endswith(";")
    return bytes(int(x) for x in v[:-1].split(";")).decode("utf-8")


@pytest.mark.parametrize(
    "ssid",
    ["Home", "123", "16;17;", " lead and trail ", "Café ☕", "back\\slash", "#hash=eq", "x" * 32],
)
def test_ssid_round_trips_as_bytes(ssid):
    kf = parse_keyfile(bf.render_nmconnection(bf.Wifi(ssid=ssid, psk="password1"), conn_uuid="u"))
    raw = kf["wifi"]["ssid"]
    assert set(raw) <= set("0123456789;")  # always the unambiguous byte-list form
    assert ssid_from_bytes(raw) == ssid


@pytest.mark.parametrize(
    "psk",
    [
        "password1",
        " leading space",
        "trailing space ",
        "back\\slash\\\\",
        "semi;colon#hash=eq",
        "~!@$%^&*()_+{}|:\"<>?`-[]',./",
        "a" * 63,
    ],
)
def test_psk_round_trips_through_glib_escaping(psk):
    text = bf.render_nmconnection(bf.Wifi(ssid="Home", psk=psk), conn_uuid="u")
    line = next(ln for ln in text.splitlines() if ln.startswith("psk="))
    value = line[len("psk=") :]
    assert not value.startswith(" ") and not value.endswith(" ")  # GLib would strip them
    assert glib_unescape(value) == psk


def test_hex_psk_and_open_network():
    hexkey = "a" * 64
    assert f"psk={hexkey}" in bf.render_nmconnection(bf.Wifi("Home", hexkey))
    text = bf.render_nmconnection(bf.Wifi("Cafe Guest", ""))
    assert "[wifi-security]" not in text


def test_hidden_flag_and_structure():
    kf = parse_keyfile(
        bf.render_nmconnection(bf.Wifi("Home", "password1", hidden=True), conn_uuid="u")
    )
    assert kf["connection"]["type"] == "wifi"
    assert kf["connection"]["id"] == "splanc-wifi"
    assert kf["wifi"]["hidden"] == "true"
    assert kf["wifi-security"]["key-mgmt"] == "wpa-psk"
    assert kf["ipv4"]["method"] == "auto"


def test_comment_line_cannot_break_the_file():
    text = bf.render_nmconnection(bf.Wifi("evil\n[connection]\nid=x", "password1"))
    assert [ln for ln in text.splitlines() if ln.startswith("[connection")] == ["[connection]"]
    assert not any(ln.startswith("id=x") for ln in text.splitlines())


@pytest.mark.parametrize(
    "psk,ok",
    [
        ("", True),
        ("1234567", False),
        ("12345678", True),
        ("x" * 63, True),
        ("x" * 64, False),
        ("A" * 64, True),  # 64 hex digits = raw key
        ("pässword", False),
        ("tab\there", False),
    ],
)
def test_psk_rules(psk, ok):
    if ok:
        bf.check_psk(psk)
    else:
        with pytest.raises(bf.InvalidSetting):
            bf.check_psk(psk)


def test_ssid_rules():
    bf.check_ssid("x" * 32)
    for bad in ["", "x" * 33, "é" * 17]:
        with pytest.raises(bf.InvalidSetting):
            bf.check_ssid(bad)


@pytest.mark.parametrize(
    "name,host",
    [
        ("Living Room", "living-room"),
        ("  Kitchen #2 ", "kitchen-2"),
        ("splanc-bridge", "splanc-bridge"),
        ("Ünïcode", "n-code"),
        ("---", None),
        ("", None),
        ("a" * 80, "a" * 63),
    ],
)
def test_slug_hostname(name, host):
    assert bf.slug_hostname(name) == host


def test_relay_country_ssh_validation():
    assert bf.check_country("de") == "DE"
    assert bf.check_relay("wss://relay.example/x") == "wss://relay.example/x"
    for bad in ["file:///etc/passwd", "wss://a b", "wss://x$(id)"]:
        with pytest.raises(bf.InvalidSetting):
            bf.check_relay(bad)
    with pytest.raises(bf.InvalidSetting):
        bf.check_country("USA")
    assert bf.ssh_key_lines("ssh-ed25519 AAAA me\n\n") == ["ssh-ed25519 AAAA me"]
    with pytest.raises(bf.InvalidSetting):
        bf.ssh_key_lines("-----BEGIN OPENSSH PRIVATE KEY-----")


def boot_dir(tmp_path):
    d = tmp_path / "FIRMWARE"
    d.mkdir()
    (d / "config.txt").write_text("[all]\n")
    return d


def test_write_boot_config(tmp_path):
    d = boot_dir(tmp_path)
    written = bf.write_boot_config(
        str(d),
        wifi=bf.Wifi("Home", "password1"),
        hostname="kitchen",
        country="GB",
        relay="wss://r.example",
        ssh_keys=["ssh-ed25519 AAAA me"],
    )
    names = sorted(os.path.relpath(p, d) for p in written)
    assert names == sorted(
        [
            "splanc-bridge.conf",
            os.path.join("system-connections", "splanc-wifi.nmconnection"),
            "authorized_keys",
        ]
    )
    conf = (d / "splanc-bridge.conf").read_text()
    assert (
        "HOSTNAME=kitchen\n" in conf
        and "WIFI_COUNTRY=GB\n" in conf
        and "SPLANC_RELAY=wss://r.example\n" in conf
    )


def test_write_boot_config_refuses_a_non_boot_partition(tmp_path):
    with pytest.raises(FileNotFoundError):
        bf.write_boot_config(str(tmp_path), wifi=bf.Wifi("Home", "password1"))


def test_round_trip_with_the_image_parser(tmp_path):
    """What the flasher writes is exactly what the Pi applies (splanc_image.bootconfig)."""
    bc = pytest.importorskip("splanc_image.bootconfig")
    d = boot_dir(tmp_path)
    bf.write_boot_config(
        str(d),
        wifi=bf.Wifi(" Café;1 ", " pa\\ss word "),
        hostname=bf.slug_hostname("Living Room"),
        country="nz",
        relay="wss://relay.example/v1",
    )
    paths = bc.Paths(
        boot=str(d), nm=str(tmp_path / "nm"), run=str(tmp_path / "run"), ssh=str(tmp_path / "ssh")
    )
    calls = []
    s = bc.apply(
        paths,
        set_hostname=lambda h: calls.append(h) or True,
        set_country=lambda c: calls.append(c) or True,
        chown_root=False,
        log=lambda m: None,
    )
    assert s.ignored == []
    assert s.values == {
        "HOSTNAME": "living-room",
        "WIFI_COUNTRY": "NZ",
        "SPLANC_RELAY": "wss://relay.example/v1",
    }
    assert calls == ["living-room", "NZ"]
    assert (tmp_path / "nm" / "splanc-wifi.nmconnection").exists()
    assert not (d / "system-connections").exists()  # the PSK left the FAT partition
