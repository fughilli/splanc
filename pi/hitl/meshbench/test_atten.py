"""One attenuator per DUT (docs/design/mesh-hitl-rig.md §2.1, §5.4, §5.8, §6.1): the
node bench model, the leak paths that bypass a relay's attenuator, the fit of node
attenuators to pair losses, the UART sequencing around the latch edge, the
calibration files and the direct Jeanoko driver."""

import json
import math
import os
import tempfile

import atten_cal
import jeanoko
import pytest
import scenarios as sc

N4 = [
    "dlyA", "dlyB", "cut01", "cut02", "cut03", "cut12", "cut13", "cut23",
    "att0", "att1", "att2", "att3", "attx", "syncled",
]  # fmt: skip


@pytest.fixture
def b():
    return sc.Bench(N4)


def test_model_detection(b):
    assert b.model == "node"
    assert b.node_atts == {0: "att0", 1: "att1", 2: "att2", 3: "att3"}
    assert b.uart_devs == {"att0", "att1", "att2", "att3", "attx"}
    assert b.atts("13") == ["att1", "att3"]
    # default budget (§2.1): F = 2 x 12.3 + 32.5, plus 2 x 1.5 dB of unit insertion loss
    assert b.min_loss_db() == pytest.approx(2 * 12.3 + 32.5 + 3.0)


def test_pair_loss_is_the_sum_of_its_two_units(b):
    v = {"cut01": 1, "att0": 10.0, "att1": 2.5}
    assert b.path_loss(v, "01") == pytest.approx(b.min_loss_db() + 12.5)


def test_full_mesh_fit_is_exact(b):
    v = b.full(70.0)
    assert all(b.path_loss(v, p) == pytest.approx(70.0, abs=0.13) for p in b.pairs)
    assert b.fit_warnings() == []


def test_a_cut_leaks_round_a_live_neighbour_bypassing_its_attenuator(b):
    # 0-1 and 1-2 live, 0-2 cut. The detour enters node 1's splitter on one port and
    # leaves on another: node 1's own attenuator is not in it, however high it is.
    lo = {"cut01": 1, "cut12": 1, "cut02": 0, "cut03": 0, "cut13": 0, "cut23": 0}
    lo.update({"att0": 0.0, "att1": 0.0, "att2": 0.0, "att3": 0.0})
    hi = dict(lo, att1=31.75)
    via1 = dict(b.leak_paths(lo, "02"))["1"]
    assert dict(b.leak_paths(hi, "02"))["1"] == pytest.approx(via1)
    # = the through loss of 0-2 + one extra pair chain + the splitter isolation
    thr = b.through_loss(lo, "02")
    assert via1 == pytest.approx(thr + sc.PAIR_CHAIN_DB + sc.SPLITTER_ISO_DB)
    assert via1 - thr == pytest.approx(52.5)
    # through the cut chains (node 3) it is deeper by the switch isolation
    assert dict(b.leak_paths(lo, "02"))["3"] > via1 + 2 * sc.CUT_ISO_DB - 1


def test_partition_is_deep_and_link_flap_is_shallow(b):
    part = b.full(70.0)
    for p in ("02", "03", "12", "13"):
        part[f"cut{p}"] = 0
    # every leak path crosses at least one open switch: about the through loss + 55 dB
    assert min(b.path_loss(part, p) for p in ("02", "03", "12", "13")) > 70 + sc.CUT_ISO_DB - 3
    assert not b.sneak_paths(part)
    flap = dict(b.full(70.0), cut01=0)
    # two detours (via 2 and via 3), each 70 + 52.5 dB, and the open switch's own
    # 70 + 55 dB, add in power
    want = sc._db_sum([70 + 52.5, 70 + 52.5, 70 + sc.CUT_ISO_DB])
    assert b.path_loss(flap, "01") == pytest.approx(want, abs=0.2)
    assert want < 70 + 52.5 - 10 * math.log10(2)
    # with 10 dB pads (the cart as first written) the same cut is only ~32 dB deep
    b10 = sc.Bench(N4, fixed_loss_db=2 * sc.NODE_SIDE_DB + 12.5)
    flap10 = dict(b10.full(60.0), cut01=0)
    assert b10.path_loss(flap10, "01") == pytest.approx(60 + 32.5 - 3.0, abs=0.3)
    assert any(w.startswith("01 via") for w in b10.sneak_paths(flap10))


