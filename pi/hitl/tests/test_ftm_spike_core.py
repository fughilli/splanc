"""The FTM spike's timestamp decode (ftm_spike_core): synthetic RX vectors and per-queue
register words built from the field map, and the console line join."""

import ftm_spike_core as c


def rxv(us2: int, tick2: int, fine2: int, us3: int, tick3: int) -> bytes:
    v = bytearray(92)
    v[11] = tick2 & 0x7F
    v[12:16] = us2.to_bytes(4, "little")
    h = (fine2 & 0x7FF) << 4
    v[34] = h & 0xFF
    v[35] = (h >> 8) & 0x7F
    v[76:80] = us3.to_bytes(4, "little")
    v[80] = tick3
    return bytes(v)


def regs(us1: int, tick1: int, us4: int, tick4: int, fine4: int) -> tuple[int, int, int]:
    w0 = us1
    w1 = (us4 & 0xFFFFC000) | tick1
    w2 = ((us4 & 0x3FFF) << 18) | ((fine4 & 0x7FF) << 7) | tick4
    return w0, w1, w2


def test_fold():
    assert c.fold(5) == 5
    assert c.fold(1023) == 1023
    assert c.fold(2047) == 1


def test_rtt_zero_flight_is_formula_offset():
    # Both legs 100 µs: what's left is the decode's constant offsets (t4, t2: -13312;
    # t1, t3: -5120), which the vendor folds into its calibration.
    w0, w1, w2 = regs(1000, 10, 1100, 10, 0)
    e = c.Exchange(1, w0, w1, w2, rxv(5000, 10, 0, 5100, 10))
    assert e.rtt_raw("none") == c.FORMULA_OFFSET_RAW


def test_rtt_ticks_and_wrap():
    # A 32-bit wrap on the sender between t1 and t4, and 3 ticks (24 raw) more on its leg.
    w0, w1, w2 = regs(0xFFFFFFF0, 0, 0x50, 3, 0)
    e = c.Exchange(1, w0, w1, w2, rxv(7, 0, 0, 7 + 0x60, 0))
    assert e.rtt_raw("none") == c.FORMULA_OFFSET_RAW + 24


def test_fine_modes():
    w0, w1, w2 = regs(10, 0, 20, 0, 2047)
    e = c.Exchange(1, w0, w1, w2, rxv(100, 0, 3, 110, 0))
    assert e.rtt_raw("fold") == c.FORMULA_OFFSET_RAW + 1 + 3
    assert e.rtt_raw("signed") == c.FORMULA_OFFSET_RAW - 1 + 3


def test_parse_join_by_tag_and_seq():
    w0, w1, w2 = regs(1000, 10, 1100, 10, 0)
    v = rxv(5000, 10, 0, 5100, 10)
    tx = [
        f"[mesh] ftmtx tag=3 seq=7 a=1 st=0 dt=90 w0={w0:08x} w1={w1:08x} w2={w2:08x} pmd=0 mus=0"
    ]
    rx = [f"[mesh] ftmrx tag=3 seq=7 retry=0 lag=150 rxv={v.hex()}"]
    assert len(c.parse_logs(tx, rx, 3)) == 1
    assert c.parse_logs(tx, rx, 4) == []
    # an unACKed attempt (st=5) never counts
    assert c.parse_logs([tx[0].replace("st=0", "st=5")], rx, 3) == []


def test_relative_ppm_and_drift_correction():
    # Receiver clock 50 ppm fast: its t2 advances 1.00005x the sender's t1.
    ex = []
    for k in range(40):
        t1 = 1000 + k * 10000
        t2 = 5000 + round(k * 10000 * 1.00005)
        w0, w1, w2 = regs(t1, 0, t1 + 200, 0, 0)
        ex.append(c.Exchange(k, w0, w1, w2, rxv(t2, 0, 0, t2 + 200, 0)))
    ppm = c.relative_ppm(ex)
    assert abs(ppm - 50) < 3
    e = ex[0]
    assert c.rtt_drift_corrected(e, ppm, "none") > e.rtt_raw("none")


def test_robust_and_exchanges_for():
    r = c.robust([1.0, 2.0, 3.0, 2.0, 100.0])
    assert r["kept"] == 4
    assert c.exchanges_for(1.0, 0.25) == 16
    assert c.inliers([1.0, 2.0, 3.0, 2.0, 100.0]) == [1.0, 2.0, 3.0, 2.0]
