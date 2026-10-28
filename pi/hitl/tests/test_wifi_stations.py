"""Reservation.wifi_stations / wifi_station: the client side of the daemon's
per-reservation AP station stats (GET/POST /reservation/<id>/wifi, hitl-reserve
package wifi). Pure logic: the daemon HTTP is stubbed."""

import io
import urllib.error

import hitl_client
import pytest
from hitl_client import Reservation, ReserveError

pytestmark = [pytest.mark.requirements("PR-36"), pytest.mark.usefixtures("clean_hitl_env")]

REPORT = {
    "reservation": "res-1",
    "unit": "c6-abcdef",
    "iface": "wlan0",
    "stations": [
        {"mac": "02:0c:6a:00:00:01", "ip": "10.42.0.11", "rx_bitrate_mbps": 39.0, "tx_failed": 2},
    ],
}


def _res():
    r = Reservation(server="http://hitl-rig-1:8087")
    r.id = "res-1"
    return r


def test_claims_the_dut_ip_then_reads_its_station(monkeypatch):
    calls = []

    def fake_post(url, body=None, timeout=15.0):
        calls.append((url, body))
        return REPORT

    monkeypatch.setattr(hitl_client, "_post", fake_post)
    st = _res().wifi_station("10.42.0.11")
    assert calls == [("http://hitl-rig-1:8087/reservation/res-1/wifi", {"ip": "10.42.0.11"})]
    assert st["rx_bitrate_mbps"] == 39.0 and st["mac"] == "02:0c:6a:00:00:01"


def test_station_absent_is_none(monkeypatch):
    monkeypatch.setattr(
        hitl_client, "_post", lambda *a, **k: {"stations": [], "missing": ["10.42.0.11"]}
    )
    assert _res().wifi_station("10.42.0.11") is None


def test_plain_read_uses_get(monkeypatch):
    seen = []
    monkeypatch.setattr(hitl_client, "_get", lambda url, timeout=10.0: seen.append(url) or REPORT)
    assert _res().wifi_stations()["unit"] == "c6-abcdef"
    assert seen == ["http://hitl-rig-1:8087/reservation/res-1/wifi"]


def test_old_daemon_or_no_ap_raises_reserve_error(monkeypatch):
    def fake_get(url, timeout=10.0):
        raise urllib.error.HTTPError(url, 501, "nope", {}, io.BytesIO(b'{"error":"disabled"}'))

    monkeypatch.setattr(hitl_client, "_get", fake_get)
    with pytest.raises(ReserveError, match="501"):
        _res().wifi_stations()


def test_requires_a_reservation():
    with pytest.raises(ReserveError):
        Reservation(server="http://hitl-rig-1:8087").wifi_stations()
