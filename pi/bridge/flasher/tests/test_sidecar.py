"""The sidecar's form validation, progress weighting and JSON-lines protocol."""

import json
import os
import subprocess
import sys

import sidecar


def test_validate_good_form():
    errors, settings, host = sidecar.validate(
        {"ssid": "Home", "psk": "password1", "country": "us", "device_name": "Living Room"}
    )
    assert errors == {}
    assert host == "living-room"
    assert settings["wifi"].ssid == "Home" and settings["country"] == "US"


def test_validate_reports_each_field():
    errors, _, host = sidecar.validate(
        {
            "ssid": "",
            "psk": "short",
            "country": "USA",
            "device_name": "!!!",
            "relay": "ftp://x",
            "ssh_key": "nope",
        }
    )
    assert set(errors) == {"ssid", "psk", "country", "device_name", "relay", "ssh_key"}
    assert host == "splanc-bridge"


def test_ethernet_only_needs_no_wifi():
    errors, settings, _ = sidecar.validate({"ethernet_only": True, "ssid": ""})
    assert errors == {} and "wifi" not in settings


def test_overall_progress_is_monotonic():
    points = [sidecar.overall(s, f) for s, _ in sidecar.STAGES for f in (0.0, 0.5, 1.0)]
    assert all(b >= a - 1e-9 for a, b in zip(points, points[1:]))
    assert points[0] == 0.0 and abs(points[-1] - 1.0) < 1e-9


def test_protocol_over_stdio():
    here = os.path.dirname(os.path.abspath(sidecar.__file__))
    p = subprocess.run(
        [sys.executable, os.path.join(here, "sidecar.py")],
        input='{"cmd":"ping"}\n{"cmd":"validate","form":{"ssid":"Home","psk":"x"}}\n',
        capture_output=True,
        text=True,
        timeout=60,
    )
    events = [json.loads(line) for line in p.stdout.splitlines()]
    assert events[0]["type"] == "ready"
    assert {"type": "pong"} in events
    v = next(e for e in events if e["type"] == "validation")
    assert "psk" in v["errors"]


def test_flash_picks_the_chosen_version(monkeypatch):
    from splanc_flasher import releases as rl

    def rel(version, prerelease=False):
        name = f"splanc-bridge-pi3-{version}.img.zst"
        img = rl.Image("pi3", version, f"pi-bridge-v{version}", rl.Asset(name, "u", 1), None)
        return rl.Release(f"pi-bridge-v{version}", version, "", {"pi3": img}, prerelease=prerelease)

    rels = [rel("1.2.0", prerelease=True), rel("1.1.0"), rel("1.0.0")]
    monkeypatch.setattr(rl, "list_releases", lambda repo=rl.REPO: rels)
    sc = sidecar.Sidecar()
    assert sc.pick_release(None).version == "1.1.0"
    assert sc.pick_release("pi-bridge-v1.0.0").version == "1.0.0"
    try:
        sc.pick_release("pi-bridge-v0.9.0")
    except ValueError as e:
        assert "0.9.0" in str(e)
    else:
        raise AssertionError("an unknown tag must not fall back to another version")
