"""Pure logic for the `flash_render` HITL (PR-40, desk D-459): do the app's flash writers
(effect store, map upload, settings) stall the render task? No hardware here; unit-tested
in //pi/hitl/tests:test_flash_render_core.

The DUT serial log (serial_capture: every line stamped `HH:MM:SS.mmmZ` in UTC) carries the
firmware's `[late] n= max= ago_ms=` (a render-start interval over 1.5 frame periods in the
[ft] window just closed), `[fs] wrote <path> <n> B us=<µs>` (each power-loss-safe littlefs
write) and, at boot, `[flash] auto-suspend on|off (...) jedec=<id>`. The driver records each
phase's UTC span; a late frame belongs to the phase its start (line time - ago_ms) is in.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_STAMP = re.compile(r"^(\d\d):(\d\d):(\d\d)\.(\d{3})Z (.*)$")
_LATE = re.compile(r"\[late\] n=(\d+) max=(\d+) ago_ms=(\d+)")
_WROTE = re.compile(r"\[fs\] wrote (\S+) (\d+) B us=(\d+)")
_SUSPEND = re.compile(r"\[flash\] auto-suspend (on|off[^j]*?)\s*jedec=([0-9a-f]+)")

# Phases whose flash writes must not delay a frame (they write outside the player mutex).
GATED = ("map", "settings")
# Measured and reported, not gated yet: these handlers hold the player mutex (which the render
# task takes every frame) for 30-70 ms of littlefs reads (the keypoint slot scan and listing,
# the store's record bookkeeping). Not a flash stall; the follow-up moves that I/O out of the
# lock (docs/design/flash-auto-suspend.md "Still late"). `strict` gates them too.
UNDER_LOCK = ("effect_store", "keypoints")


def stamped(text: str) -> list[tuple[float, str]]:
    """(UTC seconds of the day, line) for every stamped line."""
    out = []
    for raw in text.splitlines():
        m = _STAMP.match(raw)
        if m:
            h, mi, s, ms, rest = m.groups()
            out.append((int(h) * 3600 + int(mi) * 60 + int(s) + int(ms) / 1000.0, rest))
    return out


def day_seconds(epoch_s: float) -> float:
    return epoch_s % 86400.0


def late_frames(lines: list[tuple[float, str]]) -> list[dict]:
    """Late frames: {t (when the late frame started, UTC s of day), max_us, n}. A wrapped
    value (a clock step's negative interval on an older image) is no late frame."""
    out = []
    for t, line in lines:
        m = _LATE.search(line)
        if not m:
            continue
        n, mx, ago = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if mx >= 1 << 31 or ago >= 1 << 31:
            continue
        out.append({"t": round(t - ago / 1000.0, 3), "max_us": mx, "n": n})
    return out


def writes(lines: list[tuple[float, str]]) -> list[dict]:
    return [
        {"t": t, "path": m.group(1), "bytes": int(m.group(2)), "us": int(m.group(3))}
        for t, line in lines
        if (m := _WROTE.search(line))
    ]


def suspend_state(lines: list[tuple[float, str]]) -> tuple[str | None, str | None]:
    """The last boot's `[flash] auto-suspend` state ("on" / "off (...)") and JEDEC id."""
    st = jedec = None
    for _, line in lines:
        if m := _SUSPEND.search(line):
            st, jedec = m.group(1).strip(), m.group(2)
    return st, jedec


@dataclass
class Report:
    suspend: str | None
    jedec: str | None
    per_phase: dict[str, dict] = field(default_factory=dict)

    def late_in(self, name: str) -> int:
        return sum(x["n"] for x in self.per_phase.get(name, {}).get("late", []))


def report(
    text: str, phases: dict[str, tuple[float, float]], tail_s: float = 1.5, boot: str = ""
) -> Report:
    """Late frames and writes per phase. `phases`: name -> (start, end) in epoch seconds; a
    phase also owns `tail_s` after its end (a write the device finishes after replying).
    `boot`: the flash tool's boot monitor output (the capture is paused while it runs), for
    the `[flash] auto-suspend` line."""
    lines = stamped(text)
    st, jedec = suspend_state(lines)
    if st is None:
        st, jedec = suspend_state([(0.0, x) for x in boot.splitlines()])
    late, wr = late_frames(lines), writes(lines)
    rep = Report(st, jedec)
    starts = sorted(day_seconds(a) for a, _ in phases.values())
    for name, (a, b) in phases.items():
        a, b = day_seconds(a), day_seconds(b) + tail_s
        b = min([b] + [x for x in starts if x > a])  # the tail stops where the next phase starts
        rep.per_phase[name] = {
            "late": [x for x in late if a <= x["t"] <= b],
            "writes": [x for x in wr if a <= x["t"] <= b],
        }
    return rep


def verdict(
    rep: Report, require_suspend: bool = True, strict: bool = False
) -> tuple[str, list[str]]:
    """PASS: no late frame in any gated phase (and the UNDER_LOCK ones if `strict`), with
    auto-suspend on (if required) and at least one flash write seen in every gated phase
    (else the test proved nothing). FAIL otherwise; the reasons name the phase."""
    why = []
    if require_suspend and rep.suspend != "on":
        why.append(f"flash auto-suspend is {rep.suspend!r} (jedec {rep.jedec})")
    for name in GATED + (UNDER_LOCK if strict else ()):
        p = rep.per_phase.get(name)
        if p is None:
            why.append(f"{name}: not run")
            continue
        if not p["writes"]:
            why.append(f"{name}: no flash write seen")
        n = rep.late_in(name)
        if n:
            worst = max(x["max_us"] for x in p["late"])
            why.append(f"{name}: {n} late frame(s), worst {worst} us")
    return ("PASS" if not why else "FAIL"), why