def test_infeasible_pair_targets_are_reported(b):
    # a weak 0-2 backup beside a strong 0-1-2-3 chain can't come from node attenuators
    b.topology({"01": 60.0, "12": 60.0, "23": 60.0, "02": 85.0})
    w = b.fit_warnings()
    assert any(x.startswith("pair 02") for x in w)
    # three chain links and four knobs: exact
    b.topology({"01": 70.0, "12": 80.0, "23": 75.0})
    assert b.fit_warnings() == []


def test_unused_nodes_go_to_max(b):
    v = b.topology({"01": 60.0})
    assert v["att2"] == v["att3"] == 31.75
    assert v["cut02"] == 0 and v["cut01"] == 1


def test_walk_fade_moves_one_node(b):
    s = sc.walk_fade(b, duration=2.0)
    moved = {k for st in s.steps[1:] for k in st.values}
    assert moved == {"att1"}  # the higher node of pair 01


def test_compile_sequences_uart_around_the_latch(b):
    lead = sc.UART_LEAD_US
    base = b.full(60.0)
    steps = [
        sc.Step(0.0, dict(base, cut01=0), "start"),
        # a make step: 0-1 goes through, and its units move: they must land first
        sc.Step(2.0, {"cut01": 1, "att0": 3.0, "att1": 3.0}, "make"),
        # a break step: the units move after the latch edge
        sc.Step(4.0, {"cut01": 0, "att0": 9.0}, "break"),
        # attenuators only: early by the unit latency, so the RF lands on time
        sc.Step(6.0, {"att2": 12.0}, "fade"),
    ]
    c = sc.compile(sc.Scenario("t", 8.0, steps), b)
    tl = dict(c.timeline)
    at = lambda s: int((1.0 + s) * 1e6)  # noqa: E731
    assert tl[at(2.0)]["cut01"] == 1 and "att0" not in tl[at(2.0)]
    t_make = at(2.0) - lead - sc.UART_GUARD_US
    assert tl[t_make] == {"att0": 3.0, "att1": 3.0}
    assert tl[at(4.0)]["cut01"] == 0 and tl[at(4.0)]["att0"] == 9.0
    assert tl[at(6.0) - lead] == {"att2": 12.0}
    land = {(dev, val): t for _, t, dev, val in c.uart}
    assert land[("att0", 3.0)] < at(2.0)  # landed before the link opened
    assert land[("att2", 12.0)] == at(6.0)


def test_compile_spaces_commands_per_unit(b):
    steps = [sc.Step(0.0, b.full(60.0))] + [
        sc.Step(1.0 + k * 0.0002, {"att3": 1.0 + k}) for k in range(3)
    ]
    c = sc.compile(sc.Scenario("t", 2.0, steps), b)
    t3 = [t for t, _, dev, _ in c.uart if dev == "att3"]
    assert all(b2 - a2 >= sc.UART_MIN_SPACING_US for a2, b2 in zip(t3, t3[1:]))
    assert any("closer than" in w for w in c.warnings)


def test_meshsim_replay_fits_nodes(b):
    rows = [(0.0, 0, 1, 90.0), (0.0, 1, 2, 125.0), (0.0, 0, 2, 95.0), (1.5, 1, 2, 100.0)]
    s = sc.from_meshsim(b, rows, tx_sim_dbm=20, tx_bench_dbm=2)
    v0 = s.steps[0].values
    assert v0["cut12"] == 0 and v0["cut01"] == 1
    assert b.path_loss(v0, "01") == pytest.approx(90 - 18, abs=0.2)
    assert b.path_loss(v0, "02") == pytest.approx(95 - 18, abs=0.2)
    assert not s.warnings
    assert s.steps[1].values["cut12"] == 1


