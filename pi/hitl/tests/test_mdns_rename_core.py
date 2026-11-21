"""The rename -> mDNS HITL gate's pure logic (harness/mdns_rename_core.py): the record
parser and the per-rename grading of a listener timeline."""

import struct

import mdns_rename_core as core
import stable_identity_core as sic


def _msg(ptrs: list[tuple[str, int]]) -> bytes:
    """A response carrying one `_splanc._tcp.local` PTR per (instance label, ttl)."""
    body = b""
    for label, ttl in ptrs:
        rd = sic._qname(core.instance(label))
        body += sic._qname(sic.SERVICE) + struct.pack(">HHIH", sic.T_PTR, 1, ttl, len(rd)) + rd
    return struct.pack(">HHHHHH", 0, 0x8400, 0, len(ptrs), 0, 0) + body


def _ev(t: float, src: str, ptrs) -> dict:
    return {"t": t, "src": src, "records": core.parse_records(_msg(ptrs))}


def test_parse_records_reads_ptr_and_ttl():
    recs = core.parse_records(_msg([("Old", 0), ("New", 4500)]))
    assert [(r["ptr"], r["ttl"]) for r in recs] == [
        ("Old._splanc._tcp.local", 0),
        ("New._splanc._tcp.local", 4500),
    ]


def test_parse_records_rejects_short_message():
    try:
        core.parse_records(b"\x00" * 5)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def _good_timeline():
    return [
        _ev(1.0, "ucast", [("Old", 120)]),
        _ev(9.0, "ucast", [("Old", 120)]),
        # renamed at 10, session closed at 11
        _ev(11.4, "mcast", [("Old", 0)]),
        _ev(11.4, "mcast", [("New", 4500)]),
        _ev(12.0, "ucast", [("New", 120)]),
        _ev(13.0, "ucast", [("New", 120)]),
    ]


def test_clean_rename_passes():
    g = core.grade_rename(_good_timeline(), "Old", "New", 10.0, 11.0)
    assert g["problems"] == []
    assert g["goodbye_s"] == 0.4 and g["announce_s"] == 0.4 and g["unicast_new_s"] == 1.0
    assert core.verdict([g])["verdict"] == "PASS"


def test_case_insensitive_names():
    g = core.grade_rename(_good_timeline(), "OLD", "new", 10.0, 11.0)
    assert g["problems"] == []


def test_missing_goodbye_fails_when_multicast_is_visible():
    tl = [e for e in _good_timeline() if not (e["src"] == "mcast" and e["t"] == 11.4)][:]
    tl.insert(2, _ev(11.4, "mcast", [("New", 4500)]))
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    assert any("goodbye" in p for p in g["problems"])
    assert core.verdict([g])["verdict"] == "FAIL"


def test_report_bug_new_name_only_on_the_60s_refresh():
    # The field report: nothing until the next periodic announcement.
    tl = [
        _ev(1.0, "ucast", [("Old", 120)]),
        _ev(70.0, "mcast", [("New", 4500)]),
        _ev(71.0, "ucast", [("New", 120)]),
    ]
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    assert any("no multicast goodbye" in p for p in g["problems"])
    assert any("announced only" in p for p in g["problems"])
    assert any("unicast answers named 'New' only" in p for p in g["problems"])


def test_no_multicast_is_not_a_failure_but_is_reported():
    tl = [e for e in _good_timeline() if e["src"] == "ucast"]
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    assert g["problems"] == [] and g["multicast_observable"] is False
    assert g["goodbye_s"] is None


def test_old_name_coming_back_fails():
    tl = _good_timeline() + [_ev(14.0, "ucast", [("Old", 120)])]
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    assert any("again" in p for p in g["problems"])


def test_old_reannounced_after_goodbye_fails():
    tl = _good_timeline() + [_ev(15.0, "mcast", [("Old", 4500)])]
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    assert any("after its goodbye" in p for p in g["problems"])


def test_baseline_must_show_old_name():
    tl = [e for e in _good_timeline() if e["t"] > 10.0]
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    assert any("before the rename" in p for p in g["problems"])


def test_skip_and_empty():
    assert core.verdict([], "provisioning failed")["verdict"] == "SKIP"
    assert core.verdict([])["verdict"] == "SKIP"


def test_serial_goodbyes_stand_in_when_multicast_is_invisible():
    tl = [e for e in _good_timeline() if e["src"] == "ucast"]
    g = core.grade_rename(tl, "Old", "New", 10.0, 11.0)
    log = "[mdns] renamed: goodbye for the old name (180 B), re-announcing\n"
    assert core.serial_goodbyes(log) == 1
    assert core.serial_goodbyes("") is None
    assert core.verdict([g], goodbyes=1)["verdict"] == "PASS"
    v = core.verdict([g, g], goodbyes=1)
    assert v["verdict"] == "FAIL" and "logged 1 mDNS goodbye" in v["problems"][0]
    # Not captured: that half is unchecked, not failed.
    assert core.verdict([g], goodbyes=None)["verdict"] == "PASS"
