"""tools/bridge_migrate: backup -> inspect -> restore (card + SSH) -> verify, against
fake bridge root filesystems and a fake `ssh` that runs the tool's scripts locally.

The card path is tested end to end with the image's own importer
(pi/bridge/image/splanc_image/bootconfig.py), so the two halves of the restore
bundle format can't drift apart.
"""

import io
import json
import os
import shutil
import stat
import sys
import tarfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bridge_migrate as bm  # noqa: E402

RELAY = "https://splanc.pages.dev"
BID = "ABCDEFGHIJKLMNOPQRST"
PRIV = "MC4CAQAwBQYDK2VwBCIEIPRIVATEKEYMATERIALxxxxxxxxxxxxxxxxxxxxxx"
PUB = "pubPUBpubPUBpubPUBpubPUBpubPUBpubPUBpub0123"
PSK = "correct-horse-battery"
TLS_KEY = "-----BEGIN PRIVATE KEY-----\nTLSSECRETKEY\n-----END PRIVATE KEY-----\n"
TICKET_HASH = "f" * 64
SECRETS = [PRIV, PSK, "TLSSECRETKEY", TICKET_HASH]


def identity(pub=PUB, priv=PRIV, bridges=None):
    return {
        "v": 1,
        "key": {"private_pkcs8": priv, "public_raw": pub},
        "bridges": {RELAY: BID} if bridges is None else bridges,
    }


def keyfile(conn_id, ssid, psk=PSK):
    ssid_list = ";".join(str(b) for b in ssid.encode()) + ";"
    return (
        f"[connection]\nid={conn_id}\nuuid=0b0d6a7e-0000-4000-8000-00000000000{len(conn_id) % 10}\n"
        f"type=wifi\n\n[wifi]\nssid={ssid_list}\n\n[wifi-security]\nkey-mgmt=wpa-psk\npsk={psk}\n"
    )


def put(root, rel, data, mode=0o600):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data.encode() if isinstance(data, str) else data)
    os.chmod(p, mode)
    return p


def old_bridge(root, state="paired", ident=None, with_status=True):
    """A pre-OTA (v1.0.x) image's root filesystem, after the agent updated itself."""
    put(
        root,
        "etc/splanc-bridge/image.json",
        json.dumps({"board": "pi5", "rev": "7afdc632c0de"}),
        0o644,
    )
    if with_status:
        put(
            root,
            "run/splanc-bridge/status.json",
            json.dumps(
                {
                    "v": 1,
                    "state": state,
                    "relay": RELAY,
                    "bridge_id": BID,
                    "paired_clients": [{"id": "g1"}, {"id": "g2"}],
                    "players": [{"name": "lamp"}],
                }
            ),
            0o640,
        )
    s = "var/lib/splanc-bridge/"
    put(root, s + "bridge.json", json.dumps(ident or identity(), indent=2))
    put(
        root,
        s + "config/hub.json",
        json.dumps(
            {"players": {"aa:bb": {"host": "10.0.0.5", "pin": "abc"}}, "groups": {}, "poses": {}}
        ),
        0o644,
    )
    put(
        root,
        s + "live-tls.json",
        json.dumps({"key": TLS_KEY, "cert": "C", "sha256": "ab" * 32, "notAfter": 2e12}),
    )
    put(
        root,
        s + "live-clients.json",
        json.dumps({"v": 1, "tickets": {"c1": {"hash": TICKET_HASH}}}),
    )
    put(
        root, s + "effects-library.json", json.dumps({"v": 1, "entries": {"e1": {}}, "sources": {}})
    )
    put(root, s + "bridge.json.tmp", "junk")
    put(root, s + "pre-restore-20260101T000000Z/bridge.json", "older")
    n = "etc/NetworkManager/system-connections/"
    put(root, n + "splanc-wifi.nmconnection", keyfile("splanc-wifi", "Home"))
    put(root, n + "splanc-wifi-2.nmconnection", keyfile("splanc-wifi-2", "Cabin"))
    put(root, "var/lib/splanc-ssh/authorized_keys", "ssh-ed25519 AAAAold owner@laptop\n")
    put(root, "boot/firmware/config.txt", "", 0o644)
    put(root, "boot/firmware/splanc-bridge.conf", "HOSTNAME=splanc-bridge\nOLED_ROTATE=2\n", 0o644)
    return root


