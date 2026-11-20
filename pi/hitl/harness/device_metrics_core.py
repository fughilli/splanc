"""Verdict for the device-metrics HITL gate (hitl_device_metrics.py).

Pure: takes the welcome + two device_metrics replies (decoded flat dicts, camelCase)
a few seconds apart and lists what is wrong. Infra problems are the driver's SKIP,
never a FAIL here (docs: hitl-gate authoring rules).
"""

from __future__ import annotations

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"


def _n(m: dict, k: str) -> int:
    v = m.get(k, 0)
    return int(v) if isinstance(v, (int, float)) else 0


def problems(welcome: dict, a: dict, b: dict, gap_s: float) -> list[str]:
    out: list[str] = []
    if "device_metrics" not in (welcome.get("features") or []):
        out.append("welcome.features lacks device_metrics")
    for name, m in (("first", a), ("second", b)):
        if m.get("type") != "device_metrics":
            out.append(f"{name} reply is {m.get('type')!r}: {m.get('message', '')}")
    if out:
        return out
    if _n(b, "version") != 1:
        out.append(f"version {_n(b, 'version')} != 1")
    if b.get("board") != "esp32c6":
        out.append(f"board {b.get('board')!r} != 'esp32c6'")
    ua, ub = _n(a, "uptimeS"), _n(b, "uptimeS")
    if ua <= 0 or ub < ua or ub - ua > gap_s + 5:
        out.append(f"uptime_s not counting: {ua} -> {ub} over {gap_s:.0f} s")
    if not 1 <= _n(b, "resetReason") <= 15:
        out.append(f"reset_reason {_n(b, 'resetReason')} out of esp_reset_reason_t")
    if _n(b, "bootCount") < 1:
        out.append("boot_count < 1")
    free, lo, big = _n(b, "heapFree"), _n(b, "heapMinFree"), _n(b, "heapLargestFree")
    if not (0 < lo <= free and 0 < big <= free):
        out.append(f"heap inconsistent: free {free} min {lo} largest {big}")
    if _n(b, "wifiJoins") < 1:
        out.append("wifi_joins < 1 on a joined player")
    rssi = _n(b, "wifiRssiDbm")
    if not -100 <= rssi <= -10:
        out.append(f"wifi_rssi_dbm {rssi} implausible (RX-vector byte 0 is not the RSSI?)")
    if _n(b, "fpsMax") <= 0:
        out.append("fps_max 0")
    if _n(b, "meshMode") != 0 or _n(b, "meshMembers") != 0:
        out.append("mesh fields set on a player without a mesh")
    return out


def verdict(reached: bool, probs: list[str]) -> str:
    if not reached:
        return SKIP
    return FAIL if probs else PASS
