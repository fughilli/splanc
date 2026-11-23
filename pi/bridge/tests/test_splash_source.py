"""Approved artwork, deterministic OLED conversion, and the existing boot contract."""

import hashlib
import json
import os
from pathlib import Path

import gen_boot_frames as g
import pytest
from splanc_display import boot

ROOT = (
    Path(os.environ["TEST_SRCDIR"]) / "_main"
    if "TEST_SRCDIR" in os.environ
    else Path(__file__).resolve().parents[3]
)
SOURCE = ROOT / "shared/brand/splash/frames.json"
LOGO = ROOT / "web/public/icons/splanc.svg"


def test_approved_source_is_unchanged():
    raw = SOURCE.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == (
        "210d2b5ef4d09b8bbc6c0b8a21a6eae32ce6d38d3187d2744b1e8ab75dbf159f"
    )
    source = json.loads(raw)
    assert source["smoothing"] == 65 and source["timing"]["rate"] == 6
    assert source["viewBox"] == "95 -30 75 87"
    assert source["timing"]["duration"] == 0.3
    assert source["timing"]["impact"] == pytest.approx(0.8 / 6)
    assert source["timing"]["formation"] == pytest.approx(1 / 6)
    assert len(source["frames"]) == 73 and len(source["titleFrames"]) == 19
    for i, sample in enumerate(source["frames"]):
        assert sample["time"] == pytest.approx(i / 240)
    for i, sample in enumerate(source["titleFrames"]):
        assert sample["time"] == pytest.approx(i * 1001 / 60000)


def test_boot_uses_saved_samples_at_the_approved_speed():
    samples = json.loads(SOURCE.read_bytes())["frames"]
    assert g.splash_sample(samples, -1) is samples[0]
    assert g.splash_sample(samples, 100) is samples[-1]
    # After the initial black hold, the 240 fps boot frames take every sample in turn.
    for i in range(len(samples)):
        assert g.splash_sample(samples, i / g.FPS) is samples[i]
    assert g.splash_sample(samples, 4 / 30)["time"] == pytest.approx(0.8 / 6)


def test_final_sample_locks_to_existing_logo_vectors():
    source = json.loads(SOURCE.read_bytes())
    expected = g.logo_shapes(str(LOGO))["mark"]
    for sample in (source["frames"][-1], source["titleFrames"][-1]):
        actual = g.splash_shapes(sample["markup"])
        assert len(actual) == len(expected)
        for a_path, e_path in zip(actual, expected):
            assert len(a_path) == len(e_path)
            for a_sub, e_sub in zip(a_path, e_path):
                assert len(a_sub) == len(e_sub)
                for a_point, e_point in zip(a_sub, e_sub):
                    assert a_point == pytest.approx(e_point, abs=1e-12, rel=0)


def test_deterministic_generation_and_v2_loop(tmp_path):
    outputs = [tmp_path / "first.bin", tmp_path / "second.bin"]
    for output in outputs:
        assert g.main(["--svg", str(LOGO), "--splash", str(SOURCE), "--out", str(output)]) == 0
    data = outputs[0].read_bytes()
    assert data == outputs[1].read_bytes()
    # v2: 240 fps, 128x64, 768 frames, the loading loop from frame 480 (after the 2 s intro).
    assert data[:12] == b"SPLB\x02\xf0\x80\x40\x00\x03\xe0\x01"
    animation = boot.unpack(data)
    assert animation.fps == 240 and animation.duration == 2
    assert animation.loop_start == 480 and len(animation.frames) == 768
    # The loop rests on the intro's last frame, so intro -> loop is seamless.
    assert animation.frames[-1].tobytes() == animation.frames[479].tobytes()
    assert all(animation.frames[i].getbbox() is None for i in range(8))  # 1/30 s of black
    assert animation.index(200) >= animation.loop_start  # still moving, in the loop
    assert animation.frames[0].getbbox() is None
    for i, frame in enumerate(animation.frames[1:480], start=1):
        assert frame.mode == "1" and frame.size == (128, 64)
        if 8 <= i < 120:  # The splash fits; the later scan line intentionally exits the panel.
            x0, y0, x1, y1 = frame.getbbox()
            assert 0 < x0 < x1 < 128 and 0 < y0 < y1 < 64
    # Pixel baseline from main 4da9640 (then 30 fps): at each of its frame times from
    # 0.5 s onward (every eighth 240 fps frame) the glide, wordmark, LEDs, glint and
    # last held frame must remain byte-identical.
    old_times = animation.frames[120:480:8]
    assert hashlib.sha256(b"".join(f.tobytes() for f in old_times)).hexdigest() == (
        "73adc3b7b93b4ccd24d502053728d84241f4487ca523b685b7d46259657f15ef"
    )


