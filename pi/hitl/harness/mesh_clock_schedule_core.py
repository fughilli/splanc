"""Pure logic for the `mesh_clock_schedule` HITL (RTC PR-8, docs/design/schedule.md "On a
mesh"): the gateway's wall clock reaches a member with no clock of its own as the mesh's
`CLOCK` record, and a group's schedule, written once through the gateway, fires on the same
grid frame on both lamps. No hardware here; unit-tested in
//pi/hitl/tests:test_mesh_clock_schedule_core.

The references:
- **the harness's UTC** (an NTP-disciplined host) for "on time": each DUT logs the wall
  time of the frame a rule applied on (`[sched] applied ... unix_ms=`), the gateway on the
  clock the harness set, the member on the clock it took from the mesh;
- **the grid frame** for "the same frame": each DUT logs the show-epoch grid frame a
  scheduled change applied on (`[mt] apply us= k=`, the meshdev image, as
  `mesh_apply_at_skew`) and the frame the rule was mapped to (`[sched] mesh id= k=`);
- **the rig AP's beacons** for the skew in µs (`[mt] ap`: every DUT hears one beacon at
  the same instant), when both DUTs logged them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from mesh_apply_at_skew_core import ApPair, Apply, to_ap_time
from schedule_core import Applied

# One frame at the autoscaler's floor (25 fps) after the instant, plus the clocks' error
# against the harness (the gateway's push error + the host's), as schedule_core.
FRAME_MS = 40.0
CLOCK_SLACK_MS = 10.0
# Two DUTs on the same grid frame start it within this (mesh_apply_at_skew's gate).
SKEW_GATE_US = 10_000.0

_MESH = re.compile(r"\[sched\] mesh id=(\d+) k=(-?\d+)")
_TAKEN = re.compile(r"\[mt\] clock taken gen=(\d+) origin=([0-9a-f]+)")
_SENT = re.compile(r"\[mt\] clock sent gen=(\d+)")

MESH_SOURCES = ("CLOCK_SOURCE_MESH", "2", 2)


def mesh_frames(lines: list[str]) -> dict[int, int]:
    """Rule id -> the grid frame it was mapped to (`[sched] mesh id= k=`; the last one)."""
    out: dict[int, int] = {}
    for t in lines:
        if m := _MESH.search(t):
            out[int(m[1])] = int(m[2])
    return out


def clock_taken(lines: list[str]) -> list[tuple[int, int]]:
    """(gen, origin) of each `[mt] clock taken` line (a member took the mesh's record)."""
    return [(int(m[1]), int(m[2], 16)) for t in lines if (m := _TAKEN.search(t))]


def clock_sent(lines: list[str]) -> int:
    """How many `[mt] clock sent` lines (a gateway sent its record)."""
    return sum(1 for t in lines if _SENT.search(t))


@dataclass
class DutRule:
    """One DUT's view of one rule: its `[sched] applied` line, the grid frame the mesh
    mapping chose, and the `[mt] apply` line of the frame it landed on."""

    applied: Applied | None = None
    mesh_k: int | None = None
    apply: Apply | None = None

    def frame_k(self) -> int | None:
        return self.apply.k if self.apply else None


def match_apply(applied: Applied, applies: list[Apply], device_ms_of_us) -> Apply | None:
    """The `[mt] apply` line of the frame `applied` landed on: the apply whose device ms is
    the applied frame's (`at_ms`, the grid ms) within one frame."""
    best = None
    for a in applies:
        d = abs(device_ms_of_us(a.us) - applied.at_ms)
        if d <= FRAME_MS and (best is None or d < best[0]):
            best = (d, a)
    return best[1] if best else None


@dataclass
class Report:
    # The rules' instants (harness UTC ms), by rule id.
    targets: dict[int, float] = field(default_factory=dict)
    # Per DUT label ("gw", "member"), per rule id.
    rules: dict[str, dict[int, DutRule]] = field(default_factory=dict)
    # Their AP-beacon pairs (`[mt] ap`), per DUT.
    ap: dict[str, list[ApPair]] = field(default_factory=dict)
    gw_err_ms: float = 0.0
    member_source_before: str = ""
    member_source: str = ""
    member_err_ms: float | None = None
    member_delta_ms: float | None = None  # its clock vs the harness's UTC at a get_clock
    member_listed_source: str = ""  # the gateway's get_mesh entry for it
    taken: list[tuple[int, int]] = field(default_factory=list)
    sent: int = 0
    fanout: dict = field(default_factory=dict)  # the mesh_send result
    render: dict[str, dict] = field(default_factory=dict)
    late: dict[str, list[dict]] = field(default_factory=dict)

    def skew_us(self, rule: int) -> float | None:
        """The two DUTs' apply instants on the AP's clock, apart (µs)."""
        ts = []
        for label, rs in self.rules.items():
            r = rs.get(rule)
            if not r or not r.apply:
                return None
            t = to_ap_time(self.ap.get(label, []), r.apply.us)
            if t is None:
                return None
            ts.append(t)
        return max(ts) - min(ts) if len(ts) == 2 else None


def on_time(unix_ms: float, target_ms: float, err_ms: float) -> tuple[bool, str]:
    d = unix_ms - target_ms
    slack = err_ms + CLOCK_SLACK_MS
    ok = -slack <= d <= FRAME_MS + slack
    return ok, f"{d:+.0f} ms from its instant (allowed {-slack:.0f}..{FRAME_MS + slack:.0f})"


def verdict(rep: Report) -> tuple[str, list[str]]:
    """PASS:
    - the member (no clock of its own) took the gateway's record: `[mt] clock taken`, its
      get_clock reports source MESH, within its own error of the harness's UTC, and the
      gateway lists it as MESH;
    - the group's set_schedule reached the member (the mesh_send result: OK);
    - every rule applied on both DUTs on time (vs the harness's UTC), on the grid frame the
      mapping chose, and on the SAME grid frame on both (skew on the AP's clock under 10 ms
      when measurable);
    - render ran on both, with no late frame the mesh or the schedule caused."""
    why: list[str] = []
    if not rep.taken:
        why.append("member: no `[mt] clock taken` (the mesh's record never arrived)")
    if rep.member_source not in MESH_SOURCES:
        why.append(f"member: clock source {rep.member_source or 'none'}, expected MESH")
    if rep.member_delta_ms is not None and rep.member_err_ms is not None:
        if abs(rep.member_delta_ms) > rep.member_err_ms + CLOCK_SLACK_MS:
            why.append(
                f"member: clock {rep.member_delta_ms:+.0f} ms off UTC, outside its ±{rep.member_err_ms:.0f} ms"
            )
    if rep.member_listed_source not in MESH_SOURCES:
        why.append(f"gateway lists the member's clock as {rep.member_listed_source or 'nothing'}")
    st = [m.get("status") for m in rep.fanout.get("members") or []]
    if not st or any(s not in ("MESH_MEMBER_OK", 0, "0", None) for s in st):
        why.append(f"set_schedule fan-out: {rep.fanout or 'no result'}")
    if len(rep.rules) != 2:
        why.append(f"rules from {sorted(rep.rules)} only")
    for rule, target in sorted(rep.targets.items()):
        ks = {}
        for label, rs in sorted(rep.rules.items()):
            r = rs.get(rule)
            if r is None or r.applied is None:
                why.append(f"{label}: rule {rule} not applied")
                continue
            # The member's own error bound already holds the gateway's.
            err = rep.gw_err_ms if label == "gw" else max(rep.gw_err_ms, rep.member_err_ms or 0.0)
            ok, msg = on_time(r.applied.unix_ms, target, err)
            if not ok:
                why.append(f"{label}: rule {rule} {msg}")
            if r.mesh_k is None:
                why.append(f"{label}: rule {rule} was not mapped through the mesh's record")
            elif r.mesh_k < 0:
                why.append(f"{label}: rule {rule} mapped off the frame grid (no show epoch)")
            if r.apply is None:
                why.append(f"{label}: rule {rule}: no `[mt] apply` line for its frame")
            else:
                ks[label] = r.apply.k
                if r.mesh_k is not None and r.apply.k != r.mesh_k:
                    why.append(
                        f"{label}: rule {rule} landed on frame {r.apply.k}, mapped to {r.mesh_k}"
                    )
        if len(ks) == 2 and len(set(ks.values())) != 1:
            why.append(f"rule {rule}: different grid frames {ks}")
        s = rep.skew_us(rule)
        if s is not None and s > SKEW_GATE_US:
            why.append(f"rule {rule}: applied {s:.0f} µs apart on the AP's clock")
    for label in ("gw", "member"):
        r = rep.render.get(label) or {}
        if not r.get("windows"):
            why.append(f"{label}: no [ft] line: render not running")
        bad = [
            x
            for x in rep.late.get(label, [])
            if x.get("save_us") is None and not x.get("effect_load") and not x.get("tls")
        ]
        if bad:
            why.append(
                f"{label}: {sum(x['n'] for x in bad)} late frame(s) not from a flash write, load or TLS"
            )
    return ("PASS" if not why else "FAIL"), why
