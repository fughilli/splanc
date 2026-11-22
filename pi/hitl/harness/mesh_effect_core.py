"""Pure logic for the mesh M6 `mesh_effect` HITL (docs/design/mesh-m6.md): parsing the
firmware's effect-sharing lines and the gate. No hardware here; unit-tested in
//pi/hitl/tests:test_mesh_effect_core.
"""

from __future__ import annotations

import re

_KV = re.compile(r"(\w+)=(\S+)")
_APPLIED = re.compile(r"\[mesh\] fx applied us=(-?\d+) k=(-?\d+) ms=(-?\d+) load_us=(-?\d+)")
_SCENE = re.compile(r"\[mesh\] scene (have|apply) ")
_GW_APPLY = re.compile(r"\[mesh\] gw share apply ")
_PERSIST = re.compile(r"\[mesh\] shared effect persisted (\S+) (\d+) B us=(\d+)")


def kv(line: str) -> dict[str, str]:
    return dict(_KV.findall(line))


def _num(v: str) -> int | str:
    try:
        return int(v, 0)
    except ValueError:
        return v


def applied(lines: list[str]) -> list[dict]:
    """The render task's staged loads: {us, k (grid frame), ms, load_us}."""
    out = []
    for t in lines:
        if m := _APPLIED.search(t):
            out.append(
                {
                    "us": int(m.group(1)),
                    "k": int(m.group(2)),
                    "ms": int(m.group(3)),
                    "load_us": int(m.group(4)),
                }
            )
    return out


def scenes(lines: list[str]) -> list[dict]:
    """A member's scene lines ("have": fetched and held; "apply": applied), as dicts."""
    out = []
    for t in lines:
        if m := _SCENE.search(t):
            d = {k: _num(v) for k, v in kv(t).items()}
            d["kind"] = m.group(1)
            out.append(d)
    return out


def gw_apply(lines: list[str]) -> list[dict]:
    """The gateway's second phases: have=a/b, fetch_ms, at, local."""
    out = []
    for t in lines:
        if _GW_APPLY.search(t):
            d: dict = {k: _num(v) for k, v in kv(t).items()}
            have = str(d.get("have", "0/0")).split("/")
            d["have_n"], d["of_n"] = int(have[0]), int(have[1]) if len(have) > 1 else 0
            out.append(d)
    return out


def persists(lines: list[str]) -> list[dict]:
    return [
        {"ok": m.group(1) == "ok", "bytes": int(m.group(2)), "us": int(m.group(3))}
        for t in lines
        if (m := _PERSIST.search(t))
    ]


def frame_aligned(per_dut: dict[str, list[dict]]) -> tuple[bool, dict[str, int | None]]:
    """Every DUT loaded the shared effect exactly once, on the same grid frame k."""
    ks = {d: (a[-1]["k"] if a else None) for d, a in per_dut.items()}
    vals = set(ks.values())
    ok = None not in vals and len(vals) == 1 and all(len(a) == 1 for a in per_dut.values())
    return ok and -1 not in vals, ks


def round_ok(r: dict) -> bool:
    """One share round: the direct reply was result_ready, every member answered OK, every
    DUT runs the effect, all switched on one frame, none late."""
    return (
        r.get("reply") == "result_ready"
        and bool(r.get("members"))
        and all(s == "MESH_MEMBER_OK" for s in r["members"].values())
        and all(e == r.get("effect_id") for e in r.get("running", {}).values())
        and len(r.get("running", {})) == r.get("duts", 0)
        and bool(r.get("aligned"))
        and not any(s.get("late") for s in r.get("scenes", {}).values())
    )


def verdict(
    phases: dict[str, dict], max_share_s: float, allow_save_late: bool = True
) -> tuple[bool, list[str]]:
    """The gate. Rounds of shared effects all pass, within `max_share_s` each; the late joiner
    and the rebooted member catch up (effect and uniforms); render never drops below the
    baseline's floor outside effect loads; no resets outside the reboot phase."""
    why: list[str] = []
    sh = phases.get("share", {})
    rounds = sh.get("rounds", [])
    if not rounds:
        why.append("no share rounds")
    for r in rounds:
        if not round_ok(r):
            why.append(f"round {r.get('round')}: {r.get('fail')}")
        elif (r.get("all_ms") or 1e9) > max_share_s * 1000:
            why.append(f"round {r.get('round')}: {r.get('all_ms')} ms to all (> {max_share_s} s)")
    lj = phases.get("late_joiner", {})
    if not lj.get("caught_up"):
        why.append(f"late joiner did not catch up: {lj.get('fail')}")
    if not lj.get("uniforms_match"):
        why.append(f"late joiner's uniforms differ: {lj.get('uniforms')}")
    rb = phases.get("reboot", {})
    if not rb.get("caught_up"):
        why.append(f"rebooted member did not catch up: {rb.get('fail')}")
    for name, p in phases.items():
        if name != "reboot" and p.get("resets"):
            why.append(f"{name}: {p['resets']} reset(s)")
        for d, lates in (p.get("late") or {}).items():
            for x in lates:
                if x.get("save_us") is not None and allow_save_late:
                    continue
                if x.get("effect_load"):
                    continue
                why.append(f"{name}: {d} late frame(s) {x}")
    return (not why), why


