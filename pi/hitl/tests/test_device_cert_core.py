"""The per-device TLS identity HITL check's pure logic (harness/device_cert_core.py):
the firmware log parse, the connect-storm grading, a run's checklist and the
cross-DUT comparison."""

import device_cert_core as core

SHA_A = "a" * 64
SHA_B = "b" * 64

GEN_LOG = (
    "[player] identity CC:FD:49:00:3F:08 / ...\n"
    "[tls] no stored device identity (first boot / factory reset)\n"
    f"[tls] generated per-device identity in 74 ms (keygen+sign), persist=ok in 31 ms (583 B); cert sha256={SHA_A}\n"
    f"TLS init: setup ok (per-device identity, sha256={SHA_A}, persisted=1)\n"
)
LOAD_LOG = (
    "[tls] loaded per-device identity in 3 ms (first-boot keygen+sign took 74 ms); "
    f"cert sha256={SHA_A}\n"
    f"TLS init: setup ok (per-device identity, sha256={SHA_A}, persisted=1)\n"
)


def test_parse_generated_and_loaded():
    g = core.parse_identity_log(GEN_LOG)
    assert g["generated"] and not g["loaded"]
    assert (g["gen_ms"], g["persist"], g["persist_ms"], g["blob_bytes"], g["sha"]) == (
        74,
        "ok",
        31,
        583,
        SHA_A,
    )
    assert g["setup_sha"] == SHA_A and g["setup_persisted"]
    loaded = core.parse_identity_log(LOAD_LOG)
    assert loaded["loaded"] and not loaded["generated"]
    assert (loaded["load_ms"], loaded["loaded_sha"], loaded["recorded_gen_ms"]) == (3, SHA_A, 74)


def test_parse_failure_and_ram_only():
    log = (
        "[tls] device identity generation FAILED: -0x0010 after 12 ms (heap=1000); "
        "retrying, :443 stays closed\n"
        "[tls] generated per-device identity in 80 ms (keygen+sign), "
        f"persist=FAILED (RAM-only this boot) in 2 ms (583 B); cert sha256={SHA_B}\n"
    )
    g = core.parse_identity_log(log)
    assert g["failures"] == 1 and g["persist"] == "FAILED" and g["sha"] == SHA_B
    assert core.parse_identity_log("nothing")["sha"] is None


def test_race_verdict_one_cert_with_early_closed_port():
    attempts = [
        {"t": 0.0, "err": "tcp:TimeoutError"},
        {"t": 1.5, "err": "tcp:ConnectionRefusedError"},
        {"t": 2.0, "ok": True, "sha": SHA_A},
        {"t": 2.4, "ok": True, "sha": SHA_A},
    ]
    v = core.race_verdict(attempts)
    assert (v["ok"], v["distinct"], v["sha"], v["legacy_seen"], v["first_ok_s"]) == (
        2,
        1,
        SHA_A,
        False,
        2.0,
    )
    assert v["errors"] == {"tcp:TimeoutError": 1, "tcp:ConnectionRefusedError": 1}
    assert v["tls_errors_after_first_ok"] == 0


def test_race_verdict_flags_two_certs_and_legacy():
    v = core.race_verdict(
        [{"t": 0, "ok": True, "sha": SHA_A}, {"t": 1, "ok": True, "sha": core.LEGACY_SHA256}]
    )
    assert v["distinct"] == 2 and v["sha"] is None and v["legacy_seen"]


def _good_run():
    return {
        "unit": "c6-003f08",
        "mac": "CC:FD:49:00:3F:08",
        "first_boot": core.parse_identity_log(GEN_LOG),
        "race": core.race_verdict([{"t": 1, "ok": True, "sha": SHA_A}]),
        "tls_info": {"type": "tls_info", "state": "ready", "certSha256": SHA_A, "persisted": True},
        "ws_sha": SHA_A,
        "manifest_tls": {"cert_sha256": SHA_A, "state": "ready", "persisted": True},
        "reboot": core.parse_identity_log(LOAD_LOG),
        "reboot_race": core.race_verdict([{"t": 1, "ok": True, "sha": SHA_A}]),
    }


def test_check_run_pass_and_each_failure():
    assert core.check_run(_good_run()) == []
    r = _good_run()
    r["reboot"] = core.parse_identity_log(GEN_LOG.replace(SHA_A, SHA_B))
    assert any("REGENERATED" in p for p in core.check_run(r))
    r = _good_run()
    r["tls_info"]["state"] = "generating"
    assert any("state='generating'" in p for p in core.check_run(r))
    r = _good_run()
    r["race"] = core.race_verdict([{"t": 1, "ok": True, "sha": core.LEGACY_SHA256}])
    assert any("LEGACY" in p for p in core.check_run(r))
    r = _good_run()
    r["manifest_tls"] = {"cert_sha256": SHA_A}
    assert any("manifest tls block" in p for p in core.check_run(r))
    r = _good_run()
    # A monitor-reset second boot that loads (with the recorded keygen time) still counts...
    r["first_boot"] = core.parse_identity_log(LOAD_LOG)
    assert core.check_run(r) == []
    # ...but a boot log with neither a generation nor a recorded one does not.
    r["first_boot"] = core.parse_identity_log("boot without any identity line")
    assert any("did not log a generated identity" in p for p in core.check_run(r))


def test_compare_runs_needs_two_devices_with_distinct_certs():
    a = _good_run()
    b = dict(_good_run(), unit="c6-fa0324", mac="CC:FD:49:00:FA:03", race={"sha": SHA_B})
    assert core.compare_runs([a, b]) == []
    assert any(
        "share a certificate" in p for p in core.compare_runs([a, dict(b, race={"sha": SHA_A})])
    )
    assert any("two different devices" in p for p in core.compare_runs([a, a]))
