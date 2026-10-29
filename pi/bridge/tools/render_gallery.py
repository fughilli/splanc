"""Render every bridge state for HDMI and the OLED HAT to PNGs, for review.

    bazel run //pi/bridge:render_gallery -- /path/to/out
    bazel run //pi/bridge:render_gallery -- --docs "$PWD/docs/img/pi-bridge"
    (or) PYTHONPATH=pi/bridge/display python3 pi/bridge/tools/render_gallery.py out/

Writes hdmi-<state>.png (1920x1080), hdmi-<state>-720x480.png for the pairing
state, oled-<state>-<page>.png (4x, blue-on-black like the real panel), the
overlay screens, and contact sheets (hdmi-sheet.png, oled-sheet.png); and the
fixture menu + boot animation: oled-fixtures-list.png (scrolled),
oled-fixture-detail-*.png (healthy, scrolled, unreachable), oled-boot-sheet.png
(every 3rd boot frame), and the animations oled-boot.gif (logo -> first screen)
and oled-fixture-nav.gif (into a fixture's detail and back), simulated with the
real UI state machine on a fake clock at ANIM_FPS; the Clients page:
oled-clients-*.png (list, a client's detail, revoking one, none, outdated relay).

    --font-set NAME        draw the OLED screens with that font set (fonts.SETS)
    --font-sets PATH.png   instead: one comparison sheet, a row per font set and
                           a column per key screen (also PATH-4x.png, enlarged)
    --titles PATH.png      instead: the title rows of four screens per set at 8x,
                           to judge letter spacing
    --sets a,b,c           limit --font-sets / --titles to these sets (in this order)
"""

from __future__ import annotations

import dataclasses
import os
import sys

from PIL import Image, ImageDraw
from splanc_display import boot, fake_bridge, fake_updates, fonts, render_hdmi, render_oled
from splanc_display.status import WAITING, Status, parse
from splanc_display.ui import PAGES, OledUI, View

NOW = 1_760_000_000.0
STATES = ["starting", "offline", "unpaired", "pairing", "paired", "error"]
OLED_BLUE = (90, 170, 255)


def oled_preview(img: Image.Image, scale: int = 4) -> Image.Image:
    """1-bit frame -> scaled RGB preview in the panel's blue."""
    rgb = Image.new("RGB", img.size, (0, 0, 0))
    rgb.paste(OLED_BLUE, mask=img.convert("L"))
    big = rgb.resize((img.width * scale, img.height * scale), Image.NEAREST)
    framed = Image.new("RGB", (big.width + 16, big.height + 16), (40, 40, 40))
    framed.paste(big, (8, 8))
    return framed


def statuses():
    out = {WAITING: Status(state=WAITING)}
    for s in STATES:
        out[s] = parse(fake_bridge.sample(s, NOW))
    many = fake_bridge.sample("paired", NOW)
    many["players"] = [
        {"name": f"Fixture {i}", "host": f"splanc-{i}.local", "ok": i % 4 != 0} for i in range(1, 9)
    ]
    many["clients"] = 1
    out["paired-many-fixtures"] = parse(many)
    expired = fake_bridge.sample("pairing", NOW)
    expired["pairing"]["expires_at"] = NOW - 5
    expired["state"] = "unpaired"
    out["unpaired-code-expired"] = parse(expired)
    return out


def sheet(images, cols: int, pad: int = 12, labels=None) -> Image.Image:
    w = max(i.width for i in images)
    h = max(i.height for i in images)
    rows = (len(images) + cols - 1) // cols
    lab = 22 if labels else 0
    out = Image.new("RGB", (cols * (w + pad) + pad, rows * (h + pad + lab) + pad), (255, 255, 255))
    dr = ImageDraw.Draw(out)
    for n, im in enumerate(images):
        r, c = divmod(n, cols)
        x, y = pad + c * (w + pad), pad + r * (h + pad + lab)
        if labels:
            dr.text((x, y), labels[n], fill=(0, 0, 0))
        out.paste(im, (x, y + lab))
    return out


ANIM_FPS = 25  # the GIFs' frame rate: about what a Pi Zero 2 / Pi 3 panel path holds


def fixtures_status(n: int = 9) -> Status:
    doc = fake_bridge.sample("paired", NOW)
    doc["players"] = fake_bridge.many_players(NOW, n)
    return parse(doc)


