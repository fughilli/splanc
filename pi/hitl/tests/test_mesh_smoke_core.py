"""The mesh spike's console parsing and verdicts (mesh_smoke_core): the lines below are
the exact formats mesh_spike_impl.h prints."""

from mesh_smoke_core import (
    RxStat,
    Scenario,
    TxStat,
    parse_line,
    rate_hist,
    retries_proven,
    timestamp_found,
    verdict,
)

RX = (
    "[mesh] rx tag=7 src=0a:5c:4d:00:00:01 frames=120 uniq=30 retry_bit=90 env_dup=90 env_old=0 "
    "env_badmic=0 env_other=0 rssi=-41/-38/-35 nf=-96 rates=120,0,0,0|0,0,0,0,0,0,0,0|0 ch_ok=120 "
    "ch_bad=0 len_ok=120 len_bad=0 rxst_bad=0 ts_lag=180/4200 ia_n=29 ia_err_avg=35 ia_err_max=410"
)
TX = (
    "[mesh] tx tag=7 type=1 rate=0 ack=1 tries=4 len=200 frames=30 attempts=120 confirmed=0 failed=30 "
    "nocompl=0 compl_us=2950/3010/3300 pongs=0 hist=0,0,0,0,0,0,0,0 st0=0 st5=120 stx=0 acks_seen=0"
)


def test_parse_lines():
    kind, kv = parse_line("12345 " + RX)
    assert kind == "rx" and kv["tag"] == "7" and kv["src"] == "0a:5c:4d:00:00:01"
    assert parse_line("[fx] t=1.0 frame=3") is None
    kind, kv = parse_line("[mesh] rxv len=262 reap_us=99 seq=4 retry=0 " + "ab" * 92)
    assert kind == "rxv" and kv["hex"] == "ab" * 92 and kv["len"] == "262"


def test_rx_and_tx_stats():
    r = RxStat.from_kv(parse_line(RX)[1])
    assert (r.frames, r.uniq, r.retry_bit, r.env_dup) == (120, 30, 90, 90)
    assert (r.rssi_min, r.rssi_avg, r.rssi_max, r.ts_lag_min, r.ts_lag_max) == (
        -41,
        -38,
        -35,
        180,
        4200,
    )
    assert r.rates == {"1": 120}
    t = TxStat.from_kv(parse_line(TX)[1])
    assert (t.frames, t.attempts, t.confirmed, t.st_ack_timeout, t.retried) == (30, 120, 0, 120, 0)
    assert t.compl_us == (2950, 3010, 3300)
    assert rate_hist("1,0,0,2|0,0,0,0,5,0,0,0|1") == {"1": 1, "11": 2, "24": 5, "?": 1}


def test_ghost_retry_proof():
    rx = RxStat.from_kv(parse_line(RX)[1])
    tx = TxStat.from_kv(parse_line(TX)[1])
    assert retries_proven(Scenario("ghost", 30, tx, rx))
    # A MAC that never retries: one copy per frame on air.
    once = RxStat.from_kv(
        parse_line(RX.replace("frames=120", "frames=30").replace("retry_bit=90", "retry_bit=0"))[1]
    )
    assert not retries_proven(Scenario("ghost", 30, tx, once))


def test_timestamp_and_verdict():
    rx = RxStat.from_kv(parse_line(RX)[1])
    assert timestamp_found(rx)
    bad = RxStat.from_kv(parse_line(RX.replace("ia_err_avg=35", "ia_err_avg=90000"))[1])
    assert not timestamp_found(bad)
    good = Scenario("idle.bcast_1M.a_to_b", 30, None, rx)  # 30 of 30 accepted
    lossy = Scenario("idle.bcast_1M.b_to_a", 40, None, rx)  # 30 of 40
    ok, why = verdict({good.name: good, lossy.name: lossy}, [good.name, lossy.name, "assoc.x"])
    assert (
        not ok
        and any("b_to_a" in w for w in why)
        and any("assoc.x: not measured" in w for w in why)
    )
    ping = Scenario("p", 4, None, None, rtts_us=[3000, 4000, 5000, 9000], turns_us=[1000] * 4)
    lat = ping.latency_ms()
    assert ping.delivery == 1.0 and lat["rtt_p50"] == 4.5 and lat["air_p50"] == 1.75


def test_lost_seqs():
    from mesh_smoke_core import lost_seqs

    assert lost_seqs("ff" * 32, 100) == []
    assert lost_seqs("fe" + "ff" * 31, 20) == [0]
    assert lost_seqs("ff7f" + "00" * 30, 18) == [15, 16, 17]
