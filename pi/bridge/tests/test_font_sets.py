"""Bundled fonts + OLED font sets: every set lays out every screen without text
leaving its box or running into other text."""

import hashlib
import os

import pytest
from PIL import Image, ImageDraw
from splanc_display import draw, fake_bridge, fonts, render_oled
from splanc_display.status import parse
from splanc_display.ui import LIST_ROWS, View

NOW = 1_760_000_000.0
W, H = 128, 64


@pytest.fixture(autouse=True)
def restore_default():
    yield
    fonts.set_active(fonts.DEFAULT_SET)
    draw.TRACE = None


def test_bundled_files_match_their_manifest():
    """fonts/SOURCES.txt (vendor_fonts.py) lists the sha256 of every file shipped."""
    manifest = open(os.path.join(fonts.FONT_DIR, "SOURCES.txt")).read().split("outputs")[1]
    listed = {}
    for line in manifest.splitlines():
        parts = line.split()
        if len(parts) == 2 and len(parts[0]) == 64:
            listed[parts[1]] = parts[0]
    on_disk = set()
    for root, _, files in os.walk(fonts.FONT_DIR):
        for n in files:
            if n != "SOURCES.txt":
                on_disk.add(os.path.relpath(os.path.join(root, n), fonts.FONT_DIR))
    assert on_disk == set(listed)
    for rel, sha in listed.items():
        data = open(os.path.join(fonts.FONT_DIR, rel), "rb").read()
        assert hashlib.sha256(data).hexdigest() == sha, rel
    for fam in {r.split("/")[0] for r in listed}:
        assert f"{fam}/LICENSE" in listed


def test_every_set_loads_every_role():
    assert fonts.DEFAULT_SET in fonts.SETS
    for fs in fonts.SETS.values():
        assert fs.license and fs.summary
        for role in fonts.ROLES:
            assert fs.fonts(role), (fs.name, role)


def test_missing_font_fails_loudly(tmp_path, monkeypatch):
    monkeypatch.setenv("SPLANC_DISPLAY_FONT_DIR", str(tmp_path))
    with pytest.raises(FileNotFoundError):
        fonts.font_path(fonts.TTF_FACES["sans"])


def test_bitmap_font_glyphs_and_fallback():
    f = fonts.bdf("spleen/spleen-6x12.bdf", 1, False)
    assert f.width("abc") == 18 and f.height == 12
    assert f.width("a…") == 12  # synthesized from "."
    img = Image.new("1", (40, 16))
    f.draw(ImageDraw.Draw(img), (0, 0), "Ж", 1)  # Cyrillic: in the subset
    assert img.getbbox() is not None
    img = Image.new("1", (40, 16))
    f.draw(ImageDraw.Draw(img), (0, 0), "中", 1)  # not in any subset: DejaVu draws it
    assert f.width("中") > 0


def test_set_active_switches_and_rejects_unknown():
    a = fonts.set_active("terminus")
    assert fonts.active() is a
    with pytest.raises(KeyError):
        fonts.set_active("comic-sans")


# --- layout ----------------------------------------------------------------------------


def _statuses():
    out = {s: parse(fake_bridge.sample(s, NOW)) for s in fake_bridge_states()}
    long = fake_bridge.sample("pairing", NOW)
    long["players"] = fake_bridge.many_players(NOW, 9) + [
        dict(
            fake_bridge.many_players(NOW, 1)[0],
            name="A fixture with a very long name indeed",
            id="02:00:5E:99:00:01",
            host="fe80::1c2b:3aff:fe4d:5e6f",
            error="its TLS certificate changed and it will not answer until re-trusted",
            ok=False,
        )
    ]
    long["clients"] = 12
    long["paired_clients"] = fake_bridge.many_clients(NOW, 9) + [
        fake_bridge.make_client(5, NOW, used_ago=None),  # the very long name
        dict(
            fake_bridge.make_client(1, NOW, used_ago=90 * 86400, live=True),
            id="W" * 40,  # an id far wider than the screen
            label="Küche – Bücherregal, ein sehr langer Name",
        ),
    ]
    out["long"] = parse(long)
    # The Clients page's other states: none paired, an outdated relay, an older
    # bridge (no list in the file), not loaded yet, offline with the last list.
    out["clients-none"] = parse(fake_bridge.sample("paired", NOW, paired_clients=[]))
    out["clients-outdated"] = parse(
        fake_bridge.sample("paired", NOW, paired_clients=[], paired_clients_state="relay_outdated")
    )
    older = fake_bridge.sample("paired", NOW)
    del older["paired_clients"], older["paired_clients_state"]
    out["clients-older-bridge"] = parse(older)
    out["clients-unknown"] = parse(
        fake_bridge.sample("starting", NOW, paired_clients_state="unknown")
    )
    one = fake_bridge.sample("paired", NOW, paired_clients=[fake_bridge.make_client(5, NOW)])
    out["clients-one-long"] = parse(one)
    out["error-long"] = parse(
        fake_bridge.sample(
            "error",
            NOW,
            error="relay rejected this bridge (bad credentials) - run: splanc-bridge logs "
            "and check the clock, the network and the relay URL in bridge.env",
        )
    )
    return out


def fake_bridge_states():
    return ["starting", "offline", "unpaired", "pairing", "paired", "error"]


