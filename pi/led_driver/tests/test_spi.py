"""SK9822/APA102 framing (design doc §5/§8.1)."""

import pytest

from led_driver.spi import RecordingSink, buffer_len, frame_bytes


def test_buffer_length():
    for n in (1, 8, 64, 1024):
        assert len(frame_bytes(frozenset(), n)) == buffer_len(n)


def test_start_and_end_frames_are_zero():
    n = 8
    buf = frame_bytes(frozenset((0,)), n)
    assert buf[:4] == b"\x00\x00\x00\x00"  # start frame
    end_len = buffer_len(n) - 4 - 4 * n
    assert buf[-end_len:] == b"\x00" * end_len  # end frame


def test_on_led_frame_bytes_bgr_order_and_brightness():
    # One LED on, red, brightness 31.
    buf = frame_bytes(frozenset((0,)), 1, color=(255, 0, 0), brightness=31)
    led = buf[4:8]
    assert led[0] == 0xE0 | 31  # brightness byte
    assert led[1] == 0  # B
    assert led[2] == 0  # G
    assert led[3] == 255  # R


def test_off_led_is_dark():
    buf = frame_bytes(frozenset(), 1)
    assert buf[4:8] == bytes((0xE0, 0, 0, 0))


def test_selective_on_off():
    buf = frame_bytes(frozenset((1,)), 3, color=(0, 255, 0), brightness=10)
    leds = [buf[4 + 4 * i : 8 + 4 * i] for i in range(3)]
    assert leds[0] == bytes((0xE0, 0, 0, 0))  # off
    assert leds[1] == bytes((0xE0 | 10, 0, 255, 0))  # on, green
    assert leds[2] == bytes((0xE0, 0, 0, 0))  # off


@pytest.mark.parametrize("bad", [-1, 32, 99])
def test_brightness_validation(bad):
    with pytest.raises(ValueError):
        frame_bytes(frozenset(), 1, brightness=bad)


def test_recording_sink():
    sink = RecordingSink()
    sink.write(b"abc")
    sink.write(b"def")
    assert sink.writes == [b"abc", b"def"]
    sink.close()
    assert sink.closed
