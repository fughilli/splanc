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
real UI state machine on a fake clock at ANIM_FPS.
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw
from splanc_display import boot, fake_bridge, render_hdmi, render_oled
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


def docs(out: str) -> int:
    """The few images docs/pi-bridge.md embeds (smaller, fixed names)."""
    os.makedirs(out, exist_ok=True)
    st = statuses()
    for name in ("pairing", "paired"):
        render_hdmi.render(st[name], (1920, 1080), now=NOW, oled=True).resize(
            (960, 540), Image.LANCZOS
        ).save(os.path.join(out, f"hdmi-{name}.png"), optimize=True)
    pages = [
        oled_preview(render_oled.render(st["pairing"], View(page=p), now=NOW), scale=3)
        for p in PAGES
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
    sheet(pages, 4, labels=["home", "scan to pair", "fixtures", "network"]).save(
        os.path.join(out, "oled-pages.png"), optimize=True
    )
    sheet(over, 4, labels=["holding KEY3", "revoke confirm", "after KEY2", "paired"]).save(
        os.path.join(out, "oled-overlays.png"), optimize=True
    )
    tiles = menu_tiles_for_docs()
    sheet([t for _, t in tiles], 3, labels=[n for n, _ in tiles]).save(
        os.path.join(out, "oled-fixtures.png"), optimize=True
    )
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


def main(argv) -> int:
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