def _views(s):
    for page in ("home", "qr", "network"):
        yield page, View(page=page)
    n = len(s.players)
    for sel in range(n):
        top = max(0, min(sel - LIST_ROWS + 1, n - LIST_ROWS)) if n > LIST_ROWS else 0
        yield f"players-{sel}", View(page="players", sel=sel, list_pos=sel, list_top=top)
    if not s.players:
        yield "players", View(page="players")
    for p in s.players:
        rows = render_oled.detail_row_count(p, NOW)
        for scroll in range(0, max(1, rows - 3)):
            yield f"detail-{p.key}-{scroll}", View(page="detail", key=p.key, detail_scroll=scroll)
    n = len(s.paired)
    yield "clients", View(page="clients")
    for sel in range(n):
        top = max(0, min(sel - LIST_ROWS + 1, n - LIST_ROWS)) if n > LIST_ROWS else 0
        yield f"clients-{sel}", View(page="clients", client_sel=sel, client_pos=sel, client_top=top)
    for c in s.paired:
        rows = render_oled.client_row_count(c, NOW)
        for scroll in range(0, max(1, rows - 3)):
            yield f"client-{c.key}-{scroll}", View(page="client", key=c.key, client_scroll=scroll)
    yield "client-gone", View(page="client", key="no-such-client")


def _overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _check(trace, img, label):
    rule_y = render_oled._rule_y()
    has_rule = all(
        img.getpixel((x, rule_y)) for x in range(render_oled.M, W - render_oled.M)
    ) and not img.getpixel(
        (W // 2, rule_y + 1)
    )  # a rule, not the confirm banner
    body_h = H - render_oled._body_y()
    boxes = {}
    for size, box, text in trace:
        l, t, r, b = box
        if size == (W, H):
            assert 0 <= l and r <= W and 0 <= t and b <= H, (label, text, box)
            if has_rule and t < rule_y:
                assert b <= rule_y, (label, "runs into the header rule", text, box)
        else:  # a list/detail body
            if t >= LIST_ROWS * render_oled.ROW_H:
                continue  # the next row, drawn for scrolling, off the bottom
            assert 0 <= l and r <= W and 0 <= t, (label, text, box)
            assert b <= min(body_h, LIST_ROWS * render_oled.ROW_H + 2), (label, text, box)
            row_top = t // render_oled.ROW_H * render_oled.ROW_H
            assert b <= row_top + render_oled.ROW_H + 1, (label, "leaves its row", text, box)
        boxes.setdefault(size, []).append((box, text))
    for size, items in boxes.items():
        for i, (a, ta) in enumerate(items):
            for bb, tb in items[i + 1 :]:
                assert not _overlaps(a, bb), (label, "text collides", ta, a, tb, bb)


@pytest.mark.parametrize("name", list(fonts.SETS))
def test_every_screen_fits(name):
    fonts.set_active(name)
    for sname, s in _statuses().items():
        for vname, v in _views(s):
            draw.TRACE = []
            render_oled._SCENE_CACHE.clear()
            img = render_oled.render(s, v, now=NOW)
            _check(draw.TRACE, img, f"{name}/{sname}/{vname}")


@pytest.mark.parametrize("name", list(fonts.SETS))
def test_overlays_fit(name):
    fonts.set_active(name)
    render_oled.render(parse(fake_bridge.sample("pairing", NOW)), View(page="home"), now=NOW)
    long = fake_bridge.make_client(5, NOW)
    s = parse(
        fake_bridge.sample("paired", NOW, paired_clients=fake_bridge.sample_clients(NOW) + [long])
    )
    short = s.paired[0].key
    for v in (
        View(page="home", overlay="hold", overlay_seconds=4.0),
        View(page="home", overlay="confirm", overlay_seconds=9.0),
        View(page="home", overlay="toast", overlay_text="Working…"),
        View(page="home", overlay="toast", overlay_text="Hold KEY3 5 s to revoke all clients"),
        View(page="client", key=short, overlay="hold", overlay_seconds=4.0, revoke=short),
        View(page="client", key=short, overlay="confirm", overlay_seconds=9.0, revoke=short),
        View(page="client", overlay="hold", overlay_seconds=2.0, revoke=long["id"]),
        View(page="client", overlay="confirm", overlay_seconds=3.0, revoke=long["id"]),
        View(page="client", overlay="confirm", overlay_seconds=3.0, revoke="gone"),
        View(page="clients", overlay="toast", overlay_text="Client revoked"),
    ):
        img = Image.new("1", (W, H))
        dr = ImageDraw.Draw(img)
        dr.fontmode = "1"
        draw.TRACE = []
        render_oled._overlay(img, dr, v, s)
        _check(draw.TRACE, img, f"{name}/overlay-{v.overlay}-{v.revoke[:6]}")


def test_tracking_widens_measure_draw_and_ellipsis_alike():
    plain = fonts.bdf("terminus/ter-u12n.bdf", 1, True)
    tracked = fonts.bdf("terminus/ter-u12n.bdf", 1, True, 1)
    assert tracked.width("Fixtures") == plain.width("Fixtures") + 7
    img = Image.new("1", (80, 14))
    dr = ImageDraw.Draw(img)
    tracked.draw(dr, (0, 0), "Fixtures", 1)
    box = tracked.ink_box((0, 0), "Fixtures")
    assert img.getbbox()[2] <= box[2] <= tracked.width("Fixtures")
    s = draw.ellipsize(dr, "Living room arch", tracked, 60)
    assert s.endswith("…") and tracked.width(s) <= 60


def test_inverse_title_bar():
    fonts.set_active("terminus-inverse")
    s = parse(fake_bridge.sample("pairing", NOW))
    img = render_oled.render(s, View(page="players"), now=NOW)
    bar = render_oled._rule_y()
    # the bar is lit edge to edge except where the dark title/badge are
    assert all(img.getpixel((x, 0)) for x in range(W))
    assert all(img.getpixel((x, bar)) for x in range(W))
    dark = sum(1 for x in range(W) for y in range(1, bar) if not img.getpixel((x, y)))
    assert dark > 50  # "Fixtures" and "2/3 ok" cut out of the bar
    assert not img.getpixel((W // 2, bar + 1))
