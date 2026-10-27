"""Pure logic for the FX debugger HITL gate (hitl_fx_debug.py, docs/design/fx-debugger.md).

The gate pauses a real C6, snapshots the paused frame, steps one frame, snapshots
again, and replays that frame on the host VM (//firmware/fx_vm:fx_replay) from the
device's own state and inputs. The device's output, state and buffers must match
the replay BIT-EXACTLY (the on-device JIT included), one LED's re-run locals must
match the host's, and a paused engine must auto-resume when its client goes away
or its hold lease lapses.

Taxonomy (hitl-gate-test-authoring): never reached the device / no baseline =
SKIP (infra); a byte that differs, a pause that never lapses, or a step that
didn't land on its exact time = FAIL (the debugger or the engine is wrong).
Pure (no I/O): unit-tested in //pi/hitl/tests:test_fx_debug_core.
"""

from __future__ import annotations

import base64
import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

PASS = "pass"
FAIL = "fail"
SKIP = "skip"

# GetFxSnapshot.Section, by the name the proto JSON uses.
SECTIONS = {
    "output": "SECTION_OUTPUT",
    "wire": "SECTION_WIRE",
    "uniforms": "SECTION_UNIFORMS",
    "state": "SECTION_STATE",
    "arena": "SECTION_ARENA",
    "program": "SECTION_PROGRAM",
    "led_context": "SECTION_LED_CONTEXT",
    "lut": "SECTION_LUT",
    "raw": "SECTION_RAW",
    "graph": "SECTION_GRAPH",
}
ACTION = {"status": 0, "pause": 1, "resume": 2, "step": 3}
MAX_LOCALS = 128


def b64(v) -> bytes:
    """A proto3-JSON bytes field (base64 string; absent/empty = b"")."""
    if not v:
        return b""
    return base64.b64decode(v)


def reassemble(chunks: Sequence[dict]) -> bytes:
    """Concatenate fx_debug.chunk windows (in offset order), checking they tile
    [0, total_len) with no gap or overlap. Raises ValueError otherwise."""
    out = bytearray()
    total = None
    for c in sorted(chunks, key=lambda c: int(c.get("offset", 0))):
        off = int(c.get("offset", 0))
        total = int(c.get("totalLen", 0))
        if off != len(out):
            raise ValueError(f"chunk at {off}, expected {len(out)}")
        out += b64(c.get("data"))
    if total is not None and len(out) != total:
        raise ValueError(f"reassembled {len(out)} of {total} bytes")
    return bytes(out)


def f32(bits: int) -> float:
    return struct.unpack("<f", struct.pack("<I", bits & 0xFFFFFFFF))[0]


def to_f32(x: float) -> float:
    """Round a Python float to f32 (the device's time arithmetic)."""
    return struct.unpack("<f", struct.pack("<f", x))[0]


