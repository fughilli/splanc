"""status.json parsing: the contract fields, and never crashing on bad input."""

import json
import os

from splanc_display import status as st

FULL = {
    "v": 1,
    "state": "pairing",
    "relay": "wss://relay.splanc.io",
    "bridge_id": "br_1",
    "pairing": {"code": "ABCD-EFGH", "expires_at": 2000, "url": "https://splanc.io/pair#ABCD-EFGH"},
    "clients": 2,
    "players": [
        {"name": "Arch", "host": "arch.local", "ok": True},
        {"name": "Tree", "host": "10.0.0.9", "ok": False},
    ],
    "lan_ip": "192.168.1.42",
    "error": None,
    "updated_at": 1500,
}


def test_full_document():
    s = st.parse(FULL)
    assert s.state == "pairing" and s.label == "Ready to pair"
    assert s.pairing.code == "ABCD-EFGH" and s.pairing.url.endswith("#ABCD-EFGH")
    assert s.clients == 2 and s.players_ok == 1 and len(s.players) == 2
    assert s.lan_ip == "192.168.1.42" and s.relay.startswith("wss://")
    assert s.active_code(1999) is not None
    assert s.active_code(2000) is None  # expired at expires_at
    assert s.pairing.remaining(1990) == 10


def test_lenient_garbage_fields():
    s = st.parse(
        {
            "state": "paired",
            "clients": "two",
            "players": ["x", {"ok": "yes"}, None],
            "pairing": {"code": ""},
        }
    )
    assert s.state == "paired" and s.clients == 0
    assert len(s.players) == 1 and s.players[0].ok is False and s.players[0].name == "?"
    assert s.pairing is None
    assert st.parse({"clients": True}).clients == 0
    assert st.parse([1, 2]).state == "error"
    assert st.parse({}).state == "error"  # no state at all


def test_unknown_state_is_shown_not_crashed():
    s = st.parse({"state": "upgrading"})
    assert s.label == "Upgrading"


def test_pairing_without_expiry_never_expires():
    s = st.parse({"state": "pairing", "pairing": {"code": "X", "url": ""}})
    assert s.active_code(1e12) is not None and s.pairing.remaining(5) is None


def test_load_missing_and_garbled(tmp_path):
    p = tmp_path / "status.json"
    assert st.load(str(p)).state == st.WAITING
    p.write_text("{not json")
    s = st.load(str(p))
    assert s.state == "error" and "JSON" in s.error
    p.write_bytes(b"\xff\xfe")
    assert st.load(str(p)).state == "error"


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("SPLANC_BRIDGE_STATUS", "/x/s.json")
    monkeypatch.setenv("SPLANC_BRIDGE_CONTROL", "/x/c.sock")
    assert st.status_path() == "/x/s.json" and st.control_path() == "/x/c.sock"
    monkeypatch.delenv("SPLANC_BRIDGE_STATUS")
    assert st.status_path() == "/run/splanc-bridge/status.json"


def test_watcher_reloads_only_on_change(tmp_path):
    p = tmp_path / "status.json"
    w = st.StatusWatcher(str(p))
    assert w.status.state == st.WAITING
    assert w.poll() is False  # still absent
    tmp = tmp_path / "t"
    tmp.write_text(json.dumps(FULL))
    os.replace(tmp, p)  # atomic rename, as the bridge does
    assert w.poll() is True and w.status.state == "pairing"
    assert w.poll() is False
    tmp.write_text(json.dumps(dict(FULL, state="paired", pairing=None)))
    os.replace(tmp, p)
    assert w.poll() is True and w.status.state == "paired"
    os.unlink(p)
    assert w.poll() is True and w.status.state == st.WAITING


def test_short_url_and_countdown():
    assert st.short_url("https://splanc.io/pair#ABCD") == "splanc.io/pair"
    assert st.short_url("https://splanc.io/p?c=AB") == "splanc.io/p?c=AB"
    assert st.short_url("https://example.com/a/very/long/path/indeed", 12) == "example.com…"
    assert st.short_url("") == ""
    assert st.fmt_remaining(272) == "4:32"
    assert st.fmt_remaining(3725) == "1:02:05"
    assert st.fmt_remaining(-3) == "0:00"
    assert st.fmt_remaining(None) == ""
