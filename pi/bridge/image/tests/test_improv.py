"""splanc_image.improv + wifi_profiles: Improv-over-BLE WiFi provisioning on the bridge.

The load-bearing property: a network sent from the phone app over Improv is
stored exactly as the flasher stores one (byte-identical keyfile for the same
SSID/PSK), next to the networks the bridge already knows, deduplicated by SSID.
"""

import asyncio
import os

import improv_codec as codec
import pytest
from splanc_flasher import bootfiles as bf
from splanc_image import improv, wifi_profiles

# tricky_wifi.py's keyfile-hostile pair (what the VM test reads back with nmcli),
# plus a few more: list separator, escapes, comment/assignment chars, non-ASCII,
# leading/trailing spaces, a digits-only SSID, the 32-byte maximum.
TRICKY = [
    (" Café;Wi\\Fi #1 ", " p\\a;ss#wo=rd "),
    ("123", "password1"),
    ("16;17;", "semi;colon#hash=eq"),
    ("Home", "~!@$%^&*()_+{}|:\"<>?`-[]',./"),
    ("x" * 32, "a" * 63),
    ("Cafe Guest", ""),
    ("hexkey", "A" * 64),
]


def app_rpc(ssid: str, psk: str) -> bytes:
    """The bytes the phone app writes (web/src/net/improv.ts buildWifiSettings)."""
    s, p = ssid.encode(), psk.encode()
    body = bytes([0x01, 2 + len(s) + len(p), len(s)]) + s + bytes([len(p)]) + p
    return body + bytes([sum(body) & 0xFF])


class FakeNm:
    """nmcli stand-in: a scan list, an active connection, scripted `up` results."""

    def __init__(self, ssids=(), up_rc=0, active=None, ip="192.168.4.23"):
        self.ssids = list(ssids)
        self.up_rc = up_rc
        self.active = active
        self.ip = ip
        self.calls = []

    async def __call__(self, *args):
        self.calls.append(args)
        if args[:3] == ("-t", "-f", "SSID"):
            esc = [s.replace("\\", "\\\\").replace(":", "\\:") for s in self.ssids]
            return 0, "\n".join(["", *esc]) + "\n"  # hidden networks list as ""
        if args[:3] == ("-t", "-f", "UUID,TYPE"):
            return 0, (f"{self.active}:802-11-wireless\n" if self.active else "")
        if "up" in args and args[0] == "--wait" and args[1] != "0":
            return self.up_rc, "" if self.up_rc == 0 else "Error: Connection activation failed"
        if args[:3] == ("-t", "-f", "DEVICE,TYPE,STATE"):
            state = "connected" if self.up_rc == 0 else "disconnected"
            return 0, f"eth0:ethernet:unavailable\nwlan0:wifi:{state}\nlo:loopback:connected\n"
        if args[:2] == ("-g", "IP4.ADDRESS"):
            return 0, f"{self.ip}/24\n"
        return 0, ""


async def _nosleep(_s):
    return None


def joiner(tmp_path, nm, logs=None):
    return improv.Joiner(
        nm_dir=str(tmp_path / "nm"),
        run=nm,
        log=(logs.append if logs is not None else (lambda m: None)),
        sleep=_nosleep,
        chown_root=False,
    )


def provision(tmp_path, nm, ssid, psk, logs=None):
    """The device side end to end: the app's RPC bytes -> the Pi codec -> join."""
    parsed = codec.parse_rpc(app_rpc(ssid, psk))
    assert parsed is not None and parsed[0] == codec.CMD_WIFI_SETTINGS
    got_ssid, got_psk = codec.parse_wifi(parsed[1])
    return asyncio.run(joiner(tmp_path, nm, logs).join(got_ssid, got_psk))


def stored(tmp_path):
    d = tmp_path / "nm"
    return {p: (d / p).read_text() for p in sorted(os.listdir(d))} if d.exists() else {}


def uuid_of(text):
    return next(ln[5:] for ln in text.splitlines() if ln.startswith("uuid="))


@pytest.mark.parametrize("ssid,psk", TRICKY)
def test_improv_keyfile_is_byte_identical_to_the_flashers(tmp_path, ssid, psk):
    url = provision(tmp_path, FakeNm(ssids=[ssid]), ssid, psk)
    assert url == "http://192.168.4.23/#splanc-bridge"
    files = stored(tmp_path)
    assert list(files) == ["splanc-wifi.nmconnection"]  # the flasher's file name
    body = files["splanc-wifi.nmconnection"]
    assert body == bf.render_nmconnection(bf.Wifi(ssid, psk), conn_uuid=uuid_of(body))
    st = os.stat(tmp_path / "nm" / "splanc-wifi.nmconnection")
    assert st.st_mode & 0o777 == 0o600


def test_rpc_with_a_bad_checksum_never_reaches_the_store(tmp_path):
    pkt = bytearray(app_rpc("Home", "password1"))
    pkt[-1] ^= 0xFF
    assert codec.parse_rpc(bytes(pkt)) is None


