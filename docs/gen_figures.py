"""Generate the figures and animations embedded in the splanc developer docs.

Everything here is rendered from the *real* pipeline code — `shared/simulator`
for the ground-truth fixtures and camera walk, `pi/reconstruction` for the solve,
the cross-language stride golden for the strided-capture schedule — so the
visuals in the docs can never drift from the behavior they illustrate.

Invoked by `docs/build_docs.py` (the `//docs:build` target), which passes the
staging `_generated/` directory as the output path. Also runnable standalone:

    bazel run //docs:gen_figures -- /tmp/figs
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: no display, deterministic raster output

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.animation import PillowWriter  # noqa: E402
from reconstruction.api import reconstruct  # noqa: E402
from simulator import fixtures, walk  # noqa: E402
from simulator.degrade import NoiseModel  # noqa: E402
from simulator.detection_log import generate_log  # noqa: E402

# A calm, colorblind-friendly palette that also reads on furo's dark theme.
_ACCENT = "#084de7"
_TRUTH = "#8a8f98"
plt.rcParams.update(
    {
        "figure.facecolor": "white",
        "savefig.facecolor": "white",
        "font.size": 10,
        "axes.titlesize": 11,
    }
)


def _style_3d(ax, pts: np.ndarray) -> None:
    """Equal aspect + a tight, centered cube around ``pts``."""
    ax.set_box_aspect((1, 1, 1))
    center = pts.mean(axis=0)
    radius = float(np.abs(pts - center).max()) * 1.1 + 1e-6
    for setter, c in zip((ax.set_xlim, ax.set_ylim, ax.set_zlim), center):
        setter(c - radius, c + radius)
    ax.set_xticklabels([])
    ax.set_yticklabels([])
    ax.set_zticklabels([])
    ax.grid(True, alpha=0.25)


def fixtures_gallery(out: Path) -> Path:
    """A 2x2 gallery of the four built-in ground-truth fixtures."""
    specs = [("line", 48), ("grid", 64), ("cube", 64), ("helix", 96)]
    fig = plt.figure(figsize=(9, 8))
    for i, (name, n) in enumerate(specs, start=1):
        pts = fixtures.make_fixture(name, n)
        ax = fig.add_subplot(2, 2, i, projection="3d")
        ax.scatter(pts[:, 0], pts[:, 1], pts[:, 2], c=np.arange(len(pts)), cmap="viridis", s=18)
        ax.set_title(f"{name}  ({len(pts)} LEDs)")
        _style_3d(ax, pts)
        ax.view_init(elev=22, azim=-60)
    fig.suptitle("Built-in fixtures — the shapes reconstruction must recover", y=0.98)
    path = out / "fixtures.png"
    fig.savefig(path, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return path


def camera_walk_animation(out: Path) -> Path:
    """A rotating view of a helix fixture with the camera stations revealed."""
    pts = fixtures.make_fixture("helix", 96)
    poses = walk.arc_walk(pts, views=48, arc_degrees=150.0)
    eyes = np.array([p for p, _ in poses])

    fig = plt.figure(figsize=(7, 6))
    ax = fig.add_subplot(111, projection="3d")
    allpts = np.vstack([pts, eyes])

    frames = 60

    def draw(frame: int) -> None:
        ax.clear()
        _style_3d(ax, allpts)
        ax.scatter(pts[:, 0], pts[:, 1], pts[:, 2], c=_ACCENT, s=14, label="LEDs")
        shown = 1 + int((frame / (frames - 1)) * (len(eyes) - 1))
        e = eyes[:shown]
        ax.plot(e[:, 0], e[:, 1], e[:, 2], color="#f08c00", lw=1.2, alpha=0.7)
        ax.scatter(e[:, 0], e[:, 1], e[:, 2], c="#f08c00", s=26, label="camera stations")
        # Sight lines from the newest station to the fixture centroid.
        c = pts.mean(axis=0)
        ax.plot(
            [e[-1, 0], c[0]],
            [e[-1, 1], c[1]],
            [e[-1, 2], c[2]],
            color="#f08c00",
            lw=0.8,
            alpha=0.5,
            ls=":",
        )
        ax.view_init(elev=20, azim=-60 + frame * (360.0 / frames))
        ax.set_title("Synthetic capture: a phone walking an arc")
        ax.legend(loc="upper right", fontsize=8, framealpha=0.6)

    writer = PillowWriter(fps=12)
    path = out / "camera_walk.gif"
    with writer.saving(fig, str(path), dpi=90):
        for f in range(frames):
            draw(f)
            writer.grab_frame()
    plt.close(fig)
    return path


def reconstruction_accuracy(out: Path) -> Path:
    """Ground truth vs the reconstructed positions, colored by per-LED error."""
    n = 96
    noise = NoiseModel(pixel_noise_px=0.5, pose_noise_deg=0.15, pose_noise_pos_m=0.004)
    log, truth = generate_log("helix", n, noise=noise, views=60, arc_degrees=150.0, seed=7)
    out_map = reconstruct(log["detections"], led_count=n)

    ids = np.array([e.id for e in out_map.leds])
    est = np.array([e.xyz for e in out_map.leds])
    gt = truth[ids]
    err_mm = np.linalg.norm(est - gt, axis=1) * 1000.0

    fig = plt.figure(figsize=(11, 5))

    ax = fig.add_subplot(1, 2, 1, projection="3d")
    ax.scatter(
        truth[:, 0],
        truth[:, 1],
        truth[:, 2],
        facecolors="none",
        edgecolors=_TRUTH,
        s=40,
        label="ground truth",
    )
    sc = ax.scatter(est[:, 0], est[:, 1], est[:, 2], c=err_mm, cmap="plasma", s=22)
    for a, b in zip(gt, est):  # error whiskers
        ax.plot([a[0], b[0]], [a[1], b[1]], [a[2], b[2]], color="#c92a2a", lw=0.5, alpha=0.6)
    _style_3d(ax, np.vstack([truth, est]))
    ax.view_init(elev=20, azim=-60)
    ax.set_title("Recovered helix vs ground truth")
    ax.legend(loc="upper left", fontsize=8)
    cb = fig.colorbar(sc, ax=ax, shrink=0.6, pad=0.02)
    cb.set_label("per-LED error (mm)")

    ax2 = fig.add_subplot(1, 2, 2)
    ax2.hist(err_mm, bins=24, color=_ACCENT, alpha=0.85)
    ax2.axvline(
        np.median(err_mm),
        color="#c92a2a",
        ls="--",
        lw=1.2,
        label=f"median {np.median(err_mm):.1f} mm",
    )
    ax2.set_xlabel("per-LED position error (mm)")
    ax2.set_ylabel("LED count")
    ax2.set_title(f"{len(ids)}/{n} LEDs solved · RMS {np.sqrt((err_mm**2).mean()):.1f} mm")
    ax2.legend(fontsize=8)
    ax2.spines[["top", "right"]].set_visible(False)

    fig.suptitle("Reconstruction accuracy on synthetic ground truth", y=1.0)
    path = out / "reconstruction.png"
    fig.savefig(path, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return path


def _golden_stride_path() -> Path:
    """`web/tests/golden_stride.json`: the cross-language stride schedule.

    It is a `data` dep of the docs binaries, so it sits next to this file in the
    runfiles tree; `bazel run` also exposes the working tree."""
    rel = Path("web") / "tests" / "golden_stride.json"
    here = Path(os.path.abspath(__file__)).parent.parent
    candidates = [here / rel]
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    if ws:
        candidates.append(Path(ws) / rel)
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError(f"golden_stride.json not found (tried {candidates})")


# Okabe-Ito: one color per coverage class, distinguishable under color blindness.
_CLASS_COLORS = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00"]


def stride_schedule(out: Path) -> Path:
    """Which LEDs light in each phase of the diffuse-capture stride schedule.

    Drawn from `web/tests/golden_stride.json` (generated by
    shared/protocol/gen_golden_stride.py), the fixture both the phone's
    web/src/code/stride.ts and the firmware's `stride_lit` are tested against,
    so the figure shows exactly what a fixture lights."""
    golden = json.loads(_golden_stride_path().read_text())
    wanted = [(3, 3), (4, 3)]
    cases = [
        c for want in wanted for c in golden["cases"] if (c["spacing"], c["anchorDensity"]) == want
    ]
    heights = [c["phaseCount"] for c in cases]
    fig, axes = plt.subplots(
        len(cases),
        1,
        figsize=(11, 0.42 * sum(heights) + 1.6 * len(cases)),
        gridspec_kw={"height_ratios": heights},
    )
    for ax, c in zip(np.atleast_1d(axes), cases):
        s, a, n, phases = c["spacing"], c["anchorDensity"], c["ledCount"], c["phases"]
        labels = []
        for ph, lit in enumerate(phases):
            y = len(phases) - 1 - ph
            lit_set = set(lit)
            for led in range(n):
                if led in lit_set:
                    ax.add_patch(
                        plt.Rectangle(
                            (led - 0.42, y - 0.36),
                            0.84,
                            0.72,
                            color=_CLASS_COLORS[(led % s) % len(_CLASS_COLORS)],
                        )
                    )
                else:
                    ax.plot(led, y, marker="o", ms=2.2, color="#c9ccd1")
            if ph < s:
                labels.append(f"coverage {ph}")
            else:
                labels.append(f"bridge 0↔{ph - s + 1}")
        ax.set_xlim(-0.8, n - 0.2)
        ax.set_ylim(-0.7, len(phases) - 0.3)
        ax.set_yticks(range(len(phases)))
        ax.set_yticklabels(labels[::-1], fontsize=9)
        step = 4 if n > 40 else 2
        ax.set_xticks(range(0, n, step))
        ax.tick_params(axis="x", labelsize=8)
        ax.set_xlabel("LED index")
        ax.axhline(len(phases) - s - 0.5, color="#8a8f98", lw=0.8, ls="--")
        for spine in ax.spines.values():
            spine.set_visible(False)
        ax.set_title(
            f"S = {s}, A = {a}: {len(phases)} phases ({s} coverage + {s - 1} bridges), "
            f"{n} LEDs; anchor period A·S = {a * s}",
            fontsize=10,
            loc="left",
        )
    handles = [
        plt.Rectangle((0, 0), 1, 1, color=_CLASS_COLORS[k])
        for k in range(max(c["spacing"] for c in cases))
    ]
    fig.legend(
        handles,
        [f"class {k}  (index mod S = {k})" for k in range(len(handles))],
        loc="lower center",
        ncol=len(handles),
        fontsize=8,
        frameon=False,
        bbox_to_anchor=(0.5, -0.02),
    )
    fig.suptitle("Strided capture: the LEDs lit in each phase", y=1.0)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    path = out / "stride_schedule.png"
    fig.savefig(path, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return path


def generate_all(out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    made = [
        fixtures_gallery(out_dir),
        camera_walk_animation(out_dir),
        reconstruction_accuracy(out_dir),
        stride_schedule(out_dir),
    ]
    for p in made:
        print(f"  figure: {p.name} ({p.stat().st_size // 1024} KiB)", file=sys.stderr)
    return made


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    out_dir = Path(argv[0]) if argv else Path("_generated")
    generate_all(out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
