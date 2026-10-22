"""The reboot-loop rejoin HITL gate's pure logic (harness/rejoin_loop_core.py): the
per-boot join-timeline parse and the rate/p95 verdict. The STALL fixture is trimmed
from the rig-2 c6-fa0324 boot that never rejoined on main (deauth sent, then silence)."""

import rejoin_loop_core as core

BOOT = (
    "rst:0xc (SW_CPU),boot:0x8 (SPI_FAST_FLASH_BOOT)\n"
    "[wifi] restored stored credentials (ssid=hitl-rig-2) -> joining\n"
)
OK = BOOT + (
    '[t=4312] [scan] latched "hitl-rig-2" -> bssid=98:fe:54:0a:00:8e ch=11\n'
    "[t=5843] deauth sent to clear any stale association for our MAC\n"
    "[t=5845] auth ok -> assoc\n"
    "assoc status=0\n"
    "[t=5850] *** WiFi DEAUTH (reason=2) — re-joining ***\n"
    "auth ok -> assoc\n"
    "[t=5873] *** 4-WAY COMPLETE — CCMP KEYS INSTALLED, LINK UP ***\n"
    "[t=7088] *** DHCP LEASE ACQUIRED — IP 10.42.0.117 over heapless WiFi ***\n"
)
STALL = BOOT + (
    '[t=4400] [scan] latched "hitl-rig-2" -> bssid=98:fe:54:0a:00:8e ch=11\n'
    "[t=6033] deauth sent to clear any stale association for our MAC\n"
)


def test_parse_ok_boot():
    b = core.parse_boot(OK)
    assert b["booted"] and b["restored"] and b["scan_match"]
    assert (b["latch_ms"], b["deauth_ms"], b["fourway_ms"], b["lease_ms"]) == (
        4312,
        5843,
        5873,
        7088,
    )
    assert (
        b["auth_ok"] and b["ap_deauths"] == [(5850, "DEAUTH", 2)] and b["lease_ip"] == "10.42.0.117"
    )


def test_parse_stalled_boot():
    b = core.parse_boot(STALL)
    assert b["booted"] and b["deauth_ms"] == 6033 and not b["auth_ok"] and b["lease_ms"] is None


def test_parse_guard_lines():
    log = (
        STALL
        + "[t=9040] [join] no auth response after 15 tries (3006 ms) — re-sending disassoc+deauth\n"
    )
    assert core.parse_boot(log)["auth_stalls"] == [9040]
    log2 = BOOT + "[t=800] auth refused status=17\n"
    assert core.parse_boot(log2)["auth_fail_status"] == [17]


def test_percentile():
    assert core.percentile([], 95) is None
    assert core.percentile([5, 1, 3], 50) == 3
    assert core.percentile(list(range(1, 101)), 95) == 95


def test_grade_pass_and_stats():
    boots = [core.parse_boot(OK) for _ in range(30)]
    g = core.grade(boots, 40000, 20000, 25)
    assert g["verdict"] == "PASS"
    assert g["stats"]["rate"] == 1.0 and g["stats"]["p95_ms"] == 7088


def test_grade_one_stall_fails():
    # The field symptom: 1 of N reboots never rejoins.
    boots = [core.parse_boot(OK) for _ in range(29)] + [core.parse_boot(STALL)]
    g = core.grade(boots, 40000, 20000, 25)
    assert g["verdict"] == "FAIL" and g["stats"]["failed"] == 1
    assert "did not lease" in g["problems"][0]


def test_grade_slow_p95_fails():
    slow = OK.replace("[t=7088] ***", "[t=25000] ***")
    boots = [core.parse_boot(OK) for _ in range(20)] + [core.parse_boot(slow) for _ in range(10)]
    g = core.grade(boots, 40000, 20000, 25)
    assert g["verdict"] == "FAIL" and any("p95" in p for p in g["problems"])


def test_grade_infra_skip():
    boots = [core.parse_boot("wait usb download")] * 10 + [core.parse_boot(OK)] * 5
    g = core.grade(boots, 40000, 20000, 25)
    assert g["verdict"] == "SKIP"


def test_lost_lease_banner_is_not_a_stall():
    # rig-2 jump30 boot 25: the non-blocking serial dropped the LEASE banner, but the
    # DHCP ACK and the :443 listener show the board leased.
    log = OK.replace(
        "[t=7088] *** DHCP LEASE ACQUIRED \u2014 IP 10.42.0.117 over heapless WiFi ***\n",
        "DHCP reply: type=5 yiaddr=10.42.0.117\n*** TCP LISTEN on 10.42.0.117:443 \u2014 heapless server ***\n",
    )
    b = core.parse_boot(log)
    assert b["lease_ip"] == "10.42.0.117" and b["lease_inferred"] and b["lease_ms"] == 5873
