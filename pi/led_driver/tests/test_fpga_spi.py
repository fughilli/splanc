"""Byte-exact tests for the spi_ws281x FPGA framing (fpga_spi)."""

from led_driver import fpga_spi as f


def test_to_wire_grb_order():
    # WS2812 wire order is G, R, B.
    assert f.to_wire((1, 2, 3)) == bytes([2, 1, 3])
    assert f.to_wire((0x10, 0x20, 0x30), color_order="RGB") == bytes([0x10, 0x20, 0x30])


def test_set_num_ports_csr():
    assert f.set_num_ports(2) == bytes([f.OP_WRITE_CSR, f.CSR_NUM_PORTS, 2])
    assert f.encode_csr(f.CSR_LED_TYPE, 0) == bytes([0x01, 0x01, 0x00])


def test_encode_stream_round_robin():
    # 2 ports, one pixel each: port0 wire = G,R,B = 2,1,3 ; port1 = 5,4,6.
    # Round-robin (byte i -> port i%2): 0x02, p0[0],p1[0], p0[1],p1[1], p0[2],p1[2]
    stream = f.encode_stream([[(1, 2, 3)], [(4, 5, 6)]])
    assert stream == bytes([f.OP_STREAM, 2, 5, 1, 4, 3, 6])


def test_encode_stream_pads_short_ports():
    # port0 has 2 pixels (6 bytes), port1 has 1 (3 bytes -> padded to 6 with 0).
    stream = f.encode_stream([[(1, 1, 1), (2, 2, 2)], [(3, 3, 3)]])
    body = stream[1:]
    # De-interleave back to per-port byte streams and check padding.
    p0 = body[0::2]
    p1 = body[1::2]
    assert p0 == bytes([1, 1, 1, 2, 2, 2])
    assert p1 == bytes([3, 3, 3, 0, 0, 0])


def test_round_robin_reconstructs_per_port():
    ports = [
        [(10, 11, 12), (13, 14, 15)],
        [(20, 21, 22), (23, 24, 25)],
        [(30, 31, 32), (33, 34, 35)],
    ]
    stream = f.encode_stream(ports)
    n = len(ports)
    body = stream[1:]
    for p, pf in enumerate(ports):
        got = bytes(body[p::n])
        want = b"".join(f.to_wire(px) for px in pf)
        assert got == want, f"port {p}: {got!r} != {want!r}"


def test_split_ports_even_and_explicit():
    colors = [(i, i, i) for i in range(7)]
    # even split of 7 across 3 -> [3, 2, 2]
    parts = f.split_ports(colors, 3)
    assert [len(p) for p in parts] == [3, 2, 2]
    # explicit counts
    parts = f.split_ports(colors, 3, port_counts=[1, 4, 2])
    assert [len(p) for p in parts] == [1, 4, 2]
    assert parts[1] == colors[1:5]


def test_matched_speed_hz():
    # WS2812: 10 us/byte -> num_ports * 800 kHz.
    assert f.matched_speed_hz(2) == 1_600_000
    assert f.matched_speed_hz(8) == 6_400_000


def test_codec_configure_frame_dark():
    codec = f.FpgaCodec(2)
    assert codec.configure() == bytes([0x01, 0x00, 2])
    # 2 LEDs, even split -> 1 per port.
    frame = codec.frame([(1, 2, 3), (4, 5, 6)])
    assert frame == bytes([f.OP_STREAM, 2, 5, 1, 4, 3, 6])
    dark = codec.dark(2)
    assert dark == bytes([f.OP_STREAM, 0, 0, 0, 0, 0, 0])
