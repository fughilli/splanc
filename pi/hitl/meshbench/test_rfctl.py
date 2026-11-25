"""The host driver against the simulator (the shipped core behind a simulated HAL),
plus scenario compilation onto the real board tables.

`rf` is the default board (one Jeanoko UART attenuator per DUT, node model);
`rf_pe` is the legacy PR #578 table (three PE4302 DSAs per pair, pair model)."""

import pytest
import rfctl
import scenarios as sc


@pytest.fixture
def rf():
    r = rfctl.Rfctl.sim(virtual=True)
    yield r
    r.close()


@pytest.fixture
def rf_pe():
    r = rfctl.Rfctl.sim(virtual=True, board="pe4302")
    yield r
    r.close()


def test_hello_and_devices(rf_pe):
    rf = rf_pe
    assert rf.info["board"] == "starter-n4"
    assert rf.info["chain"] == "144"
    assert len(rf.devices) == 27
    assert rf.devices["att01a"].is_atten
    assert rf.devices["cut23"].safe == "0"
    assert "bank A" in rf.devices["dlyA"].note


def test_power_up_is_safe(rf_pe):
    rf = rf_pe
    st = rf.state()
    assert all(
        st[f"att{p}{s}"] == "31.5" for p in ("01", "02", "03", "12", "13", "23") for s in "abc"
    )
    assert all(st[f"cut{p}"] == "0" for p in ("01", "02", "03", "12", "13", "23"))
    out = rf.raw("sim.outputs")[-1]
    assert "chain=" in out


def test_set_get_and_errors(rf_pe):
    rf = rf_pe
    rf.set({"att01a": 12.5, "cut01": 1})
    assert rf.get("att01a") == "12.5"
    assert rf.get("cut01") == "1"
    with pytest.raises(rfctl.RfctlError) as e:
        rf.cmd("set att01a 33")
    assert e.value.code == "range"
    with pytest.raises(KeyError):
        rf.set({"nope": 1})
    with pytest.raises(ValueError):
        rf.set({"att01a": 1.25})


def test_timeline_commits_on_time_in_one_latch(rf_pe):
    rf = rf_pe
    rf.safe()
    rf.load([(1000, {"cut01": 1, "cut02": 1}), (1000, {"att01a": 0.0}), (250_000, {"cut01": 0})])
    t0 = rf.play(delay_us=10_000)
    rf.sim_advance(10_000 + 260_000)
    log = rf.log()
    assert [s["t_sched"] - t0 for s in log] == [1000, 250_000]
    assert all(s["late_us"] == 0 for s in log)
    assert log[0]["count"] == 3  # three devices, one step
    hist = rf.sim_history(3)
    assert [t - t0 for t, _, _ in hist[-2:]] == [1000, 250_000]
    st = rf.status()
    assert st["playing"] == 0 and st["steps"] == 2


def test_lease_expiry_goes_safe(rf):
    rf.set({"cut12": 1})
    rf.lease(100)
    rf.sim_advance(150_000)
    assert rf.get("cut12") == "0"
    assert rf.status()["faults"] & 0x01
    rf.lease(0)


def test_frame_start_capture(rf):
    rf.capture(0b101, holdoff_us=2000)
    assert rf.sim_edge(0, 1000)
    assert not rf.sim_edge(0, 1500)  # inside the holdoff: the rest of the same frame
    assert rf.sim_edge(0, 13500)
    assert not rf.sim_edge(1, 2000)  # masked
    assert rf.sim_edge(2, 2100)
    assert rf.capread() == [(0, 1000), (0, 13500), (2, 2100)]


def test_clock_map_virtual(rf):
    cm = rf.clock_map(n=6)
    assert cm.b == pytest.approx(1e-6)


def test_selftest(rf):
    assert rf.selftest() == "pass"
    rf.raw("sim.loopback fail")
    assert rf.selftest() == "fail"


def test_late_steps_are_reported(rf):
    rf.raw("sim.jitter 80")
    rf.load([(5000, {"cut13": 1})])
    rf.play(delay_us=1000)
    rf.sim_advance(10_000)
    assert rf.log()[-1]["late_us"] == 80
    assert rf.status()["faults"] & 0x02


