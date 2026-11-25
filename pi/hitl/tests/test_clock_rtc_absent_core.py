"""clock_rtc_absent_core: the "no RTC changes nothing" verdict (RTC plan PR-5)."""

from clock_app_core import Reading
from clock_rtc_absent_core import Report, serial_findings, verdict

BOOT = "[sensor] absent on sda=6 scl=7 (probe 900 us)\n[rtc] none (auto)\n"
RE_DETECT = (
    "[rtc] none (off)\n[sensor] i2c bus up for the driver VM (sda=6 scl=7)\n"
    "[rtc] none (auto)\n[sensor] i2c bus released (no RTC)\n"
)


def _good() -> Report:
    rep = Report(features=["wall_clock", "rtc"], set_result="CLOCK_SET_RESULT_ACCEPTED")
    for i in range(3):
        rep.readings.append(
            Reading("read", 1000.0 + i, 1010.0 + i, True, 1005.0 + i, 20.0, "CLOCK_SOURCE_PUSH")
        )
    rep.readings.append(Reading("config", 2000.0, 2010.0, True, 2005.0, 20.0, "CLOCK_SOURCE_PUSH"))
    rep.rtc_states = [
        ("setup", {}),
        ("read", {"configured": "RTC_CHIP_AUTO"}),
        ("config off", {"configured": "RTC_CHIP_OFF"}),
    ]
    rep.configured_after = {"off": "RTC_CHIP_OFF", "auto": "RTC_CHIP_AUTO"}
    rep.per_phase = {n: {"late": [], "ft": 5, "span_s": 5.0} for n in ("sync", "read", "config")}
    return rep


def test_pass():
    assert verdict(_good(), BOOT + RE_DETECT) == ("PASS", [])


def test_auto_default_is_an_absent_configured_field():
    rep = _good()
    rep.configured_after["auto"] = "0"
    assert verdict(rep, BOOT + RE_DETECT)[0] == "PASS"


def test_a_present_chip_fails():
    rep = _good()
    rep.rtc_states.append(("read", {"present": True, "chip": "RTC_CHIP_DS3231"}))
    v, why = verdict(rep, BOOT + RE_DETECT)
    assert v == "FAIL" and any("present" in w for w in why)


def test_no_rtc_feature_fails():
    rep = _good()
    rep.features = ["wall_clock"]
    assert any("rtc feature" in w for w in verdict(rep, BOOT + RE_DETECT)[1])


def test_source_must_stay_the_push():
    rep = _good()
    rep.readings[-1].source = "CLOCK_SOURCE_HW_RTC"
    assert any("expected the push" in w for w in verdict(rep, BOOT + RE_DETECT)[1])


def test_config_reply_must_follow():
    rep = _good()
    rep.configured_after["off"] = "RTC_CHIP_AUTO"
    assert any("config off" in w for w in verdict(rep, BOOT + RE_DETECT)[1])
    rep.configured_after.pop("auto")
    assert any("config auto: no reply" in w for w in verdict(rep, BOOT + RE_DETECT)[1])


def test_serial_findings():
    assert serial_findings(BOOT + RE_DETECT) == []
    assert any("none (auto)" in w for w in serial_findings("[sensor] absent\n"))
    assert any(
        "reported" in w for w in serial_findings(BOOT + "[rtc] DS3231@0x68 (auto) time_valid=0\n")
    )
    assert any(
        "kept" in w for w in serial_findings(BOOT + "[sensor] absent ...; bus kept for the RTC\n")
    )
    assert any(
        "never released" in w
        for w in serial_findings(BOOT + "[sensor] i2c bus up for the driver VM\n")
    )
    assert any("crashed" in w for w in serial_findings(BOOT + "Guru Meditation Error\n"))


def test_late_frames_and_no_render_fail():
    rep = _good()
    rep.per_phase["config"] = {
        "late": [{"n": 2, "max_us": 41000, "t": 1.0}],
        "ft": 4,
        "span_s": 5.0,
    }
    rep.per_phase["read"]["ft"] = 0
    v, why = verdict(rep, BOOT + RE_DETECT)
    assert v == "FAIL"
    assert any("late" in w for w in why) and any("render not running" in w for w in why)