def test_unknown_splash_elements_fail_explicitly():
    with pytest.raises(ValueError, match="unsupported splash element"):
        g.splash_shapes('<rect x="1" y="1" width="10" height="10"/>')


@pytest.fixture(scope="module")
def hdmi():
    return g.build_hdmi_frames(str(LOGO), str(SOURCE))


def test_hdmi_animation_timeline(hdmi):
    """HDMI: the OLED's timeline at 60 fps, in colour, from the titleFrames samples."""
    intro, loop, focus = hdmi
    assert len(intro) == 120 and len(loop) == 72  # 2 s + 1.2 s at 60 fps
    assert all(f.size == (512, 256) and f.mode == "RGB" for f in intro + loop)
    assert intro[0].getbbox() is None and intro[1].getbbox() is None  # 1/30 s of black
    assert intro[2].getbbox() is not None  # the splash's first sample
    # The splash plays in the samples' own colour; the wordmark is white.
    source = json.loads(SOURCE.read_bytes())
    fill = g._sample_fill(source["titleFrames"][0]["markup"])
    assert fill in {c for _, c in intro[6].getcolors(1 << 16)}
    assert g.HDMI_WORD in {c for _, c in intro[-1].getcolors(1 << 16)}
    # The loop rests on the intro's last frame (seamless), and the focus (where the
    # outro opens from) is the finished mark's centre, inside its ink.
    assert loop[-1].tobytes() == intro[-1].tobytes()
    assert (
        intro[-1].getpixel(focus) != (0, 0, 0)
        or intro[-1].crop((focus[0] - 12, focus[1] - 12, focus[0] + 12, focus[1] + 12)).getbbox()
        is not None
    )
    # It uses the 60000/1001 fps samples one for one through the splash.
    titles = source["titleFrames"]
    for f in range(2, 20):
        t = f / g.HDMI_FPS - g.BLACK
        assert g.splash_sample(titles, t) is titles[min(len(titles) - 1, round(t * 60000 / 1001))]


def test_hdmi_pack_round_trip(hdmi):
    intro, loop, focus = hdmi
    data = g.pack_hdmi(intro, loop, focus)
    fps, w, h, loop_start, pal, frames = g.load_hdmi(data)
    assert (fps, w, h, loop_start) == (60, 512, 256, 120) and len(frames) == 193
    assert frames[-1] == frames[loop_start]  # the wrap record
    assert len(data) < 600_000  # it lives in the initrd
    from PIL import Image

    for i in (0, 10, 60, 119, 150):
        img = Image.frombytes("P", (w, h), frames[i])
        img.putpalette(pal + [0] * (768 - len(pal)))
        got, want = img.convert("RGB"), (intro + loop)[i]
        # palette quantisation: close, colour for colour (mean error per channel)
        diff = sum(abs(a - b) for p, q in zip(got.getdata(), want.getdata()) for a, b in zip(p, q))
        assert diff / (w * h * 3) < 2.0, (i, diff / (w * h * 3))
    assert max(max(f) for f in frames) < g.HDMI_TEXT_BASE  # text palette left free
