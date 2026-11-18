# Ported from fughilli/indoor_localization swarm/proto/gen_golden.py at 5a906e78 (Splanc owns this
# copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
"""Golden encodings of swarm.v1 messages, from a hand-written protobuf encoder (stdlib only).

An encoder independent of micropb, pbview and protoc: the Rust tests, the C++ test and the Python
tests all check their own encoders and decoders against these bytes. Regenerate with

    python3 firmware/mesh/swarm/proto/gen_golden.py > firmware/mesh/swarm/proto/testdata/swarm_wire_golden.txt

Format: `name = hex`, one per line. Inputs are listed in the comments below each message so a
test can rebuild the message and compare.
"""

import hashlib
import hmac


def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def tag(field, wire):
    return varint(field << 3 | wire)


def uint(field, v):  # omitted at 0 (proto3)
    return tag(field, 0) + varint(v) if v else b""


def sint(field, v):  # zigzag 32
    z = (v << 1) ^ (v >> 31) & 0xFFFFFFFF
    return tag(field, 0) + varint(z & 0xFFFFFFFF) if v else b""


def fixed32(field, v):
    return tag(field, 5) + v.to_bytes(4, "little") if v else b""


def fixed64(field, v):
    return tag(field, 1) + v.to_bytes(8, "little") if v else b""


def blob(field, b):  # bytes / nested message; omitted when empty
    return tag(field, 2) + varint(len(b)) + b if b else b""


def setting(key, value, source=0):
    return uint(1, key) + fixed32(2, value) + uint(3, source)


HMAC_KEY = bytes([0x42] * 32)
TAG_LEN = 4


def hmac_tag(domain, *parts):
    return hmac.new(HMAC_KEY, domain + b"".join(parts), hashlib.sha256).digest()[:TAG_LEN]


def main():
    out = {}
    # LinkFrame fields are written in field-number order (ver = 15 last), as every encoder does.
    # LinkFrame: POLL from node 3, slot 2, seq 9, advert b"\x01\x02\x03", summary below.
    summary = uint(1, 7) + uint(2, 8) + uint(3, 5) + uint(4, 12) + uint(5, 300)
    out["summary"] = summary  # running 7, staged 8, pages 5, total 12, generation 300
    out["link_poll"] = (
        uint(1, 1)
        + uint(2, 3)
        + uint(4, 9)
        + uint(5, 2)
        + blob(11, b"\x01\x02\x03")
        + blob(12, summary)
        + uint(15, 1)
    )
    # RESPONSE 3 <- 20000 (a wide id), seq 9, advert empty.
    out["link_response"] = uint(1, 2) + uint(2, 20000) + uint(3, 3) + uint(4, 9) + uint(15, 1)
    # REPORT 3 <- 20000: t_round_b 0x00123456, t_reply_b 0x00654321.
    out["link_report"] = (
        uint(1, 4)
        + uint(2, 20000)
        + uint(3, 3)
        + uint(4, 9)
        + fixed32(8, 0x00123456)
        + fixed32(9, 0x00654321)
        + uint(15, 1)
    )
    # RESULT: range_mm -1234.
    out["link_result"] = (
        uint(1, 5) + uint(2, 3) + uint(3, 20000) + uint(4, 9) + sint(10, -1234) + uint(15, 1)
    )
    # MESH broadcast from 3 carrying payload b"\xaa\xbb".
    out["link_mesh"] = uint(1, 6) + uint(2, 3) + blob(6, b"\xaa\xbb") + uint(15, 1)
    # Splanc: BEACON from 3 carrying the summary above (backhauls without a POLL).
    out["link_beacon"] = uint(1, 10) + uint(2, 3) + blob(12, summary) + uint(15, 1)
    # Splanc: FW_REQUEST 3 -> 20000 (link unicast) carrying payload b"\x01".
    out["link_fw_request"] = (
        uint(1, 7) + uint(2, 3) + uint(3, 20000) + blob(6, b"\x01") + uint(15, 1)
    )

    # MeshPacket: origin 3, id 7, dest 2, hop_limit 2, hop_start 3, port 4, flags 1 (want ack), attempt 2.
    out["mesh_packet"] = (
        uint(1, 3)
        + uint(2, 7)
        + uint(3, 2)
        + uint(4, 2)
        + uint(5, 3)
        + uint(6, 4)
        + uint(7, 1)
        + uint(8, 2)
        + blob(9, b"\x01\x02\x03\x04")
    )
    # Splanc: a broadcast MeshPacket (dest absent) from 3, id 8, hop_limit 3, hop_start 3, port 16,
    # with a 200-byte payload (bytes 0..199): an 802.11-sized packet, two-byte length varint.
    out["mesh_packet_200"] = (
        uint(1, 3) + uint(2, 8) + uint(4, 3) + uint(5, 3) + uint(6, 16) + blob(9, bytes(range(200)))
    )

    # BundleBody: generation 3, settings (106 -> 0x0000e040), (300 -> 0x3e4ccccd); key 0x42*32.
    body = uint(1, 3) + blob(2, setting(106, 0x0000E040)) + blob(2, setting(300, 0x3E4CCCCD))
    out["bundle_body"] = body
    out["bundle"] = blob(1, body) + blob(2, hmac_tag(b"B", body))
    # OverrideBody for dest 1: SET, seq 1, (300 -> 0x3e4ccccd).
    obody = uint(1, 1) + uint(2, 1) + blob(3, setting(300, 0x3E4CCCCD))
    out["override_body"] = obody
    out["override"] = blob(1, obody) + blob(2, hmac_tag(b"O", (1).to_bytes(2, "little"), obody))
    # BundleFragment: generation 3, total_len 20, offset 0, data 4 bytes.
    out["bundle_fragment"] = uint(1, 3) + uint(2, 20) + blob(4, b"\x11\x22\x33\x44")
    out["bundle_request"] = uint(1, 3)
    # SettingsReport part 0 of 2, generation 3, override_seq 1, (106 swarm, 300 override).
    out["settings_report"] = (
        uint(2, 2)
        + uint(3, 3)
        + uint(4, 1)
        + blob(5, setting(106, 0x0000E040, 1))
        + blob(5, setting(300, 0x3E4CCCCD, 2))
    )
    out["ack"] = uint(1, 7)

    # Firmware: manifest body version 5, size 100000, sha256 = sha256(b"image"), flags 0.
    sha = hashlib.sha256(b"image").digest()
    mbody = uint(1, 5) + uint(2, 100000) + blob(3, sha)
    out["manifest_body"] = mbody
    out["manifest_dummy_signature"] = blob(1, mbody) + blob(2, bytes(range(64)))  # structure only
    out["fw_request"] = uint(1, 5) + uint(2, 3) + fixed64(3, 0x00000000000000FF)
    out["fw_data"] = uint(1, 5) + uint(2, 3) + uint(3, 2) + blob(4, bytes(range(10)))
    for k, v in out.items():
        print("%s = %s" % (k, v.hex()))


if __name__ == "__main__":
    main()
