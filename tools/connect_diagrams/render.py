"""Render the Splanc app's connect-flow pictograms from the product's mechanical design.

The fixture in every picture is the Splanc Mini, built here as a triangle mesh from
the enclosure's design parameters (hardware/mechanical/enclosure-spec.json plus the
frozen board reference, on the `splanc-mini` branch today), or from an STL export of
the real assembly when one is given. The laptop, phones, router and cable are simple
procedural props. A small numpy rasterizer draws everything as light line art on
black: depth / normal / part-id buffers at supersampled resolution, lines where those
buffers are discontinuous (silhouettes and creases), dark lambert-shaded fills, then a
box-filter downsample for antialiasing. Arrows, Bluetooth and Wi-Fi glyphs are 2D
overlays anchored on projected 3D points.

    bazel run //tools/connect_diagrams:render            # regenerate web/public/connect/*.png
    bazel run //tools/connect_diagrams:render -- --check # inputs load, outputs exist

Model precedence: --mesh <stl>, then --cad-dir (default <repo>/hardware/mechanical
when it exists), then the committed snapshot mini_mechanical.json. Refresh the
snapshot from the CAD branch with --refresh-snapshot [--git-ref origin/splanc-mini].
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SNAPSHOT = HERE / "mini_mechanical.json"
SPEC_PATH = "hardware/mechanical/enclosure-spec.json"
BOARD_PATH = "hardware/mechanical/assets/mini-board-reference.json"
# Board-reference components the pictograms need (USB-C, buttons, status lights).
KEEP_REFS = ("USB", "SW", "LED", "J")

SS = 3  # supersampling factor
BG = 0.0


def repo_root() -> Path:
    env = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    if env:
        return Path(env)
    for p in [HERE, *HERE.parents]:
        if (p / "MODULE.bazel").exists():
            return p
    return HERE.parents[1]


# -- mechanical inputs -------------------------------------------------------------


def _model_from_sources(spec: dict, board: dict) -> dict:
    """Reduce the CAD sources to the parameters the pictograms use."""
    hh = spec["handheld"]
    comps = [
        {"ref": c["ref"], "position": c["position"], "address": c.get("address", "")}
        for c in board.get("components", [])
        if c["ref"].startswith(KEEP_REFS)
    ]
    return {
        "revision": spec.get("revision", ""),
        "edge_chamfer": spec.get("edge_chamfer", 0.5),
        "usb_c": spec["usb_c"],
        "handheld": {
            k: hh[k]
            for k in (
                "wall",
                "floor",
                "roof",
                "corner_radius",
                "assembly_z_shift_mm",
                "button",
                "mini",
            )
            if k in hh
        },
        "board": {
            "outline": board["outline"],
            "mounts": board["mounts"],
            "frame": board.get("frame", ""),
            "components": comps,
        },
    }


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def refresh_snapshot(ref: str) -> None:
    root = repo_root()

    def show(path: str) -> bytes:
        return subprocess.run(
            ["git", "-C", str(root), "show", f"{ref}:{path}"], check=True, capture_output=True
        ).stdout

    commit = subprocess.run(
        ["git", "-C", str(root), "rev-parse", ref], check=True, capture_output=True, text=True
    ).stdout.strip()
    spec_b, board_b = show(SPEC_PATH), show(BOARD_PATH)
    model = _model_from_sources(json.loads(spec_b), json.loads(board_b))
    model["provenance"] = {
        "ref": ref,
        "commit": commit,
        "files": {SPEC_PATH: _sha(spec_b), BOARD_PATH: _sha(board_b)},
        "note": "Reduced snapshot of the Mini enclosure design parameters; regenerate with "
        "render.py --refresh-snapshot --git-ref <ref>.",
    }
    SNAPSHOT.write_text(json.dumps(model, indent=1, sort_keys=True) + "\n")
    print(f"snapshot <- {ref} @ {commit[:12]} ({model['revision']})")


def load_model(cad_dir: Path | None) -> tuple[dict, str]:
    if cad_dir is None:
        default = repo_root() / "hardware" / "mechanical"
        if (default / "enclosure-spec.json").exists():
            cad_dir = default
    if cad_dir is not None:
        spec_b = (cad_dir / "enclosure-spec.json").read_bytes()
        board_b = (cad_dir / "assets" / "mini-board-reference.json").read_bytes()
        model = _model_from_sources(json.loads(spec_b), json.loads(board_b))
        return model, f"{cad_dir} ({model['revision']})"
    model = json.loads(SNAPSHOT.read_text())
    prov = model.get("provenance", {})
    return model, f"snapshot {prov.get('ref')}@{str(prov.get('commit'))[:9]} ({model['revision']})"


def read_stl(path: Path) -> tuple[np.ndarray, np.ndarray]:
    data = path.read_bytes()
    if data[:5].lower() == b"solid" and b"facet" in data[:400]:
        pts = []
        for line in data.decode("ascii", "replace").splitlines():
            t = line.split()
            if t and t[0] == "vertex":
                pts.append([float(t[1]), float(t[2]), float(t[3])])
        v = np.array(pts, float)
    else:
        (n,) = struct.unpack_from("<I", data, 80)
        # Each 50-byte record: normal(3f) v0 v1 v2 (9f) attr(H) — not float aligned.
        rec = np.frombuffer(data[84 : 84 + 50 * n], dtype=np.uint8).reshape(n, 50)
        v = rec[:, 12:48].copy().view("<f4").reshape(n * 3, 3).astype(float)
    f = np.arange(len(v)).reshape(-1, 3)
    return v, f


# -- mesh building -----------------------------------------------------------------


@dataclass
class Part:
    v: np.ndarray
    f: np.ndarray
    fill: float = 0.18
    line: float = 0.85
    crease: bool = True
    tag: str = ""


@dataclass
class Scene:
    parts: list[Part] = field(default_factory=list)

    def add(self, v, f, **kw) -> Part:
        p = Part(np.asarray(v, float), np.asarray(f, int), **kw)
        self.parts.append(p)
        return p

    def extend(self, parts: list[Part]) -> None:
        self.parts.extend(parts)


def rot_z(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def xform(parts: list[Part], r: np.ndarray, t) -> list[Part]:
    for p in parts:
        p.v = p.v @ r.T + np.asarray(t, float)
    return parts


def rrect(x0, y0, x1, y1, r, seg=8) -> np.ndarray:
    """Counter-clockwise rounded rectangle outline."""
    r = max(0.0, min(r, (x1 - x0) / 2, (y1 - y0) / 2))
    if r < 1e-6:
        return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], float)
    pts = []
    for cx, cy, a0 in (
        (x1 - r, y0 + r, -90),
        (x1 - r, y1 - r, 0),
        (x0 + r, y1 - r, 90),
        (x0 + r, y0 + r, 180),
    ):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append([cx + r * math.cos(a), cy + r * math.sin(a)])
    return np.array(pts, float)


def stack(x0, y0, x1, y1, r, levels, seg=8) -> tuple[np.ndarray, np.ndarray]:
    """A prism through rounded-rect rings: levels = [(z, inset), ...] bottom to top."""
    rings = [rrect(x0 + i, y0 + i, x1 - i, y1 - i, max(0.0, r - i), seg) for _, i in levels]
    n = len(rings[0])
    v = []
    for (z, _), ring in zip(levels, rings):
        v.extend([[x, y, z] for x, y in ring])
    f = []
    for k in range(len(levels) - 1):
        a, b = k * n, (k + 1) * n
        for i in range(n):
            j = (i + 1) % n
            f += [[a + i, a + j, b + j], [a + i, b + j, b + i]]
    for k, ring in ((0, rings[0]), (len(levels) - 1, rings[-1])):
        c = len(v)
        v.append([*ring.mean(0), levels[k][0]])
        base = k * n
        for i in range(n):
            f.append([c, base + i, base + (i + 1) % n])
    return np.array(v), np.array(f)


def box(x0, y0, z0, x1, y1, z1, r=0.0, chamfer=0.0, seg=6):
    if chamfer > 0:
        lv = [(z0, chamfer), (z0 + chamfer, 0), (z1 - chamfer, 0), (z1, chamfer)]
    else:
        lv = [(z0, 0), (z1, 0)]
    return stack(x0, y0, x1, y1, r, lv, seg)


def cylinder(r, h, seg=20):
    return stack(-r, -r, r, r, r, [(0, 0), (h, 0)], seg=max(2, seg // 4))


def plate(origin, u, w, h, r=0.0, offset=0.08, seg=6):
    """A flat rounded-rect decal centred at `origin`, spanning unit vectors u (width)
    and the face normal n × u (height), pushed `offset` along the normal n."""
    origin, (uu, nn) = np.asarray(origin, float), (np.asarray(u[0], float), np.asarray(u[1], float))
    vv = np.cross(nn, uu)
    ring = rrect(-w / 2, -h / 2, w / 2, h / 2, r, seg)
    v = [origin + nn * offset + uu * x + vv * y for x, y in ring]
    c = len(v)
    v.append(origin + nn * offset)
    f = [[c, i, (i + 1) % c] for i in range(c)]
    return np.array(v), np.array(f)


def tube(points, radius, seg=10):
    pts = np.asarray(points, float)
    v, f = [], []
    n = len(pts)
    prev = None
    for i in range(n):
        t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        ref = np.array([0, 0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0, 0])
        a = np.cross(t, ref) if prev is None else prev - t * np.dot(prev, t)
        a /= np.linalg.norm(a)
        prev = a
        b = np.cross(t, a)
        for k in range(seg):
            th = 2 * math.pi * k / seg
            v.append(pts[i] + radius * (math.cos(th) * a + math.sin(th) * b))
    for i in range(n - 1):
        for k in range(seg):
            a0, a1 = i * seg + k, i * seg + (k + 1) % seg
            b0, b1 = a0 + seg, a1 + seg
            f += [[a0, a1, b1], [a0, b1, b0]]
    return np.array(v), np.array(f)


def bezier(p0, p1, p2, p3, n=40):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2, p3 = (np.asarray(p, float) for p in (p0, p1, p2, p3))
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


def oriented_box(center, axis, up, length, w, h, r=1.0):
    """A box of size w×h (cross-section) × length along `axis` (starting at center)."""
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    up = np.asarray(up, float)
    side = np.cross(axis, up)
    side /= np.linalg.norm(side)
    up = np.cross(side, axis)
    v, f = box(-w / 2, -h / 2, 0, w / 2, h / 2, length, r)
    m = np.stack([side, up, axis], axis=1)
    return v @ m.T + np.asarray(center, float), f


# -- the fixture -------------------------------------------------------------------


@dataclass
class Fixture:
    parts: list[Part]
    usb_mouth: np.ndarray  # world point at the centre of the USB-C cable well
    usb_normal: np.ndarray
    top_center: np.ndarray
    logo: tuple  # (center, u, v, width) on the lid, world frame


def build_mini(model: dict, stl: Path | None = None) -> Fixture:
    """The Splanc Mini in its board-reference frame (X right, Y to the rear, Z up, mm),
    re-based so the enclosure floor sits at z=0. Every dimension below comes from the
    enclosure spec / board reference; the formulas mirror build_clean_enclosures.py."""
    hh = model["handheld"]
    d = hh["mini"]
    bt = {**hh["button"], **d.get("button_overrides", {})}
    w, h = d["board"]
    top = d["top"]
    bottom = -hh.get("assembly_z_shift_mm", 0)
    side = d.get("side_margin", 3.2)
    back = d.get("rear_margin", 3.2)
    front = -3.2
    cr = hh.get("corner_radius", 3.0)
    ch = model.get("edge_chamfer", 0.5)
    usb = model["usb_c"]
    zoff = -bottom  # floor at z = 0
    x0, y0, x1, y1 = -side, front, w + side, h + back
    parts: list[Part] = []

    def P(vf, **kw):
        v, f = vf
        v = np.asarray(v, float).copy()
        v[:, 2] += zoff
        parts.append(Part(v, np.asarray(f), **kw))

    fn = (np.array([1.0, 0, 0]), np.array([0, -1.0, 0]))  # front face: u=+X, n=-Y
    up = (np.array([1.0, 0, 0]), np.array([0, 0, 1.0]))  # lid: u=+X, n=+Z
    usb_z = 9.13
    if stl is not None:
        v, f = read_stl(stl)
        parts.append(Part(v, f, fill=0.17, line=0.88, tag="mini_top"))
    else:
        # Shell: rounded box with chamfered top/bottom edges; the lid top is its own
        # part so the logo can be clipped to it.
        P(box(x0, y0, bottom, x1, y1, top - 0.02, cr, ch), fill=0.17, line=0.88, tag="mini")
        P(
            plate(
                ((x0 + x1) / 2, (y0 + y1) / 2, top),
                up,
                x1 - x0 - 2 * ch,
                y1 - y0 - 2 * ch,
                cr - ch,
                0.0,
            ),
            fill=0.15,
            line=0.88,
            tag="mini_top",
        )
        # Parting line: z = split around the shell, raised to raised_seam_z over the
        # button run on the front face (min(buttons)-5.5 .. max(buttons)+5.5).
        lo, hi = min(d["buttons"]) - 5.5, max(d["buttons"]) + 5.5
        seam = 0.25
        for (a, b), z in (
            ((x0 + cr, lo), d["split"]),
            ((lo, hi), bt["raised_seam_z"]),
            ((hi, x1 - cr), d["split"]),
        ):
            P(
                plate(((a + b) / 2, front, z), fn, b - a, seam, 0, 0.05),
                fill=0.05,
                line=0.55,
                crease=False,
            )
        for xx in (lo, hi):
            zc = (d["split"] + bt["raised_seam_z"]) / 2
            P(
                plate((xx, front, zc), fn, seam, bt["raised_seam_z"] - d["split"], 0, 0.05),
                fill=0.05,
                line=0.55,
                crease=False,
            )
        for xs, nrm, uu in (((x0,), (-1, 0, 0), (0, -1, 0)), ((x1,), (1, 0, 0), (0, 1, 0))):
            P(
                plate(
                    (xs[0], (y0 + y1) / 2, d["split"]),
                    (np.array(uu, float), np.array(nrm, float)),
                    y1 - y0 - 2 * cr,
                    seam,
                    0,
                    0.05,
                ),
                fill=0.05,
                line=0.55,
                crease=False,
            )
        P(
            plate(
                ((x0 + x1) / 2, y1, d["split"]),
                (np.array([-1.0, 0, 0]), np.array([0, 1.0, 0])),
                x1 - x0 - 2 * cr,
                seam,
                0,
                0.05,
            ),
            fill=0.05,
            line=0.55,
            crease=False,
        )
        # USB-C: the cable well (well_outer) clipped to the shell face, with the
        # connector throat (shell + radial clearance) inside it.
        wo, ho = usb["well_outer_mm"]
        ho = min(ho, (top - bottom) - 2 * ch - 0.6)
        zc = min(usb_z, top - ch - 0.3 - ho / 2)
        P(
            plate((d["usb_x"], front, zc), fn, wo, ho, usb["well_corner_radius_mm"], 0.06),
            fill=0.07,
            line=0.7,
            crease=False,
        )
        sw = usb["shell_width_mm"] + 2 * usb["radial_clearance_mm"]
        sh = usb["shell_height_mm"] + 2 * usb["radial_clearance_mm"]
        P(
            plate((d["usb_x"], front, usb_z), fn, sw, sh, sh / 2, 0.12),
            fill=0.0,
            line=0.8,
            crease=False,
        )
        # Buttons: caps proud of the face by depth - (rear_y - front), in their apertures.
        ap_w, ap_h = bt["aperture"]
        proud = bt["depth"] - (bt["rear_y"] - front)
        for x in d["buttons"]:
            P(
                plate((x, front, bt["center_z"]), fn, ap_w, ap_h, 0.6, 0.05),
                fill=0.02,
                line=0.6,
                crease=False,
            )
            cw, chh = bt["rear_width"] * 0.92, bt["rear_height"] * 0.92
            P(
                box(
                    x - cw / 2,
                    front - max(proud, 0.6),
                    bt["center_z"] - chh / 2,
                    x + cw / 2,
                    front + 0.2,
                    bt["center_z"] + chh / 2,
                    0.5,
                ),
                fill=0.55,
                line=0.95,
                tag="button",
            )
        # Status light pipes and corner screws on the lid.
        for x, y in d["lightpipes"]:
            v, f = cylinder(0.9, 0.15, 16)
            P((v + [x, y, top], f), fill=0.95, line=0.95, crease=False)
        for m in model["board"]["mounts"]:
            v, f = cylinder(2.25, 0.25, 20)
            P((v + [m["x"], m["y"], top - 0.1], f), fill=0.32, line=0.75, crease=False)
            P(
                plate((m["x"], m["y"], top + 0.15), up, 1.6, 1.6, 0.0, 0.05),
                fill=0.05,
                line=0.5,
                crease=False,
            )
        # LED output ports: top-entry openings in the lowered east bowl.
        for x, y in d["led_ports"]:
            P(plate((x, y, top), up, 8.8, 9.4, 1.2, 0.06), fill=0.03, line=0.7, crease=False)
            for k in (-1, 1):
                P(
                    plate((x + k * 2.0, y, top - 0.0), up, 2.4, 5.0, 0.4, 0.1),
                    fill=0.6,
                    line=0.8,
                    crease=False,
                )
        # QWIIC side opening (west face).
        q = d.get("qwiic")
        if q:
            ow, oh = q["opening_outer_mm"]
            P(
                plate(
                    (x0, q["mouth_mm"][1], q["mouth_mm"][2]),
                    (np.array([0, 1.0, 0]), np.array([-1.0, 0, 0])),
                    ow,
                    min(oh, top - bottom - 2),
                    1.0,
                    0.06,
                ),
                fill=0.05,
                line=0.65,
                crease=False,
            )
    logo_w = d.get("logo_width", 34)
    return Fixture(
        parts=parts,
        usb_mouth=np.array([d["usb_x"], front - 0.5, usb_z + zoff]),
        usb_normal=np.array([0, -1.0, 0]),
        top_center=np.array([(x0 + x1) / 2, (y0 + y1) / 2, top + zoff]),
        logo=(
            np.array([w / 2, h / 2 + 2, top + zoff]),
            np.array([1.0, 0, 0]),
            np.array([0, 1.0, 0]),
            logo_w,
        ),
    )


def place(fix: Fixture, r: np.ndarray, t) -> Fixture:
    """Move a fixture by r (rotation, optionally uniformly scaled) then t."""
    t = np.asarray(t, float)
    k = float(np.linalg.norm(r[:, 0]))
    xform(fix.parts, r, t)
    c, u, v, lw = fix.logo
    return Fixture(
        fix.parts,
        fix.usb_mouth @ r.T + t,
        fix.usb_normal @ r.T / k,
        fix.top_center @ r.T + t,
        (c @ r.T + t, u @ r.T / k, v @ r.T / k, lw * k),
    )


# -- props -------------------------------------------------------------------------


def laptop(open_deg=108.0) -> tuple[list[Part], np.ndarray, np.ndarray]:
    """A 13" laptop, front edge along -Y, hinge at the rear. Returns parts, the left
    USB-C port mouth and its outward normal."""
    W, D, T = 300.0, 212.0, 14.0
    parts = [Part(*box(-W / 2, -D / 2, 0, W / 2, D / 2, T, 9, 1.2), fill=0.42, line=0.97)]
    up = (np.array([1.0, 0, 0]), np.array([0, 0, 1.0]))
    # Keyboard well and keys.
    kx0, kx1, ky0, ky1 = -W / 2 + 22, W / 2 - 22, -D / 2 + 92, D / 2 - 16
    parts.append(
        Part(
            *plate((0, (ky0 + ky1) / 2, T), up, kx1 - kx0, ky1 - ky0, 4, 0.05),
            fill=0.2,
            line=0.6,
            crease=False,
        )
    )
    rows, cols = 6, 14
    gap = 3.0
    kw = (kx1 - kx0 - gap * (cols + 1)) / cols
    kh = (ky1 - ky0 - gap * (rows + 1)) / rows
    for rr in range(rows):
        y = ky1 - gap - rr * (kh + gap) - kh
        if rr == rows - 1:
            spans = [(0, 4), (4, 10), (10, 14)]
        else:
            spans = [(c, c + 1) for c in range(cols)]
        for a, b in spans:
            x = kx0 + gap + a * (kw + gap)
            xe = kx0 + gap + b * (kw + gap) - gap
            parts.append(Part(*box(x, y, T, xe, y + kh, T + 1.2, 1.2), fill=0.07, line=0.5))
    # Trackpad.
    parts.append(
        Part(*plate((0, -D / 2 + 46, T), up, 112, 68, 6, 0.06), fill=0.33, line=0.8, crease=False)
    )
    # Lid, hinged at the rear edge.
    LT = 6.0
    lid = [Part(*box(-W / 2, 0, 0, W / 2, D - 4, LT, 9, 1.0), fill=0.3, line=0.95)]
    face = (np.array([1.0, 0, 0]), np.array([0, 0, 1.0]))
    lid.append(
        Part(
            *plate((0, (D - 4) / 2 + 2, LT), face, W - 18, D - 26, 4, 0.06),
            fill=0.02,
            line=0.55,
            crease=False,
        )
    )
    # Closed over the base (screen down, spanning y in [-(D-4), 0]), then opened
    # about the rear hinge.
    xform(lid, rot_x(math.pi), (0, 0, LT))
    xform(lid, rot_x(-math.radians(open_deg)), (0, D / 2, T))
    parts += lid
    # Left-side USB-C port (towards the front).
    port_y = -D / 2 + 70
    side = (np.array([0, -1.0, 0]), np.array([-1.0, 0, 0]))
    parts.append(
        Part(
            *plate((-W / 2, port_y, T / 2), side, 9.2, 3.6, 1.6, 0.08),
            fill=0.0,
            line=0.95,
            crease=False,
        )
    )
    return parts, np.array([-W / 2 - 0.5, port_y, T / 2]), np.array([-1.0, 0, 0])


def phone(android=True) -> tuple[list[Part], np.ndarray, np.ndarray]:
    """A phone lying screen-up, top edge toward +Y. Returns parts, the bottom USB-C
    port mouth and its outward normal (-Y)."""
    W, H, T = 74.0, 158.0, 8.4
    parts = [Part(*box(-W / 2, -H / 2, 0, W / 2, H / 2, T, 10, 1.0), fill=0.24, line=0.95)]
    up = (np.array([1.0, 0, 0]), np.array([0, 0, 1.0]))
    parts.append(
        Part(
            *plate((0, 0, T), up, W - 6, H - 6, 8, 0.06),
            fill=0.02,
            line=0.6,
            crease=False,
            tag="screen",
        )
    )
    if android:
        v, f = cylinder(1.8, 0.1, 16)
        parts.append(Part(v + [0, H / 2 - 10, T + 0.06], f, fill=0.25, line=0.6, crease=False))
    fn = (np.array([1.0, 0, 0]), np.array([0, -1.0, 0]))
    parts.append(
        Part(*plate((0, -H / 2, T / 2), fn, 9.0, 3.4, 1.6, 0.08), fill=0.0, line=0.9, crease=False)
    )
    return parts, np.array([0, -H / 2 - 0.5, T / 2]), np.array([0, -1.0, 0])


def router() -> list[Part]:
    W, D, T = 170.0, 110.0, 30.0
    parts = [Part(*box(-W / 2, -D / 2, 0, W / 2, D / 2, T, 12, 2.0), fill=0.26, line=0.95)]
    fn = (np.array([1.0, 0, 0]), np.array([0, -1.0, 0]))
    for i in range(4):
        v, f = plate((-30 + i * 20, -D / 2, T / 2), fn, 4, 4, 2, 0.08)
        parts.append(Part(v, f, fill=0.9, line=0.9, crease=False))
    for sx in (-1, 1):
        v, f = box(-4, -2.5, 0, 4, 2.5, 120, 2.4)
        p = [Part(v, f, fill=0.3, line=0.95)]
        xform(p, rot_y(sx * math.radians(12)), (sx * (W / 2 - 22), D / 2 - 14, T - 4))
        parts += p
    return parts


def usb_cable(a, na, b, nb, sag=-60.0, ground=0.0) -> list[Part]:
    """A USB-C cable from port mouth a (outward normal na) to port mouth b."""
    parts = []
    ends = []
    for p, n in ((a, na), (b, nb)):
        n = np.asarray(n, float)
        upv = np.array([0, 0, 1.0]) if abs(n[2]) < 0.9 else np.array([0, 1.0, 0])
        # Plug shell into the port, then the overmold (cable_overmold 16 × 8 mm).
        v, f = oriented_box(p - n * 3, n, upv, 4.5, 8.3, 2.6, 1.2)
        parts.append(Part(v, f, fill=0.55, line=0.85, crease=False))
        v, f = oriented_box(p + n * 1.2, n, upv, 22, 12, 6.5, 2.8)
        parts.append(Part(v, f, fill=0.28, line=0.9, crease=False))
        ends.append((p + n * 23, n))
    (pa, na_), (pb, nb_) = ends
    span = np.linalg.norm(pb - pa)
    c1 = pa + na_ * span * 0.35
    c2 = pb + nb_ * span * 0.35
    c1[2] = c2[2] = ground + sag
    pts = bezier(pa, c1, c2, pb, 48)
    pts[:, 2] = np.maximum(pts[:, 2], ground + 2.0)
    v, f = tube(pts, 2.0, 10)
    parts.append(Part(v, f, fill=0.3, line=0.85, crease=False))
    return parts


# -- camera + rasterizer -----------------------------------------------------------


class Camera:
    def __init__(self, eye, target, size, fov_deg=28.0, margin=0.08):
        self.eye = np.asarray(eye, float)
        fwd = np.asarray(target, float) - self.eye
        fwd /= np.linalg.norm(fwd)
        right = np.cross(fwd, [0, 0, 1.0])
        right /= np.linalg.norm(right)
        upv = np.cross(right, fwd)
        self.m = np.stack([right, upv, fwd])
        self.W, self.H = size
        self.f = 1.0
        self.cx = self.cy = 0.0
        self.margin = margin

    def view(self, p):
        return (np.asarray(p, float) - self.eye) @ self.m.T

    def fit(self, pts):
        v = self.view(pts)
        x, y = v[:, 0] / v[:, 2], v[:, 1] / v[:, 2]
        bw, bh = x.max() - x.min(), y.max() - y.min()
        W, H = self.W * (1 - 2 * self.margin), self.H * (1 - 2 * self.margin)
        self.f = min(W / bw, H / bh)
        self.cx = self.W / 2 - self.f * (x.max() + x.min()) / 2
        self.cy = self.H / 2 + self.f * (y.max() + y.min()) / 2

    def project(self, p):
        v = self.view(np.atleast_2d(p))
        return (
            np.stack(
                [self.cx + self.f * v[:, 0] / v[:, 2], self.cy - self.f * v[:, 1] / v[:, 2]], 1
            ),
            v[:, 2],
        )

    def px(self, p, s=1.0):
        q, _ = self.project(p)
        return (float(q[0, 0]) * s, float(q[0, 1]) * s)


def render(scene: Scene, cam: Camera, ss=SS):
    W, H = cam.W * ss, cam.H * ss
    zbuf = np.zeros((H, W))
    fbuf = np.full((H, W), -1, np.int64)
    allv, allf, fpart = [], [], []
    off = 0
    for pi, p in enumerate(scene.parts):
        allv.append(p.v)
        allf.append(p.f + off)
        fpart.append(np.full(len(p.f), pi))
        off += len(p.v)
    V = np.concatenate(allv)
    F = np.concatenate(allf)
    FP = np.concatenate(fpart)
    q, z = cam.project(V)
    q = q * ss
    iz = 1.0 / z
    for fi in range(len(F)):
        a, b, c = F[fi]
        xs = q[[a, b, c], 0]
        ys = q[[a, b, c], 1]
        x0, x1 = max(int(math.floor(xs.min())), 0), min(int(math.ceil(xs.max())), W - 1)
        y0, y1 = max(int(math.floor(ys.min())), 0), min(int(math.ceil(ys.max())), H - 1)
        if x1 < x0 or y1 < y0:
            continue
        area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
        if abs(area) < 1e-9:
            continue
        X, Y = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        l1 = ((X - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (Y - ys[0])) / area
        l2 = ((xs[1] - xs[0]) * (Y - ys[0]) - (X - xs[0]) * (ys[1] - ys[0])) / area
        l0 = 1 - l1 - l2
        m = (l0 >= -1e-9) & (l1 >= -1e-9) & (l2 >= -1e-9)
        if not m.any():
            continue
        zz = l0 * iz[a] + l1 * iz[b] + l2 * iz[c]
        sub = zbuf[y0 : y1 + 1, x0 : x1 + 1]
        fsub = fbuf[y0 : y1 + 1, x0 : x1 + 1]
        u = m & (zz > sub)
        sub[u] = zz[u]
        fsub[u] = fi
    # Face normals, flipped toward the camera.
    e1 = V[F[:, 1]] - V[F[:, 0]]
    e2 = V[F[:, 2]] - V[F[:, 0]]
    n = np.cross(e1, e2)
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    cen = V[F].mean(1)
    tocam = cam.eye - cen
    flip = np.einsum("ij,ij->i", n, tocam) < 0
    n[flip] *= -1
    light = np.array([-0.35, -0.55, 0.76])
    light /= np.linalg.norm(light)
    fill = np.array([p.fill for p in scene.parts])[FP]
    lam = np.clip(n @ light, 0, 1)
    shade = fill * (0.5 + 0.65 * lam)
    fg = fbuf >= 0
    fsafe = np.where(fg, fbuf, 0)
    img = np.where(fg, shade[fsafe], BG)
    pid = np.where(fg, FP[fsafe], -1)
    N = n[fsafe]
    D = np.where(fg, 1.0 / np.maximum(zbuf, 1e-12), 1e9)
    crease = np.array([p.crease for p in scene.parts])
    linecol = np.array([p.line for p in scene.parts])
    cos_t = math.cos(math.radians(32))
    line = np.zeros((H, W))

    def mark(sa, sb):
        """Compare neighbours a (sa) and b (sb); mark the nearer pixel of each edge."""
        pa, pb = pid[sa], pid[sb]
        dot = np.einsum("ijk,ijk->ij", N[sa], N[sb])
        same = pa == pb
        cr = same & (pa >= 0) & crease[np.maximum(pa, 0)] & (dot < cos_t)
        dj = same & (pa >= 0) & (np.abs(D[sa] - D[sb]) > 0.03 * np.minimum(D[sa], D[sb]))
        e = (~same) | cr | dj
        nearer_a = D[sa] <= D[sb]
        ca = np.where(pa >= 0, linecol[np.maximum(pa, 0)], 0)
        cb = np.where(pb >= 0, linecol[np.maximum(pb, 0)], 0)
        la = line[sa]
        lb = line[sb]
        np.maximum(la, np.where(e & nearer_a, ca, 0), out=la)
        np.maximum(lb, np.where(e & ~nearer_a, cb, 0), out=lb)
        line[sa] = la
        line[sb] = lb

    mark((slice(None), slice(0, -1)), (slice(None), slice(1, None)))
    mark((slice(0, -1), slice(None)), (slice(1, None), slice(None)))
    # Thicken to ~1.3 px at the output resolution.
    rad = max(1, int(round(ss * 0.45)))
    thick = line.copy()
    for dy in range(-rad, rad + 1):
        for dx in range(-rad, rad + 1):
            if dx * dx + dy * dy > rad * rad + 0.5:
                continue
            thick = np.maximum(thick, np.roll(np.roll(line, dy, 0), dx, 1))
    out = np.maximum(img, thick)
    return out, pid, scene


def downsample(a: np.ndarray, ss=SS) -> np.ndarray:
    H, W = a.shape[0] // ss, a.shape[1] // ss
    return a[: H * ss, : W * ss].reshape(H, ss, W, ss).mean((1, 3))


# -- overlays (drawn on the supersampled canvas) -----------------------------------

WHITE = 235


def font(px: float) -> ImageFont.FreeTypeFont:
    return ImageFont.load_default(size=max(6, int(px)))


def paint_quad(
    canvas: Image.Image,
    pid,
    scene: Scene,
    cam: Camera,
    corners,
    img: Image.Image,
    tag: str,
    level=215,
    ss=SS,
):
    """Perspective-map a 2D image onto a 3D quad (corners TL, TR, BR, BL), lightening
    the canvas only where the visible surface is a part tagged `tag`."""
    dst = [cam.px(p, ss) for p in corners]
    w, h = img.size
    coeffs = _perspective_coeffs(dst, [(0, 0), (w, 0), (w, h), (0, h)])
    warped = (
        np.asarray(img.transform(canvas.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)) / 255.0
    )
    mask = np.isin(pid, [i for i, p in enumerate(scene.parts) if p.tag == tag])
    a = np.asarray(canvas, float)
    a = np.where(mask, np.maximum(a, warped * level), a)
    canvas.paste(Image.fromarray(a.astype(np.uint8)))


def logo_decal(
    canvas: Image.Image, pid: np.ndarray, scene: Scene, cam: Camera, fix: Fixture, ss=SS
):
    """'Splanc' wordmark on the lid, perspective-mapped and clipped to the lid top."""
    c, u, v, lw = fix.logo
    th = lw * 0.28
    tw, thp = 600, int(600 * th / lw)
    txt = Image.new("L", (tw, thp), 0)
    d = ImageDraw.Draw(txt)
    f = font(thp * 0.9)
    bb = d.textbbox((0, 0), "Splanc", font=f)
    d.text(
        ((tw - (bb[2] - bb[0])) / 2 - bb[0], (thp - (bb[3] - bb[1])) / 2 - bb[1]),
        "Splanc",
        font=f,
        fill=255,
    )
    corners = [
        c - u * lw / 2 + v * th / 2,
        c + u * lw / 2 + v * th / 2,
        c + u * lw / 2 - v * th / 2,
        c - u * lw / 2 - v * th / 2,
    ]
    paint_quad(canvas, pid, scene, cam, corners, txt, "mini_top", 215, ss)


def screen_ui(kind: str, w=340, h=740) -> Image.Image:
    """A schematic phone-screen UI for the pictograms (white on black)."""
    im = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(im)
    lw = 7
    if kind == "wifi":
        wifi_glyph(d, (w / 2, h * 0.3), w * 0.26, lw / 1.8)
        for y in (0.45, 0.56):
            d.rounded_rectangle(
                [w * 0.14, h * y, w * 0.86, h * y + h * 0.065], 14, outline=200, width=lw - 2
            )
        d.rounded_rectangle([w * 0.14, h * 0.72, w * 0.86, h * 0.72 + h * 0.07], 18, fill=210)
    elif kind == "sliders":
        d.ellipse([w * 0.3, h * 0.12, w * 0.7, h * 0.12 + w * 0.4], outline=210, width=lw)
        for i, k in enumerate((0.35, 0.7, 0.5)):
            y = h * (0.5 + i * 0.12)
            d.line([(w * 0.14, y), (w * 0.86, y)], fill=150, width=lw - 2)
            x = w * (0.14 + 0.72 * k)
            d.ellipse([x - 20, y - 20, x + 20, y + 20], fill=220)
    elif kind == "list":
        for i in range(4):
            y = h * (0.16 + i * 0.13)
            d.ellipse([w * 0.14, y, w * 0.14 + 34, y + 34], fill=200 if i == 0 else 120)
            d.rounded_rectangle(
                [w * 0.3, y + 6, w * (0.86 if i else 0.75), y + 28], 10, fill=200 if i == 0 else 110
            )
    return im


def phone_screen_corners(r, pos, W=74.0, H=158.0, T=8.4):
    pos = np.asarray(pos, float)
    sw, sh = W - 6, H - 6
    loc = [(-sw / 2, sh / 2), (sw / 2, sh / 2), (sw / 2, -sh / 2), (-sw / 2, -sh / 2)]
    return [np.array([x, y, T + 0.06]) @ r.T + pos for x, y in loc]


def _perspective_coeffs(dst, src):
    """Coefficients mapping output (dst) pixels to input (src) pixels for PIL."""
    m = []
    for (x, y), (X, Y) in zip(dst, src):
        m.append([x, y, 1, 0, 0, 0, -X * x, -X * y])
        m.append([0, 0, 0, x, y, 1, -Y * x, -Y * y])
    b = np.array(src, float).reshape(8)
    return np.linalg.solve(np.array(m, float), b).tolist()


def dashed(d: ImageDraw.ImageDraw, a, b, width, dash, gap, fill=WHITE):
    a, b = np.asarray(a, float), np.asarray(b, float)
    L = np.linalg.norm(b - a)
    u = (b - a) / L
    t = 0.0
    while t < L:
        e = min(t + dash, L)
        d.line([tuple(a + u * t), tuple(a + u * e)], fill=fill, width=width)
        t = e + gap


def arrowhead(d, tip, direction, size, fill=WHITE):
    u = np.asarray(direction, float)
    u /= np.linalg.norm(u)
    nrm = np.array([-u[1], u[0]])
    tip = np.asarray(tip, float)
    pts = [
        tip,
        tip - u * size + nrm * size * 0.55,
        tip - u * size * 0.7,
        tip - u * size - nrm * size * 0.55,
    ]
    d.polygon([tuple(p) for p in pts], fill=fill)


def link(d, a, b, s, both=False, inset=0.0):
    """A dashed link between two screen points with arrowheads."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    u = (b - a) / np.linalg.norm(b - a)
    a2, b2 = a + u * inset, b - u * inset
    dashed(d, a2 + (u * 6 * s if both else 0), b2 - u * 6 * s, max(1, int(1.6 * s)), 5 * s, 4 * s)
    arrowhead(d, b2, u, 9 * s)
    if both:
        arrowhead(d, a2, -u, 9 * s)