# ---- the default board: UART attenuators


def test_jeanoko_board(rf):
    assert rf.info["board"] == "jeanoko-n4"
    assert rf.info["chain"] == "48" and rf.info["uart"] == "5"
    assert len(rf.devices) == 14
    a = rf.devices["att2"]
    assert a.is_atten and a.is_uart and a.step_db == 0.25 and a.max == "31.75"
    assert not rf.devices["cut01"].is_atten
    st = rf.state()
    assert all(st[f"att{i}"] == "31.75" for i in range(4)) and st["attx"] == "31.75"
    assert all(st[f"cut{p}"] == "0" for p in ("01", "02", "03", "12", "13", "23"))
    assert st["_chain"] == "fffffffff000"  # cuts and spares high, delay bank at arm 0
    # every unit was told its safe value at power-up, on its own TX pin
    boot = rf.sim_uart(5)
    assert sorted((u, g) for _, u, g, _ in boot) == [(0, 22), (1, 26), (2, 27), (3, 28), (6, 29)]
    assert {txt for *_, txt in boot} == {"wv03175"}


def test_uart_set_and_format(rf):
    rf.sim_advance(1000)
    rf.set({"att0": 12.25, "att3": 7, "cut01": 1})
    assert rf.get("att0") == "12.25" and rf.get("att3") == "7.0"
    sent = {u: txt for _, u, _, txt in rf.sim_uart(2)}
    assert sent == {0: "wv01225", 3: "wv00700"}
    with pytest.raises(ValueError):
        rf.set({"att0": 12.3})
    with pytest.raises(rfctl.RfctlError) as e:
        rf.cmd("set att1 32")
    assert e.value.code == "range"
    assert rfctl.fmt_value(12.25, 0.25) == "12.25"
    assert rfctl.fmt_value(12.5, 0.25) == "12.5"
    assert rfctl.fmt_value(3.0, 0.25) == "3.0"


def test_uart_busy_unit_is_deferred(rf):
    rf.sim_advance(1000)
    rf.set({"att1": 1.0})
    rf.set({"att1": 2.0})  # 0 us later: unit 1 is still sending
    st = rf.status()
    assert st["uart_deferred"] >= 1 and st["faults"] & 0x10
    rf.sim_advance(2000)
    assert rf.sim_uart(1)[-1][3] == "wv00200"  # the latest value went out


def test_uart_timeline_starts_on_the_latch(rf):
    rf.sim_advance(10_000)
    rf.load([(2000, {"cut12": 1, "att1": 5.5, "att2": 5.5}), (40_000, {"cut12": 0})])
    t0 = rf.play(delay_us=5000)
    rf.sim_advance(5000 + 41_000)
    latch = [t for t, _, _ in rf.sim_history(3)]
    assert t0 + 2000 in latch
    uart = [(t, u, txt) for t, u, _, txt in rf.sim_uart(2)]
    assert uart == [(t0 + 2000, 1, "wv00550"), (t0 + 2000, 2, "wv00550")]


def test_lease_puts_attenuators_to_max(rf):
    rf.sim_advance(1000)
    rf.set({"att0": 0.0, "cut01": 1})
    rf.lease(50)
    rf.sim_advance(100_000)
    assert rf.get("att0") == "31.75" and rf.get("cut01") == "0"
    assert rf.sim_uart(5)[-1][3] == "wv03175"
    rf.lease(0)


def test_attcheck(rf):
    rf.sim_advance(1000)
    res = rf.attcheck()
    assert set(res) == {"att0", "att1", "att2", "att3", "attx"}
    assert all(r["result"] == "ok" and r["latency_us"] == 1500 for r in res.values())
    rf.raw("sim.uartack none")
    assert rf.attcheck("att2") == {"att2": {"result": "timeout", "value": "31.75", "latency_us": 0}}
    rf.raw("sim.uartack stuck")
    assert rf.attcheck("att0")["att0"]["result"] == "stuck_low"


