"""splanc_image.bootconfig: the on-Pi half of the flash-time settings."""

import os

from splanc_image import bootconfig as bc


def boot(tmp_path, conf=None, connections=None, keys=None):
    b = tmp_path / "boot"
    b.mkdir()
    if conf is not None:
        (b / bc.CONF_NAME).write_bytes(conf.encode() if isinstance(conf, str) else conf)
    for name, body in (connections or {}).items():
        (b / bc.CONNECTIONS_DIR).mkdir(exist_ok=True)
        (b / bc.CONNECTIONS_DIR / name).write_text(body)
    if keys is not None:
        (b / bc.AUTHORIZED_KEYS).write_text(keys)
    return bc.Paths(
        boot=str(b), nm=str(tmp_path / "nm"), run=str(tmp_path / "run"), ssh=str(tmp_path / "ssh")
    )


def run(paths, calls=None):
    calls = calls if calls is not None else []
    log = []
    s = bc.apply(
        paths,
        set_hostname=lambda h: calls.append(("hostname", h)) or True,
        set_country=lambda c: calls.append(("country", c)) or True,
        chown_root=False,
        log=log.append,
    )
    return s, calls, log


KEYFILE = (
    "[connection]\nid=splanc-wifi\ntype=wifi\n[wifi]\nssid=Home\n[wifi-security]\npsk=secret\n"
)


def test_parse_conf_validates_and_normalizes():
    s = bc.parse_conf(
        "﻿# comment\r\nHOSTNAME=Living-Room\r\nWIFI_COUNTRY=gb\nOLED='spi'\n"
        "SPLANC_RELAY=wss://relay.example/x\nOLED_ROTATE=9\nPATH=/evil\nnonsense\n"
        'SPLANC_DISPLAY_HDMI="off"\nSPLANC_AUTO_UPDATE=0\n'
    )
    assert s.values == {
        "HOSTNAME": "living-room",
        "WIFI_COUNTRY": "GB",
        "OLED": "spi",
        "SPLANC_RELAY": "wss://relay.example/x",
        "SPLANC_DISPLAY_HDMI": "off",
        "SPLANC_AUTO_UPDATE": "0",
    }
    assert len(s.ignored) == 3  # OLED_ROTATE=9, PATH, nonsense


def test_relay_url_cannot_smuggle_shell_or_env():
    for bad in ["wss://x $(reboot)", "file:///etc/passwd", "wss://a`b`"]:
        assert "SPLANC_RELAY" not in bc.parse_conf(f"SPLANC_RELAY={bad}").values


def test_hostname_rules():
    ok = ["splanc-bridge", "a", "kitchen2", "x" * 63]
    bad = ["-lead", "trail-", "under_score", "dot.ted", "x" * 64, "spa ce", ""]
    for h in ok:
        assert bc.parse_conf(f"HOSTNAME={h}").hostname == h
    for h in bad:
        assert bc.parse_conf(f"HOSTNAME={h}").hostname == bc.DEFAULT_HOSTNAME


def test_apply_full(tmp_path):
    paths = boot(
        tmp_path,
        conf="HOSTNAME=kitchen\nWIFI_COUNTRY=de\nSPLANC_RELAY=wss://r.example\n",
        connections={
            "splanc-wifi.nmconnection": KEYFILE,
            "junk.nmconnection": "hello",
            "x.txt": "x",
        },
        keys="ssh-ed25519 AAAA one\nnot a key\n",
    )
    s, calls, log = run(paths)
    assert ("hostname", "kitchen") in calls and ("country", "DE") in calls
    nm = tmp_path / "nm" / "splanc-wifi.nmconnection"
    assert nm.read_text() == KEYFILE
    assert oct(os.stat(nm).st_mode & 0o777) == "0o600"
    # the PSK is moved off the FAT partition; non-keyfiles are left alone
    conns = tmp_path / "boot" / bc.CONNECTIONS_DIR
    assert sorted(os.listdir(conns)) == ["junk.nmconnection", "x.txt"]
    assert not (tmp_path / "nm" / "junk.nmconnection").exists()
    env = (tmp_path / "run" / "bridge.env").read_text()
    assert "SPLANC_RELAY=wss://r.example\n" in env and "HOSTNAME" not in env
    assert (tmp_path / "ssh" / "authorized_keys").read_text() == "ssh-ed25519 AAAA one\n"


def test_apply_is_idempotent_and_merges_keys(tmp_path):
    paths = boot(tmp_path, keys="ssh-ed25519 AAAA one\n")
    run(paths)
    (tmp_path / "boot" / bc.AUTHORIZED_KEYS).write_text("ssh-ed25519 AAAA one\nssh-rsa BBBB two\n")
    run(paths)
    run(paths)
    assert (tmp_path / "ssh" / "authorized_keys").read_text().splitlines() == [
        "ssh-ed25519 AAAA one",
        "ssh-rsa BBBB two",
    ]


def test_empty_boot_partition_is_a_noop_with_defaults(tmp_path):
    paths = boot(tmp_path)
    s, calls, _ = run(paths)
    assert s.hostname == bc.DEFAULT_HOSTNAME
    assert [c for c in calls if c[0] == "country"] == []
    assert (tmp_path / "run" / "bridge.env").read_text().startswith("#")
    assert not (tmp_path / "nm").exists()


def test_a_new_profile_later_replaces_the_old_one(tmp_path):
    paths = boot(tmp_path, connections={"splanc-wifi.nmconnection": KEYFILE})
    run(paths)
    newer = KEYFILE.replace("ssid=Home", "ssid=Office")
    (tmp_path / "boot" / bc.CONNECTIONS_DIR).mkdir()
    (tmp_path / "boot" / bc.CONNECTIONS_DIR / "splanc-wifi.nmconnection").write_text(newer)
    run(paths)
    assert "ssid=Office" in (tmp_path / "nm" / "splanc-wifi.nmconnection").read_text()


def test_main_without_boot_partition(tmp_path):
    assert bc.main(["--boot", str(tmp_path / "missing")]) == 0