def ble_badge(d, c, r, s):
    """A circled Bluetooth rune."""
    cx, cy = c
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=0, outline=WHITE, width=max(1, int(1.6 * s)))
    k = r * 0.52
    pts = [(-0.5, -0.5), (0.5, 0.5), (0, 1), (0, -1), (0.5, -0.5), (-0.5, 0.5)]
    d.line(
        [(cx + x * k, cy - y * k * 1.0) for x, y in pts],
        fill=WHITE,
        width=max(1, int(1.8 * s)),
        joint="curve",
    )


def wifi_glyph(d, c, r, s, arcs=3, fill=WHITE):
    cx, cy = c
    w = max(1, int(1.8 * s))
    for i in range(1, arcs + 1):
        rr = r * i / arcs
        d.arc([cx - rr, cy - rr, cx + rr, cy + rr], 225, 315, fill=fill, width=w)
    dot = r * 0.12
    d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=fill)


def label(d, c, text, px, s, fill=WHITE):
    f = font(px * s)
    bb = d.textbbox((0, 0), text, font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    x, y = c[0] - w / 2 - bb[0], c[1] - h / 2 - bb[1]
    pad = 4 * s
    d.rounded_rectangle(
        [x + bb[0] - pad, y + bb[1] - pad, x + bb[2] + pad, y + bb[3] + pad],
        radius=4 * s,
        fill=0,
        outline=150,
        width=max(1, int(s)),
    )
    d.text((x, y), text, font=f, fill=fill)


# -- scenes ------------------------------------------------------------------------


def compose(scene: Scene, cam: Camera, fixtures: list[Fixture], overlay, screens=()) -> Image.Image:
    a, pid, _ = render(scene, cam)
    canvas = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8), "L")
    for fx in fixtures:
        logo_decal(canvas, pid, scene, cam, fx)
    for corners, kind in screens:
        paint_quad(canvas, pid, scene, cam, corners, screen_ui(kind), "screen", 200)
    d = ImageDraw.Draw(canvas)
    if overlay:
        overlay(d, cam, SS)
    out = downsample(np.asarray(canvas, float))
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "L")