class _Clock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def simulate(st: Status, script, frames=None, fps: int = ANIM_FPS):
    """Drive the real OledUI with ``script`` [(seconds_to_wait, key or None)] and
    render a frame every 1/fps s: the PNG frames of what the panel would show."""
    clock = _Clock()
    u = OledUI(lambda cmd, done: done(True, ""), clock)
    u.set_fixtures(
        [p.key for p in st.players], lambda k: render_oled.detail_row_count(st.player(k), NOW)
    )
    out = []
    if frames is not None:
        u.start_boot(frames.duration)
    for wait, key in script:
        if key:
            u.press(key)
        end = clock.t + wait
        while clock.t < end - 1e-9:
            u.tick()
            out.append(render_oled.render(st, u.view(), now=NOW, frames=frames))
            clock.t += 1.0 / fps
    return out


def save_gif(frames, path: str, fps: int = ANIM_FPS, scale: int = 3) -> None:
    rgb = [oled_preview(f, scale=scale) for f in frames]
    rgb[0].save(
        path, save_all=True, append_images=rgb[1:], duration=int(1000 / fps), loop=0, optimize=True
    )


NAV_SCRIPT = [
    (0.6, None),
    (0.5, "down"),
    (0.5, "down"),
    (0.6, "press"),  # into the third fixture
    (0.4, "down"),
    (0.4, "down"),
    (0.8, "down"),
    (0.7, "left"),  # back to the list
    (0.4, "down"),
    (0.4, "down"),
    (0.6, "down"),  # the list scrolls
    (0.7, "press"),
    (0.8, "press"),  # press backs out too
]


def menu(out: str) -> list:
    """The fixture menu + boot screens and animations; returns the sheet tiles."""
    st = fixtures_status()
    small = parse(fake_bridge.sample("paired", NOW))
    arch, porch, tree = (p.key for p in small.players)
    shots = {
        "oled-fixtures-list": (st, View(page="players", sel=5, list_pos=5, list_top=2)),
        "oled-fixtures-list-top": (small, View(page="players", sel=1, list_pos=1)),
        "oled-fixture-detail-healthy": (small, View(page="detail", key=arch)),
        "oled-fixture-detail-healthy-scrolled": (
            small,
            View(page="detail", key=arch, detail_scroll=7),
        ),
        "oled-fixture-detail-idle": (small, View(page="detail", key=porch)),
        "oled-fixture-detail-unreachable": (small, View(page="detail", key=tree)),
    }
    for name, (s, v) in client_views().items():
        shots["oled-clients-" + name] = (s, v)
    for name, (s, v) in update_views().items():
        shots["oled-updates-" + name] = (s, v)
    tiles = []
    for name, (s, v) in shots.items():
        o = oled_preview(render_oled.render(s, v, now=NOW))
        o.save(os.path.join(out, name + ".png"))
        tiles.append((name.replace("oled-", ""), o))
    frames = boot.load()
    if frames is None:
        print("no boot frames (build //pi/bridge:boot_frames): skipping the boot images")
    else:
        sel = frames.frames[::3] + [frames.frames[-1]]
        sheet(
            [oled_preview(f, scale=2) for f in sel],
            6,
            labels=[f"{i * 3 / frames.fps:.2f} s" for i in range(len(sel) - 1)] + ["final"],
        ).save(os.path.join(out, "oled-boot-sheet.png"))
        boot_seq = simulate(small, [(frames.duration + 0.25 + 0.8, None)], frames=frames)
        save_gif(boot_seq, os.path.join(out, "oled-boot.gif"))
    nav = simulate(st, [(0.4, None), (0.25, "right"), (0.4, "right")] + NAV_SCRIPT)
    save_gif(nav, os.path.join(out, "oled-fixture-nav.gif"))
    return tiles