def test_adds_alongside_flash_time_network_and_joins_fresh(tmp_path):
    nm = tmp_path / "nm"
    nm.mkdir()
    flash = bf.render_nmconnection(
        bf.Wifi("Home", "password1"), conn_uuid="1" * 8 + "-1111-1111-1111-" + "1" * 12
    )
    (nm / "splanc-wifi.nmconnection").write_text(flash)
    fake = FakeNm(ssids=["Home", "Venue"], active="1" * 8 + "-1111-1111-1111-" + "1" * 12)
    assert provision(tmp_path, fake, "Venue", "venue-pass")
    files = stored(tmp_path)
    assert files["splanc-wifi.nmconnection"] == flash  # untouched
    venue = files["splanc-wifi-2.nmconnection"]
    assert venue == bf.render_nmconnection(
        bf.Wifi("Venue", "venue-pass"), conn_uuid=uuid_of(venue), conn_id="splanc-wifi-2"
    )
    # fresh scan first, then load + activate the new profile by uuid
    assert fake.calls[0][-2:] == ("--rescan", "yes")
    assert ("connection", "load", str(nm / "splanc-wifi-2.nmconnection")) in fake.calls
    up = [c for c in fake.calls if "up" in c]
    assert up[0][-1] == uuid_of(venue)


def test_same_ssid_replaces_in_place_and_same_creds_still_rejoin(tmp_path):
    fake = FakeNm(ssids=["Home"])
    provision(tmp_path, fake, "Home", "old-password")
    first = stored(tmp_path)["splanc-wifi.nmconnection"]
    provision(tmp_path, fake, "Home", "new-password")
    files = stored(tmp_path)
    assert list(files) == ["splanc-wifi.nmconnection"]  # no duplicate
    assert uuid_of(files["splanc-wifi.nmconnection"]) == uuid_of(first)
    assert "psk=new-password" in files["splanc-wifi.nmconnection"]
    # Identical creds again: never a no-op — scan and `connection up` every time.
    fake.calls.clear()
    provision(tmp_path, fake, "Home", "new-password")
    assert any("--rescan" in c for c in fake.calls)
    assert any(c[:1] == ("--wait",) and "up" in c for c in fake.calls)


def test_dedupe_matches_a_hand_written_plain_ssid_profile(tmp_path):
    nm = tmp_path / "nm"
    nm.mkdir()
    (nm / "home.nmconnection").write_text(
        "[connection]\nid=My Home\nuuid=22222222-2222-2222-2222-222222222222\ntype=wifi\n"
        "[wifi]\nssid=My\\sHome\n[wifi-security]\nkey-mgmt=wpa-psk\npsk=oldoldold\n"
    )
    provision(tmp_path, FakeNm(ssids=["My Home"]), "My Home", "newnewnew")
    files = stored(tmp_path)
    assert list(files) == ["home.nmconnection"]
    body = files["home.nmconnection"]
    # an id with a space isn't one we write: it gets a splanc-wifi id, same uuid
    assert "id=splanc-wifi\n" in body and "uuid=22222222-2222-2222-2222-222222222222" in body


def test_failed_join_restores_everything_and_rejoins_previous(tmp_path):
    nm = tmp_path / "nm"
    nm.mkdir()
    home_uuid = "33333333-3333-3333-3333-333333333333"
    flash = bf.render_nmconnection(bf.Wifi("Home", "password1"), conn_uuid=home_uuid)
    (nm / "splanc-wifi.nmconnection").write_text(flash)
    logs = []
    fake = FakeNm(ssids=["Home", "Venue"], up_rc=4, active=home_uuid)
    assert provision(tmp_path, fake, "Venue", "wrong-pass", logs) is None
    assert stored(tmp_path) == {"splanc-wifi.nmconnection": flash}
    assert fake.calls[-1] == ("--wait", "0", "connection", "up", "uuid", home_uuid)
    # a wrong password for the SAME network puts the working profile back
    assert provision(tmp_path, fake, "Home", "typo-pass", logs) is None
    assert stored(tmp_path) == {"splanc-wifi.nmconnection": flash}


def test_unseen_ssid_is_tried_as_hidden(tmp_path):
    fake = FakeNm(ssids=["Other"])
    assert provision(tmp_path, fake, "Stealth", "password1")
    assert sum(1 for c in fake.calls if "--rescan" in c) == improv.SWEEPS
    body = stored(tmp_path)["splanc-wifi.nmconnection"]
    assert body == bf.render_nmconnection(
        bf.Wifi("Stealth", "password1", hidden=True), conn_uuid=uuid_of(body)
    )


def test_unseen_and_unjoinable_is_unable_to_connect(tmp_path):
    assert provision(tmp_path, FakeNm(ssids=[], up_rc=4), "Gone", "password1") is None
    assert stored(tmp_path) == {}


@pytest.mark.parametrize("psk", ["short", "x" * 64, "tab\there1"])
def test_psk_the_flasher_would_refuse_is_refused_before_touching_nm(tmp_path, psk):
    fake = FakeNm(ssids=["Home"])
    assert provision(tmp_path, fake, "Home", psk) is None
    assert fake.calls == [] and stored(tmp_path) == {}


def test_join_wait_fits_the_apps_timeout(tmp_path):
    fake = FakeNm(ssids=["Home"])
    provision(tmp_path, fake, "Home", "password1")
    up = next(c for c in fake.calls if c[:1] == ("--wait",))
    assert improv.MIN_JOIN_S <= int(up[1]) <= improv.BUDGET_S < 45


def test_terse_fields_unescapes():
    assert improv.terse_fields("a\\:b:c\\\\d:") == ["a:b", "c\\d", ""]


def test_keyfile_ssid_forms():
    assert wifi_profiles.keyfile_ssid("77;121;") == b"My"
    assert wifi_profiles.keyfile_ssid("\\sMy\\\\Net") == b" My\\Net"