def all_points(scene: Scene) -> np.ndarray:
    return np.concatenate([p.v for p in scene.parts])


def mini_at(model, stl, angle_deg, pos, scale=1.0) -> Fixture:
    fx = build_mini(model, stl)
    r = rot_z(math.radians(angle_deg)) * scale
    return place(fx, r, pos)


def held_phone(angle_deg, pos, tilt_deg=38.0):
    """A phone tipped up toward the viewer; returns parts and its screen centre."""
    parts, _, _ = phone()
    r = rot_z(math.radians(angle_deg)) @ rot_x(math.radians(tilt_deg))
    xform(parts, r, pos)
    return parts, phone_screen_corners(r, pos)


def sbox(cam: Camera, parts: list[Part], s: float, pad: float = 10.0) -> np.ndarray:
    """Screen bounding box (x0, y0, x1, y1) of some parts, padded, in canvas px."""
    q, _ = cam.project(np.concatenate([p.v for p in parts]))
    q = q * s
    return np.array(
        [
            q[:, 0].min() - pad * s,
            q[:, 1].min() - pad * s,
            q[:, 0].max() + pad * s,
            q[:, 1].max() + pad * s,
        ]
    )


def _exit(c, u, bx):
    """Distance along unit u from c (inside box bx) to the box boundary."""
    ts = []
    for k, (lo, hi) in enumerate(((bx[0], bx[2]), (bx[1], bx[3]))):
        if abs(u[k]) > 1e-9:
            ts.append(max((lo - c[k]) / u[k], (hi - c[k]) / u[k]))
    return min(ts)


