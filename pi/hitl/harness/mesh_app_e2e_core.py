"""Pure logic for the `mesh_app_e2e` HITL: the real web app (headless Chromium) drives three
C6s through the mesh flow. Parses the DUTs' serial lines into the observables the gate
needs and makes the verdict. No hardware, no browser here; unit-tested in
//pi/hitl/tests:test_mesh_app_e2e_core.
"""

from __future__ import annotations

import re

from mesh_effect_core import ap_refs, applied, on_ap_clock

_UNLOCK = re.compile(r"\[mesh\] unlock conn=(\d+) session=(\d+) not_after=(\d+) -> (\w+)")
_MT_APPLY = re.compile(r"\[mt\] apply us=(-?\d+) k=(-?\d+) ms=(-?\d+)")
_RESET = re.compile(r"rst:0x|ESP-ROM:|boot:0x")
_LATE = re.compile(r"\[late\] n=(\d+) max=(\d+) ago_ms=(\d+)")
_FT = re.compile(r"\[ft\] r\d+:")
# What can cost a frame, by cause. A line is logged when the work is done, so a cause seen
# in the [ft] window of a [late] line, the window before it, or right after it (before the
# next [ft]) is that late frame's cause.
_CAUSES = (
    (
        "effect_load",
        re.compile(
            r"\[mesh\] fx applied |\[mesh\] scene apply .*staged=0|"
            r"\[mesh\] gw share apply .*local=now|effect loaded|fx_load"
        ),
    ),
    (
        "flash_write",
        re.compile(
            r"\[mesh\] state (?:saved|erased) |\[mesh\] shared effect persisted |"
            r"\[fs\] wrote |\[upload\](?!.*\(ram\))|nvs"
        ),
    ),
    ("tls", re.compile(r"TLS HANDSHAKE COMPLETE|TLS hs state ->")),
)


def unlocks(lines: list[str]) -> list[dict]:
    """The gateway's `[mesh] unlock` lines: the app's grants and whether each was taken."""
    out = []
    for t in lines:
        if m := _UNLOCK.search(t):
            out.append(
                {
                    "conn": int(m.group(1)),
                    "session": int(m.group(2)),
                    "not_after": int(m.group(3)),
                    "ok": m.group(4) == "ok",
                }
            )
    return out


def mt_applies(lines: list[str]) -> list[dict]:
    """Scheduled control changes applied on a frame (`[mt] apply`, the dev image's
    observable): brightness, effect switches, crossfades sent with a lead."""
    return [
        {"us": int(m.group(1)), "k": int(m.group(2)), "ms": int(m.group(3))}
        for t in lines
        if (m := _MT_APPLY.search(t))
    ]


def spread_on_ap(
    per_dut: dict[str, list[dict]], refs: dict[str, list[tuple[int, int]]]
) -> tuple[int | None, dict[str, int | None]]:
    """(spread µs on the AP clock of each DUT's LAST event, each DUT's grid frame k).
    None when a DUT has no event or no beacon near it."""
    ts, ks = [], {}
    for d, evs in per_dut.items():
        ks[d] = evs[-1]["k"] if evs else None
        if not evs:
            return None, ks
        t = on_ap_clock(refs.get(d, []), evs[-1]["us"])
        if t is None:
            return None, ks
        ts.append(t)
    return (max(ts) - min(ts) if ts else None), ks


def same_frame(
    per_dut: dict[str, list[dict]],
    refs: dict[str, list[tuple[int, int]]],
    max_skew_us: int,
) -> dict:
    """One whole-mesh change: every DUT applied it once, within one frame on the AP clock.
    Grid k is reported but not gated: it differs when the DUTs' fps differ (the fps
    autoscaler restarts after every effect load)."""
    skew, ks = spread_on_ap(per_dut, refs)
    once = bool(per_dut) and all(len(v) == 1 for v in per_dut.values())
    return {
        "k": ks,
        "skew_us": skew,
        "counts": {d: len(v) for d, v in per_dut.items()},
        "ok": once and skew is not None and skew <= max_skew_us,
    }


def fx_same_frame(lines: dict[str, list[str]], max_skew_us: int) -> dict:
    """A shared effect (`[mesh] fx applied`) on every DUT on one frame."""
    per = {d: applied(ls) for d, ls in lines.items()}
    refs = {d: ap_refs(ls) for d, ls in lines.items()}
    return same_frame(per, refs, max_skew_us)


def mt_same_frame(lines: dict[str, list[str]], max_skew_us: int) -> dict:
    """A scheduled change (`[mt] apply`) on every DUT on one frame."""
    per = {d: mt_applies(ls) for d, ls in lines.items()}
    refs = {d: ap_refs(ls) for d, ls in lines.items()}
    return same_frame(per, refs, max_skew_us)


