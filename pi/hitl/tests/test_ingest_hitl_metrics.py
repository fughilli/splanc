"""Unit tests for the HITL per-gate metrics ingest (pi/hitl/observability/metrics).

The ingest turns CI job logs into the "HITL performance" dashboard's dataset. Pinned
here: the per-test section split (with flaky retries), rig/DUT attribution, that a
gate's own HITL_METRIC line wins over the legacy parse of the same metric, the
legacy extractors on real log lines, and the headroom statistics the audit uses.
"""

from datetime import datetime, timezone

import ingest_hitl_metrics as ing
import legacy_extractors as lx

# GitHub's timestamp prefix is stripped by the ingest, as in the real job log.
TS = "2026-11-19T10:00:00.0000000Z "

LOG = "\n".join(
    TS + line
    for line in [
        "(10:00:00) INFO: Found 3 test targets...",
        "==================== Test output for //pi/hitl/harness:live_latency_netstack:",
        "reserved: id=b84584d6 on http://hitl-rig-2:8087 unit=c6-71226c class=pr-ci",
        "RESULT live_latency verdict=PASS sender=live all[n=938 p50=62ms p99=148ms max=364ms]"
        " first[n=240 p50=62ms p99=140ms max=183ms] last[n=240 p50=64ms p99=153ms max=179ms]"
        " path=lan frame=45ms budget_p50=95ms budget_p99=256ms features_live_mailbox=True end=done",
        "RESULT live_latency verdict=PASS sender=live all[n=938 p50=62ms p99=148ms max=364ms]"
        " | RESULT live_latency verdict=PASS sender=osc all[n=1 p50=1ms p99=1ms max=1ms]",
        "=" * 80,
        "==================== Test output for //pi/hitl/harness:improv_fresh_join:",
        "reserved: id=1 on http://hitl-rig-1:8087 unit=c6-123170 class=pr-ci",
        'HITL_METRIC {"v":1,"gate":"improv_fresh_join","metric":"phase_wall_time",'
        '"unit":"s","value":99.0,"phase":"absent"}',
        'IMPROV_FRESH_JOIN_JSON {"phases": {"absent": {"ok": false, "error": "x", "wall_s": 47.2}}}',
        "=" * 80,
        "==================== Test output for //pi/hitl/harness:improv_fresh_join:",
        "reserved: id=2 on http://hitl-rig-2:8087 unit=c6-71226c class=pr-ci",
        'IMPROV_FRESH_JOIN_JSON {"phases": {"absent": {"ok": false, "error": "x", "wall_s": 46.0},'
        ' "stored": {"ok": false, "error": "BLE transport failed: hung", "wall_s": 3}}}',
        "=" * 80,
        "//pi/hitl/harness:live_latency_netstack                PASSED in 3541.1s",
        "//pi/hitl/harness:improv_fresh_join                    FLAKY, failed in 1 out of 2 in 3173.2s",
    ]
)

RUN = {
    "run_id": 7,
    "branch": "main",
    "sha": "9d5dbb1230000",
    "event": "push",
    "created_at": "2026-11-19T09:00:00Z",
}


def test_sections_carry_attempts_and_outcome():
    secs = ing.split_sections(LOG)
    assert [(s["target"].rsplit(":", 1)[1], s["attempt"]) for s in secs] == [
        ("live_latency_netstack", 1),
        ("improv_fresh_join", 1),
        ("improv_fresh_join", 2),
    ]
    # FLAKY: the earlier attempt failed, the last passed.
    assert [s["attempt_ok"] for s in secs] == [True, False, True]


def test_parse_log_rows():
    rows = ing.parse_log(LOG, RUN)
    ll = [r for r in rows if r["gate"] == "live_latency"]
    # The duplicated summary line (" | RESULT ...") is not counted twice.
    assert sorted((r["stat"], r["value"], r.get("limit")) for r in ll) == [
        ("max", 364.0, None),
        ("p50", 62.0, 95.0),
        ("p99", 148.0, 256.0),
    ]
    assert {r["rig"] for r in ll} == {"hitl-rig-2"} and {r["dut"] for r in ll} == {"c6-71226c"}
    assert all(r["lane"] == "main" and r["run_id"] == 7 for r in rows)
    ifj = [r for r in rows if r["gate"] == "improv_fresh_join"]
    # Attempt 1 emitted the metric itself, so its legacy duplicate is dropped; attempt
    # 2 has only the legacy line; the infra phase is skipped.
    assert sorted((r["attempt"], r["src"], r["value"]) for r in ifj) == [
        (1, "emit", 99.0),
        (2, "legacy", 46.0),
    ]
    assert ifj[0]["rig"] == "hitl-rig-1"


def test_gate_of_strips_variant_suffixes():
    assert ing.gate_of("//pi/hitl/harness:live_latency_netstack") == "live_latency"
    assert ing.gate_of("//pi/hitl/harness:improv_e2e_led-mapper-pi") == "improv_e2e"
    assert ing.gate_of("//pi/hitl/harness:ota_gate") == "ota_gate"


def test_series_key_is_asset_safe():
    r = {"gate": "wifi_cadence", "metric": "frame_period_dev_max", "phase": "heavy/dhcp"}
    assert ing.series_key(r) == "wifi_cadence.frame_period_dev_max.heavy-dhcp"