def between(ba, bb):
    """The link between two screen boxes: from box centre to box centre, clipped to
    both boxes so it spans only the gap between the objects."""
    ca = np.array([(ba[0] + ba[2]) / 2, (ba[1] + ba[3]) / 2])
    cb = np.array([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2])
    u = (cb - ca) / np.linalg.norm(cb - ca)
    return ca + u * _exit(ca, u, ba), cb - u * _exit(cb, -u, bb)


def scene_setup_ble(model, stl, size):
    sc = Scene()
    ph, ph_c = held_phone(12, (-230, -20, 0), 24)
    sc.extend(ph)
    fx = mini_at(model, stl, -10, (-40, -80, 0), 1.9)
    sc.extend(fx.parts)
    rt = router()
    xform(rt, rot_z(math.radians(-10)), (250, 140, 0))
    sc.extend(rt)
    cam = Camera((-40, -640, 440), (20, 20, 30), size, margin=0.06)
    cam.fit(all_points(sc))

    def ov(d, cam, s):
        bp, bm, br = sbox(cam, ph, s), sbox(cam, fx.parts, s), sbox(cam, rt, s, 4)
        a, b = between(bp, bm)
        link(d, a, b, s)
        ble_badge(d, (a + b) / 2 + [0, -22 * s], 15 * s, s)
        a, b = between(bm, br)
        link(d, a, b, s)
        wifi_glyph(d, (a + b) / 2 + [-14 * s, -12 * s], 18 * s, s)
        wifi_glyph(d, np.array(cam.px([250, 140, 150], s)), 28 * s, s)

    return compose(sc, cam, [fx], ov, [(ph_c, "wifi")])


