"""Pure logic for the mesh M3 HITL test (hitl_mesh_smoke.py; docs/design/mesh.md §14.2,
§15 M3): parse the firmware's `[mesh] ...` and `[ft] ...` console lines, reduce each phase
to numbers, and judge them. No I/O, unit-tested (//pi/hitl/tests:test_mesh_smoke_core).

The firmware side is mesh_glue.h / mesh_ffi.rs (the console it prints is documented there).
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from mesh_spike_core import parse_line

# Gates (the M3 PR's; see verdict()).
FORM_MAX_S = 15.0  # every DUT lists every other as a member neighbour within this of its key
DELIVERY_MIN = 0.99  # what must arrive (ACKed unicast fan-out, end-to-end unicast)
REJOIN_MAX_S = 45.0  # a DUT that re-joined the AP is back in everyone's table within this
FPS_MIN_RATIO = 0.95  # render rate with the mesh on, vs off (median of the [ft] windows)
NEIGHBOUR_FRESH_MS = 3000  # an advert seen this recently counts as present

_FT = re.compile(
    r"\[ft\] r(?P<rn>\d+):(?P<rmin>\d+)/(?P<rmean>\d+)/(?P<rmax>\d+) "
    r"w(?P<wn>\d+):(?P<wmin>\d+)/(?P<wmean>\d+)/(?P<wmax>\d+) dt(?P<dt>\d+) fps=(?P<fps>\d+)"
)
_LEASE = re.compile(
    r"DHCP LEASE ACQUIRED .*?IP (\d+\.\d+\.\d+\.\d+)|PROV re-received at IP (\d+\.\d+\.\d+\.\d+)"
)
_RESET = re.compile(r"rst:0x|ESP-ROM:|=== boot ===")


def lease_ip(line: str) -> str | None:
    m = _LEASE.search(line)
    return (m.group(1) or m.group(2)) if m else None


def is_reset(line: str) -> bool:
    """A boot banner: the DUT reset (the owner's rule: never, for anything recoverable)."""
    return bool(_RESET.search(line))


@dataclass
class Neighbour:
    id: str
    rssi: int
    rssi_avg: int
    age_ms: int
    first_ms: int
    rx: int
    tx_ok: int
    tx_fail: int
    retries: int
    ch: int
    advert: bool
    advert_age_ms: int

    @staticmethod
    def from_kv(kv: dict[str, str]) -> "Neighbour":
        return Neighbour(
            id=kv["id"],
            rssi=int(kv["rssi"]),
            rssi_avg=int(kv["rssi_avg"]),
            age_ms=int(kv["age_ms"]),
            first_ms=int(kv["first_ms"]),
            rx=int(kv["rx"]),
            tx_ok=int(kv["tx_ok"]),
            tx_fail=int(kv["tx_fail"]),
            retries=int(kv["retries"]),
            ch=int(kv["ch"]),
            advert=kv.get("advert") == "1",
            advert_age_ms=int(kv.get("advert_age_ms", "-1")),
        )

    def present(self) -> bool:
        """In the link table AND advertising as a member, recently."""
        return (
            self.advert
            and 0 <= self.advert_age_ms < NEIGHBOUR_FRESH_MS
            and self.age_ms < NEIGHBOUR_FRESH_MS
        )


def neighbours(lines: list[str]) -> dict[str, Neighbour]:
    """The `[mesh] nb ...` lines of one `MESH NB` reply, by node id."""
    out = {}
    for t in lines:
        p = parse_line(t)
        if p and p[0] == "nb":
            try:
                n = Neighbour.from_kv(p[1])
            except (KeyError, ValueError):
                continue
            out[n.id] = n
    return out


def formed(nb: dict[str, Neighbour], expect: list[str]) -> bool:
    return all(i in nb and nb[i].present() for i in expect)


def rx_counters(lines: list[str]) -> dict[tuple[str, int], dict[str, int]]:
    """`[mesh] testrx from=… tag=… uniq=… dups=…` lines -> {(from, tag): counters}."""
    out = {}
    for t in lines:
        p = parse_line(t)
        if p and p[0] == "testrx" and "from" in p[1]:
            kv = p[1]
            try:
                out[(kv["from"], int(kv["tag"]))] = {
                    k: int(kv[k]) for k in ("uniq", "dups", "max_seq", "port")
                }
            except (KeyError, ValueError):
                continue
    return out


def kv_line(lines: list[str], kind: str) -> dict[str, str]:
    """The last `[mesh] <kind> ...` line's fields."""
    out: dict[str, str] = {}
    for t in lines:
        p = parse_line(t)
        if p and p[0] == kind:
            out = p[1]
    return out


def ints(kv: dict[str, str]) -> dict[str, int]:
    out = {}
    for k, v in kv.items():
        try:
            out[k] = int(v)
        except ValueError:
            pass
    return out


def ft_windows(lines: list[str]) -> list[dict[str, int]]:
    out = []
    for t in lines:
        m = _FT.search(t)
        if m:
            out.append({k: int(v) for k, v in m.groupdict().items()})
    return out


def render(lines: list[str], skip: int = 1) -> dict:
    """Render cadence over a phase from its [ft] windows (the first `skip` dropped: the
    console attach and phase start disturb them, wifi-cadence notes)."""
    w = [x for x in ft_windows(lines) if x["rn"] > 0][skip:]
    if not w:
        return {"windows": 0}
    return {
        "windows": len(w),
        "fps_median": statistics.median(x["fps"] for x in w),
        "fps_min": min(x["fps"] for x in w),
        "render_mean_us": round(statistics.mean(x["rmean"] for x in w)),
        "render_max_us": max(x["rmax"] for x in w),
        "dt_max_ms": max(x["dt"] for x in w),
    }


@dataclass
class Delivery:
    name: str
    sent: int
    got: dict[str, int] = field(default_factory=dict)  # receiver label -> unique packets
    dups: dict[str, int] = field(default_factory=dict)

    def ratio(self) -> float:
        if not self.sent or not self.got:
            return 0.0
        return min(self.got.values()) / self.sent

    def row(self) -> dict:
        return {
            "name": self.name,
            "sent": self.sent,
            "got": self.got,
            "dups": self.dups,
            "delivery": round(self.ratio(), 4),
        }


@dataclass
class Results:
    formation_s: dict[str, float] = field(default_factory=dict)  # per DUT, from its key
    deliveries: dict[str, Delivery] = field(default_factory=dict)
    gated: list[str] = field(default_factory=list)  # delivery names that must reach DELIVERY_MIN
    replay: dict = field(
        default_factory=dict
    )  # {"replayed": n, "dup_delta": {label: n}, "extra_rx": n}
    wrong_key: dict = field(
        default_factory=dict
    )  # {"bad_mic_delta": {label: n}, "leaked": n, "joined": bool}
    rejoin: dict = field(default_factory=dict)  # {"back_s": s, "after": ratio, "gap_ok": bool}
    render_off: dict[str, dict] = field(default_factory=dict)
    render_on: dict[str, dict] = field(default_factory=dict)
    resets: dict[str, list[str]] = field(default_factory=dict)
    heap: dict[str, dict] = field(default_factory=dict)


def verdict(r: Results) -> tuple[bool, list[str]]:
    why = []
    for d, s in r.formation_s.items():
        if s is None or s > FORM_MAX_S:
            why.append(f"{d}: mesh not formed within {FORM_MAX_S:.0f} s ({s})")
    for name in r.gated:
        d = r.deliveries.get(name)
        if not d:
            why.append(f"{name}: not measured")
        elif d.ratio() < DELIVERY_MIN:
            why.append(f"{name}: delivery {d.ratio():.3f} < {DELIVERY_MIN}")
    if r.replay:
        if r.replay.get("extra_rx", 1) != 0:
            why.append(f"replay: replayed frames delivered ({r.replay.get('extra_rx')})")
        if not all(v > 0 for v in r.replay.get("dup_delta", {}).values()):
            why.append(
                f"replay: not every receiver rejected the replays ({r.replay.get('dup_delta')})"
            )
    else:
        why.append("replay: not run")
    if r.wrong_key:
        if r.wrong_key.get("leaked", 1) != 0:
            why.append(f"wrong key: a wrong-key node got {r.wrong_key.get('leaked')} packets")
        if r.wrong_key.get("joined"):
            why.append("wrong key: the wrong-key node became a member")
        if not all(v > 0 for v in r.wrong_key.get("bad_mic_delta", {}).values()):
            why.append(
                f"wrong key: its frames were not MIC-rejected ({r.wrong_key.get('bad_mic_delta')})"
            )
    else:
        why.append("wrong key: not run")
    if r.rejoin:
        back = r.rejoin.get("back_s")
        if back is None or back > REJOIN_MAX_S:
            why.append(f"rejoin: not back in the mesh within {REJOIN_MAX_S:.0f} s ({back})")
        if r.rejoin.get("after", 0.0) < DELIVERY_MIN:
            why.append(f"rejoin: delivery after {r.rejoin.get('after')} < {DELIVERY_MIN}")
    else:
        why.append("rejoin: not run")
    for d, on in r.render_on.items():
        off = r.render_off.get(d, {})
        if not on.get("windows") or not off.get("windows"):
            why.append(f"{d}: no render cadence lines (effect not running?)")
            continue
        if on["fps_median"] < FPS_MIN_RATIO * off["fps_median"]:
            why.append(
                f"{d}: render {on['fps_median']} fps with the mesh on vs {off['fps_median']} off"
            )
    for d, lines in r.resets.items():
        if lines:
            why.append(f"{d}: reset during the run ({lines[0][:80]})")
    return not why, why


def markdown(r: Results, units: dict[str, str]) -> str:
    ok, why = verdict(r)
    out = ["| | " + " | ".join(units) + " |", "|---|" + "---|" * len(units)]
    out.append(
        "| formation (s) | " + " | ".join(f"{r.formation_s.get(d, '?')}" for d in units) + " |"
    )
    for d, label in (("render_off", "fps off"), ("render_on", "fps on")):
        m = getattr(r, d)
        out.append(
            f"| {label} | "
            + " | ".join(str(m.get(u, {}).get("fps_median", "?")) for u in units)
            + " |"
        )
    out.append("")
    out.append("| delivery | sent | per receiver | ratio |")
    out.append("|---|---|---|---|")
    for name, dv in r.deliveries.items():
        got = ", ".join(f"{k} {v}" for k, v in dv.got.items())
        gate = " (gated)" if name in r.gated else ""
        out.append(f"| {name}{gate} | {dv.sent} | {got} | {dv.ratio():.3f} |")
    out.append("")
    out.append(
        f"replay: {r.replay}  \nwrong key: {r.wrong_key}  \nrejoin: {r.rejoin}  \nheap: {r.heap}"
    )
    out.append("")
    out.append(f"**{'PASS' if ok else 'FAIL'}**" + ("" if ok else ": " + "; ".join(why)))
    return "\n".join(out) + "\n"
