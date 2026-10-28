"""Pure logic for the OSC deck-follow HITL gate (#402, hitl_osc_deck_follow.py).

Native OSC (udp/9000) must drive the VISIBLE FX deck: deck A alone, the incoming
deck once a crossfade starts, back to deck A on a rollback fade, and names resolve
against that deck's manifest. The driver records one `Check` per expectation (a
uniform on a deck read back with get_effect_uniforms); this module encodes the OSC
datagrams, grades the checks and renders the RESULT line.

Gating (see hitl-gate-test-authoring): the first deck-A OSC write is the BASELINE —
it proves datagrams from the rig reach the DUT at all. Never seeing it is the
bench (or the long-standing OSC path, which live_latency_netstack gates), so the
run SKIPs. Once the baseline landed, any deck-follow expectation that doesn't hold
is the regression: FAIL.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

PASS, FAIL, SKIP = "pass", "fail", "skip"
TOL = 1e-3

# Deck A's effect: col = slots 0..2, k = slot 3.
FX_A = """uniform vec3 col : color = 0.0, 0.0, 0.0;
uniform float k : 0.0 .. 1.0 = 0.5;
void update() {}
vec3 shade(Led led) { return col * k; }
"""

# Deck B's: a DIFFERENT layout — tint = slots 0..2, gain = 3, k = 4, then a mat4
# pose (the tracker's 16 floats). A table that stayed on deck A's manifest would
# write B's gain (slot 3) for /k. tint's non-zero default shows a per-axis write
# keeps B's own other components (nothing of A's /col carries over).
FX_B = """uniform vec3 tint : color = 0.1, 0.2, 0.3;
uniform float gain : 0.0 .. 1.0 = 1.0;
uniform float k : 0.0 .. 1.0 = 0.5;
uniform mat4 pose;
void update() {}
vec3 shade(Led led) { return tint * gain * k * transform(pose, led.pos).x; }
"""

# The external tracker's contract: `/plane ,ffff` after a deploy_effect.
FX_PLANE = """uniform vec4 plane = 0.0, 0.0, 1.0, 0.0;
void update() {}
vec3 shade(Led led) { return vec3(abs(plane.x), abs(plane.y), abs(plane.z)); }
"""

# B's mat4 slot (pinned by //firmware/player_app:osc_decks_test via the manifest).
POSE_SLOT_B = 5

SLOT = {
    ("A", "col"): 0,
    ("A", "k"): 3,
    ("B", "tint"): 0,
    ("B", "gain"): 3,
    ("B", "k"): 4,
    ("B", "pose"): POSE_SLOT_B,
    ("P", "plane"): 0,
}


def _osc_str(s: str) -> bytes:
    b = s.encode() + b"\0"
    return b + b"\0" * (-len(b) % 4)


def osc_message(addr: str, args: list[float]) -> bytes:
    """One OSC message of float32 args (`,f...`)."""
    out = _osc_str(addr) + _osc_str("," + "f" * len(args))
    return out + b"".join(struct.pack(">f", float(a)) for a in args)


def joined(cur: dict[int, list[float]], slot: int, n: int) -> list[float] | None:
    """`n` consecutive slots from `slot` out of get_effect_uniforms.current, which
    reports a value wider than 4 floats as 4-float chunks at slot, slot+4, ..."""
    out: list[float] = []
    s = slot
    while len(out) < n:
        c = cur.get(s)
        if not c:
            return out or None
        out.extend(c)
        s += len(c)
    return out[:n]


@dataclass
class Check:
    """One expectation: deck `deck`'s `slot` reads `want` after `step`."""

    step: str
    deck: int
    slot: int
    want: list[float]
    got: list[float] | None
    baseline: bool = False

    @property
    def ok(self) -> bool:
        return (
            self.got is not None
            and len(self.got) == len(self.want)
            and all(abs(a - b) <= TOL for a, b in zip(self.got, self.want))
        )

    def describe(self) -> str:
        d = "AB"[self.deck] if self.deck in (0, 1) else str(self.deck)
        got = "none" if self.got is None else [round(v, 4) for v in self.got]
        return f"{self.step}: deck {d} slot {self.slot} = {got}, want {self.want}"


def verdict(checks: list[Check]) -> tuple[str, list[str]]:
    """(status, reasons). SKIP when the baseline never landed (or nothing ran)."""
    base = [c for c in checks if c.baseline]
    if not base or not all(c.ok for c in base):
        why = [c.describe() for c in base if not c.ok] or ["no baseline check ran"]
        return SKIP, [f"baseline OSC never reached deck A ({'; '.join(why)})"]
    bad = [c.describe() for c in checks if not c.baseline and not c.ok]
    return (FAIL, bad) if bad else (PASS, [])


def result_line(unit: str, status: str, checks: list[Check], reasons: list[str]) -> str:
    ok = sum(1 for c in checks if c.ok)
    line = f"RESULT osc_deck_follow verdict={status.upper()} unit={unit} checks={ok}/{len(checks)}"
    if reasons:
        line += " reasons=" + " | ".join(reasons)
    return line
