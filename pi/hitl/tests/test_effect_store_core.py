"""The effect-store HITL gate's pure logic (harness/effect_store_core.py)."""

import effect_store_core as core


def test_stored_reads_proto3_json_with_defaults():
    reply = {
        "type": "stored_effect_list",
        "effects": [
            {"effectId": "a", "name": "A", "fxbBytes": 900, "uniforms": ["gain"], "decks": [0]},
            {"effectId": "b"},
        ],
    }
    s = core.stored(reply)
    assert s["a"] == {"name": "A", "bytes": 900, "uniforms": ["gain"], "decks": [0]}
    assert s["b"] == {"name": "", "bytes": 0, "uniforms": [], "decks": []}
    assert core.stored(None) == {} and core.stored({"type": "error"}) == {}


def test_big_source_grows_with_terms():
    assert len(core.big_source(10)) < len(core.big_source(20))
    assert "uniform float gain" in core.big_source(1)


def test_pick_big_takes_the_largest_under_the_cap():
    assert core.pick_big({30: 1200, 60: 2500, 100: 3900, 150: 5200}) == 100
    assert core.pick_big({150: 5200}) is None
    assert core.pick_big({}) is None


def test_result_line_and_verdict():
    run = core.Run()
    assert core.verdict(run) == core.SKIP
    run.reached = True
    run.check("store", "two", True)
    run.check("reboot", "resumed", True)
    line = core.result_line(run, "1.2.3", 3900)
    assert line.startswith("RESULT effect_store verdict=PASS fw=1.2.3 ")
    assert "store=1/1" in line and "reboot=1/1" in line and "big_fxb=3900B" in line
    run.check("delete", "gone", False, "still listed")
    assert core.verdict(run) == core.FAIL
    assert core.failures(run) == ["delete/gone: still listed"]
