"""Pure-logic helpers for the mapping-sequence-trigger HITL test (FUG-62).

The player firmware records a "frame shown" tick (lm_pattern_frame_shown) ONLY
inside the mapping-pattern render branch of render_once() — so a growing tick
count across get_frame_timing polls is a direct, hardware-observable proof that
the gray-code flashing sequence is actually being driven onto the strip.

FUG-62: a persisted effect resumed on boot left lm_fx_active() true, and the
effect branch used to run BEFORE the mapping-pattern branch, so "start mapping"
latched a capture (nonzero pattern epoch) yet never showed a single frame — the
strip kept rendering the effect. These helpers turn a series of decoded
frame_timing replies (camelCase, per proto_wire.decode_server) into the
triggered/not-triggered verdict, with no hardware or network so //pi/hitl/tests
can pin them.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence


def frame_ticks_in(report: Mapping[str, Any]) -> int:
    """Frames the device reported showing in one frame_timing reply: the ticks it
    drained plus any it dropped from the ring since the last poll — both mean the
    mapping-pattern branch rendered a frame."""
    ticks = report.get("ticks") or []
    dropped = int(report.get("dropped") or 0)
    return len(ticks) + dropped


def pattern_epoch_of(report: Mapping[str, Any]) -> int:
    """The pattern-clock epoch the reply carries. 0 means no capture is latched
    (proto3 drops the zero, so a missing key reads as 0)."""
    return int(report.get("patternClockEpochMs") or 0)


def total_frame_ticks(reports: Sequence[Mapping[str, Any]]) -> int:
    return sum(frame_ticks_in(r) for r in reports)


def pattern_triggered(reports: Sequence[Mapping[str, Any]], *, min_ticks: int = 3) -> bool:
    """True when the polled frame_timing replies prove the mapping sequence ran:
    the device advertised a nonzero pattern epoch AND showed at least ``min_ticks``
    pattern frames across the polls.

    BOTH are required — that is the whole point of the FUG-62 guard. An epoch with
    zero frames shown is exactly the bug: the capture is latched but something
    downstream (a resumed effect masking the render branch) kept the pattern off
    the strip. Requiring real ticks, not just the latched epoch, catches it.
    """
    if total_frame_ticks(reports) < min_ticks:
        return False
    return any(pattern_epoch_of(r) > 0 for r in reports)