def test_n6_board():
    with rfctl.Rfctl.sim(board="jeanoko-n6") as r:
        assert r.info["board"] == "jeanoko-n6" and r.info["uart"] == "7"
        b = sc.Bench(r.devices)
        assert b.nodes == [0, 1, 2, 3, 4, 5] and len(b.pairs) == 15
        assert b.node_atts[5] == "att5"


# ---- scenarios on the legacy (pair model) board table


@pytest.fixture
def bench(rf_pe):
    return sc.Bench(rf_pe.devices)


def test_bench_model(bench):
    assert bench.pairs == ["01", "02", "03", "12", "13", "23"]
    assert bench.nodes == [0, 1, 2, 3]
    assert bench.atts("12") == ["att12a", "att12b", "att12c"]
    v = bench.loss("01", 42.0 + 40.0)
    assert sum(v.values()) == 40.0 and v["att01a"] == 31.5
    assert bench.delay(325) == {"dlyA": 1, "dlyB": 3}
    with pytest.raises(ValueError):
        bench.delay(30)


def test_chain_topology_and_sneak(bench):
    v = bench.chain([0, 1, 2, 3], loss_db=45.0)
    assert v["cut01"] == 1 and v["cut02"] == 0 and v["cut13"] == 0
    # 0-1-2 at 45 dB each: the cut 0-2 leaks round through 1 (90 < 100 dB)
    assert any(w.startswith("02 via 1") for w in bench.sneak_paths(v))
    assert not bench.sneak_paths(bench.chain([0, 1, 2, 3], loss_db=60.0))


@pytest.mark.parametrize("board", ["jeanoko-n4", "pe4302"])
@pytest.mark.parametrize("name", sorted(sc.LIBRARY))
def test_library_compiles_and_plays(board, name):
    rf = rfctl.Rfctl.sim(virtual=True, board=board)
    bench = sc.Bench(rf.devices)
    assert bench.model == ("node" if board.startswith("jeanoko") else "pair")
    s = sc.LIBRARY[name](bench)
    c = sc.compile(s, bench)
    assert c.timeline and c.timeline[0][0] == 0
    assert all(t1 > t0 for (t0, _), (t1, _) in zip(c.timeline, c.timeline[1:]))
    n = rf.load(c.timeline)
    assert n == sum(len(v) for _, v in c.timeline)
    t0 = rf.play(delay_us=5000)
    last = c.timeline[-1][0]
    # play the first second only (walk_fade is 2000 steps)
    rf.sim_advance(5000 + min(last, 1_200_000) + 1000)
    log = rf.log(256)
    assert log and all(e["late_us"] == 0 for e in log)
    assert log[0]["t_sched"] == t0
    # no UART command ever had to wait for its unit
    assert rf.status()["uart_deferred"] == 0
    rf.stop()
    rf.close()


def test_sync_code_and_marks(bench):
    c = sc.compile(sc.link_flap(bench, cycles=2), bench)
    assert c.sync_us[: len(sc.SYNC_CODE)] == [int(t * 1e6) for t in sc.SYNC_CODE]
    labels = [l for _, l in c.marks]
    assert labels == ["full", "down:01", "up:01", "down:01", "up:01"]
    # every mark toggles the LED at its own instant
    assert {t for t, _ in c.marks} <= set(c.sync_us)


def test_meshsim_replay(bench):
    rows = [(0.0, 0, 1, 70.0), (0.0, 1, 2, 125.0), (1.5, 1, 2, 90.0)]
    s = sc.from_meshsim(bench, rows, tx_sim_dbm=20, tx_bench_dbm=2)
    assert s.steps[0].values["cut12"] == 0  # past the edge: cut
    assert s.steps[1].values["cut12"] == 1
    assert sum(v for k, v in s.steps[1].values.items() if k.startswith("att")) == pytest.approx(
        90 - 18 - 42
    )


def test_min_spacing_rejected(bench):
    s = sc.Scenario("x", 1.0, [sc.Step(0.0, {"cut01": 1}), sc.Step(0.00001, {"cut01": 0})])
    with pytest.raises(ValueError):
        sc.compile(s, bench)
