"""Pure-logic tests for the JIT-on soak verdict (pi/hitl/harness/jit_soak_core.py):
the serial `[fx]` parsing, the fault/reboot detection, and the heap_min_free
stability rules — no hardware. Pins that a clean 30-sample soak passes, and that a
watchdog reboot, a non-ok update outcome, a cancelled shade, a dropped socket, and
a leaking heap each fail with a pointed message."""

from jit_soak_core import (
    BOOT_BANNER,
    evaluate_soak,
    find_fault_markers,
    heap_min_free_series,
    parse_fx_lines,
)


def _fx_log(n=30, outcome="ok", cancelled=0, leds=200, boots=1):
    """A synthetic serial log: one boot banner (the monitor-attach reset) plus `n`
    ~1 Hz `[fx]` render lines."""
    lines = [f"{BOOT_BANNER} some rom banner"] * boots
    for i in range(n):
        lines.append(
            f"[fx] t={i + 1:.2f} frame={i * 30} update={outcome} shade_cancelled={cancelled}/{leds}"
        )
    return "\n".join(lines) + "\n"


def _heap(samples, start=180000, step=0):
    """`samples` PerfReports whose heap_min_free starts at `start` and drops `step`
    bytes per sample (step=0 → perfectly flat / settled)."""
    return [
        {"heapMinFree": start - step * i, "heapFree": start - step * i, "droppedFrames": 0}
        for i in range(samples)
    ]


def test_clean_soak_passes():
    v = evaluate_soak(_fx_log(), _heap(30), ws_dropped=False)
    assert v["ok"], v["failures"]
    assert v["failures"] == []
    assert v["stats"]["fxLines"] == 30
    assert v["stats"]["bootBanners"] == 1


def test_parse_fx_lines_extracts_fields():
    fx = parse_fx_lines(_fx_log(n=2, outcome="ok", cancelled=3, leds=200))
    assert len(fx) == 2
    assert fx[0]["update"] == "ok"
    assert fx[0]["cancelled"] == 3
    assert fx[0]["leds"] == 200


def test_ws_drop_fails_as_reboot():
    v = evaluate_soak(_fx_log(), _heap(30), ws_dropped=True)
    assert not v["ok"]
    assert any("WebSocket dropped" in f for f in v["failures"])


def test_second_boot_banner_is_a_reboot():
    v = evaluate_soak(_fx_log(boots=2), _heap(30), ws_dropped=False)
    assert not v["ok"]
    assert any("rebooted" in f for f in v["failures"])


def test_guru_meditation_fails():
    log = _fx_log() + "Guru Meditation Error: Core 0 panic'ed (Interrupt wdt timeout)\n"
    v = evaluate_soak(log, _heap(30), ws_dropped=False)
    assert not v["ok"]
    assert any("fault/watchdog" in f for f in v["failures"])
    assert "Guru Meditation" in find_fault_markers(log)


def test_task_watchdog_fails():
    log = _fx_log() + "E (1234) task_wdt: Task watchdog got triggered.\n"
    v = evaluate_soak(log, _heap(30), ws_dropped=False)
    assert not v["ok"]
    assert any("fault/watchdog" in f for f in v["failures"])


def test_non_ok_update_fails():
    v = evaluate_soak(_fx_log(outcome="timeout"), _heap(30), ws_dropped=False)
    assert not v["ok"]
    assert any("update=ok" in f for f in v["failures"])


def test_cancelled_shades_fail():
    v = evaluate_soak(_fx_log(cancelled=5), _heap(30), ws_dropped=False)
    assert not v["ok"]
    assert any("shade_cancelled" in f for f in v["failures"])


def test_too_few_fx_lines_fails():
    v = evaluate_soak(_fx_log(n=3), _heap(30), ws_dropped=False, min_fx_lines=10)
    assert not v["ok"]
    assert any("render line" in f for f in v["failures"])


def test_leaking_heap_fails():
    # A steadily-falling low-water mark across the whole window: the back half
    # keeps dropping well past the drift tolerance.
    v = evaluate_soak(_fx_log(), _heap(30, step=1000), ws_dropped=False, heap_drift_bytes=4096)
    assert not v["ok"]
    assert any("still falling" in f for f in v["failures"])


def test_settled_heap_with_early_drop_passes():
    # Heap drops early then flattens — the low-water mark's back half is stable, so
    # it's a settled floor, not a leak. Non-increasing overall (min_free semantics).
    series = [200000, 190000, 182000, 178000, 176000] + [175000] * 25
    samples = [{"heapMinFree": h} for h in series]
    v = evaluate_soak(_fx_log(), samples, ws_dropped=False, heap_drift_bytes=4096)
    assert v["ok"], v["failures"]


def test_heap_floor_breach_fails():
    v = evaluate_soak(_fx_log(), _heap(30, start=10000), ws_dropped=False, heap_floor_bytes=20000)
    assert not v["ok"]
    assert any("floor" in f for f in v["failures"])


def test_few_heap_samples_warns_not_fails():
    v = evaluate_soak(_fx_log(), _heap(2), ws_dropped=False, min_heap_samples=3)
    assert v["ok"], v["failures"]
    assert any("under-observed" in w for w in v["warnings"])


def test_device_ws_mode_skips_serial_checks():
    # No rig serial (--device-ws): a second "boot banner" in an empty-serial run
    # can't be observed, and serial-only checks are skipped; only WS + heap gate.
    v = evaluate_soak("", _heap(30), ws_dropped=False, serial_captured=False, expected_boots=0)
    assert v["ok"], v["failures"]
    assert v["stats"]["fxLines"] == 0


def test_heap_min_free_series_filters_zeros():
    samples = [{"heapMinFree": 0}, {"heapMinFree": 1000}, {"heap_min_free": 900}]
    assert heap_min_free_series(samples) == [1000, 900]