def client_views() -> dict:
    """The Clients page's screens: name -> (status, view)."""
    small = parse(fake_bridge.sample("paired", NOW))
    many = parse(fake_bridge.sample("paired", NOW, paired_clients=fake_bridge.many_clients(NOW, 9)))
    claude = small.paired[0].key
    return {
        "list": (small, View(page="clients", client_sel=1, client_pos=1)),
        "list-many": (many, View(page="clients", client_sel=5, client_pos=5, client_top=2)),
        "detail": (small, View(page="client", key=claude)),
        "detail-scrolled": (small, View(page="client", key=claude, client_scroll=2)),
        "hold": (
            small,
            View(page="client", key=claude, overlay="hold", overlay_seconds=2.2, revoke=claude),
        ),
        "confirm": (
            small,
            View(page="client", key=claude, overlay="confirm", overlay_seconds=8.0, revoke=claude),
        ),
        "none": (parse(fake_bridge.sample("paired", NOW, paired_clients=[])), View(page="clients")),
        "relay-outdated": (
            parse(
                fake_bridge.sample(
                    "paired", NOW, paired_clients=[], paired_clients_state="relay_outdated"
                )
            ),
            View(page="clients"),
        ),
    }


def update_views() -> dict:
    """The Updates page's screens: name -> (status, view)."""
    paired = parse(fake_bridge.sample("paired", NOW))
    ups = fake_updates.sample_updates(NOW)

    def with_(name, clients=None):
        st = dataclasses.replace(paired, updates=ups[name])
        return dataclasses.replace(st, clients=clients) if clients is not None else st

    return {
        "up-to-date": (with_("up-to-date"), View(page="updates")),
        "available": (with_("both"), View(page="updates")),
        "checking": (with_("checking"), View(page="updates", update_sel=2, update_pos=2)),
        "detail": (with_("both"), View(page="update", key="system")),
        "detail-agent": (with_("both"), View(page="update", key="agent")),
        "confirm": (
            with_("both", clients=0),
            View(
                page="update",
                key="system",
                overlay="confirm",
                overlay_seconds=8.0,
                install="system",
            ),
        ),
        "downloading": (with_("downloading"), View(page="update", key="system")),
        "rebooting": (with_("rebooting"), View(page="update", key="system")),
        "failed": (with_("failed"), View(page="update", key="system")),
        "ssh-only": (with_("ssh"), View(page="updates")),
    }


def docs(out: str) -> int:
    """The few images docs/pi-bridge.md embeds (smaller, fixed names)."""
    os.makedirs(out, exist_ok=True)
    st = statuses()
    for name in ("pairing", "paired"):
        render_hdmi.render(st[name], (1920, 1080), now=NOW, oled=True).resize(
            (960, 540), Image.LANCZOS
        ).save(os.path.join(out, f"hdmi-{name}.png"), optimize=True)
    pages = [
        oled_preview(
            render_oled.render(
                st["paired" if p == "clients" else "pairing"], View(page=p), now=NOW
            ),
            scale=3,
        )
        for p in PAGES
        if p != "updates"  # (its own sheet below)
    ]
    over = [
        oled_preview(render_oled.render(st["pairing"], v, now=NOW), scale=3)
        for v in (
            View(page="home", overlay="hold", overlay_seconds=2.2),
            View(page="home", overlay="confirm", overlay_seconds=8.0),
            View(page="home", overlay="toast", overlay_text="Identifying fixtures"),
            View(page="home"),
        )
    ]
    over[3] = oled_preview(render_oled.render(st["paired"], View(page="home"), now=NOW), scale=3)
    sheet(pages, 5, labels=["home", "scan to pair", "fixtures", "network", "clients"]).save(
        os.path.join(out, "oled-pages.png"), optimize=True
    )
    sheet(over, 4, labels=["holding KEY3", "revoke confirm", "after KEY2", "paired"]).save(
        os.path.join(out, "oled-overlays.png"), optimize=True
    )
    tiles = menu_tiles_for_docs()
    sheet([t for _, t in tiles], 3, labels=[n for n, _ in tiles]).save(
        os.path.join(out, "oled-fixtures.png"), optimize=True
    )
    cv = client_views()
    tiles = [
        (label, oled_preview(render_oled.render(*cv[k], now=NOW), scale=3))
        for label, k in (
            ("client list", "list"),
            ("a client", "detail"),
            ("revoke it", "confirm"),
        )
    ]
    sheet([t for _, t in tiles], 3, labels=[n for n, _ in tiles]).save(
        os.path.join(out, "oled-clients.png"), optimize=True
    )
    uv = update_views()
    tiles = [
        (label, oled_preview(render_oled.render(*uv[k], now=NOW), scale=3))
        for label, k in (
            ("Updates page", "available"),
            ("an update", "detail"),
            ("KEY3: confirm", "confirm"),
            ("installing", "downloading"),
        )
    ]
    sheet([t for _, t in tiles], 4, labels=[n for n, _ in tiles]).save(
        os.path.join(out, "oled-updates.png"), optimize=True
    )
    render_hdmi.render(uv["available"][0], (1920, 1080), now=NOW, oled=True).resize(
        (960, 540), Image.LANCZOS
    ).save(os.path.join(out, "hdmi-update-available.png"), optimize=True)
    print(f"wrote doc images to {out}")
    return 0


