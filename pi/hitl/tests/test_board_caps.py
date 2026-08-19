"""Unit tests for the HITL board-capabilities contract (pure; no hardware).

Two jobs: pin the diff logic that the on-hardware BOARD CAPS phase
(//pi/hitl/harness:e2e) relies on, and pin the REAL checked-in descriptor
(firmware/player_app/board_caps.textproto) so an edit that (re)introduces an
unsafe classification — e.g. marking a JTAG/flash pin "recommended" — fails in
the normal `bazel test //...` suite, not only on a rig."""

import copy

from board_caps import diff_board_caps, parse_expected

# A tiny self-contained descriptor: exercises every safety level + a note.
SAMPLE = """
board: "Test Board"
gpio_pins { gpio: 0 safety: PIN_SAFETY_RECOMMENDED }
gpio_pins { gpio: 6 safety: PIN_SAFETY_CAUTION note: "JTAG pin" }
gpio_pins { gpio: 18 safety: PIN_SAFETY_AVOID note: "flash" }
led_modes { id: "ws281x" label: "WS281x" }
"""


def test_parse_roundtrips_to_no_diff():
    # The device reporting EXACTLY the descriptor => no diffs. parse_expected
    # renders the textproto through the same json_format options proto_wire uses,
    # so a faithful device report is byte-identical.
    exp = parse_expected(SAMPLE)
    assert diff_board_caps(exp, exp) == []


def test_missing_board_is_a_single_diff():
    exp = parse_expected(SAMPLE)
    assert diff_board_caps(exp, None) == [
        "device reported no board capabilities (hardware_config_state.board unset)"
    ]
    assert len(diff_board_caps(exp, {})) == 1


def test_wrong_safety_is_flagged():
    exp = parse_expected(SAMPLE)
    got = copy.deepcopy(exp)
    # Device downgrades the flash pin to "recommended" — the exact regression the
    # descriptor guards against.
    for p in got["gpioPins"]:
        if p["gpio"] == 18:
            p["safety"] = "PIN_SAFETY_RECOMMENDED"
    diffs = diff_board_caps(exp, got)
    assert any("GPIO 18" in d for d in diffs)


def test_missing_and_extra_pins_flagged():
    exp = parse_expected(SAMPLE)
    got = copy.deepcopy(exp)
    got["gpioPins"] = [p for p in got["gpioPins"] if p["gpio"] != 6]  # drop one
    got["gpioPins"].append({"gpio": 21, "safety": "PIN_SAFETY_RECOMMENDED", "note": ""})
    diffs = diff_board_caps(exp, got)
    assert any("GPIO 6" in d and "didn't report" in d for d in diffs)
    assert any("GPIO 21" in d and "descriptor doesn't" in d for d in diffs)


def test_led_mode_mismatch_flagged():
    exp = parse_expected(SAMPLE)
    got = copy.deepcopy(exp)
    got["ledModes"] = [{"id": "apa102", "label": "APA102"}]
    assert any("LED modes" in d for d in diff_board_caps(exp, got))


# --- the real checked-in descriptor ---------------------------------------


def _real_descriptor():
    from python.runfiles import runfiles

    path = runfiles.Create().Rlocation("_main/firmware/player_app/board_caps.textproto")
    with open(path, encoding="utf-8") as f:
        return parse_expected(f.read())


def _safety_of(caps, gpio):
    for p in caps["gpioPins"]:
        if p["gpio"] == gpio:
            return p["safety"]
    return None


def test_real_descriptor_invariants():
    caps = _real_descriptor()
    assert caps["board"] == "ESP32-C6 SuperMini"
    assert any(m["id"] == "ws281x" for m in caps["ledModes"])
    # The pins the pinout review turned on: 10/11 usable, 6/7 are JTAG/flash (NOT
    # recommended), 18/19 flash => avoid, 20 is the default data pin.
    for gpio in (0, 1, 2, 3, 10, 11, 14, 20, 21, 22, 23):
        assert _safety_of(caps, gpio) == "PIN_SAFETY_RECOMMENDED", gpio
    for gpio in (4, 5, 6, 7, 8, 9, 12, 13, 15):
        assert _safety_of(caps, gpio) == "PIN_SAFETY_CAUTION", gpio
    for gpio in (18, 19):
        assert _safety_of(caps, gpio) == "PIN_SAFETY_AVOID", gpio
