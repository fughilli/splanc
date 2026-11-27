"""Pure logic for the `connect_render` HITL (desk D-460): does a NEW client's TLS handshake
make frames late under a heavy effect? No hardware here; unit-tested in
//pi/hitl/tests:test_connect_render_core.

The DUT serial log (serial_capture: every line stamped `HH:MM:SS.mmmZ` in UTC) carries, once
a second while an effect renders:

- `[ft] r<n>:<min>/<mean>/<max> w... fps=<live rate> sl=<a>-<b>`: render-start intervals
  (us) over the window and the rate the effect runs at;
- `[late] n= max= ago_ms=`: render-start intervals over 1.5 periods of the live rung;
- `[rsv] frames=<n> entered=<k>`: frames the window ran under the reserved slice (D-460: a
  handshake waiting on render's sleeps makes render take at most half the CPU, on a lower
  steady rung) and how many reserves began.

The driver records each phase's UTC span (steady: no client; connect: N new clients, one at
a time; after); a line belongs to the phase its time is in (a late frame: the time it
started, line time - ago_ms).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from flash_render_core import day_seconds, late_frames, stamped

_FT = re.compile(r"\[ft\] r(\d+):(\d+)/(\d+)/(\d+) .*?fps=(\d+)")
_RSV = re.compile(r"\[rsv\] frames=(\d+) entered=(\d+)")

# A new client's connect (TCP + TLS + WS upgrade + hello) must finish inside this (the
# app's and heavy_effect_reachability's budget).
HANDSHAKE_S = 8.0
# Phases whose frames must all be on time.
GATED = ("steady", "connect", "after")


def ft_windows(lines: list[tuple[float, str]]) -> list[dict]:
    """[ft] windows: {t, n, min_us, mean_us, max_us, fps}."""
    out = []
    for t, line in lines:
        m = _FT.search(line)
        if m:
            n, lo, mean, hi, fps = (int(x) for x in m.groups())
            out.append({"t": t, "n": n, "min_us": lo, "mean_us": mean, "max_us": hi, "fps": fps})
    return out


def rsv_windows(lines: list[tuple[float, str]]) -> list[dict]:
    """[rsv] windows: {t, frames, entered}."""
    return [
        {"t": t, "frames": int(m.group(1)), "entered": int(m.group(2))}
        for t, line in lines
        if (m := _RSV.search(line))
    ]


@dataclass
class Report:
    per_phase: dict[str, dict] = field(default_factory=dict)

    def late_in(self, name: str) -> int:
        return sum(x["n"] for x in self.per_phase.get(name, {}).get("late", []))

    def worst_late_us(self, name: str) -> int:
        return max((x["max_us"] for x in self.per_phase.get(name, {}).get("late", [])), default=0)

    def reserve_frames(self, name: str) -> int:
        return sum(x["frames"] for x in self.per_phase.get(name, {}).get("rsv", []))

    def reserves_entered(self, name: str) -> int:
        return sum(x["entered"] for x in self.per_phase.get(name, {}).get("rsv", []))

    def fps_range(self, name: str) -> tuple[int, int]:
        f = [x["fps"] for x in self.per_phase.get(name, {}).get("ft", [])]
        return (min(f), max(f)) if f else (0, 0)

    def max_interval_us(self, name: str) -> int:
        return max((x["max_us"] for x in self.per_phase.get(name, {}).get("ft", [])), default=0)


def report(text: str, phases: dict[str, tuple[float, float]]) -> Report:
    """Per phase: late frames, [ft] and [rsv] windows. `phases`: name -> (start, end) in
    epoch seconds. An [ft]/[rsv] line closes the second BEFORE it, so a phase owns the lines
    stamped up to 1 s past its end (never past the next phase's start)."""
    lines = stamped(text)
    late, ft, rsv = late_frames(lines), ft_windows(lines), rsv_windows(lines)
    rep = Report()
    starts = sorted(day_seconds(a) for a, _ in phases.values())
    for name, (a, b) in phases.items():
        a, b = day_seconds(a), day_seconds(b)
        nxt = min([x for x in starts if x > a], default=b + 1.0)
        tail = min(b + 1.0, nxt)
        rep.per_phase[name] = {
            "late": [x for x in late if a <= x["t"] <= b],
            # Window lines: the first one that closes inside the phase onwards.
            "ft": [x for x in ft if a + 1.0 <= x["t"] <= tail],
            "rsv": [x for x in rsv if a < x["t"] <= tail],
        }
    return rep


def grade_attempts(attempts: list[dict]) -> list[str]:
    """Every new client connected inside HANDSHAKE_S."""
    why = []
    if not attempts:
        why.append("connect: no client attempted")
    for i, a in enumerate(attempts):
        if not a.get("ok"):
            why.append(f"connect #{i + 1}: {a.get('err') or 'failed'} after {a.get('s', 0):.2f} s")
        elif a.get("s", 0) > HANDSHAKE_S:
            why.append(f"connect #{i + 1}: took {a['s']:.2f} s (> {HANDSHAKE_S:g} s)")
    return why


def verdict(
    rep: Report, attempts: list[dict], require_reserve: bool = True
) -> tuple[str, list[str]]:
    """PASS: no late frame in any gated phase, every client connected in time, and (unless
    measuring a baseline image) the reserve was used while they did, so the test exercised
    the slice. FAIL otherwise; the reasons name the phase."""
    why = grade_attempts(attempts)
    for name in GATED:
        if name not in rep.per_phase:
            why.append(f"{name}: not run")
            continue
        if not rep.per_phase[name]["ft"]:
            why.append(f"{name}: no [ft] window (is the effect rendering?)")
        n = rep.late_in(name)
        if n:
            why.append(f"{name}: {n} late frame(s), worst {rep.worst_late_us(name)} us")
    if require_reserve and "connect" in rep.per_phase and rep.reserves_entered("connect") == 0:
        why.append("connect: the reserve never engaged (effect too light to need it?)")
    return ("PASS" if not why else "FAIL"), why


def summary(rep: Report, attempts: list[dict]) -> dict:
    """The numbers the desk item quotes, per phase."""
    out: dict = {}
    for name in rep.per_phase:
        lo, hi = rep.fps_range(name)
        out[name] = {
            "late": rep.late_in(name),
            "worst_late_us": rep.worst_late_us(name),
            "max_interval_us": rep.max_interval_us(name),
            "fps": [lo, hi],
            "reserve_frames": rep.reserve_frames(name),
            "reserves": rep.reserves_entered(name),
        }
    secs = sorted(a["s"] for a in attempts if a.get("ok"))
    out["handshakes"] = {
        "n": len(attempts),
        "ok": len(secs),
        "s_min": round(secs[0], 2) if secs else None,
        "s_max": round(secs[-1], 2) if secs else None,
    }
    return out
