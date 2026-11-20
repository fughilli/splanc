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


# --- restore bundle (tools/bridge_migrate) -----------------------------------------

import hashlib  # noqa: E402
import json  # noqa: E402
import stat  # noqa: E402

import pytest  # noqa: E402

IDENT = json.dumps(
    {"v": 1, "key": {"private_pkcs8": "PRIV", "public_raw": "PUB"}, "bridges": {"r": "BID"}}
)


def restore_card(tmp_path, files=None, manifest_extra=None, tamper=None):
    """A boot partition carrying splanc-restore/ (as `bridge_migrate restore --card`)."""
    files = {"bridge.json": IDENT, "config/hub.json": '{"players": {}}'} if files is None else files
    paths = boot(tmp_path)
    paths.state = str(tmp_path / "var/lib/splanc-bridge")
    root = os.path.join(paths.boot, bc.RESTORE_DIR)
    ents = []
    for rel, body in files.items():
        p = os.path.join(root, "state", *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(body)
        ents.append(
            {
                "path": rel,
                "size": len(body.encode()),
                "sha256": hashlib.sha256(body.encode()).hexdigest(),
            }
        )
    m = {"format": bc.RESTORE_FORMAT, "v": 1, "bridge_ids": {"r": "BID"}, "files": ents}
    m.update(manifest_extra or {})
    with open(os.path.join(root, "manifest.json"), "w") as f:
        json.dump(m, f)
    if tamper:
        with open(os.path.join(root, "state", tamper), "r+b") as f:
            f.seek(5)
            f.write(b"X")  # same size, different bytes
    return paths


def result(paths):
    with open(os.path.join(paths.boot, bc.RESTORE_RESULT)) as f:
        return f.read()


def test_restore_bundle_is_imported_then_removed_from_the_card(tmp_path):
    paths = restore_card(tmp_path)
    _, _, log = run(paths)
    with open(os.path.join(paths.state, "bridge.json")) as f:
        assert f.read() == IDENT
    for p in ["bridge.json", "config/hub.json"]:
        assert stat.S_IMODE(os.stat(os.path.join(paths.state, p)).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(paths.state).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(os.path.join(paths.state, "config")).st_mode) == 0o700
    assert not os.path.exists(os.path.join(paths.boot, bc.RESTORE_DIR))
    assert result(paths).startswith("ok ") and "BID" in result(paths)
    assert "PRIV" not in "\n".join(log) + result(paths)


def test_restore_keeps_the_files_it_replaces(tmp_path):
    paths = restore_card(tmp_path)
    os.makedirs(paths.state)
    with open(os.path.join(paths.state, "bridge.json"), "w") as f:
        f.write("the identity the first boot made")
    run(paths)
    saved = [d for d in os.listdir(paths.state) if d.startswith("pre-restore-")]
    assert len(saved) == 1
    with open(os.path.join(paths.state, saved[0], "bridge.json")) as f:
        assert f.read() == "the identity the first boot made"


@pytest.mark.parametrize(
    "files,tamper,why",
    [
        ({"bridge.json": IDENT}, "bridge.json", "checksum"),
        ({"config/hub.json": "{}"}, None, "no bridge.json"),
        ({"bridge.json": '{"v": 1}'}, None, "not a usable bridge identity"),
    ],
)
def test_a_bad_restore_bundle_changes_nothing(tmp_path, files, tamper, why):
    paths = restore_card(tmp_path, files=files, tamper=tamper)
    _, _, log = run(paths)
    assert not os.path.exists(paths.state)
    assert why in result(paths) and "Nothing was changed" in result(paths)
    assert os.path.isdir(os.path.join(paths.boot, bc.RESTORE_DIR))  # left to look at
    assert any("NOT imported" in m for m in log)


@pytest.mark.parametrize(
    "rel", ["../etc/shadow", "/etc/passwd", ".ssh/x", "a/../../b", "a\\b", "a//b", "-x"]
)
def test_restore_paths_cannot_escape_the_state_dir(tmp_path, rel):
    assert not bc.safe_rel_path(rel)
    paths = restore_card(tmp_path)
    mp = os.path.join(paths.boot, bc.RESTORE_DIR, "manifest.json")
    with open(mp) as f:
        m = json.load(f)
    m["files"].append({"path": rel, "size": 0, "sha256": hashlib.sha256(b"").hexdigest()})
    with open(mp, "w") as f:
        json.dump(m, f)
    run(paths)
    assert not os.path.exists(paths.state)
    assert "bad or repeated path" in result(paths)


def test_a_bundle_is_never_imported_twice(tmp_path):
    import shutil

    paths = restore_card(tmp_path)
    keep = str(tmp_path / "copy")
    shutil.copytree(os.path.join(paths.boot, bc.RESTORE_DIR), keep)
    run(paths)
    with open(os.path.join(paths.state, "bridge.json"), "w") as f:
        f.write("newer state the bridge wrote since")
    # The FAT partition kept the bundle (say, removal failed): a reboot must not roll back.
    shutil.copytree(keep, os.path.join(paths.boot, bc.RESTORE_DIR))
    _, _, log = run(paths)
    with open(os.path.join(paths.state, "bridge.json")) as f:
        assert f.read() == "newer state the bridge wrote since"
    assert any("already imported" in m for m in log)
    assert not os.path.exists(os.path.join(paths.boot, bc.RESTORE_DIR))


def test_restore_chowns_to_the_bridge_user(tmp_path, monkeypatch):
    paths = restore_card(tmp_path)
    chowned = []
    monkeypatch.setattr(
        bc.os, "chown", lambda p, u, g: chowned.append((os.path.relpath(p, paths.state), u, g))
    )
    bc.apply(
        paths,
        set_hostname=lambda h: True,
        set_country=lambda c: True,
        chown_root=False,
        state_owner=(1234, 5678),
        log=lambda m: None,
    )
    owned = {p for p, u, g in chowned if (u, g) == (1234, 5678)}
    assert {
        ".",
        "config",
        "bridge.json.restore-tmp",
        "config/hub.json.restore-tmp",
        bc.RESTORE_MARK,
    } <= owned


def test_no_restore_bundle_is_a_no_op(tmp_path):
    paths = boot(tmp_path)
    paths.state = str(tmp_path / "state")
    run(paths)
    assert not os.path.exists(paths.state)
    assert not os.path.exists(os.path.join(paths.boot, bc.RESTORE_RESULT))