def diff_bytes(device: bytes, host: bytes, stride: int = 1) -> List[int]:
    """Indices (in `stride`-sized records) where the two differ; a length
    mismatch counts every missing record."""
    n = max(len(device), len(host))
    bad = []
    for i in range(0, n, stride):
        if device[i : i + stride] != host[i : i + stride]:
            bad.append(i // stride)
    return bad


def locals_from_device(vals: Sequence) -> List[int]:
    """fx_debug.led.locals (floats; proto3 JSON spells NaN / Infinity as strings)
    as f32 bit patterns."""
    out = []
    for v in vals:
        if isinstance(v, str):
            v = {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}.get(
                v, 0.0
            )
        out.append(struct.unpack("<I", struct.pack("<f", float(v)))[0])
    return out


def locals_from_host(rec: bytes) -> List[int]:
    """fx_replay's led<N>.bin locals (after the 3 rgb bytes) as bit patterns."""
    body = rec[3 : 3 + 4 * MAX_LOCALS]
    return [struct.unpack_from("<I", body, 4 * k)[0] for k in range(len(body) // 4)]


def same_f32_bits(a: int, b: int) -> bool:
    """Bit-equal, or both NaN (a NaN's payload may not survive the JSON trip)."""
    nan = lambda x: (x & 0x7F800000) == 0x7F800000 and (x & 0x7FFFFF) != 0  # noqa: E731
    return a == b or (nan(a) and nan(b))


@dataclass
class EffectResult:
    """One effect's paused-frame replay."""

    effect: str
    leds: int = 0
    output_mismatch: List[int] = field(default_factory=list)  # LED indices
    state_mismatch: List[int] = field(default_factory=list)  # state words
    arena_mismatch: int = 0  # bytes
    locals_mismatch: List[int] = field(default_factory=list)  # slots
    jit_disagrees: bool = False  # the device's normal path != its interpreter
    step_time_ok: bool = True  # a step landed exactly on its time / dt
    jit_blocks: int = 0
    error: Optional[str] = None  # couldn't complete (infra) -> not asserted

    def ok(self) -> bool:
        return (
            self.error is None
            and not self.output_mismatch
            and not self.state_mismatch
            and self.arena_mismatch == 0
            and not self.locals_mismatch
            and not self.jit_disagrees
            and self.step_time_ok
        )

    def summary(self) -> str:
        if self.error:
            return f"{self.effect}: not run ({self.error})"
        if self.ok():
            return f"{self.effect}: bit-exact ({self.leds} LEDs, jit_blocks={self.jit_blocks})"
        bits = []
        if self.output_mismatch:
            bits.append(
                f"output differs on {len(self.output_mismatch)} LEDs (first {self.output_mismatch[0]})"
            )
        if self.state_mismatch:
            bits.append(f"state words {self.state_mismatch[:6]}")
        if self.arena_mismatch:
            bits.append(f"{self.arena_mismatch} buffer bytes")
        if self.locals_mismatch:
            bits.append(f"locals slots {self.locals_mismatch[:6]}")
        if self.jit_disagrees:
            bits.append("JIT != interpreter on the device")
        if not self.step_time_ok:
            bits.append("step time/dt not exact")
        return f"{self.effect}: " + "; ".join(bits)


@dataclass
class ResumeCheck:
    """An auto-resume probe: did the engine run again, and why."""

    kind: str  # "disconnect" | "timeout"
    resumed: Optional[bool]  # None = the probe couldn't run (infra)
    reason: str = ""
    advancing: Optional[bool] = None  # frames advanced after the resume

    def ok(self) -> bool:
        return self.resumed is True and self.reason == self.kind and self.advancing is not False


def verdict(reached: bool, effects: Sequence[EffectResult], resumes: Sequence[ResumeCheck]):
    """(status, reasons). SKIP when the DUT was never reachable or nothing ran;
    FAIL on any asserted mismatch; PASS otherwise."""
    if not reached:
        return SKIP, ["the DUT was never reachable over wss (infra)"]
    ran = [e for e in effects if e.error is None]
    if not ran:
        return SKIP, ["no effect completed a replay (infra)"] + [e.summary() for e in effects]
    reasons = [e.summary() for e in ran if not e.ok()]
    for r in resumes:
        if r.resumed is None:
            continue
        if not r.ok():
            reasons.append(
                f"auto-resume on {r.kind}: resumed={r.resumed} reason={r.reason!r} advancing={r.advancing}"
            )
    return (FAIL, reasons) if reasons else (PASS, [e.summary() for e in ran])


def result_line(
    status: str, effects: Sequence[EffectResult], resumes: Sequence[ResumeCheck]
) -> str:
    exact = sum(1 for e in effects if e.error is None and e.ok())
    ran = sum(1 for e in effects if e.error is None)
    res = ",".join(
        f"{r.kind}={'ok' if r.ok() else ('skip' if r.resumed is None else 'FAIL')}" for r in resumes
    )
    return f"RESULT fx_debug verdict={status.upper()} bit_exact={exact}/{ran} auto_resume={res or 'none'}"


def run_status(status: str) -> int:
    """Process exit code: only FAIL gates."""
    return 1 if status == FAIL else 0


def frames_tile(sections: Dict[str, int], chunk: int) -> int:
    """Requests needed to pull sections of the given sizes at `chunk` bytes each
    (planning / logging only)."""
    return sum(max(1, -(-n // chunk)) for n in sections.values())
