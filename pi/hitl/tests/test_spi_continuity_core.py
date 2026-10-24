"""Unit tests for spi_continuity_core (the SPI-continuity capture's pure analysis)."""

import base64
import math

import spi_continuity_core as sc


def _uvarint(vals):
    out = bytearray()
    for v in vals:
        while True:
            b = v & 0x7F
            v >>= 7
            if v:
                out.append(b | 0x80)
            else:
                out.append(b)
                break
    return base64.b64encode(bytes(out)).decode()


def test_uvarint_roundtrip():
    vals = [1, 127, 128, 300, 1_000_000, 5]
    assert sc.decode_uvarint_runs(_uvarint(vals)) == vals


def test_level_intervals_drops_cut_ends():
    # start HIGH(10) LOW(5) HIGH(7) LOW(3) HIGH(9): complete LOWs are [10,15) and [22,25)
    runs = [10, 5, 7, 3, 9]
    assert sc.level_intervals(runs, 1, 0) == [(10, 15), (22, 25)]
    # the first run is cut by the window, so a LOW there is dropped
    assert sc.level_intervals([4, 6, 2], 0, 0) == []


def test_histogram_bins():
    h = sc.histogram([0.5, 3, 12, 25, 700])
    assert h["<1"] == 1 and h["1-5"] == 1 and h["10-20"] == 1 and h["20-50"] == 1
    assert h[">=600"] == 1
    assert sum(h.values()) == 5


def _frame(start_us, bits, gaps=(), gap_before=None, rate=1_000_000):
    return {
        "start_sample": int(start_us * rate / 1e6),
        "start_us": start_us,
        "bits": bits,
        "gap_before_us": gap_before,
        "gaps": [{"at_us": a, "len_us": n, "bit": b} for a, n, b in gaps],
        "gap_count": len(gaps),
    }


def test_transactions_place_gaps_by_byte_and_catch_frame_splits():
    rate = 1_000_000  # 1 sample = 1 us
    # one CS-low transaction [100, 5000) us: a burst with a 2 us pause after 80
    # bits (byte 10), then a 300 us pause that ended the CLK "frame" (reset_us),
    # then a second burst.
    f1 = _frame(110, 800, gaps=[(20, 2.0, 80)])
    f2 = _frame(1500, 800, gap_before=300.0)
    txs = sc.transactions([f1, f2], [(100, 5000)], rate)
    assert len(txs) == 1
    tx = txs[0]
    assert tx.bytes == 200
    assert [(round(g.at_us), g.len_us, g.byte) for g in tx.gaps] == [
        (20, 2.0, 10),
        (1090, 300.0, 100),
    ]
    assert math.isclose(tx.cs_low_us, 4900)


def test_slack_model_and_verdicts():
    ports, r = 4, 2.0
    # before every port has PREFILL bytes nothing is emitting: unlimited slack
    assert sc.slack_us(1 + 4 * 1, 2, ports, r) == float("inf")
    # right at the start (2 bytes/port) the lead is PREFILL bytes
    assert math.isclose(sc.slack_us(1 + 4 * 2, 2, ports, r), 2 * sc.WS_BYTE_US)
    # 100 bytes/port later at r=2 the lead grew by 50 bytes
    assert math.isclose(sc.slack_us(1 + 4 * 102, 2, ports, r), 52 * sc.WS_BYTE_US)

    tx = sc.Transaction(start_us=0, cs_low_us=10_000, bits=8 * 12289)
    tx.gaps = [sc.Gap(10, 30.0, 1 + 4 * 2), sc.Gap(5000, 400.0, 1 + 4 * 600)]
    v2, v64 = sc.verdicts([tx], ports, r)
    # PREFILL=2: a 30 us pause at the start overruns the 20 us lead by ~10 us
    assert v2.window_bytes == 17 and v2.max_gap_in_window_us == 30.0
    assert v2.stalls == 1 and v2.latches == 0 and 9 < v2.worst_excess_us < 11
    # PREFILL=64: the same pause lands before emission starts -> no stall
    assert v64.stalls == 0 and v64.worst_excess_us < 0


def test_spi_clock_from_expected_size():
    tx = sc.Transaction(start_us=0, cs_low_us=1000 + 50, bits=8 * 800)
    tx.gaps = [sc.Gap(10, 50.0, 1)]
    hz = sc.spi_clock_hz([tx], 800)
    assert math.isclose(hz, 800 * 8 / 1e-3)