def test_legacy_lines():
    got = lx.extract(
        "//x:rejoin_loop",
        "rejoin_loop",
        [
            'BOOT_JSON {"booted": true, "lease_ms": 8288, "i": 0}',
            "RESULT unit=c6-71081c boots=30 rejoined=30 rate=1.0 p50_ms=7097 p95_ms=8090"
            " max_ms=8288 verdict=PASS",
        ],
    )
    assert [(r["metric"], r.get("stat"), r["value"], r["limit"]) for r in got] == [
        ("lease_latency", None, 8288.0, 40000.0),
        ("lease_latency", "p95", 8090.0, 20000.0),
    ]
    got = lx.extract(
        "//x:ota_gate",
        "ota_gate",
        [
            '[unhealthy] outcome=rolled_back in 199s {"handoff_s": 14.2, "transfer_s": 52.0,'
            ' "bytes_sent": 2261776, "resumes": 0, "finish_s": 0.66, "healthy_s": 25.0}'
        ],
    )
    by = {r["metric"]: r for r in got}
    assert by["phase_duration"]["value"] == 199.0 and by["phase_duration"]["phase"] == "unhealthy"
    assert by["handoff_duration"]["limit"] == 120.0
    assert by["healthy_duration"]["limit"] == 300.0  # the crash/unhealthy health window
    got = lx.extract(
        "//x:ble_rename",
        "ble_rename",
        [
            "RESULT unit=c6-fa0324 budget=5s adv=PASS conn=PASS adv_fw_s=0.964 conn_fw_s=-0.165"
            " final_fw_s=None verdict=PASS"
        ],
    )
    assert [(r["phase"], r["value"], r["ok"]) for r in got] == [
        ("adv", 0.964, True),
        ("conn", -0.165, True),
    ]
    # An early run's harness-clock `<ph>_s` (4.84 s: teardown included) is not the gate's
    # firmware-clock measurement: it must not surface as name_seen_latency.
    got = lx.extract(
        "//x:ble_rename",
        "ble_rename",
        ["RESULT unit=c6-fa0324 budget=5s adv=PASS conn=PASS adv_s=0.81 conn_s=4.84 verdict=PASS"],
    )
    assert got == []
    got = lx.extract(
        "//x:ble_rename",
        "ble_rename",
        [
            "RESULT unit=c6-fa0324 budget=5s adv=PASS conn=PASS conn_s=4.84 adv_fw_s=0.964"
            " conn_fw_s=-0.165 verdict=PASS"
        ],
    )
    assert [(r["phase"], r["value"]) for r in got] == [("adv", 0.964), ("conn", -0.165)]
    got = lx.extract(
        "//x:mesh_apply_at_skew",
        "mesh_apply_at_skew",
        [
            '[mesh_apply_at_skew] apply: {"skew": {"rounds": 24, "skew_median_us": 277.5,'
            ' "skew_p95_us": 722.0, "skew_max_us": 755.9, "host_skew_max_us": 2584}, "rounds": [{"at',
            "[mesh_smoke] formation (s from key): {'c': 5.01, 'a': 6.4}",
        ],
    )
    skew = {r["stat"]: r for r in got if r["metric"] == "apply_skew"}
    assert skew["max"]["value"] == 755.9 and skew["max"]["limit"] == 10000.0
    assert sorted(r["value"] for r in got if r["metric"] == "formation") == [5.01, 6.4]


def test_summary_headroom_and_slack():
    now = datetime(2026, 11, 20, tzinfo=timezone.utc)
    rows = [
        {
            "gate": "g",
            "metric": "m",
            "unit": "s",
            "value": float(v),
            "limit": 40.0,
            "cmp": "<=",
            "ok": v <= 40,
            "lane": "main",
            "rig": "hitl-rig-2",
            "dut": "c6-1",
            "time": f"2026-11-{10 + i % 9:02d}T00:00:00Z",
        }
        for i, v in enumerate([2, 2, 3, 3, 4])
    ]
    s = {(x["lane"], x["rig"]): x for x in ing.summarize(rows, now) if x["series"] == "g.m"}
    top = s[("all", "all")]
    assert (top["n"], top["p50"], top["max"]) == (5, 3.0, 4.0)
    assert top["limit_over_p50"] == round(40 / 3, 3)
    assert top["slack"] is True
    assert ("main", "hitl-rig-2/c6-1") in s
    # A floor (>=) reads the other way round: typical / limit.
    assert ing._headroom(10.0, ">=", 59.3) == 5.93


def test_series_rows_add_reference_lines():
    now = datetime(2026, 11, 20, tzinfo=timezone.utc)
    rows = [
        {
            "gate": "g",
            "metric": "m",
            "unit": "s",
            "value": 1.0,
            "limit": 5.0,
            "cmp": "<=",
            "lane": "pr",
            "rig": "r",
            "time": "2026-11-18T00:00:00Z",
        },
        {
            "gate": "g",
            "metric": "m",
            "unit": "s",
            "value": 3.0,
            "limit": 5.0,
            "cmp": "<=",
            "lane": "main",
            "rig": "r",
            "time": "2026-11-19T00:00:00Z",
        },
    ]
    out = ing.series_rows(rows, ing.summarize(rows, now), now)["g.m"]
    refs = [p for p in out if p["lane"] == "ref"]
    assert {(p["rig"], p["v"]) for p in refs} == {("limit", 5.0), ("p50", 2.0), ("p95", 2.9)}
    assert {p["t"] for p in refs} == {"2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"}