def scene_direct_ble(model, stl, size):
    sc = Scene()
    ph, ph_c = held_phone(10, (-95, 10, 0), 24)
    sc.extend(ph)
    fx = mini_at(model, stl, -12, (35, -60, 0), 2.0)
    sc.extend(fx.parts)
    cam = Camera((-40, -600, 420), (0, 0, 30), size, margin=0.1)
    cam.fit(all_points(sc))

    def ov(d, cam, s):
        a, b = between(sbox(cam, ph, s, 14), sbox(cam, fx.parts, s, 14))
        link(d, a, b, s, both=True)
        ble_badge(d, (a + b) / 2 + [0, -24 * s], 17 * s, s)

    return compose(sc, cam, [fx], ov, [(ph_c, "sliders")])


def scene_address(model, stl, size):
    sc = Scene()
    rt = router()
    xform(rt, rot_z(math.radians(-6)), (10, 170, 0))
    sc.extend(rt)
    ph, ph_c = held_phone(14, (-210, -40, 0), 24)
    sc.extend(ph)
    fx = mini_at(model, stl, -12, (110, -90, 0), 1.9)
    sc.extend(fx.parts)
    cam = Camera((-40, -640, 460), (10, 30, 30), size, margin=0.07)
    cam.fit(all_points(sc))

    def ov(d, cam, s):
        br = sbox(cam, rt, s, 6)
        w = max(1, int(1.6 * s))
        for other in (ph, fx.parts):
            a, b = between(br, sbox(cam, other, s, 8))
            dashed(d, a, b, w, 4 * s, 4 * s)
        wifi_glyph(d, np.array(cam.px([10, 170, 160], s)), 28 * s, s)
        bm = sbox(cam, fx.parts, s, 0)
        label(d, ((bm[0] + bm[2]) / 2, bm[3] + 18 * s), "192.168.1.40", 13, s)

    return compose(sc, cam, [fx], ov, [(ph_c, "list")])


