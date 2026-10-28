"""The fixture screens, slides and the boot animation as pixels; saves review PNGs.

PNGs land in Bazel's undeclared test outputs (or $SPLANC_RENDER_OUT), as test_render.
"""

import os

import pytest
from PIL import Image
from splanc_display import boot, fake_bridge, render_oled
from splanc_display.anim import Scene, SlideView
from splanc_display.status import parse
from splanc_display.ui import View

NOW = 1_760_000_000.0
IN_BAZEL = "TEST_SRCDIR" in os.environ


def many(n=9):
    doc = fake_bridge.sample("paired", NOW)
    doc["players"] = fake_bridge.many_players(NOW, n)
    return parse(doc)


def few():
    return parse(fake_bridge.sample("paired", NOW))


def save(img, outdir, name):
    if outdir:
        img.convert("L").resize((512, 256), Image.NEAREST).save(os.path.join(outdir, name))


def lit(img, box):
    return img.crop(box).histogram()[255]


def test_list_scrolled_highlight_and_scrollbar(outdir):
    st = many()
    img = render_oled.render(st, View(page="players", sel=5, list_pos=5, list_top=2), now=NOW)
    save(img, outdir, "oled-fixtures-list-scrolled.png")
    # Row 5 is the 4th visible row (top = 2): its band is mostly lit (inverted).
    y = render_oled.BODY_Y + 3 * render_oled.ROW_H
    assert lit(img, (0, y + 1, 120, y + 11)) > 0.6 * 120 * 10
    # The other rows are dark text on black.
    assert lit(img, (0, render_oled.BODY_Y + 1, 120, render_oled.BODY_Y + 11)) < 0.35 * 120 * 10
    # A scrollbar thumb on the right edge.
    assert lit(img, (125, render_oled.BODY_Y, 128, 64)) > 15


def test_short_list_has_no_scrollbar():
    img = render_oled.render(few(), View(page="players"), now=NOW)
    assert (
        lit(img, (126, render_oled.BODY_Y + render_oled.ROW_H + 1, 128, 64)) == 0
    )  # under the highlight


def test_list_mid_scroll_draws_partial_rows():
    st = many()
    a = render_oled.render(st, View(page="players", sel=4, list_pos=4, list_top=1), now=NOW)
    b = render_oled.render(st, View(page="players", sel=4, list_pos=3.6, list_top=0.6), now=NOW)
    assert a.tobytes() != b.tobytes()


def test_long_names_are_cut():
    doc = fake_bridge.sample("paired", NOW)
    doc["players"] = [
        dict(fake_bridge.many_players(NOW, 1)[0], name="An extraordinarily long fixture name " * 3)
    ]
    st = parse(doc)
    for v in (View(page="players"), View(page="detail", key=st.players[0].key)):
        img = render_oled.render(st, v, now=NOW)
        assert img.size == (128, 64)


@pytest.mark.parametrize("which", ["healthy", "idle", "unreachable"])
def test_detail_screens(which, outdir):
    st = few()
    p = {"healthy": st.players[0], "idle": st.players[1], "unreachable": st.players[2]}[which]
    img = render_oled.render(st, View(page="detail", key=p.key), now=NOW)
    save(img, outdir, f"oled-fixture-detail-{which}.png")
    assert img.size == (128, 64) and 150 < img.histogram()[255] < 128 * 64 * 0.5
    scrolled = render_oled.render(st, View(page="detail", key=p.key, detail_scroll=6), now=NOW)
    assert scrolled.tobytes() != img.tobytes()


def test_detail_of_a_vanished_fixture():
    img = render_oled.render(few(), View(page="detail", key="nope"), now=NOW)
    assert img.histogram()[255] > 50


@pytest.mark.parametrize("style", ["slide", "push"])
@pytest.mark.parametrize("direction", ["left", "right"])
def test_slides_start_at_src_and_end_at_dst(style, direction):
    st = few()
    src, dst = Scene("players"), Scene("detail", st.players[0].key)
    whole = {
        sc: render_oled.render(st, View(page=sc.page, key=sc.key), now=NOW).tobytes()
        for sc in (src, dst)
    }
    for p, want in ((0.0, src), (1.0, dst)):
        v = View(page=dst.page, key=dst.key, slide=SlideView(src, dst, direction, style, p))
        assert render_oled.render(st, v, now=NOW).tobytes() == whole[want]
    mid = render_oled.render(
        st,
        View(page=dst.page, key=dst.key, slide=SlideView(src, dst, direction, style, 0.5)),
        now=NOW,
    )
    assert mid.tobytes() not in whole.values()


