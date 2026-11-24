"""mesh_range_core (docs/design/mesh-ftm.md): the firmware's MESH RANGE lines, the
on-hardware gate's verdict, and the ground-truth fit (D-520 / D-521)."""

from mesh_range_core import (
    M_PER_RAW,
    GateResult,
    Point,
    coax_equivalent_m,
    fit,
    parse,
    state_key,
    verdict,
)

SELF = (
    "123 [mesh] range self on=1 phase=41 votes=0/57/1 k_x16=22520 cal=0 period_ms=10000 "
    "rx_recs=58 tx_recs=60 rx_bad=1 tx_bad=0 probes=16 reports=7 reports_in=7 bad_msgs=0 "
    "matched=56 exch=55 rejected=1 fits=6 no_fit=1"
)
PEER = (
    "124 [mesh] range id=1f48 range_mm=312 sigma_mm=41 n=16 age_ms=900 phase_self=41 "
    "phase_peer=39 cal=0 ppb=48812"
)
NONE = (
    "125 [mesh] range id=2240 range_mm=-2147483648 sigma_mm=0 n=0 age_ms=-1 phase_self=41 "
    "phase_peer=0 cal=0 ppb=-9223372036854775808"
)


def test_parse_lines():
    me, peers = parse([SELF, PEER, NONE, "noise"])
    assert me.on and me.phase == 41 and me.votes == (0, 57, 1) and me.k_x16 == 22520
    assert me.counters["exch"] == 55
    p = peers["1f48"]
    assert (p.range_m, p.sigma_m, p.n, p.phase_self, p.phase_peer, p.ppb) == (
        0.312,
        0.041,
        16,
        41,
        39,
        48812,
    )
    # The RTT the estimate stands for: K + range / 0.234.
    assert abs(p.rtt_raw(22520) - (1407.5 + 0.312 / M_PER_RAW)) < 1e-9
    q = peers["2240"]
    assert q.range_m is None and q.ppb is None and q.rtt_raw(22520) is None


def _gate(ab_line: str, ba_line: str) -> GateResult:
    _, pa = parse([ab_line])
    _, pb = parse([ba_line])
    r = GateResult(ab=next(iter(pa.values())), ba=next(iter(pb.values())))
    w = {"windows": 5, "fps_median": 60.0, "dt_max_ms": 25}
    r.render_off = {"a": dict(w), "b": dict(w)}
    r.render_on = {"a": dict(w), "b": dict(w)}
    return r


BA = (
    "[mesh] range id=1170 range_mm=290 sigma_mm=50 n=16 age_ms=100 phase_self=39 "
    "phase_peer=41 cal=0 ppb=-48812"
)


def test_gate_passes_a_symmetric_flagged_pair():
    ok, why = verdict(_gate(PEER, BA))
    assert ok, why


def test_gate_failures():
    # B->A missing.
    r = _gate(PEER, BA)
    r.ba = None
    assert not verdict(r)[0]
    # Phase states that do not mirror.
    ok, why = verdict(_gate(PEER, BA.replace("phase_self=39", "phase_self=41")))
    assert not ok and any("disagree" in w for w in why)
    # A wide estimate, too few exchanges, A->B vs B->A apart, "calibrated".
    for bad in ("sigma_mm=400", "n=3", "range_mm=1500", "cal=1"):
        key = bad.split("=")[0]
        line = " ".join(bad if t.startswith(key + "=") else t for t in BA.split())
        assert not verdict(_gate(PEER, line))[0], bad
    # Render: fps drop, or a new long frame gap, with ranging on.
    r = _gate(PEER, BA)
    r.render_on["a"]["fps_median"] = 50.0
    assert not verdict(r)[0]
    r = _gate(PEER, BA)
    r.render_on["b"]["dt_max_ms"] = 80
    assert not verdict(r)[0]


def test_fit_recovers_k_per_state_and_slope():
    # Truth: K = 1407.5 (39/39), +9 raw for a pair with one device in 41, slope 1.
    pts = []
    for d in (0.5, 1, 2, 4, 8):
        for st, k in (((39, 39), 1407.5), ((41, 39), 1416.5)):
            pts.append(Point(d, k + d / M_PER_RAW, 0.05, st[0], st[1]))
    f = fit(pts)
    assert abs(f["slope"] - 1.0) < 1e-6
    assert abs(f["k_raw"]["39/39"] - 1407.5) < 1e-6 and abs(f["k_raw"]["39/41"] - 1416.5) < 1e-6
    assert f["k_x16"]["39/39"] == 22520
    assert abs(f["offset_vs_39_39_m"]["39/41"] - 9 * M_PER_RAW) < 1e-3
    assert f["residual_max_m"] < 1e-6
    assert state_key(Point(1, 0, 0, 41, 39)) == "39/41"
    assert "error" in fit(pts[:1])


def test_coax_equivalent():
    assert abs(coax_equivalent_m(0.7, 0.7) - 1.0) < 1e-12