# ---- calibration files


def _rows(il=2.0, slope=1.02, latency=None):
    rows = []
    for k in range(128):
        for f in (2412.0, 2437.0, 2462.0):
            rows.append((k * 0.25, f, -(il + (f - 2412) * 0.004 + k * 0.25 * slope)))
    return rows


def test_unit_file_and_check():
    u = atten_cal.unit_from_rows("J1", _rows(), latency_us=2600)
    assert u["schema"] == atten_cal.UNIT_SCHEMA and len(u["s21_db"]) == 3
    loss = atten_cal.loss_at(u, 2437.0)
    assert loss[0] == pytest.approx(2.1) and loss[127] == pytest.approx(2.1 + 31.75 * 1.02)
    assert atten_cal.loss_at(u, 2449.5)[0] == pytest.approx(2.15)
    q = atten_cal.check(u)
    assert q["insertion_loss_db"] == pytest.approx(2.1)
    assert q["max_abs_error_db"] == pytest.approx(0.64, abs=0.02)
    assert q["non_monotonic_settings"] == []
    with pytest.raises(ValueError):
        atten_cal.unit_from_rows("J2", _rows()[:-1])


def test_bench_file_feeds_the_compiler():
    units = {
        f"att{i}": atten_cal.unit_from_rows(f"J{i + 1}", _rows(il=1.5 + i), latency_us=4000 + i)
        for i in range(4)
    }
    e2e = {"01": 52.0, "02": 53.0, "03": 54.0, "12": 54.0, "13": 55.0, "23": 56.0}
    bc = atten_cal.build_bench(units, 2462.0, e2e)
    assert bc["pair_fixed_db"]["01"] == pytest.approx(52.0 - 1.7 - 2.7, abs=0.01)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "bench_cal.json")
        json.dump(bc, open(path, "w"))
        cal = atten_cal.load(path)
    b = sc.Bench(N4, cal=cal)
    # end to end at all-zero reproduces the measurement
    zero = {f"att{i}": 0.0 for i in range(4)}
    assert all(b.through_loss(zero, p) == pytest.approx(e2e[p], abs=0.01) for p in e2e)
    # the calibrated slope (1.02 dB per dB) is used to hit a target
    v = b.full(70.0)
    assert all(b.path_loss(v, p) == pytest.approx(70.0, abs=1.0) for p in b.pairs)
    assert b.uart_lead_us("att2") == 4002
    with pytest.raises(ValueError):
        atten_cal.build_bench({"att0": units["att0"]}, 2462.0, {"01": 50.0})


# ---- the direct USB driver


class FakePort:
    def __init__(self, reply=b"ok\r\n"):
        self.sent = []
        self.reply = reply

    def write(self, b):
        self.sent.append(b)

    def readline(self):
        return self.reply


def test_jeanoko_commands():
    assert jeanoko.command(23.75) == "wv02375\n"
    assert jeanoko.command(0) == "wv00000\n"
    assert jeanoko.command(31.75) == "wv03175\n"
    for bad in (1.1, 32.0, -0.25):
        with pytest.raises(ValueError):
            jeanoko.command(bad)


def test_jeanoko_set_and_ack():
    p = FakePort()
    j = jeanoko.Jeanoko(p)
    assert j.set(12.5) >= 0 and p.sent == [b"wv01250\n"] and j.value == 12.5
    j2 = jeanoko.Jeanoko(FakePort(reply=b"OK\r\n"))
    j2.set(1.0)
    dead = jeanoko.Jeanoko(FakePort(reply=b""), timeout=0.01)
    with pytest.raises(jeanoko.JeanokoError):
        dead.set(3.0, retries=1)