def test_vertical_handoff_from_the_boot_logo():
    frames = boot.BootFrames([Image.new("1", (128, 64), 255)], fps=30)  # an all-white "logo"
    st = few()
    v = View(
        page="home", boot_t=5.0, slide=SlideView(Scene("boot"), Scene("home"), "up", "slide", 0.5)
    )
    img = render_oled.render(st, v, now=NOW, frames=frames)
    assert lit(img, (0, 0, 128, 32)) == 128 * 32  # the logo's lower half, moved up
    assert lit(img, (0, 32, 128, 64)) < 128 * 32  # the home page coming in under it


def test_boot_frames_round_trip_and_hold_the_last():
    a, b = Image.new("1", (128, 64), 0), Image.new("1", (128, 64), 255)
    import gen_boot_frames

    fr = boot.unpack(gen_boot_frames.pack([a, b], fps=10))
    assert fr.fps == 10 and fr.duration == pytest.approx(0.2)
    assert fr.at(0).tobytes() == a.tobytes() and fr.at(0.15).tobytes() == b.tobytes()
    assert fr.at(9).tobytes() == b.tobytes() and fr.at(-1).tobytes() == a.tobytes()
    with pytest.raises(ValueError):
        boot.unpack(b"nope")


def test_missing_boot_frames_mean_no_animation(tmp_path):
    assert boot.load(str(tmp_path / "none.bin")) is None
    (tmp_path / "bad.bin").write_bytes(b"SPLB\x01")
    assert boot.load(str(tmp_path / "bad.bin")) is None
    # The renderer still draws something for a boot scene without frames.
    img = render_oled.render(few(), View(page="boot", boot_t=0.5), now=NOW, frames=None)
    assert img.size == (128, 64)


def test_svg_path_flattening():
    import gen_boot_frames as g

    subs = g.flatten_path("M 0,0 h 10 v 10 h -10 z m 2,2 l 6,0 0,6 -6,0 z")
    assert len(subs) == 2 and subs[0][:4] == [(0, 0), (10, 0), (10, 10), (0, 10)]
    assert subs[1][0] == (2, 2)
    img = g.raster([subs], 1.0, 0, 0, (12, 12))
    assert img.getpixel((5, 1)) == 255 and img.getpixel((5, 5)) == 0  # even-odd hole
    c = g.flatten_path("M0 0 C 0 10 10 10 10 0", steps=4)
    assert len(c[0]) == 5 and c[0][-1] == (10, 0)
    assert g.parse_transform("translate(2,3) scale(2)") == (2, 0, 0, 2, 2, 3)


@pytest.mark.skipif(
    not IN_BAZEL, reason="the frames are a Bazel build output (//pi/bridge:boot_frames)"
)
def test_built_boot_frames(outdir):
    fr = boot.load()
    assert fr is not None, "boot_frames.bin was not built next to the package"
    assert 1.5 <= fr.duration <= 3.0 and fr.fps >= 25
    first, last = fr.frames[0], fr.frames[-1]
    assert first.histogram()[255] == 0  # starts black
    assert 600 < last.histogram()[255] < 128 * 64 * 0.4  # ends on the full logo
    # Smooth: consecutive frames differ by small amounts, none is a jump cut.
    diffs = [
        sum(x != y for x, y in zip(a.tobytes(), b.tobytes()))
        for a, b in zip(fr.frames, fr.frames[1:])
    ]
    assert max(diffs) < 400
    if outdir:
        sheet = Image.new("1", (128 * 6, 64 * ((len(fr.frames) + 5) // 6)))
        for i, f in enumerate(fr.frames):
            sheet.paste(f, ((i % 6) * 128, (i // 6) * 64))
        sheet.save(os.path.join(outdir, "oled-boot-frames.png"))


def test_generator_matches_the_logo_svg():
    """The generator runs on the real logo (a data dep in Bazel; the checkout otherwise)."""
    import gen_boot_frames as g

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, "..", "..", "..", "web", "public", "icons", "splanc.svg")]
    if IN_BAZEL:
        candidates.insert(
            0,
            os.path.join(
                os.environ["TEST_SRCDIR"], "_main", "web", "public", "icons", "splanc.svg"
            ),
        )
    svg = next((c for c in candidates if os.path.exists(c)), None)
    if svg is None:
        pytest.skip("logo svg not reachable")
    shapes = g.logo_shapes(svg)
    assert len(shapes["mark"]) == 2 and len(shapes["word"]) == 1
    frames = g.build_frames(svg)
    assert len(frames) == int(g.SECONDS * g.FPS)
    assert boot.unpack(g.pack(frames)).frames[-1].tobytes() == frames[-1].tobytes()


def test_scene_cache_never_leaks_overlays():
    st = few()
    toast = render_oled.render(
        st, View(page="network", overlay="toast", overlay_text="Hi"), now=NOW
    )
    plain = render_oled.render(st, View(page="network"), now=NOW)
    assert toast.tobytes() != plain.tobytes()
    assert lit(plain, (0, 48, 128, 64)) < lit(toast, (0, 48, 128, 64))