def scene_flash_laptop(model, stl, size):
    sc = Scene()
    lp, port, pn = laptop()
    sc.extend(lp)
    fx = mini_at(model, stl, 35, (-330, -170, 0), 1.45)
    sc.extend(fx.parts)
    sc.extend(usb_cable(port, pn, fx.usb_mouth, fx.usb_normal, sag=-40))
    cam = Camera((-520, -620, 420), (-90, 0, 40), size, margin=0.07)
    cam.fit(all_points(sc))

    def ov(d, cam, s):
        tip = np.array(cam.px(port + pn * 6, s))
        tail = np.array(cam.px(port + pn * 34, s))
        u = tip - tail
        dashed(d, tail, tip - u / np.linalg.norm(u) * 6 * s, max(1, int(2 * s)), 30 * s, 4 * s)
        arrowhead(d, tip, u, 10 * s)

    return compose(sc, cam, [fx], ov)


def scene_flash_phone(model, stl, size):
    sc = Scene()
    ph, port, pn = phone(android=True)
    r = rot_z(math.radians(-40))
    xform(ph, r, (40, 60, 0))
    port = port @ r.T + [40, 60, 0]
    pn = pn @ r.T
    sc.extend(ph)
    fx = mini_at(model, stl, 30, (-110, -110, 0), 1.0)
    sc.extend(fx.parts)
    sc.extend(usb_cable(port, pn, fx.usb_mouth, fx.usb_normal, sag=-30))
    cam = Camera((-260, -420, 420), (0, -20, 0), size, margin=0.1)
    cam.fit(all_points(sc))

    return compose(sc, cam, [fx], None)


