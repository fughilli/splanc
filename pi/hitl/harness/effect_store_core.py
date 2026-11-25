"""Pure logic for the effect-store HITL gate (hitl_effect_store.py,
docs/design/effect-store.md): the stored_effect_list reading, the generated large
effect, and the result line. Check bookkeeping and the verdict are kiosk_core's
(a run that never reached the DUT is SKIP, any failed check on it is FAIL).
"""

from __future__ import annotations

from kiosk_core import FAIL, PASS, SKIP, Run, failures, near, uniform, verdict  # noqa: F401

PHASES = ("setup", "store", "load", "reboot", "big", "delete", "capacity", "driver")

# The player's fxb cap (ffi.rs FX_MAX_BYTES) and the store's slot count (MAX_STORED).
FX_MAX_BYTES = 4096
MAX_STORED = 8


def stored(reply: dict | None) -> dict[str, dict]:
    """stored_effect_list -> {effect id: entry} (proto3 JSON names, defaults filled)."""
    out: dict[str, dict] = {}
    for e in (reply or {}).get("effects", []) or []:
        eid = e.get("effectId") or e.get("effect_id") or ""
        out[eid] = {
            "name": e.get("name", ""),
            "bytes": int(e.get("fxbBytes", e.get("fxb_bytes", 0)) or 0),
            "uniforms": list(e.get("uniforms", []) or []),
            "decks": [int(d) for d in (e.get("decks", []) or [])],
        }
    return out


def big_source(terms: int) -> str:
    """An effect whose bytecode grows with `terms` (one uniform-weighted sine per term),
    to store a record near the 4 KiB cap and make the device stage all of it to load it."""
    lines = ["uniform float gain : 0.0 .. 1.0 = 1.0;", "void update() {}", "vec3 shade(Led led) {"]
    lines.append("    float a = 0.0;")
    for i in range(terms):
        lines.append(f"    a = a + sin(led.pos.x * {i + 1}.0 + {i}.5) * 0.01;")
    lines.append("    return vec3(a, gain, 0.1);")
    lines.append("}")
    return "\n".join(lines) + "\n"


def pick_big(sizes: dict[int, int]) -> int | None:
    """The term count whose fxb is the largest still under the cap ({terms: bytes})."""
    ok = [(b, t) for t, b in sizes.items() if 0 < b <= FX_MAX_BYTES]
    return max(ok)[1] if ok else None


def result_line(run: Run, fw: str | None = None, big: int | None = None) -> str:
    by_phase: dict[str, list[bool]] = {}
    for c in run.checks:
        by_phase.setdefault(c.phase, []).append(c.ok)
    parts = [f"{p}={sum(v)}/{len(v)}" for p in PHASES if (v := by_phase.get(p)) is not None]
    if big:
        parts.append(f"big_fxb={big}B")
    if run.skipped:
        parts.append("skipped=" + ",".join(run.skipped))
    return f"RESULT effect_store verdict={verdict(run)} fw={fw} " + " ".join(parts)
