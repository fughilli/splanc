"""LedDriver loop, epoch, and debug modes (design doc §6 M1 / §8.1)."""

import pytest

from led_driver.driver import LedDriver
from led_driver.graycode import default_code_params, frame_plan
from led_driver.spi import RecordingSink, frame_bytes


def _auto_stop_sleep(driver, stop_after):
    """A fake sleep that halts the driver after ``stop_after`` frames."""
    count = {"n": 0}

    def _sleep(_seconds):
        count["n"] += 1
        if count["n"] >= stop_after:
            driver._stop.set()

    return _sleep


def test_loop_emits_cycle_then_goes_dark():
    cp = default_code_params(8)  # bits=ceil(log2(9))=4, cycleFrames=6
    plan = frame_plan(cp)
    sink = RecordingSink()
    driver = LedDriver(sink, clock=lambda: 5000.0)
    driver._sleep = _auto_stop_sleep(driver, stop_after=3)

    epoch = driver.start(cp)
    driver.join(timeout=5.0)

    assert epoch == 5000.0
    # 3 frames emitted, then an all-off frame from the finally clause.
    assert len(sink.writes) == 4
    assert sink.writes[0] == frame_bytes(plan[0], 8)  # ALL_ON
    assert sink.writes[1] == frame_bytes(plan[1], 8)  # ALL_OFF (sync)
    assert sink.writes[2] == frame_bytes(plan[2], 8)  # first bit frame
    assert sink.writes[3] == frame_bytes(frozenset(), 8)  # dark on exit


def test_get_clock_before_and_after_start():
    sink = RecordingSink()
    driver = LedDriver(sink, clock=lambda: 1234.0)
    assert driver.get_clock() == {"epoch": 0.0, "bitPeriodMs": 0.0, "cycleLen": 0}

    cp = default_code_params(64)
    driver._sleep = _auto_stop_sleep(driver, stop_after=1)
    driver.start(cp)
    driver.join(timeout=5.0)

    clk = driver.get_clock()
    assert clk == {"epoch": 1234.0, "bitPeriodMs": cp.bitPeriodMs, "cycleLen": cp.cycleFrames}


def test_on_set_modes():
    cp = default_code_params(16)
    plan = frame_plan(cp)
    driver = LedDriver(RecordingSink())

    # Default = cycle: follows the plan, wrapping.
    assert driver._on_set_for(0, plan) == plan[0]
    assert driver._on_set_for(len(plan), plan) == plan[0]

    driver.set_debug("off")
    assert driver._on_set_for(0, plan) == frozenset()

    driver.set_debug("single", {"ledId": 5})
    assert driver._on_set_for(0, plan) == frozenset((5,))


def test_set_debug_rejects_unknown_mode():
    driver = LedDriver(RecordingSink())
    with pytest.raises(ValueError):
        driver.set_debug("strobe")


def test_set_debug_single_out_of_range():
    sink = RecordingSink()
    driver = LedDriver(sink)
    driver._sleep = _auto_stop_sleep(driver, stop_after=1)
    driver.start(default_code_params(8))
    driver.join(timeout=5.0)
    with pytest.raises(ValueError):
        driver.set_debug("single", {"ledId": 99})  # only 8 LEDs


def test_stop_when_idle_is_noop():
    driver = LedDriver(RecordingSink())
    driver.stop()  # no thread running → must not raise
    driver.stop()