def scene_flash(model, stl, size):
    W, H = size
    lw = int(W * 0.64)
    left = scene_flash_laptop(model, stl, (lw, H))
    right = scene_flash_phone(model, stl, (W - lw, H))
    out = Image.new("L", size, 0)
    out.paste(left, (0, 0))
    out.paste(right, (lw, 0))
    d = ImageDraw.Draw(out)
    x = lw
    d.line([(x, H * 0.18), (x, H * 0.42)], fill=90, width=1)
    d.line([(x, H * 0.58), (x, H * 0.82)], fill=90, width=1)
    f = font(22)
    bb = d.textbbox((0, 0), "or", font=f)
    d.text(
        (x - (bb[2] - bb[0]) / 2 - bb[0], H / 2 - (bb[3] - bb[1]) / 2 - bb[1]),
        "or",
        font=f,
        fill=200,
    )
    return out


SCENES = {
    "setup-ble.png": (scene_setup_ble, (640, 400)),
    "direct-ble.png": (scene_direct_ble, (640, 400)),
    "address.png": (scene_address, (640, 400)),
    "flash-usb.png": (scene_flash, (960, 600)),
}


def save(img: Image.Image, path: Path) -> None:
    q = img.convert("L").quantize(
        colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    q.save(path, optimize=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--mesh", type=Path, help="STL export of the Mini assembly (mm, +Z up, USB-C on -Y)"
    )
    ap.add_argument(
        "--cad-dir",
        type=Path,
        help="dir with enclosure-spec.json + assets/mini-board-reference.json",
    )
    ap.add_argument("--out-dir", type=Path, help="default: <repo>/web/public/connect")
    ap.add_argument("--only", nargs="*", help="render just these outputs (e.g. setup-ble.png)")
    ap.add_argument(
        "--check", action="store_true", help="verify the inputs load and the outputs exist"
    )
    ap.add_argument(
        "--refresh-snapshot", action="store_true", help="rebuild mini_mechanical.json from git"
    )
    ap.add_argument("--git-ref", default="origin/splanc-mini")
    args = ap.parse_args(argv)
    if args.refresh_snapshot:
        refresh_snapshot(args.git_ref)
        return 0
    model, source = load_model(args.cad_dir)
    out = args.out_dir or (repo_root() / "web" / "public" / "connect")
    build_mini(model, args.mesh)  # validates the inputs
    print(f"mini model: {source}" + (f", mesh {args.mesh}" if args.mesh else ""))
    if args.check:
        missing = [n for n in SCENES if not (out / n).exists()]
        if missing:
            print(f"missing outputs in {out}: {', '.join(missing)}", file=sys.stderr)
            return 1
        print(f"ok: {len(SCENES)} outputs present in {out}")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for name, (fn, size) in SCENES.items():
        if args.only and name not in args.only:
            continue
        img = fn(model, args.mesh, size)
        save(img, out / name)
        print(f"wrote {out / name} ({(out / name).stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