FAKE_SSH = r"""#!/bin/sh
# ssh [-o x]... [-i key] target command  ->  run command locally (fake bridge).
for last; do :; done
export PATH="$FAKE_BIN:$PATH"
exec /bin/sh -c "$last"
"""

FAKE_SYSTEMCTL = r"""#!/bin/sh
echo "systemctl $*" >> "$FAKE_LOG"
if [ "$1" = start ] && [ "$2" = splanc-bridge.service ]; then
  "$FAKE_PY" - "$FAKE_ROOT" <<'EOF'
import json, os, sys
root = sys.argv[1]
ident = json.load(open(os.path.join(root, "var/lib/splanc-bridge/bridge.json")))
relay = "https://splanc.pages.dev"
os.makedirs(os.path.join(root, "run/splanc-bridge"), exist_ok=True)
bid = ident["bridges"].get(relay, "")
st = {"v": 1, "state": "paired" if bid == os.environ.get("FAKE_PAIRED_BID") else "unpaired",
      "relay": relay, "bridge_id": bid, "paired_clients": [{"id": "g1"}, {"id": "g2"}]}
json.dump(st, open(os.path.join(root, "run/splanc-bridge/status.json"), "w"))
EOF
fi
if [ "$1" = stop ]; then rm -f "$FAKE_ROOT/run/splanc-bridge/status.json"; fi
"""


