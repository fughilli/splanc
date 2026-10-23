"""Pure-logic tests for the on-LAN live-control latency budget (ctrl_budget_core) and the
rig-side probe's wire encoding (ctrl_budget_probe). No rig: a synthetic window whose
device trace is built with known stage durations and a known clock offset must come back
attributed exactly. The on-hardware bench is //pi/hitl/harness:ctrl_budget_netstack.
"""

from __future__ import annotations

import base64
import struct

import ctrl_budget_core as core
import ctrl_budget_probe as probe

OFF = 7_000_000  # device clock = host clock + OFF (µs)


def _image(now, rx, frames, n_rx=8, n_fr=16):
    hdr = struct.pack(
        core.HDR_FMT,
        0x31525443,
        now & 0xFFFFFFFF,
        len(rx),
        len(frames),
        n_rx,
        n_fr,
        struct.calcsize(core.RX_FMT),
        struct.calcsize(core.FR_FMT),
    )
    body = b""
    for i in range(n_rx):
        if i < len(rx):
            body += struct.pack(core.RX_FMT, *[v & 0xFFFFFFFF for v in rx[i]])
        else:
            body += bytes(struct.calcsize(core.RX_FMT))
    for i in range(n_fr):
        if i < len(frames):
            body += struct.pack(core.FR_FMT, *[v & 0xFFFFFFFF for v in frames[i]])
        else:
            body += bytes(struct.calcsize(core.FR_FMT))
    return hdr + body


def _wss_run():
    t0 = 10_000_000
    lines = ['META {"transport": "wss"}', f"W 0 {t0}"]
    for v in range(1, 6):
        lines.append(f"G {v} {t0 + v * 10_000}")
    # batch 1 carries counter 1 (sent 5 ms after it moved); batch 2 counter 5.
    sends = [(1, t0 + 15_000, 1, 1), (2, t0 + 55_000, 2, 5)]
    rx = []
    for idx, ts, seq, ctr in sends:
        lines.append(f"S {idx} {ts} u {seq} {ctr}")
        reap = ts + OFF + 2_000  # 2 ms uplink
        e = (
            idx,
            1,
            3,
            40,
            reap - 1_000,  # last empty poll 1 ms before the reap
            reap,
            reap + 300,  # decoded
            reap + 350,  # enter
            reap + 4_350,  # locked: 4 ms behind the render mutex
            reap + 4_400,  # handled
            reap + 4_600,  # reply sent
        )
        rx.append(e)
        lines.append(f"R {e[10] - OFF + 2_000} a {seq}")
    frames = []
    fs0 = t0 + OFF - 100_000
    for k in range(10):
        fs = fs0 + k * 20_000
        frames.append((k, fs, fs + 12_000, fs + 12_100, fs + 17_000))
    now = t0 + OFF + 300_000
    img = _image(now, rx, frames)
    lines.append(f"D 0 {now - OFF} {base64.b64encode(img).decode()}")
    lines.append("END done")
    return "\n".join(lines)


def test_decode_dump_relative_stamps_and_wrap():
    now = 0xFFFF_F000  # the 32-bit µs clock wraps between the stamps and the dump
    rx = [(1, 1, 0, 9, 0, now - 50, (now + 100) & 0xFFFFFFFF, 0, 0, 0, 0)]
    d = core.decode_dump(_image(now, rx, [(3, now - 10, 0, 0, 0)]))
    assert d.rx[0].reap == -50.0 and d.rx[0].decoded == 100.0
    assert d.rx[0].empty is None  # 0 = never stamped
    assert d.frames[0].seq == 3 and d.frames[0].fs == -10.0
    assert not d.rx_overrun


def test_clock_fit_recovers_offset_and_floor():
    run = core.parse(_wss_run())
    fit = core.clock_fit(run.windows[0])
    now_rel = OFF + 10_000_000 + 300_000
    assert abs(fit.offset - (OFF - now_rel)) < 1e-6
    assert abs(fit.up_floor - 2_000) < 1e-6


