"""The APA102 driver's pattern frames ARE the kernel's output.

The driver has no colour-code logic of its own (``led_driver.pattern`` asks the
Rust kernel ``//firmware/pattern`` for every frame). These tests pin that: run
the real ``LedDriver`` loop over one full cycle into a ``RecordingSink`` and
require every SPI buffer to be the APA102 framing of the kernel's checked-in
colour plan (``firmware/pattern/testdata/golden_secded16*.json``, emitted by
``//firmware/pattern:gen_golden``), and cross-check the whole-frame render
against the kernel's per-LED entry point at a full-size geometry.
"""

import json
import os
from pathlib import Path

import ledmapper_pattern as kernel
import pytest
from led_driver.driver import LedDriver
from led_driver.pattern import color_plan, default_code_params
from led_driver.spi import RecordingSink, frame_bytes, frame_bytes_colors
from ledmapper_protocol import CodeParams

pytestmark = pytest.mark.requirements("PR-11")

# The golden's palette letters (see its "comment"), 255-scale RGB.
LETTER_RGB = {
    "W": (255, 255, 255),
    "G": (0, 255, 0),
    "R": (255, 0, 0),
    "B": (0, 0, 255),
    "M": (255, 0, 255),
    "Y": (255, 255, 0),
}


def _golden(env: str) -> dict:
    return json.loads(Path(os.environ[env]).read_text())


def _params(g: dict) -> CodeParams:
    return CodeParams(
        ledCount=g["ledCount"],
        bits=g["bits"],
        encoding="hue",
        symbols=g["symbols"],
        bitPeriodMs=100.0,
        syncPattern="on_off",
        cycleFrames=g["cycleFrames"],
        fec=g["fec"],
    )


def _run_cycle(cp: CodeParams, frames: int, brightness: int = 31) -> list:
    sink = RecordingSink()
    driver = LedDriver(sink, brightness=brightness, clock=lambda: 0.0)
    count = {"n": 0}

    def _sleep(_s):
        count["n"] += 1
        if count["n"] >= frames:
            driver._stop.set()

    driver._sleep = _sleep
    driver.start(cp)
    driver.join(timeout=10.0)
    return sink.writes


@pytest.mark.parametrize("env", ["GOLDEN_SECDED16", "GOLDEN_SECDED16_SYM4"])
def test_apa102_spi_frames_equal_kernel_golden(env):
    g = _golden(env)
    cp = _params(g)
    # The driver's own default code-book (kernel-sized) matches the golden's.
    d = default_code_params(g["ledCount"], symbols=g["symbols"])
    assert (d.bits, d.cycleFrames) == (g["bits"], g["cycleFrames"])

    # Two full cycles: the second must wrap back onto frame 0.
    n_frames = 2 * g["cycleFrames"]
    writes = _run_cycle(cp, n_frames, brightness=17)
    assert len(writes) == n_frames + 1  # + the dark frame on exit
    for i, buf in enumerate(writes[:n_frames]):
        letters = g["colorPlan"][i % g["cycleFrames"]]
        want = frame_bytes_colors([LETTER_RGB[c] for c in letters], brightness=17)
        assert buf == want, f"frame {i}"
        # Spell the wire out once: per LED 0xE0|bright5, B, G, R.
        for led, c in enumerate(letters):
            r, gr, b = LETTER_RGB[c]
            assert buf[4 + 4 * led : 8 + 4 * led] == bytes((0xE0 | 17, b, gr, r))
    assert writes[-1] == frame_bytes(frozenset(), g["ledCount"], brightness=17)


@pytest.mark.parametrize("symbols", [2, 4])
@pytest.mark.parametrize("fec", ["secded", "none"])
def test_whole_frame_render_matches_per_led_kernel(symbols, fec):
    n = 2200  # the Pi image's 4 x 550 HITL geometry
    frames = kernel.cycle_frames(n, symbols, fec)
    cp = CodeParams(
        ledCount=n,
        bits=kernel.expected_bits(n, fec),
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=100.0,
        syncPattern="on_off",
        cycleFrames=frames,
        fec=fec,
    )
    plan = color_plan(cp)
    assert len(plan) == frames
    for f in range(frames):
        for led in range(0, n, 97):
            assert plan[f][led] == kernel.color_rgb(led, f, n, symbols, fec)


def test_inconsistent_code_book_is_rejected():
    cp = default_code_params(64)
    with pytest.raises(ValueError):
        color_plan(cp.model_copy(update={"bits": cp.bits + 1}))
    with pytest.raises(ValueError):
        color_plan(cp.model_copy(update={"cycleFrames": cp.cycleFrames + 1}))


def test_frame_outside_cycle_is_rejected():
    with pytest.raises(ValueError):
        kernel.frame_rgb(kernel.cycle_frames(16, 2, "secded"), 16, 2, "secded")


@pytest.mark.parametrize("env", ["GOLDEN_STAGGER16", "GOLDEN_STAGGER16_SYM4"])
def test_python_binding_renders_the_stagger_golden(env):
    """Hue code v2 phase 2 through the ctypes binding: the staggered-pilot
    colour plan (per-LED rotation inside the kernel) is the golden's."""
    g = _golden(env)
    n, sym, fec, sync = g["ledCount"], g["symbols"], g["fec"], g["syncPattern"]
    assert kernel.stagger_step(g["cycleFrames"]) == g["staggerStep"]
    assert [kernel.stagger_phase(i, n, sym, fec, sync) for i in range(n)] == g["phases"]
    for f, row in enumerate(g["colorPlan"]):
        want = [LETTER_RGB[ch] for ch in row]
        assert kernel.frame_rgb(f, n, sym, fec, sync) == want, f"frame {f}"
        assert [kernel.color_rgb(i, f, n, sym, fec, sync) for i in range(n)] == want
    # v1 stays the default.
    assert kernel.stagger_phase(5, n, sym, fec, "on_off") == 0
