"""Hardware seams with fakes: framebuffer packing, the luma GPIO adapter, HAT
buttons and OLED detection. (Real-panel behaviour is NOT covered here — see
pi/bridge/README.md "What is tested where".)"""

import os

import pytest
from PIL import Image
from splanc_display import fb, hat


def px(color, info):
    return fb.pack(Image.new("RGB", (1, 1), color), info)


def test_pack_rgb565_little_endian():
    info = fb.FbInfo(1, 1, 16, 2, red_off=11)
    assert px((255, 0, 0), info) == (0xF800).to_bytes(2, "little")
    assert px((0, 255, 0), info) == (0x07E0).to_bytes(2, "little")
    assert px((0, 0, 255), info) == (0x001F).to_bytes(2, "little")
    assert px((255, 255, 255), info) == b"\xff\xff"
    assert px((0x12, 0x34, 0x56), info) == (
        ((0x12 >> 3) << 11) | ((0x34 >> 2) << 5) | (0x56 >> 3)
    ).to_bytes(2, "little")


def test_pack_bgr565_swaps():
    info = fb.FbInfo(1, 1, 16, 2, red_off=0)
    assert px((255, 0, 0), info) == (0x001F).to_bytes(2, "little")


def test_pack_32bpp_orders():
    # (the 4th, X/alpha, byte is padding the scanout ignores)
    assert px((1, 2, 3), fb.FbInfo(1, 1, 32, 4, red_off=16))[:3] == bytes([3, 2, 1])
    assert px((1, 2, 3), fb.FbInfo(1, 1, 32, 4, red_off=0))[:3] == bytes([1, 2, 3])


def test_pack_stride_padding():
    info = fb.FbInfo(3, 2, 32, 16, red_off=16)
    raw = fb.pack(Image.new("RGB", (3, 2), (9, 9, 9)), info)
    assert len(raw) == 32 and raw[12:16] == b"\0\0\0\0"


def test_pack_rejects_unknown_depth():
    with pytest.raises(ValueError):
        px((0, 0, 0), fb.FbInfo(1, 1, 8, 1))


def test_framebuffer_open_missing_device_is_none(tmp_path):
    assert fb.Framebuffer.open(str(tmp_path / "fb9")) is None


def test_png_sink(tmp_path):
    s = fb.PngSink(str(tmp_path / "o.png"), (64, 32))
    assert (
        s.show(Image.new("RGB", (64, 32))) and s.frames == 1 and os.path.exists(tmp_path / "o.png")
    )


class FakeOut:
    def __init__(self, pin, initial_value=False):
        self.pin, self.value, self.closed = pin, initial_value, False

    def close(self):
        self.closed = True


def test_gpio_adapter_is_rpi_gpio_compatible():
    made = {}

    def factory(pin, initial_value=False):
        made[pin] = FakeOut(pin, initial_value)
        return made[pin]

    g = hat.GpioAdapter(factory)
    g.setmode(g.BCM)
    g.setwarnings(False)
    g.setup(24, g.OUT)
    g.setup(25, g.OUT, initial=g.HIGH)
    assert made[25].value is True and made[24].value is False
    g.output(24, g.HIGH)
    assert made[24].value is True
    g.output(24, g.LOW)
    assert made[24].value is False
    g.cleanup([24])
    assert made[24].closed and not made[25].closed
    g.cleanup()
    assert made[25].closed


def test_buttons_route_to_callbacks(buttons):
    events = []
    b = hat.Buttons(
        lambda k: events.append(("down", k)), lambda k: events.append(("up", k)), factory=buttons
    )
    assert sorted(buttons.by_pin) == sorted(hat.KEY_PINS.values())
    buttons.by_pin[21].press()
    buttons.by_pin[16].press()
    buttons.by_pin[16].release()
    buttons.by_pin[26].press()
    assert events == [("down", "key1"), ("down", "key3"), ("up", "key3"), ("down", "right")]
    b.close()
    assert all(x.closed for x in buttons.by_pin.values())


