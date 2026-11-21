"""Draw the rolling-stride figures (docs/design/rolling-stride.md) as SVG.

    python3 docs/design/img/rolling-stride/make_figures.py

The schedule comes from the hue-code kernel's pinned fixture,
`firmware/pattern/testdata/golden_stride_rolling.json` (emitted by
`//firmware/pattern:gen_golden` from `stride_lit_rolling`, the function the
players and the phone run). The few things the fixture does not record (which
LED a block-boundary rule blanked, each block's offset) come from a line-by-line
port of the kernel below, which is checked against every frame of the fixture
before anything is drawn, so a figure cannot drift from the firmware.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
GOLDEN = ROOT / "firmware" / "pattern" / "testdata" / "golden_stride_rolling.json"

# Palette: three stride classes (colour-blind safe), neutral greys, one alert.
CLASS = ["#2a6fdb", "#e0892b", "#3aa17e", "#b35fc4", "#c9a227", "#5b8aa6"]
GRID = "#c9ccd3"
INK = "#1f2430"
MUTED = "#6b7180"
DARK_CELL = "#f2f3f6"
YIELD = "#d64545"
FONT = "font-family='Inter, system-ui, -apple-system, Segoe UI, sans-serif'"

# --------------------------------------------------------------------------
# Kernel port (firmware/pattern/src/lib.rs). Integer arithmetic throughout.
# --------------------------------------------------------------------------
M32 = 0xFFFFFFFF


def _mix32(x: int) -> int:
    x &= M32
    x ^= x >> 16
    x = (x * 0x7FEB352D) & M32
    x ^= x >> 15
    x = (x * 0x846CA68B) & M32
    x ^= x >> 16
    return x


def _stagger_step(c: int) -> int:
    if c < 2:
        return 1
    target = c * 618_033_989
    best, err = 1, None
    for s in range(1, c):
        if math.gcd(s, c) == 1:
            e = abs(s * 1_000_000_000 - target)
            if err is None or e < err:
                best, err = s, e
    return best


def _circ(a: int, b: int, c: int) -> int:
    d = (a % c + c - b % c) % c
    return min(d, c - d)


def _block_offset(q: int, c: int, s: int) -> int:
    free = lambda k: _mix32(k ^ 0x5EED) % c  # noqa: E731
    v = free(q)
    if q % 2 == 0:
        return v
    lo, hi, d = free(q - 1), free(q + 1), c // 8 + 1
    for t in range(c):
        x = (v + t) % c
        if _circ(s + x, lo, c) >= d and _circ(s + hi, x, c) >= d:
            return x
    return v


def stagger_phase(i: int, c: int, staggered: bool) -> int:
    if not staggered or c == 0:
        return 0
    s = _stagger_step(c)
    return ((i % c) * s + _block_offset(i // c, c, s)) % c


class Rolling:
    """stride_lit_rolling + rolling_interval for one geometry."""

    def __init__(self, n, s, a, d, c, staggered, offset=0):
        self.n, self.S, self.C = n, s, c
        self.D = min(max(d, 2), 64)
        self.B = max(a, 3) * s
        self.W = self.D * c
        self.P = s * self.W
        self.own = [stagger_phase(i + offset, c, staggered) for i in range(n + s)]

    def shift(self, b: int) -> int:
        return (self.P - (b * self.C) % self.P) % self.P

    def offset(self, b: int, t: int) -> int:
        """Block b's lit class at frame t."""
        return ((t - self.shift(b)) // self.W) % self.S

    def interval(self, x: int, t: int) -> tuple[int, int]:
        s, c, w = self.S, self.C, self.W
        sh = self.shift(x // self.B)
        t = max(t, 0)
        k0 = (t - sh) // w
        k = k0 - ((k0 - x % s) % s)
        while True:
            ws = max(k * w + sh, 0)
            we = (k + 1) * w + sh
            start = ws + ((self.own[x] - ws) % c)
            if we > start:
                end = start + ((we - start) // c) * c
                if end > start and end > t:
                    return start, end
            k += s

    def candidate(self, x: int, t: int) -> bool:
        return x < self.n and self.interval(x, t)[0] <= t

    def lit(self, x: int, t: int) -> bool:
        if self.S <= 1:
            return True
        if x >= self.n:
            return False
        start, _ = self.interval(x, t)
        if start > t:
            return False
        cs = start + ((t - start) // self.C) * self.C
        ce = cs + self.C
        for y in range(max(0, x - self.S + 1), x + self.S):
            if y == x or y >= self.n or y // self.B == x // self.B:
                continue
            ys, _ = self.interval(y, cs)
            if ys < ce and (ys < start or (ys == start and y < x)):
                return False
        return True


def load_cases() -> list[tuple[dict, Rolling]]:
    g = json.loads(GOLDEN.read_text())
    out = []
    for case in g["cases"]:
        r = Rolling(
            case["ledCount"],
            case["spacing"],
            case["anchorDensity"],
            case["dwellCycles"],
            case["cycleFrames"],
            case["syncPattern"] == "stagger_pilot",
            case["codeOffset"],
        )
        assert r.own[: r.n] == case["ownPhase"], "own phase drifted from the kernel"
        for t, row in enumerate(case["frames"]):
            got = "".join("#" if r.lit(x, t) else "." for x in range(r.n))
            assert got == row, f"port drifted from the kernel at frame {t}: {got} != {row}"
        out.append((case, r))
    return out


# --------------------------------------------------------------------------
# SVG helpers
# --------------------------------------------------------------------------
class Svg:
    def __init__(self, w: float, h: float, title: str):
        self.w, self.h = w, h
        self.parts = [
            f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w:.0f} {h:.0f}' "
            f"width='{w:.0f}' height='{h:.0f}' role='img' aria-label='{title}'>",
            f"<title>{title}</title>",
            f"<rect width='{w:.0f}' height='{h:.0f}' fill='white'/>",
        ]

    def rect(self, x, y, w, h, fill, stroke=None, sw=1.0, extra=""):
        st = f" stroke='{stroke}' stroke-width='{sw}'" if stroke else ""
        self.parts.append(
            f"<rect x='{x:.2f}' y='{y:.2f}' width='{w:.2f}' height='{h:.2f}' fill='{fill}'{st} {extra}/>"
        )

    def line(self, x1, y1, x2, y2, stroke=GRID, sw=1.0, dash=None):
        d = f" stroke-dasharray='{dash}'" if dash else ""
        self.parts.append(
            f"<line x1='{x1:.2f}' y1='{y1:.2f}' x2='{x2:.2f}' y2='{y2:.2f}' "
            f"stroke='{stroke}' stroke-width='{sw}'{d}/>"
        )

    def text(self, x, y, s, size=12, fill=INK, anchor="start", weight="normal", rotate=None):
        tr = f" transform='rotate({rotate} {x:.1f} {y:.1f})'" if rotate is not None else ""
        self.parts.append(
            f"<text x='{x:.1f}' y='{y:.1f}' font-size='{size}' fill='{fill}' "
            f"text-anchor='{anchor}' font-weight='{weight}' {FONT}{tr}>{s}</text>"
        )

    def raw(self, s):
        self.parts.append(s)

    def save(self, name: str) -> Path:
        p = HERE / name
        p.write_text("\n".join(self.parts + ["</svg>"]) + "\n")
        return p


YIELD_FILL = "#f7d0d0"


def runs(r: Rolling, x: int, t_lo: int, t_hi: int):
    """Maximal runs [t0, t1) of LED x being lit ("lit") or yielding ("yield")."""
    out = []
    t = t_lo
    while t < t_hi:
        state = "lit" if r.lit(x, t) else ("yield" if r.candidate(x, t) else None)
        t1 = t + 1
        while (
            t1 < t_hi
            and ("lit" if r.lit(x, t1) else ("yield" if r.candidate(x, t1) else None)) == state
        ):
            t1 += 1
        if state is not None:
            out.append((state, t, t1))
        t = t1
    return out


def draw_runs(
    svg: "Svg", r: Rolling, x: int, t_lo: int, t_hi: int, x0: float, y0: float, cw: float, ch: float
):
    for state, t0, t1 in runs(r, x, t_lo, t_hi):
        y = y0 + (t0 - t_lo) * ch
        hh = (t1 - t0) * ch
        if state == "lit":
            svg.rect(x0 + 1, y, cw - 2, hh, CLASS[x % r.S])
        else:
            svg.rect(x0 + 1.5, y + 0.5, cw - 3, hh - 1, YIELD_FILL, YIELD, 1.2)


# --------------------------------------------------------------------------
# Figures
# --------------------------------------------------------------------------
def spacetime(case: dict, r: Rolling) -> Path:
    """LED index across, pattern-clock frames down, for two periods."""
    n, frames = r.n, 2 * r.P
    cw, ch = 16.0, 3.0
    left, top = 70.0, 64.0
    w = left + n * cw + 210
    h = top + frames * ch + 40
    svg = Svg(w, h, "Rolling stride: lit LEDs over time")
    svg.text(left, 24, "Rolling stride over two periods", 15, weight="600")
    svg.text(
        left,
        44,
        f"S={r.S}, A={r.B // r.S} (blocks of {r.B}), D={r.D} cycles of C={r.C} frames, "
        f"hue code v2 · {n} LEDs · P = one period",
        12,
        MUTED,
    )
    for x in range(n):
        draw_runs(svg, r, x, 0, frames, left + x * cw, top, cw, ch)
    for b in range(0, n + 1, r.B):
        svg.line(left + b * cw, top - 6, left + b * cw, top + frames * ch, INK, 1.2)
    for k in range(0, frames + 1, r.C):
        major = k % r.P == 0
        svg.line(
            left - (10 if major else 4), top + k * ch, left, top + k * ch, INK if major else GRID
        )
        if major:
            svg.text(left - 14, top + k * ch + 4, f"{k // r.P}P", 11, MUTED, "end")
    for x in range(0, n, r.S):
        svg.text(left + x * cw + cw / 2, top - 10, str(x), 9, MUTED, "middle")
    svg.text(18, top + frames * ch / 2, "pattern-clock frame →", 11, MUTED, "middle", rotate=-90)
    lx = left + n * cw + 24
    svg.text(lx, top + 6, "LED class (x mod S)", 11, INK, weight="600")
    for j in range(r.S):
        svg.rect(lx, top + 18 + j * 20, 14, 12, CLASS[j])
        svg.text(lx + 22, top + 28 + j * 20, f"class {j}", 11, INK)
    yy = top + 18 + r.S * 20 + 12
    svg.rect(lx, yy, 14, 12, YIELD_FILL, YIELD, 1.2)
    svg.text(lx + 22, yy + 10, "yields (boundary rule)", 11, INK)
    svg.line(lx, yy + 34, lx + 14, yy + 34, INK, 1.2)
    svg.text(lx + 22, yy + 38, "block boundary", 11, INK)
    svg.text(lx, yy + 64, "Each block steps one code", 11, MUTED)
    svg.text(lx, yy + 79, "cycle after the block to", 11, MUTED)
    svg.text(lx, yy + 94, "its right: a short wave.", 11, MUTED)
    return svg.save("spacetime.svg")


def phased_vs_rolling(case: dict, r: Rolling) -> Path:
    """The same strip under the phased schedule and the rolling one."""
    n = r.n
    frames = 2 * r.P
    cw, ch = 9.0, 2.4
    gap = 70
    left, top = 56.0, 86.0
    pw = n * cw
    w = left + 2 * pw + gap + 30
    h = top + frames * ch + 64
    svg = Svg(w, h, "Phased vs rolling stride")
    svg.text(left, 24, "Phased (today) vs rolling", 15, weight="600")
    svg.text(left, 44, "Same strip and dwell. Grey bands: no decodable track anywhere.", 12, MUTED)
    # Phased: global steps every W frames through 2S-1 phases (coverage + bridges).
    phases = 2 * r.S - 1
    a = r.B // r.S

    def phased_lit(x, t):
        ph = (t // r.W) % phases
        if ph < r.S:
            return x % r.S == ph
        j = ph - r.S + 1
        m = x % (a * r.S)
        return m == 0 or m == (a // 2) * r.S + j

    for panel, title in ((0, "phased: global step"), (1, "rolling: per-block clocks")):
        x0 = left + panel * (pw + gap)
        svg.text(x0, top - 14, title, 12, INK, weight="600")
        if panel == 0:
            for t in range(0, frames, r.W):
                svg.rect(x0, top + t * ch, pw, r.C * ch, "#e3e5ea")
            for x in range(n):
                t = 0
                while t < frames:
                    if phased_lit(x, t):
                        t1 = t
                        while t1 < frames and phased_lit(x, t1):
                            t1 += 1
                        svg.rect(
                            x0 + x * cw + 0.8, top + t * ch, cw - 1.6, (t1 - t) * ch, CLASS[x % r.S]
                        )
                        t = t1
                    else:
                        t += 1
        else:
            for x in range(n):
                draw_runs(svg, r, x, 0, frames, x0 + x * cw, top, cw, ch)
        if panel == 1:
            for b in range(0, n + 1, r.B):
                svg.line(x0 + b * cw, top - 4, x0 + b * cw, top + frames * ch, INK, 1)
        svg.line(x0, top, x0, top + frames * ch, GRID)
    svg.text(
        left + pw / 2,
        top + frames * ch + 22,
        "every LED re-locks after each step",
        11,
        MUTED,
        "middle",
    )
    svg.text(
        left + pw + gap + pw / 2,
        top + frames * ch + 22,
        f"1 block in {r.D} is in its first cycle at any moment",
        11,
        MUTED,
        "middle",
    )
    svg.text(
        left + pw / 2, top + frames * ch + 40, "(+ 2 bridge phases per period)", 11, MUTED, "middle"
    )
    svg.text(
        left + pw + gap + pw / 2,
        top + frames * ch + 40,
        "(no bridges, no reconfigures)",
        11,
        MUTED,
        "middle",
    )
    return svg.save("phased-vs-rolling.svg")


def block_clocks(case: dict, r: Rolling) -> Path:
    """Each block's lit class over time: the one-cycle wave."""
    blocks = math.ceil(r.n / r.B)
    frames = 2 * r.P
    left, top = 90.0, 70.0
    fw = 3.2
    rowh = 34.0
    w = left + frames * fw + 40
    h = top + blocks * rowh + 60
    svg = Svg(w, h, "Block clocks")
    svg.text(left, 24, "Each block's dwell schedule", 15, weight="600")
    svg.text(
        left,
        44,
        f"Lit class per block (D={r.D} cycles per dwell). Block b+1 steps one cycle (C={r.C} frames) "
        "before block b.",
        12,
        MUTED,
    )
    for b in range(blocks):
        y = top + b * rowh
        svg.text(left - 12, y + 20, f"block {b}", 11, INK, "end")
        t = 0
        while t < frames:
            o = r.offset(b, t)
            t1 = t
            while t1 < frames and r.offset(b, t1) == o:
                t1 += 1
            svg.rect(left + t * fw, y + 4, (t1 - t) * fw - 1, rowh - 10, CLASS[o])
            if (t1 - t) * fw > 30:
                svg.text(
                    left + (t + t1) / 2 * fw, y + 21, f"class {o}", 10, "white", "middle", "600"
                )
            t = t1
    for k in range(0, frames + 1, r.C):
        major = k % r.W == 0
        svg.line(
            left + k * fw, top - 4, left + k * fw, top + blocks * rowh, INK if major else GRID, 0.6
        )
    svg.text(
        left,
        top + blocks * rowh + 22,
        "pattern-clock frame → (ticks: code cycles; dark: dwells of block 0)",
        11,
        MUTED,
    )
    return svg.save("block-clocks.svg")


def boundary_zoom(case: dict, r: Rolling) -> Path:
    """Zoom on one block boundary across an offset wrap: the later one yields."""
    bnd = r.B  # boundary between block 0 and block 1
    xs = list(range(bnd - 4, bnd + 4))
    # Find a yield at this boundary (block 1's first LED, class 0).
    t0 = next(t for t in range(0, 3 * r.P) if r.candidate(bnd, t) and not r.lit(bnd, t))
    t_lo, t_hi = t0 - 2 * r.C, t0 + 3 * r.C
    cw, ch = 46.0, 7.0
    left, top = 110.0, 104.0
    w = left + len(xs) * cw + 250
    h = top + (t_hi - t_lo) * ch + 50
    svg = Svg(w, h, "Block boundary: the later-started LED yields")
    svg.text(24, 26, "At a block boundary the later-started LED yields", 15, weight="600")
    svg.text(
        24,
        46,
        f"LEDs {xs[0]}–{xs[-1]} around the boundary at {bnd}; frames {t_lo}–{t_hi - 1}. "
        f"Ticks: own-cycle starts.",
        12,
        MUTED,
    )
    for i, x in enumerate(xs):
        svg.text(left + i * cw + cw / 2, top - 10, f"LED {x}", 11, INK, "middle")
        draw_runs(svg, r, x, t_lo, t_hi, left + i * cw + 2, top, cw - 4, ch)
        for t in range(t_lo, t_hi):
            y = top + (t - t_lo) * ch
            if (t - r.own[x]) % r.C == 0:
                svg.line(left + i * cw + 3, y, left + i * cw + 12, y, INK, 1)
    bx = left + xs.index(bnd) * cw
    svg.line(bx, top - 26, bx, top + (t_hi - t_lo) * ch, INK, 2)
    svg.text(bx - 6, top - 26, "block 0", 11, MUTED, "end")
    svg.text(bx + 6, top - 26, "block 1", 11, MUTED)
    for t in range(t_lo, t_hi + 1, r.C):
        svg.text(left - 10, top + (t - t_lo) * ch + 4, str(t), 10, MUTED, "end")
    tx = left + len(xs) * cw + 20
    yy = top + 10
    for line in [
        f"LED {bnd - 1} (block 0, class {r.S - 1}) has been",
        "lit since its dwell began.",
        "",
        "Block 1 steps to class 0 one cycle",
        f"earlier, so LED {bnd} would light 1 LED",
        f"away from LED {bnd - 1} (closer than S={r.S}).",
        "",
        f"LED {bnd}'s interval started LATER: it",
        "stays dark for each own cycle that",
        "overlaps the other's interval (red),",
        "then lights on its next own cycle.",
        "",
        "The earlier LED is never cut, so no",
        "live track is interrupted.",
    ]:
        svg.text(tx, yy, line, 11, INK if line else MUTED)
        yy += 16
    return svg.save("boundary-yield.svg")


def dwell_choice() -> Path:
    """Own whole cycles per dwell and the decoded share at D = 3 vs D = 4."""
    # Measured on the kernel schedule: every (LED, dwell) of a 90-LED v2 strip
    # (S=3, A=3, C=10) over six steady periods, by whole own cycles lit.
    data = {}
    for d in (3, 4):
        r = Rolling(90, 3, 3, d, 10, True)
        hist: dict[int, int] = {}
        for x in range(r.n):
            for state, t0, t1 in runs(r, x, r.P, 7 * r.P):
                if state == "lit" and t0 > r.P and t1 < 7 * r.P:
                    hist[(t1 - t0) // r.C] = hist.get((t1 - t0) // r.C, 0) + 1
        data[d] = hist
    left, top = 70.0, 70.0
    bw, gap = 46.0, 18.0
    hmax = 180.0
    w = 620
    h = top + hmax + 90
    svg = Svg(w, h, "Dwell length: whole own cycles per dwell")
    svg.text(24, 26, "D = 3 vs D = 4: whole own code cycles per dwell", 15, weight="600")
    svg.text(
        24,
        46,
        "Share of (LED, dwell) pairs, hue code v2 (S=3, A=3, C=10). A decode needs 2.",
        12,
        MUTED,
    )
    x = left
    for d, hist in data.items():
        tot = sum(hist.values())
        svg.text(
            x + 1.5 * (bw + gap) - gap / 2, top + hmax + 46, f"D = {d}", 13, INK, "middle", "600"
        )
        for k in range(1, 5):
            frac = hist.get(k, 0) / tot
            bh = frac * hmax
            col = YIELD if k < 2 else ("#e0892b" if k == 2 else "#3aa17e")
            svg.rect(x, top + hmax - bh, bw, bh, col)
            svg.text(x + bw / 2, top + hmax - bh - 6, f"{100 * frac:.0f}%", 11, INK, "middle")
            svg.text(x + bw / 2, top + hmax + 18, f"{k}", 11, MUTED, "middle")
            x += bw + gap
        x += 40
    svg.line(left - 10, top + hmax, x - 40, top + hmax, INK)
    svg.text(left - 10, top + hmax + 18, "cycles:", 11, MUTED, "end")
    svg.text(
        24,
        h - 14,
        "D=3: most dwells give exactly the two cycles a decode needs (no margin, no confirmed track left lit).",
        11,
        MUTED,
    )
    return svg.save("dwell-choice.svg")


def main() -> int:
    cases = load_cases()  # checks the port against every golden frame
    main_case = cases[0][0]
    # The figures' strip: 5 blocks, C = 10 (the 250-LED rope's v2 cycle at 4
    # symbols), long enough that a boundary yield shows within two periods.
    r = Rolling(45, 3, 3, 4, 10, True)
    for p in (
        spacetime(main_case, r),
        phased_vs_rolling(main_case, r),
        block_clocks(main_case, r),
        boundary_zoom(main_case, r),
        dwell_choice(),
    ):
        print("wrote", p.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
