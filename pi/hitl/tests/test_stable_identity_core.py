"""The netstack stable-identity HITL gate's pure logic (harness/stable_identity_core.py):
boot-log parse, the legacy-unicast mDNS query/answer codec, and the verdict."""

import struct

import stable_identity_core as core

BOOT = (
    "rst:0x15 (USB_UART_HPSYS),boot:0xc (SPI_FAST_FLASH_BOOT)\n"
    '[player] identity 8C:FD:49:10:3A:86 / "PixieLamp" ap "x" host x.local build abc\n'
    "MAC 8c:fd:49:10:3a:84 (factory)\n"
    "[t=10345] *** DHCP LEASE ACQUIRED — IP 10.42.0.37 over heapless WiFi ***\n"
    "[mdns] announcing _splanc._tcp on 10.42.0.37\n"
)
OLD_BOOT = BOOT.replace("MAC 8c:fd:49:10:3a:84 (factory)", "MAC 02:0c:6a:95:10:f2")


def _answer(ip="10.42.0.37", dev="8C:FD:49:10:3A:86") -> bytes:
    def name(n):
        return core._qname(n)

    q = core.build_ptr_query()
    hdr = struct.pack(">HHHHHH", 0x5A5A, 0x8400, 1, 1, 0, 3)
    body = q[12:]
    inst = "PixieLamp." + core.SERVICE
    ptr = name(core.SERVICE) + struct.pack(">HHIH", core.T_PTR, 1, 120, len(name(inst))) + name(inst)
    host = name("splanc-103a86.local")
    srv_rd = struct.pack(">HHH", 0, 0, 443) + host
    srv = name(inst) + struct.pack(">HHIH", core.T_SRV, 0x8001, 120, len(srv_rd)) + srv_rd
    txt_rd = b"".join(bytes([len(s)]) + s for s in (f"id={dev}".encode(), b"name=PixieLamp", b"tls=ready"))
    txt = name(inst) + struct.pack(">HHIH", core.T_TXT, 0x8001, 120, len(txt_rd)) + txt_rd
    a = host + struct.pack(">HHIH", core.T_A, 0x8001, 120, 4) + bytes(int(x) for x in ip.split("."))
    return hdr + body + ptr + srv + txt + a


def test_parse_boot_factory_mac():
    b = core.parse_boot(BOOT)
    assert b["sta_mac"] == "8c:fd:49:10:3a:84" and b["mac_kind"] == "factory"
    assert b["lease_ip"] == "10.42.0.37" and b["mdns_ip"] == "10.42.0.37"
    assert b["device_id"] == "8C:FD:49:10:3A:86"
    assert core.parse_boot(OLD_BOOT)["mac_kind"] is None  # pre-fix firmware: no kind


def test_query_is_one_ptr_question():
    q = core.build_ptr_query()
    assert struct.unpack(">HHHHHH", q[:12])[2] == 1
    assert q.endswith(struct.pack(">HH", core.T_PTR, 1))


def test_parse_answers_roundtrip():
    a = core.parse_answers(_answer())
    assert a["a"] == ["10.42.0.37"]
    assert a["txt"]["id"] == "8C:FD:49:10:3A:86"
    assert a["srv"] == [("splanc-103a86.local", 443)]
    assert a["ptr"] == ["PixieLamp._splanc._tcp.local"]


def _ok_refusal():
    return {"second": "reset", "second_s": 0.02, "first_after": 200}


def test_grade_pass():
    b = core.parse_boot(BOOT)
    g = core.grade(b, b, core.parse_answers(_answer()), _ok_refusal())
    assert g["verdict"] == "PASS", g


def test_grade_random_mac_and_moved_lease_fail():
    # The field report: a new random MAC each boot -> a new lease each boot.
    b1 = core.parse_boot(OLD_BOOT)
    b2 = core.parse_boot(OLD_BOOT.replace("95:10:f2", "11:22:33").replace("10.42.0.37", "10.42.0.41"))
    g = core.grade(b1, b2, core.parse_answers(_answer("10.42.0.41")), _ok_refusal())
    assert g["verdict"] == "FAIL"
    assert any("factory" in p for p in g["problems"])
    assert any("MAC changed" in p for p in g["problems"])
    assert any("lease changed" in p for p in g["problems"])


def test_grade_mdns_mismatch_and_hung_extra_client_fail():
    b = core.parse_boot(BOOT)
    g = core.grade(b, b, core.parse_answers(_answer("10.42.0.99", "AA:BB:CC:DD:EE:FF")),
                   {"second": "hung", "second_s": 8.0, "first_after": None})
    assert g["verdict"] == "FAIL"
    text = " ".join(g["problems"])
    assert "A record" in text and "TXT id" in text and "not refused cleanly" in text and "unusable" in text


def test_grade_infra_skip():
    assert core.grade(None, None, None, None)["verdict"] == "SKIP"
    b = core.parse_boot(BOOT)
    assert core.grade(b, {"booted": False}, None, None)["verdict"] == "SKIP"