@pytest.fixture
def env(tmp_path, monkeypatch):
    if not shutil.which("sha256sum") or not shutil.which("tar"):
        pytest.skip("needs GNU coreutils/tar (the bridge's tools)")
    fake_bin = tmp_path / "fakebin"
    fake_bin.mkdir()
    for name, body in {
        "systemctl": FAKE_SYSTEMCTL,
        "nmcli": '#!/bin/sh\necho "nmcli $*" >> "$FAKE_LOG"\n',
        "chown": '#!/bin/sh\necho "chown $*" >> "$FAKE_LOG"\n',
        "id": "#!/bin/sh\necho 0\n",
    }.items():
        p = fake_bin / name
        p.write_text(body)
        p.chmod(0o755)
    ssh = tmp_path / "ssh"
    ssh.write_text(FAKE_SSH)
    ssh.chmod(0o755)
    log = tmp_path / "remote.log"
    monkeypatch.setenv("BRIDGE_MIGRATE_SSH", str(ssh))
    monkeypatch.setenv("FAKE_BIN", str(fake_bin))
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_PY", sys.executable)
    monkeypatch.setenv("FAKE_PAIRED_BID", BID)
    monkeypatch.setattr(bm, "CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setattr(bm.time, "sleep", lambda s: None)

    class E:
        tmp = tmp_path

        def root(self, name, **kw):
            r = str(tmp_path / name)
            monkeypatch.setenv("FAKE_ROOT", r)
            return r

        def log(self):
            return log.read_text() if log.exists() else ""

    return E()


def run(*argv):
    return bm.main(list(argv))


def backup(env, root, *extra):
    out = str(env.tmp / "backups")
    rc = run(
        "backup",
        "--ssh",
        "splanc-bridge.local",
        "--remote-root",
        root,
        "--out",
        out,
        "--key",
        str(env.tmp / "nokey"),
        *extra,
    )
    files = sorted(os.listdir(out)) if os.path.isdir(out) else []
    return rc, (os.path.join(out, files[0]) if files else None)


def no_secrets(text):
    for s in SECRETS:
        assert s not in text, "a secret was printed"


# --------------------------------------------------------------------- backup ---


def test_backup_over_ssh_makes_a_private_verified_bundle(env, capsys):
    root = old_bridge(env.root("old"))
    rc, path = backup(env, root)
    assert rc == 0 and path
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
    assert BID in os.path.basename(path)
    assert "systemctl stop splanc-bridge.service" in env.log()

    b = bm.load_bundle(path)
    rels = sorted(e.rel for e in b.role("state"))
    assert rels == [
        "bridge.json",
        "config/hub.json",
        "effects-library.json",
        "live-clients.json",
        "live-tls.json",
    ]
    assert b.get("var/lib/splanc-bridge/bridge.json").klass == "must-keep"
    assert sorted(e.rel for e in b.role("wifi")) == [
        "splanc-wifi-2.nmconnection",
        "splanc-wifi.nmconnection",
    ]
    assert b.role("ssh") and b.role("conf") and b.role("image")
    assert b.bridge_ids == {RELAY: BID}
    assert b.manifest["status_at_backup"]["paired_clients"] == 2
    no_secrets(capsys.readouterr().out)


def test_backup_dry_run_copies_and_stops_nothing(env):
    root = old_bridge(env.root("old"))
    rc, path = backup(env, root, "--dry-run")
    assert rc == 0 and path is None
    assert "stop" not in env.log()


def test_backup_refuses_without_the_identity(env, capsys):
    root = old_bridge(env.root("old"))
    os.remove(os.path.join(root, "var/lib/splanc-bridge/bridge.json"))
    rc, path = backup(env, root)
    assert rc == 1 and path is None
    assert "bridge.json" in capsys.readouterr().err


def test_backup_refuses_an_unpaired_or_mismatched_bridge_unless_forced(env, capsys):
    root = old_bridge(env.root("old"), state="unpaired")
    assert backup(env, root) == (1, None)
    assert "--force" in capsys.readouterr().err
    root2 = old_bridge(env.root("old2"), ident=identity(bridges={"https://other.example": "X"}))
    assert backup(env, root2) == (1, None)
    assert "no bridge id for the relay" in capsys.readouterr().out
    rc, path = backup(env, root2, "--force")
    assert rc == 0 and path


def test_backup_from_a_mounted_card_follows_symlinks_inside_it(env, tmp_path):
    root = old_bridge(str(tmp_path / "card-root"), with_status=False)
    # NixOS: /etc/splanc-bridge/image.json -> /etc/static/... -> /nix/store/...
    img = os.path.join(root, "etc/splanc-bridge/image.json")
    data = open(img).read()
    os.remove(img)
    put(root, "nix/store/abc-etc/etc/splanc-bridge/image.json", data, 0o444)
    os.symlink("/nix/store/abc-etc/etc", os.path.join(root, "etc/static"))
    os.symlink("/etc/static/splanc-bridge/image.json", img)
    out = str(tmp_path / "b")
    assert (
        run(
            "backup",
            "--from-root",
            root,
            "--from-boot",
            os.path.join(root, "boot/firmware"),
            "--out",
            out,
        )
        == 0
    )
    b = bm.load_bundle(os.path.join(out, os.listdir(out)[0]))
    assert json.loads(b.role("image")[0].data)["board"] == "pi5"
    assert b.manifest["source"]["kind"] == "card"


# -------------------------------------------------------------------- inspect ---


def test_inspect_redacts_secrets(env, capsys):
    _, path = backup(env, old_bridge(env.root("old")))
    capsys.readouterr()
    assert run("inspect", path) == 0
    text = capsys.readouterr().out
    no_secrets(text)
    assert BID in text and "'Home'" in text and "'Cabin'" in text
    assert "1 fixture(s)" in text and "1 ticket(s)" in text and "1 effect(s)" in text


def test_a_damaged_bundle_is_refused(env, tmp_path):
    _, path = backup(env, old_bridge(env.root("old")))
    with tarfile.open(path, "r:gz") as tf:
        members = [(m, tf.extractfile(m).read()) for m in tf.getmembers()]
    bad = str(tmp_path / "bad.tar.gz")
    with tarfile.open(bad, "w:gz") as tf:
        for m, data in members:
            if m.name.endswith("bridge.json"):
                data = data.replace(b"PRIVATE", b"PRIVATF")
            m.size = len(data)
            tf.addfile(m, io.BytesIO(data))
    with pytest.raises(bm.Fail, match="checksum"):
        bm.load_bundle(bad)


# ---------------------------------------------------------------- restore card ---


def fresh_card(tmp_path, flasher_ssid="Home"):
    card = str(tmp_path / "FIRMWARE")
    put(card, "config.txt", "")
    put(card, "splanc-bridge.conf", "HOSTNAME=splanc-bridge\nWIFI_COUNTRY=US\n")
    if flasher_ssid:
        put(
            card,
            "system-connections/splanc-wifi.nmconnection",
            keyfile("splanc-wifi", flasher_ssid, "newpass1"),
        )
    return card


def test_restore_card_dry_run_writes_nothing(env, tmp_path):
    _, path = backup(env, old_bridge(env.root("old")))
    card = fresh_card(tmp_path)
    before = sorted(os.walk(card))
    assert run("restore", path, "--card", card, "--dry-run") == 0
    assert sorted(os.walk(card)) == before


def test_restore_card_prepares_the_new_card(env, tmp_path, capsys):
    _, path = backup(env, old_bridge(env.root("old")))
    card = fresh_card(tmp_path)
    capsys.readouterr()
    assert run("restore", path, "--card", card, "--key", str(tmp_path / "nokey")) == 0
    out = capsys.readouterr().out
    no_secrets(out)
    m = json.load(open(os.path.join(card, "splanc-restore/manifest.json")))
    assert m["format"] == "splanc-bridge-restore" and m["bridge_ids"] == {RELAY: BID}
    assert {f["path"] for f in m["files"]} >= {"bridge.json", "config/hub.json", "live-tls.json"}
    conns = sorted(os.listdir(os.path.join(card, "system-connections")))
    # 'Home' is the flasher's already (its new password wins); 'Cabin' comes back, renamed.
    assert conns == ["restored-splanc-wifi-2.nmconnection", "splanc-wifi.nmconnection"]
    cabin = open(
        os.path.join(card, "system-connections/restored-splanc-wifi-2.nmconnection")
    ).read()
    assert "id=restored-splanc-wifi-2" in cabin
    conf = open(os.path.join(card, "splanc-bridge.conf")).read()
    assert "WIFI_COUNTRY=US" in conf and "OLED_ROTATE=2" in conf
    assert "ssh-ed25519 AAAAold" in open(os.path.join(card, "authorized_keys")).read()


def test_card_bundle_is_imported_by_the_image_at_first_boot(env, tmp_path):
    """The whole no-SSH path: backup -> restore --card -> the image's bootconfig.apply."""
    from splanc_image import bootconfig as bc

    old = old_bridge(env.root("old"))
    _, path = backup(env, old)
    card = fresh_card(tmp_path)
    assert run("restore", path, "--card", card) == 0
    paths = bc.Paths(
        boot=card,
        nm=str(tmp_path / "nm"),
        run=str(tmp_path / "run"),
        ssh=str(tmp_path / "ssh"),
        state=str(tmp_path / "new/var/lib/splanc-bridge"),
    )
    bc.apply(
        paths,
        set_hostname=lambda h: True,
        set_country=lambda c: True,
        chown_root=False,
        log=lambda m: None,
    )
    for rel in [
        "bridge.json",
        "config/hub.json",
        "live-tls.json",
        "live-clients.json",
        "effects-library.json",
    ]:
        got = os.path.join(paths.state, rel)
        assert (
            open(got, "rb").read()
            == open(os.path.join(old, "var/lib/splanc-bridge", rel), "rb").read()
        )
        assert stat.S_IMODE(os.stat(got).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(paths.state).st_mode) == 0o700
    assert not os.path.exists(
        os.path.join(card, "splanc-restore")
    )  # the key is off the FAT partition
    assert open(os.path.join(card, "splanc-restore-result.txt")).read().startswith("ok ")
    assert sorted(os.listdir(paths.nm)) == [
        "restored-splanc-wifi-2.nmconnection",
        "splanc-wifi.nmconnection",
    ]


# ----------------------------------------------------------------- restore SSH ---


def new_bridge(root, imported=False):
    """A freshly flashed current image that already booted once: it made itself a NEW
    identity (unless it imported the card's bundle) and is unpaired."""
    ident = (
        identity()
        if imported
        else identity(pub="NEWpub", priv="NEWpriv", bridges={RELAY: "NEWBRIDGEID"})
    )
    put(
        root,
        "etc/splanc-bridge/image.json",
        json.dumps({"board": "pi5", "rev": "3bed51b28"}),
        0o644,
    )
    put(root, "var/lib/splanc-bridge/bridge.json", json.dumps(ident, indent=2))
    put(root, "var/lib/splanc-bridge/live-tls.json", "{}")
    state = "paired" if imported else "unpaired"
    bid = BID if imported else "NEWBRIDGEID"
    put(
        root,
        "run/splanc-bridge/status.json",
        json.dumps({"state": state, "relay": RELAY, "bridge_id": bid}),
    )
    put(root, "boot/firmware/config.txt", "")
    put(root, "boot/firmware/splanc-restore/manifest.json", "{}")  # an image that ignores it
    put(
        root,
        "etc/NetworkManager/system-connections/splanc-wifi.nmconnection",
        keyfile("splanc-wifi", "Home"),
    )
    return root


def test_restore_ssh_places_state_and_waits_for_paired(env, capsys):
    _, path = backup(env, old_bridge(env.root("old")))
    root = new_bridge(env.root("new"))
    capsys.readouterr()
    assert (
        run(
            "restore", path, "--ssh", "splanc-bridge.local", "--remote-root", root, "--timeout", "5"
        )
        == 0
    )
    out = capsys.readouterr().out
    no_secrets(out)
    assert "PAIRED as bridge " + BID in out
    s = os.path.join(root, "var/lib/splanc-bridge")
    assert json.load(open(os.path.join(s, "bridge.json")))["key"]["private_pkcs8"] == PRIV
    pre = [d for d in os.listdir(s) if d.startswith("pre-restore-")]
    assert (
        pre
        and json.load(open(os.path.join(s, pre[0], "bridge.json")))["key"]["public_raw"] == "NEWpub"
    )
    for dirpath, _, files in os.walk(s):
        assert stat.S_IMODE(os.stat(dirpath).st_mode) == 0o700
        for f in files:
            assert stat.S_IMODE(os.stat(os.path.join(dirpath, f)).st_mode) == 0o600
    nm = sorted(os.listdir(os.path.join(root, "etc/NetworkManager/system-connections")))
    assert "restored-splanc-wifi-2.nmconnection" in nm and "restored-splanc-wifi.nmconnection" in nm
    assert not os.path.exists(os.path.join(root, "boot/firmware/splanc-restore"))
    log = env.log()
    assert "chown -R splanc:splanc" in log and "nmcli connection reload" in log
    assert log.index("systemctl stop") < log.index("systemctl start")


def test_restore_ssh_when_the_card_import_already_ran(env, capsys):
    _, path = backup(env, old_bridge(env.root("old")))
    root = new_bridge(env.root("new"), imported=True)
    capsys.readouterr()
    seen = len(env.log())
    assert (
        run(
            "restore", path, "--ssh", "splanc-bridge.local", "--remote-root", root, "--timeout", "5"
        )
        == 0
    )
    assert "imported it from the card" in capsys.readouterr().out
    assert "systemctl" not in env.log()[seen:]  # nothing touched


def test_verify_explains_a_relay_that_forgot_the_clients(env, capsys, monkeypatch):
    _, path = backup(env, old_bridge(env.root("old")))
    root = new_bridge(env.root("new"))
    monkeypatch.setenv("FAKE_PAIRED_BID", "nobody")  # the relay has no grants for BID
    assert (
        run(
            "restore", path, "--ssh", "splanc-bridge.local", "--remote-root", root, "--timeout", "0"
        )
        == 1
    )
    assert "no paired clients" in capsys.readouterr().err


def test_verify_refuses_a_bridge_with_another_identity(env, capsys):
    _, path = backup(env, old_bridge(env.root("old")))
    root = new_bridge(env.root("new"))
    rc = run(
        "verify", path, "--ssh", "splanc-bridge.local", "--remote-root", root, "--timeout", "0"
    )
    assert rc == 1 and "NOT using the old identity" in capsys.readouterr().err


# ------------------------------------------------------------------ enable-ssh ---


def test_enable_ssh_adds_a_key_to_the_old_card(env, tmp_path):
    card = str(tmp_path / "OLD")
    put(card, "config.txt", "")
    pub = put(str(tmp_path), "k.pub", "ssh-ed25519 AAAAtool splanc-bridge-migrate\n")
    assert run("enable-ssh", "--card", card, "--pubkey", pub) == 0
    assert run("enable-ssh", "--card", card, "--pubkey", pub) == 0  # idempotent
    assert (
        open(os.path.join(card, "authorized_keys")).read()
        == "ssh-ed25519 AAAAtool splanc-bridge-migrate\n"
    )


def test_ssh_argv_is_batch_mode_with_its_own_known_hosts(monkeypatch):
    monkeypatch.delenv("BRIDGE_MIGRATE_SSH", raising=False)
    argv = bm.ssh_argv("splanc-bridge.local", "/k", "/kh", "echo")
    assert argv[0] == "ssh" and "root@splanc-bridge.local" in argv
    assert "BatchMode=yes" in argv and "UserKnownHostsFile=/kh" in argv and "-i" in argv


def test_keyfile_ssid_parsing():
    assert bm.keyfile_ssid(keyfile("x", "Café;1")) == "Café;1".encode()
    assert bm.keyfile_ssid("[wifi]\nssid=My\\sNet\n") == b"My Net"
    assert bm.keyfile_ssid("[connection]\ntype=ethernet\n") is None


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
