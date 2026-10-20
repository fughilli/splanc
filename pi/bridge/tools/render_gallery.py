"""Render every bridge state for HDMI and the OLED HAT to PNGs, for review.

    bazel run //pi/bridge:render_gallery -- /path/to/out
    bazel run //pi/bridge:render_gallery -- --docs "$PWD/docs/img/pi-bridge"
    (or) PYTHONPATH=pi/bridge/display python3 pi/bridge/tools/render_gallery.py out/

Writes hdmi-<state>.png (1920x1080), hdmi-<state>-720x480.png for the pairing
state, oled-<state>-<page>.png (4x, blue-on-black like the real panel), the
overlay screens, and contact sheets (hdmi-sheet.png, oled-sheet.png).
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw
from splanc_display import fake_bridge, render_hdmi, render_oled
from splanc_display.status import WAITING, Status, parse
from splanc_display.ui import PAGES, View

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
    print(f"wrote doc images to {out}")
    return 0


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
    sheet(hdmi, 3, labels=hdmi_labels).save(os.path.join(out, "hdmi-sheet.png"))
    sheet(oled, 4, labels=oled_labels).save(os.path.join(out, "oled-sheet.png"))
    print(f"wrote {len(os.listdir(out))} PNGs to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
