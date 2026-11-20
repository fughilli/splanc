"""Unit tests for the HITL_METRIC emitter (pi/hitl/harness/hitl_metrics.py).

The line format is a contract with the CI ingest
(pi/hitl/observability/metrics/ingest_hitl_metrics.py) and with gates on other
branches that print it by hand, so the round trip and the defaults are pinned.
"""

import json

import hitl_metrics


def test_emit_round_trips_through_parse_line(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    monkeypatch.setenv("TEST_UNDECLARED_OUTPUTS_DIR", str(tmp_path))
    hitl_metrics.set_context(rig="hitl-rig-2", dut="c6-71226c")
    try:
        rec = hitl_metrics.emit(
            "ble_rename", "name_seen_latency", 1.84, "s", limit=5.0, phase="connected"
        )
    finally:
        hitl_metrics.set_context(rig=None, dut=None)
    out = capsys.readouterr().out.strip()
    assert out.startswith("HITL_METRIC {")
    parsed = hitl_metrics.parse_line("2026-11-20T10:00:00.1Z " + out)
    assert parsed == rec
    assert parsed["v"] == 1
    assert parsed["ok"] is True and parsed["cmp"] == "<="
    assert parsed["rig"] == "hitl-rig-2" and parsed["dut"] == "c6-71226c"
    assert parsed["fw"] == "abc123"
    assert parsed["phase"] == "connected"
    # The same record lands in the test's outputs dir.
    lines = (tmp_path / "hitl_metrics.jsonl").read_text().splitlines()
    assert [json.loads(x) for x in lines] == [rec]


def test_ok_follows_the_comparison():
    assert hitl_metrics.record("g", "m", 6.0, "s", limit=5.0)["ok"] is False
    assert hitl_metrics.record("g", "fps", 22, "fps", limit=10, cmp=">=")["ok"] is True
    assert hitl_metrics.record("g", "fps", 9, "fps", limit=10, cmp=">=")["ok"] is False
    # No limit: telemetry, no ok/cmp unless the gate says so.
    rec = hitl_metrics.record("g", "drops", 2, "count")
    assert "limit" not in rec and "ok" not in rec and "cmp" not in rec


def test_emit_never_raises_on_bad_input(capsys):
    assert hitl_metrics.emit("g", "m", float("nan"), "s") is None
    assert hitl_metrics.emit("g", "m", 1.0, "furlongs") is None
    assert "dropped g/m" in capsys.readouterr().out


def test_parse_line_rejects_other_lines():
    assert hitl_metrics.parse_line("RESULT live_latency verdict=PASS") is None
    assert hitl_metrics.parse_line("HITL_METRIC {not json") is None
    assert hitl_metrics.parse_line('HITL_METRIC {"gate":"g","metric":"m"}') is None
