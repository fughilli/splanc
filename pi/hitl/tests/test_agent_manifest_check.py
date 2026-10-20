"""The e2e agent-manifest check: what it accepts and what it reds.

hitl_e2e.agent_manifest_check fetches /.well-known/splanc.json over the DUT tunnel
and asserts it mirrors the welcome and pins the presented TLS cert. Driven here
with a fake HTTPS GET (no hardware).
"""

import hashlib
import json

import device_cert_core
import hitl_e2e
import pytest
from provision import HarnessError

CERT = b"0\x82fake-der-certificate"
WELCOME = {
    "type": "welcome",
    "mac": "AA:BB:CC:DD:EE:FF",
    "deviceName": "Kitchen",
    "fwVersion": "1.6.0",
    "fwGitCommit": "0123456789abcdef0123456789abcdef01234567",
    "fwGitDirty": False,
    "features": ["effects", "list_effects"],
    "fxbFormat": 1,
}


def manifest(**over):
    m = {
        "schema": "splanc-agent/1",
        "device": {"id": "AA:BB:CC:DD:EE:FF", "name": "Kitchen", "board": "esp32c6"},
        "firmware": {
            "version": "1.6.0",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "dirty": False,
        },
        "protocol": {
            "package": "ledmapper.v1",
            "ws_path": "/ws",
            "profile": "core",
            "features": ["effects", "list_effects"],
            "fxb_format": 1,
        },
        "tls": {
            "cert_sha256": hashlib.sha256(CERT).hexdigest(),
            "state": "ready",
            "persisted": True,
        },
        "bundle": None,
    }
    m.update(over)
    return m


def serve(monkeypatch, body, status=200, ctype="application/json"):
    raw = json.dumps(body).encode() if not isinstance(body, bytes) else body
    monkeypatch.setattr(
        hitl_e2e, "_https_get", lambda *a: (status, {"content-type": ctype}, raw, CERT)
    )


def test_a_matching_manifest_passes(monkeypatch):
    serve(monkeypatch, manifest())
    assert hitl_e2e.agent_manifest_check("wss://localhost:9443/ws", WELCOME)["schema"]


@pytest.mark.parametrize(
    "bad",
    [
        manifest(tls={"cert_sha256": "00" * 32}),  # pins a different cert
        # Per-device identity not ready / not persisted / no state (pre-per-device fw).
        manifest(
            tls={
                "cert_sha256": hashlib.sha256(CERT).hexdigest(),
                "state": "generating",
                "persisted": True,
            }
        ),
        manifest(
            tls={
                "cert_sha256": hashlib.sha256(CERT).hexdigest(),
                "state": "ready",
                "persisted": False,
            }
        ),
        manifest(tls={"cert_sha256": hashlib.sha256(CERT).hexdigest()}),
        manifest(device={"id": "11:22:33:44:55:66", "name": "Kitchen"}),
        manifest(schema="splanc-agent/2"),
    ],
)
def test_a_manifest_that_disagrees_fails(monkeypatch, bad):
    serve(monkeypatch, bad)
    with pytest.raises(HarnessError):
        hitl_e2e.agent_manifest_check("wss://localhost:9443/ws", WELCOME)


def test_the_legacy_shared_cert_fails(monkeypatch):
    # The device must serve its OWN cert, never the shared CN=heapless one every
    # pre-per-device image carried (its private key was in the open-source tree).
    monkeypatch.setattr(device_cert_core, "LEGACY_SHA256", hashlib.sha256(CERT).hexdigest())
    serve(monkeypatch, manifest())
    with pytest.raises(HarnessError, match="LEGACY"):
        hitl_e2e.agent_manifest_check("wss://localhost:9443/ws", WELCOME)


def test_a_missing_route_fails(monkeypatch):
    serve(monkeypatch, b"<html>", ctype="text/html")
    with pytest.raises(HarnessError, match="application/json"):
        hitl_e2e.agent_manifest_check("wss://localhost:9443/ws", WELCOME)


def test_plain_ws_skips():
    assert hitl_e2e.agent_manifest_check("ws://localhost:81/ws", WELCOME) is None