def menu_tiles_for_docs() -> list:
    st = fixtures_status()
    small = parse(fake_bridge.sample("paired", NOW))
    arch, _, tree = (p.key for p in small.players)
    views = [
        ("fixture list", st, View(page="players", sel=5, list_pos=5, list_top=2)),
        ("a fixture", small, View(page="detail", key=arch)),
        ("an unreachable one", small, View(page="detail", key=tree)),
    ]
    return [(n, oled_preview(render_oled.render(s, v, now=NOW), scale=3)) for n, s, v in views]


def font_set_views():
    """(label, status, view) of the screens the font sets are compared on."""
    st = statuses()
    pairing = st["pairing"]
    many = fixtures_status(9)
    down = next(p for p in pairing.players if not p.ok)
    return [
        ("pairing / home", pairing, View(page="home")),
        ("pairing / qr", pairing, View(page="qr")),
        ("paired / home", st["paired"], View(page="home")),
        ("fixtures", many, View(page="players", sel=1, list_pos=1)),
        ("detail", pairing, View(page="detail", key=pairing.players[0].key)),
        ("detail (unreachable)", pairing, View(page="detail", key=down.key)),
        ("network", pairing, View(page="network")),
        *(
            (f"clients / {k}", s, v)
            for k, (s, v) in client_views().items()
            if k in ("list", "detail", "confirm")
        ),
        ("error", st["error"], View(page="home")),
        ("offline", st["offline"], View(page="home")),
        ("revoke confirm", pairing, View(page="home", overlay="confirm", overlay_seconds=8.0)),
        ("toast", pairing, View(page="players", overlay="toast", overlay_text="Identify sent")),
    ]


def font_sets_sheet(path: str, scale: int = 2, sets=None) -> Image.Image:
    """A row per font set, a column per screen; labelled. Also writes PATH-4x.png."""
    views = font_set_views()
    tiles = {}
    for name in sets or fonts.SETS:
        fonts.set_active(name)
        tiles[name] = [
            oled_preview(render_oled.render(s, v, now=NOW), scale=scale) for _, s, v in views
        ]
    fonts.set_active(fonts.DEFAULT_SET)
    tw, th = next(iter(tiles.values()))[0].size
    pad, lab_w, head = 10, 190, 20
    out = Image.new(
        "RGB",
        (lab_w + len(views) * (tw + pad) + pad, head + len(tiles) * (th + pad) + pad),
        (255, 255, 255),
    )
    dr = ImageDraw.Draw(out)
    for c, (label, _, _) in enumerate(views):
        dr.text((lab_w + c * (tw + pad), 4), label, fill=(0, 0, 0))
    for r, (name, row) in enumerate(tiles.items()):
        fs = fonts.SETS[name]
        y = head + r * (th + pad)
        lines = [name + (" (default)" if name == fonts.DEFAULT_SET else ""), fs.license]
        lines += _wrap_words(fs.summary, 28)
        for i, line in enumerate(lines):
            dr.text((pad, y + 4 + i * 14), line, fill=(0, 0, 0) if i == 0 else (90, 90, 90))
        for c, t in enumerate(row):
            out.paste(t, (lab_w + c * (tw + pad), y))
    out.save(path)
    big = out.resize((out.width * 2, out.height * 2), Image.NEAREST)
    root, ext = os.path.splitext(path)
    big.save(root + "-4x" + ext)
    return out


