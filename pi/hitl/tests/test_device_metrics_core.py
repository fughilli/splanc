"""The device-metrics HITL gate's pure verdict (harness/device_metrics_core.py)."""

import device_metrics_core as core

W = {"type": "welcome", "features": ["effects", "device_metrics"]}


def m(**kw):
    base = {
        "type": "device_metrics",
        "version": 1,
        "board": "esp32c6",
        "uptimeS": 100,
        "resetReason": 1,
        "bootCount": 1,
        "heapFree": 80000,
        "heapMinFree": 54000,
        "heapLargestFree": 30000,
        "wifiJoins": 1,
        "wifiRssiDbm": -55,
        "fpsMax": 80,
    }
    base.update(kw)
    return base


def test_good_pair_passes():
    assert core.problems(W, m(), m(uptimeS=106), 6.0) == []
    assert core.verdict(True, []) == core.PASS


def test_each_check_bites():
    assert core.problems({"features": []}, m(), m(uptimeS=106), 6)
    assert any(
        "uptime" in p
        for p in core.problems(W, m(), m(), 6) + core.problems(W, m(), m(uptimeS=90), 6)
    )
    assert any("rssi" in p for p in core.problems(W, m(), m(uptimeS=106, wifiRssiDbm=0), 6))
    assert any("rssi" in p for p in core.problems(W, m(), m(uptimeS=106, wifiRssiDbm=20), 6))
    assert any("heap" in p for p in core.problems(W, m(), m(uptimeS=106, heapMinFree=90000), 6))
    assert any("mesh" in p for p in core.problems(W, m(), m(uptimeS=106, meshMode=1), 6))
    assert any(
        "reply" in p for p in core.problems(W, {"type": "error", "message": "unsupported"}, m(), 6)
    )


def test_unreached_is_skip_not_fail():
    assert core.verdict(False, ["anything"]) == core.SKIP
    assert core.verdict(True, ["x"]) == core.FAIL