_LATE = re.compile(r"\[late\] n=(\d+) max=(\d+) ago_ms=(\d+)")
_FT_LINE = re.compile(r"\[ft\] r\d+:")
_SAVE = re.compile(r"\[mesh\] state (?:saved|erased) |\[mesh\] shared effect persisted |\[upload\]")
_LOAD = re.compile(
    r"\[mesh\] fx applied |\[mesh\] scene apply .*staged=0|\[mesh\] gw share apply .*local=now"
)


def late_frames(lines: list[str]) -> list[dict]:
    """The firmware's `[late]` windows (a render-start interval over 1.5 frame periods),
    attributed: `effect_load` when an effect was loaded in that [ft] window or the one before
    (the load itself: any effect switch, mesh or not, costs its frame), `save_us` (0) when
    a flash write was (a littlefs write stalls the whole chip). Unattributed ones are what
    effect sharing must never cause (transfers, hashing, scenes)."""
    out: list[dict] = []
    cur = {"load": False, "save": False}
    prev = dict(cur)
    # A sharded upload logs only its first window; it writes /lfs/upload.tmp until the
    # reassembled frame is handed on (the gateway's `gw share` line), so the windows in
    # between are flash-write windows too.
    uploading = False
    for t in lines:
        if _LOAD.search(t):
            cur["load"] = True
        if _SAVE.search(t):
            cur["save"] = True
        if "[upload] " in t and "first window" in t:
            uploading = True
        if uploading:
            cur["save"] = True
            if "[mesh] gw share " in t or "[upload] " in t and ("decoded" in t or "NOT" in t):
                uploading = False
        if _FT_LINE.search(t):
            prev, cur = cur, {"load": False, "save": False}
        elif _SAVE.search(t) or _LOAD.search(t):
            # A write (or load) logged after the [late] line of its window, before the
            # next [ft]: it ended there (its log line comes when it is done).
            for x in reversed(out):
                if x.get("_win") != id(prev):
                    break
                if _SAVE.search(t):
                    x["save_us"] = 0
                else:
                    x["effect_load"] = True
        elif m := _LATE.search(t):
            out.append(
                {
                    "n": int(m.group(1)),
                    "max_us": int(m.group(2)),
                    "ago_ms": int(m.group(3)),
                    "effect_load": prev["load"] or cur["load"],
                    "save_us": 0 if (prev["save"] or cur["save"]) else None,
                    "_win": id(prev),
                }
            )
    for x in out:
        x.pop("_win", None)
    return out


_AP = re.compile(r"\[mt\] ap tsf=(\d+) rx=(-?\d+)")


def ap_refs(lines: list[str]) -> list[tuple[int, int]]:
    """(device µs, AP TSF µs) of the rig AP's beacons as this DUT heard them (`[mt] ap`):
    every DUT hears one beacon at the same instant, so they map device time onto one clock."""
    return [(int(m.group(2)), int(m.group(1))) for t in lines if (m := _AP.search(t))]


def on_ap_clock(refs: list[tuple[int, int]], us: int, max_gap_us: int = 3_000_000) -> int | None:
    """Device time `us` on the AP's clock, from the beacon heard nearest to it."""
    best = min(refs, key=lambda r: abs(r[0] - us), default=None)
    if best is None or abs(best[0] - us) > max_gap_us:
        return None
    return best[1] + (us - best[0])


def apply_skew(
    per_dut: dict[str, list[dict]], refs: dict[str, list[tuple[int, int]]]
) -> int | None:
    """The spread (µs) of the DUTs' effect loads on the AP clock (None: not measurable)."""
    ts = []
    for d, a in per_dut.items():
        if not a:
            return None
        t = on_ap_clock(refs.get(d, []), a[-1]["us"])
        if t is None:
            return None
        ts.append(t)
    return max(ts) - min(ts) if ts else None