def titles_sheet(path: str, sets=None, scale: int = 8) -> Image.Image:
    """Each set's header row on four screens ("Ready to pair", "Fixtures", a
    fixture's name, the revoke banner), cropped to the title and enlarged."""
    st = statuses()
    pairing = st["pairing"]
    views = [
        ("Ready to pair", pairing, View(page="home")),
        ("Fixtures", pairing, View(page="players")),
        ("Living room arch", pairing, View(page="detail", key=pairing.players[0].key)),
        ("REVOKE ALL?", pairing, View(page="home", overlay="confirm", overlay_seconds=8.0)),
    ]
    rows = []
    for name in sets or fonts.SETS:
        fonts.set_active(name)
        crops = []
        for _, s, v in views:
            img = render_oled.render(s, v, now=NOW)
            h = 15 if v.overlay else render_oled._rule_y() + 1
            crops.append(oled_preview(img.crop((0, 0, 128, h)), scale=scale))
        rows.append((name, crops))
    fonts.set_active(fonts.DEFAULT_SET)
    pad, lab = 12, 26
    cw = max(c.width for _, cs in rows for c in cs)
    ch = max(c.height for _, cs in rows for c in cs)
    out = Image.new(
        "RGB",
        (2 * (cw + pad) + pad, len(rows) * 2 * (ch + pad) + len(rows) * lab + pad),
        (255, 255, 255),
    )
    dr = ImageDraw.Draw(out)
    lf = fonts.ttf("bold", 18)
    y = pad
    for name, crops in rows:
        dr.text((pad, y), f"{name}: {fonts.SETS[name].summary}", font=lf, fill=(0, 0, 0))
        y += lab
        for i, c in enumerate(crops):
            r, col = divmod(i, 2)
            out.paste(c, (pad + col * (cw + pad), y + r * (ch + pad)))
        y += 2 * (ch + pad)
    out.save(path)
    return out


def _wrap_words(text: str, n: int) -> list:
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > n:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    return lines + ([cur] if cur else [])


def main(argv) -> int:
    argv = list(argv)
    if "--font-set" in argv:
        i = argv.index("--font-set")
        fonts.set_active(argv[i + 1])
        del argv[i : i + 2]
    sets = None
    if "--sets" in argv:
        i = argv.index("--sets")
        sets = argv[i + 1].split(",")
        del argv[i : i + 2]
        for n in sets:
            fonts.SETS[n]  # noqa: B018 (an unknown name fails here, loudly)
    for flag, fn in (("--font-sets", font_sets_sheet), ("--titles", titles_sheet)):
        if flag in argv:
            path = argv[argv.index(flag) + 1]
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            fn(path, sets=sets)
            print(f"wrote {path}")
            return 0
    if len(argv) > 2 and argv[1] == "--docs":
        return docs(argv[2])
    out = argv[1] if len(argv) > 1 else "gallery"
    os.makedirs(out, exist_ok=True)
    hdmi, hdmi_labels, oled, oled_labels = [], [], [], []
    for name, st in statuses().items():
        im = render_hdmi.render(st, (1920, 1080), now=NOW, oled=True)
        im.save(os.path.join(out, f"hdmi-{name}.png"))
        hdmi.append(im.resize((640, 360), Image.LANCZOS))
        hdmi_labels.append(name)
        for page in PAGES:
            o = oled_preview(render_oled.render(st, View(page=page), now=NOW))
            o.save(os.path.join(out, f"oled-{name}-{page}.png"))
            if (
                name in ("pairing", "paired", "offline", "error", WAITING, "unpaired-code-expired")
                or page == "home"
            ):
                oled.append(o)
                oled_labels.append(f"{name} / {page}")
    pairing = statuses()["pairing"]
    render_hdmi.render(pairing, (720, 480), now=NOW, oled=False).save(
        os.path.join(out, "hdmi-pairing-720x480.png")
    )
    render_hdmi.render(pairing, (1280, 720), now=NOW, oled=False).save(
        os.path.join(out, "hdmi-pairing-1280x720.png")
    )
    overlays = {
        "hold": View(page="home", overlay="hold", overlay_seconds=2.2),
        "confirm": View(page="home", overlay="confirm", overlay_seconds=8.0),
        "toast": View(page="home", overlay="toast", overlay_text="New code requested"),
    }
    for name, v in overlays.items():
        o = oled_preview(render_oled.render(pairing, v, now=NOW))
        o.save(os.path.join(out, f"oled-overlay-{name}.png"))
        oled.append(o)
        oled_labels.append(f"overlay / {name}")
    for name, o in menu(out):
        oled.append(o)
        oled_labels.append(name)
    sheet(hdmi, 3, labels=hdmi_labels).save(os.path.join(out, "hdmi-sheet.png"))
    sheet(oled, 4, labels=oled_labels).save(os.path.join(out, "oled-sheet.png"))
    print(f"wrote {len(os.listdir(out))} images to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