def test_stages_attributed():
    run = core.parse(_wss_run())
    w = run.windows[0]
    s = core.attribute(w, core.clock_fit(w))
    by = {x.counter: x.stages for x in s}
    # counter 1: moved t0+10ms, sent t0+15ms -> pace 5 ms; handled t0+15+2+4.4 = 21.4 ms.
    st = by[1]
    assert st["pace"] == 5_000
    assert st["uplink"] == 2_000 and st["ring"] == 1_000
    assert st["decode"] == 300 and st["queue"] == 50
    assert st["mutex"] == 4_000 and st["handle"] == 50
    # frames start at t0-100ms + 20k: the first after t0+21.4ms is t0+40ms.
    assert st["frame_wait"] == 40_000 - 21_400
    assert st["render"] == 12_000 and st["wire"] == 5_000
    assert st["apply"] == 30_000 and st["photon"] == 30_000 + 17_000
    # counters 2..5 ride batch 2 (sent t0+55ms): 5 waited 5 ms, 2 waited 35 ms.
    assert by[5]["pace"] == 5_000 and by[2]["pace"] == 35_000
    assert by[2]["apply"] == by[5]["apply"] + 30_000


def test_budget_table_and_result_line():
    b = core.budget(core.parse(_wss_run()), "heavy wss")
    assert b.n == 5 and abs(b.frame_ms - 20.0) < 1e-9
    t = core.table([b])
    assert "heavy wss" in t and "**" in t
    line = core.result_line(b)
    assert line.startswith("RESULT ctrl_budget config=heavy_wss n=5")


def test_gate_metric_ages_oldest_unhandled():
    run = core.parse(_wss_run())
    w = run.windows[0]
    g = core.gate_metric(w, core.clock_fit(w), step_us=1_000)
    # from batch 1's handling (t0+21.4ms) to batch 2's (t0+61.4ms): counter 2 (moved
    # t0+20ms) is the oldest unhandled, so the lag grows from 1.4 ms to ~41 ms.
    assert len(g) == 40
    assert abs(g[0] - 1_400) < 1e-6 and abs(g[-1] - 40_400) < 1e-6


def test_osc_attribution():
    t0 = 10_000_000
    lines = ['META {"transport": "osc"}', f"W 0 {t0}"]
    rx = [(1, 1, 2, 30, 0, t0 + OFF + 3_000, 0, 0, 0, t0 + OFF + 3_300, t0 + OFF + 3_400)]
    lines.append(f"S 1 {t0} p 0 -1")
    lines.append(f"R {t0 + 3_400 + 3_000} p 1")
    for v in (1, 2):
        lines.append(f"G {v} {t0 + v * 10_000}")
        lines.append(f"O {v} {t0 + v * 10_000 + 100}")
        reap = t0 + v * 10_000 + 100 + OFF + 3_000
        rx.append((v, 2, 0, 16, reap - 500, reap, 0, reap + 20, 0, reap + 60, 0))
    frames = [(k, t0 + OFF + k * 25_000, t0 + OFF + k * 25_000 + 1_000, 0, 0) for k in range(4)]
    now = t0 + OFF + 200_000
    img = _image(now, rx, frames)
    lines += [f"D 0 {now - OFF} {base64.b64encode(img).decode()}", "END done"]
    run = core.parse("\n".join(lines))
    w = run.windows[0]
    fit = core.clock_fit(w)
    s = {x.counter: x.stages for x in core.attribute(w, fit)}
    assert s[1]["pace"] == 100 and s[1]["uplink"] == 3_000 and s[1]["ring"] == 500
    assert s[1]["handle"] == 40 and s[1]["mutex"] is None
    # handled at t0+13.16 ms -> the frame at t0+25 ms
    assert s[1]["apply"] == 15_000 and s[1]["photon"] is None


def test_probe_set_uniforms_encoding_matches_the_proto():
    from ledmapper_pb2 import ClientMessage

    m = ClientMessage()
    m.ParseFromString(probe.client_set_uniforms([(0, [7.0]), (2, [0.25])], seq=9))
    su = m.set_uniforms
    assert m.WhichOneof("msg") == "set_uniforms"
    assert [(v.slot, list(v.value)) for v in su.values] == [(0, [7.0]), (2, [0.25])]
    assert su.HasField("commit") and su.commit is False and su.seq == 9
    m.ParseFromString(probe.client_ping(1234.5))
    assert m.WhichOneof("msg") == "time_sync_ping" and m.time_sync_ping.t0 == 1234.5


def test_probe_osc_message_layout():
    assert probe.osc_msg("/probe", 3.0) == probe.OSC_PROBE_HEAD + struct.pack(">f", 3.0)
    assert len(probe.osc_msg("/k1", 0.5)) % 4 == 0