def late_report(phase: str, dut: str, lines: list[str]) -> list[dict]:
    """Every `[late]` window in `lines` with its cause: `effect_load` (an effect switched on
    that frame), `flash_write` (a littlefs/NVS write stalls the chip), `tls` (a TLS server
    handshake: an app connecting), `boot` (the first seconds after a reset), or
    `unattributed`. Nothing is dropped: the owner rule is no blipping, so every late frame
    is reported."""
    boot_until = -1
    out: list[dict] = []
    cur: set[str] = set()
    prev: set[str] = set()
    open_: list[dict] = []  # late lines of the current window (a cause may log after them)
    for i, t in enumerate(lines):
        if _RESET.search(t):
            boot_until = i + 400  # the boot log: Wi-Fi join, TLS key load, fs mount
        hit = {name for name, rx in _CAUSES if rx.search(t)}
        cur |= hit
        for x in open_:
            x["_c"] |= hit
        if _FT.search(t):
            prev, cur, open_ = cur, set(), []
        elif m := _LATE.search(t):
            x = {
                "phase": phase,
                "dut": dut,
                "n": int(m.group(1)),
                "max_us": int(m.group(2)),
                "line": i,
                "_c": prev | cur,
                "_boot": i <= boot_until,
            }
            out.append(x)
            open_.append(x)
    for x in out:
        c = x.pop("_c")
        boot = x.pop("_boot")
        x["cause"] = (
            "boot" if boot else next((name for name, _ in _CAUSES if name in c), "unattributed")
        )
    return out


def late_summary(lates: list[dict]) -> dict:
    """Totals per DUT and per cause (frames, not windows)."""
    by_dut: dict[str, int] = {}
    by_cause: dict[str, int] = {}
    for x in lates:
        by_dut[x["dut"]] = by_dut.get(x["dut"], 0) + x["n"]
        by_cause[x["cause"]] = by_cause.get(x["cause"], 0) + x["n"]
    return {"frames": sum(by_dut.values()), "by_dut": by_dut, "by_cause": by_cause}


def last_change_ok(rows: list[dict], want: int) -> bool:
    """The app's "Last change sent to the mesh": `want` fixtures, every one reached."""
    return len(rows) >= want and all(r.get("ok") for r in rows)


def verdict(record: dict, strict_late: bool = False) -> tuple[bool, list[str]]:
    """The gate. Every step reached its end state; whole-mesh changes landed on one frame
    (effect, brightness) and every fixture answered; eject, re-add and reboot left all
    three in the mesh with the current effect. Late frames are reported; with
    `strict_late` any outside boot fails (owner rule: no blipping)."""
    why: list[str] = []
    steps = record.get("steps", {})
    for name, s in steps.items():
        if not s.get("ok"):
            why.append(f"{name}: {s.get('fail') or 'not reached'}")
    if not steps:
        why.append("no steps ran")
    for err, v in (record.get("errors") or {}).items():
        why.append(f"{err} raised {v}")
    if strict_late:
        for x in record.get("late", []):
            if x["cause"] != "boot":
                why.append(f"late frame: {x}")
    return (not why), why


_ONEOF_FIELD = re.compile(r"^\s+(\w+)\s+(\w+)\s*=\s*(\d+);")


def client_arms(proto_text: str) -> dict[int, str]:
    """ClientMessage's arms by field number, from ledmapper.proto."""
    out: dict[int, str] = {}
    body = proto_text.split("message ClientMessage {", 1)[-1]
    depth = 1
    for line in body.splitlines():
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            break
        if m := _ONEOF_FIELD.match(line):
            out[int(m.group(3))] = m.group(2)
    return out


def _field(hexs: str) -> int | None:
    """The first protobuf tag's field number of a frame (its ClientMessage arm)."""
    v, shift = 0, 0
    for i in range(0, min(len(hexs), 10), 2):
        b = int(hexs[i : i + 2], 16)
        v |= (b & 0x7F) << shift
        shift += 7
        if b < 0x80:
            return v >> 3
    return None


def app_requests(frames: list[tuple[float, str, int, str]], arms: dict[int, str]) -> list[str]:
    """What the app asked the fixture just before a late frame: (dt ms, tx/rx, bytes, hex)
    frames -> the arms of the requests sent in the 200 ms before it."""
    out = []
    for dt, kind, _n, h in frames:
        if kind == "tx" and -200 <= dt <= 20:
            f = _field(h)
            name = arms.get(f, f"field {f}") if f is not None else "?"
            if name not in out:
                out.append(name)
    return out