def test_waveshare_pin_map():
    # https://www.waveshare.com/wiki/1.3inch_OLED_HAT "Pin Function" (BCM)
    assert hat.KEY_PINS == {
        "key1": 21,
        "key2": 20,
        "key3": 16,
        "up": 6,
        "down": 19,
        "left": 5,
        "right": 26,
        "press": 13,
    }
    assert (hat.PIN_DC, hat.PIN_RST, hat.I2C_ADDR) == (24, 25, 0x3C)


def test_detect(monkeypatch):
    assert hat.detect("off") is None
    assert hat.detect("spi") == "spi" and hat.detect("I2C") == "i2c"
    monkeypatch.setattr(hat, "_i2c_ack", lambda *a: False)
    monkeypatch.setattr(hat, "_hat_eeprom_says_oled", lambda: False)
    monkeypatch.setattr(hat.os.path, "exists", lambda p: False)
    assert hat.detect("auto") is None
    monkeypatch.setattr(hat.os.path, "exists", lambda p: p == "/dev/spidev0.0")
    assert hat.detect("auto") == "spi"
    monkeypatch.setattr(hat, "_i2c_ack", lambda *a: True)
    assert hat.detect("auto") == "i2c"


def fake_fb_ioctl(xres, yres, bpp, red_off, line_length):
    """An fcntl.ioctl stand-in answering FBIOGET_{V,F}SCREENINFO like the kernel."""
    import struct

    def ioctl(fd, req, buf, *a):
        if req == fb.FBIOGET_VSCREENINFO:
            blue_off = 0 if red_off else 11 if bpp == 16 else 16
            struct.pack_into(
                "=8I12I",
                buf,
                0,
                xres,
                yres,
                xres,
                yres,
                0,
                0,
                bpp,
                0,
                red_off,
                5,
                0,
                5,
                6,
                0,
                blue_off,
                5,
                0,
                0,
                0,
                0,
            )
        elif req == fb.FBIOGET_FSCREENINFO:
            # id[16], unsigned long smem_start, smem_len, type, type_aux, visual,
            # xpanstep, ypanstep, ywrapstep, (pad), line_length: native layout.
            struct.pack_into(
                "@16sLIIIIHHHI",
                buf,
                0,
                b"vc4drmfb",
                0,
                line_length * yres,
                0,
                0,
                2,
                1,
                1,
                0,
                line_length,
            )
        else:
            raise OSError(25, "not a tty")
        return 0

    return ioctl


def test_framebuffer_query_and_write(tmp_path, monkeypatch):
    dev = tmp_path / "fb0"
    dev.write_bytes(b"")
    monkeypatch.setattr(fb.fcntl, "ioctl", fake_fb_ioctl(4, 2, 16, 11, 16))  # stride > 4 px * 2 B
    f = fb.Framebuffer.open(str(dev))
    assert f.size == (4, 2) and f.info.bpp == 16 and f.info.stride == 16 and f.info.red_off == 11
    assert f.show(Image.new("RGB", (8, 4), (255, 0, 0)))  # resized to the mode
    raw = dev.read_bytes()
    assert len(raw) == 32
    assert raw[0:2] == (0xF800).to_bytes(2, "little") and raw[8:16] == b"\0" * 8
    assert not f.changed()
    monkeypatch.setattr(fb.fcntl, "ioctl", fake_fb_ioctl(8, 2, 16, 11, 16))
    assert f.changed()  # hotplug / mode switch is noticed
    f.close()


def test_console_vt_takeover(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(fb.fcntl, "ioctl", lambda fd, req, arg: calls.append((req, arg)))
    real_open = fb.os.open
    monkeypatch.setattr(
        fb.os,
        "open",
        lambda p, fl: real_open(str(tmp_path / "tty"), fb.os.O_WRONLY | fb.os.O_CREAT),
    )
    con = fb.Console.take(8)
    assert calls == [(fb.VT_ACTIVATE, 8), (fb.KDSETMODE, fb.KD_GRAPHICS)]
    con.release()
    assert calls[-1] == (fb.KDSETMODE, fb.KD_TEXT)
