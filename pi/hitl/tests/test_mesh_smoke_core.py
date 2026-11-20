"""The mesh M3 smoke test's console parsing and verdict (mesh_smoke_core): the lines below
are the formats mesh_glue.h / mesh_ffi.rs / main.cpp print."""

from mesh_smoke_core import (
    DELIVERY_MIN,
    Delivery,
    Results,
    formed,
    is_reset,
    kv_line,
    lease_ip,
    neighbours,
    render,
    rx_counters,
    verdict,
)

NB = [
    "[mesh] nb id=1130 mac=98:88:e0:71:11:30 rssi=-20 rssi_avg=-21 age_ms=120 first_ms=900 rx=40 "
    "tx_ok=12 tx_fail=0 retries=1 ch=1 advert=1 advert_age_ms=400 adv_ch=1",
    "[mesh] nb id=1f48 mac=98:88:e0:71:1f:48 rssi=-9 rssi_avg=-10 age_ms=80 first_ms=950 rx=38 "
    "tx_ok=11 tx_fail=0 retries=0 ch=1 advert=0 advert_age_ms=-1 adv_ch=0",
    "[mesh] nbend",
]


def test_neighbours_and_formation():
    nb = neighbours(NB)
    assert set(nb) == {"1130", "1f48"}
    assert nb["1130"].present() and not nb["1f48"].present()
    assert formed(nb, ["1130"]) and not formed(nb, ["1130", "1f48"])
    assert nb["1130"].rssi == -20 and nb["1130"].tx_ok == 12


def test_testrx_and_kv():
    lines = [
        "[mesh] testrx from=3170 tag=11 port=18 uniq=200 dups=0 max_seq=199 sent_here=0",
        "[mesh] testrx from=1130 tag=12 port=17 uniq=198 dups=2 max_seq=199 sent_here=0",
        "[mesh] testrxend",
        "[mesh] env sealed=10 opened=7 bad_mic=3 dup=4 mesh_acked=2",
    ]
    t = rx_counters(lines)
    assert t[("3170", 11)]["uniq"] == 200 and t[("1130", 12)]["dups"] == 2
    assert kv_line(lines, "env")["bad_mic"] == "3"


def test_render_drops_the_first_window():
    ft = [
        f"[ft] r60:15000/{16000 + i}/18000 w60:15000/16000/17000 dt20 fps={f} sl=1-3"
        for i, f in enumerate([30, 60, 59, 61])
    ]
    r = render(ft)
    assert r["windows"] == 3 and r["fps_median"] == 60 and r["fps_min"] == 59
    assert render([])["windows"] == 0


def test_lease_and_reset_lines():
    assert (
        lease_ip("[t=900] *** DHCP LEASE ACQUIRED — IP 10.42.0.17 over heapless WiFi ***")
        == "10.42.0.17"
    )
    assert (
        lease_ip(
            "[t=1] [wire] PROV received (ssid=x) — already joined, link kept; PROV re-received at IP 10.42.0.9"
        )
        == "10.42.0.9"
    )
    assert lease_ip("[mesh] ok on") is None
    assert is_reset("ESP-ROM:esp32c6-20220919") and is_reset("rst:0x15 (USB_UART_HPSYS)")
    assert not is_reset("[mesh] info id=3170")


def _passing() -> Results:
    r = Results()
    r.formation_s = {"a": 7.1, "b": 6.9, "c": 7.4}
    r.deliveries = {"bcast.a": Delivery("bcast.a", 200, {"b": 200, "c": 199})}
    r.gated = ["bcast.a"]
    r.replay = {"replayed": 20, "dup_delta": {"b": 20, "c": 19}, "extra_rx": 0}
    r.wrong_key = {"bad_mic_delta": {"a": 5, "b": 6}, "leaked": 0, "joined": False}
    r.rejoin = {"back_s": 12.0, "after": 1.0}
    r.render_off = {"a": {"windows": 10, "fps_median": 60}}
    r.render_on = {"a": {"windows": 10, "fps_median": 59}}
    r.resets = {"a": []}
    return r


def test_verdict_passes_and_names_each_failure():
    ok, why = verdict(_passing())
    assert ok, why
    assert _passing().deliveries["bcast.a"].ratio() == 199 / 200 >= DELIVERY_MIN
    r = _passing()
    r.formation_s["c"] = None
    r.deliveries["bcast.a"].got["c"] = 150
    r.replay["extra_rx"] = 3
    r.wrong_key["leaked"] = 1
    r.rejoin = {}
    r.render_on["a"]["fps_median"] = 40
    r.resets["a"] = ["rst:0x15"]
    ok, why = verdict(r)
    assert not ok
    text = " | ".join(why)
    for word in (
        "not formed",
        "delivery 0.750",
        "replay",
        "wrong key",
        "rejoin: not run",
        "render 40",
        "reset",
    ):
        assert word in text, (word, text)
