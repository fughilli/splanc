"""Pure analysis for `mesh_gateway` (mesh M5, docs/design/mesh.md §8): a client on one DUT (the
gateway) changes effect, sliders and brightness on every DUT through the mesh.

- **Apply skew** uses M4's reference (mesh_apply_at_skew_core): every member logs, once per
  AP-TSF second, the AP beacon's TSF against its own clock, and `[mt] apply us=` at the
  start of the frame that applied a scheduled change. Each apply maps onto the AP's TSF
  through that member's own (rx, tsf) pairs. Rounds are found by clustering those AP
  instants (a round's applies land within milliseconds; rounds are >= 1 s apart), so the
  same analysis serves the wss phase and the BLE phase, whose sends are timed in the rig
  container, not here.
- **Per-member results**: the gateway's pushed `MeshResult` (decoded by the driver) and its
  `[mesh] gw result` log lines.
- **Refusals**: `[mesh] ctl refused op=.. arm=..` on every member for each disallowed arm.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from mesh_apply_at_skew_core import ApPair, Apply, _pct, to_ap_time

GATE_MS = 10.0
# A round counts if every member applied it (a DUT that misses one is a failure to report,
# not a skew to average away).
_REFUSED = re.compile(r"\[mesh\] ctl refused op=(\d+) arm=(\d+) from=([0-9a-f]+)")
_GW_RESULT = re.compile(r"\[mesh\] gw result op=(\d+) n=(\d+) ok=(\d+) complete=(\d)")
_KV = re.compile(r"(\w+)=(-?\d+)")


def kv(text: str) -> dict[str, int]:
    return {k: int(v) for k, v in _KV.findall(text)}


@dataclass
class Cluster:
    """One round: each member's apply instant on the AP's TSF (µs), and its frame index."""

    ap_us: dict[str, float] = field(default_factory=dict)
    k: dict[str, int] = field(default_factory=dict)

    def complete(self, labels: list[str]) -> bool:
        return all(x in self.ap_us for x in labels)

    def skew_us(self) -> float:
        v = list(self.ap_us.values())
        return max(v) - min(v) if len(v) > 1 else 0.0

    def same_frame(self) -> bool:
        return len(set(self.k.values())) == 1


def cluster_rounds(
    apps: dict[str, list[Apply]],
    pairs: dict[str, list[ApPair]],
    gap_us: float = 400_000.0,
) -> list[Cluster]:
    """Group every member's applies into rounds by their AP time (a new round starts after
    `gap_us` without an apply). A member with two applies in one round keeps the first."""
    pts = []
    for label, v in apps.items():
        for a in v:
            t = to_ap_time(pairs.get(label, []), a.us)
            if t is not None:
                pts.append((t, label, a.k))
    pts.sort()
    out: list[Cluster] = []
    last = None
    for t, label, k in pts:
        if last is None or t - last > gap_us:
            out.append(Cluster())
        c = out[-1]
        if label not in c.ap_us:
            c.ap_us[label] = t
            c.k[label] = k
        last = t
    return out


def skew_stats(cs: list[Cluster], labels: list[str], expected: int) -> dict:
    full = [c for c in cs if c.complete(labels)]
    sk = [c.skew_us() for c in full]
    out: dict = {
        "rounds": expected,
        "clusters": len(cs),
        "measured": len(full),
        "partial": len(cs) - len(full),
        "same_frame": sum(1 for c in full if c.same_frame()),
    }
    if sk:
        out.update(
            {
                "skew_median_us": statistics.median(sk),
                "skew_p95_us": _pct(sk, 95),
                "skew_max_us": max(sk),
            }
        )
    return out


def refusals(lines: list[str]) -> list[dict]:
    out = []
    for t in lines:
        m = _REFUSED.search(t)
        if m:
            out.append({"op": int(m.group(1)), "arm": int(m.group(2)), "from": m.group(3)})
    return out


def gw_results(lines: list[str]) -> dict[int, dict]:
    """`[mesh] gw result` lines by op id."""
    out = {}
    for t in lines:
        m = _GW_RESULT.search(t)
        if m:
            op = int(m.group(1))
            out[op] = {
                "n": int(m.group(2)),
                "ok": int(m.group(3)),
                "complete": m.group(4) == "1",
                "line": t[t.index("[mesh]") :],
            }
    return out


def member_results(result: dict | None) -> dict:
    """A decoded `MeshResult` (proto JSON names): {node: (status, code, latency_ms)}."""
    out = {}
    for m in (result or {}).get("members", []) or []:
        out[m.get("node", 0)] = (
            m.get("status", "MESH_MEMBER_OK"),
            m.get("code", 0),
            m.get("latency_ms", m.get("latencyMs", 0)),
        )
    return out


def all_ok(result: dict | None, expect: int) -> bool:
    r = member_results(result)
    return len(r) >= expect and all(s == "MESH_MEMBER_OK" for s, _, _ in r.values())


def latency_summary(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0}
    return {
        "n": len(xs),
        "median_ms": round(statistics.median(xs), 1),
        "p95_ms": round(_pct(xs, 95), 1),
        "max_ms": round(max(xs), 1),
    }


def verdict(phases: dict[str, dict], members: int) -> tuple[bool, list[str]]:
    """The gate:
    - every phase with scheduled rounds: >= 90 % of rounds applied on every DUT, worst skew
      < 10 ms;
    - control results: every member answered OK in >= 90 % of the want_reply sends;
    - refusals: every disallowed arm refused by every member (and none dispatched), and the
      gateway refused one itself;
    - live moves: every member dispatched >= 90 % of them;
    - the show clock: a member's own set_time_base was refused (desk #79);
    - render fps with the mesh on not below the baseline - 2 (except a phase that loads an
      effect: the autoscaler restarts its search, `fps_exempt`), no resets.
    """
    why: list[str] = []
    base_fps = phases.get("baseline", {}).get("fps_min")
    for name, p in phases.items():
        s = p.get("skew") or {}
        if s.get("rounds"):
            if s.get("measured", 0) < 0.9 * s["rounds"]:
                why.append(
                    f"{name}: {s.get('measured', 0)}/{s['rounds']} rounds applied on every DUT"
                )
            if s.get("skew_max_us", 0) >= GATE_MS * 1000:
                why.append(f"{name}: skew {s['skew_max_us'] / 1000:.2f} ms >= {GATE_MS} ms")
        res = p.get("results")
        if res is not None and res.get("sent"):
            if res.get("all_ok", 0) < 0.9 * res["sent"]:
                why.append(f"{name}: every member OK in {res.get('all_ok', 0)}/{res['sent']} sends")
        ref = p.get("refused")
        if ref is not None:
            for arm, by in ref.get("by_arm", {}).items():
                if len(by) < members:
                    why.append(f"{name}: arm {arm} refused by {len(by)}/{members} members")
            if ref.get("dispatched"):
                why.append(f"{name}: a disallowed arm was dispatched: {ref['dispatched']}")
            if not ref.get("gateway_refused"):
                why.append(f"{name}: the gateway did not refuse a disallowed mesh_send")
        live = p.get("live")
        if live is not None:
            for k, d in live.get("dispatched", {}).items():
                if d < 0.9 * live["sent"]:
                    why.append(f"{name}: member {k} dispatched {d}/{live['sent']} live moves")
        if "epoch_refused" in p and not p["epoch_refused"]:
            why.append(f"{name}: a member started a show epoch (desk #79 says only the gateway)")
        if (
            base_fps is not None
            and p.get("fps_min") is not None
            and name != "baseline"
            and not p.get("fps_exempt")
        ):
            if p["fps_min"] < base_fps - 2:
                why.append(f"{name}: render {p['fps_min']} fps < baseline {base_fps} - 2")
        if p.get("resets"):
            why.append(f"{name}: {p['resets']} reset(s)")
    return (not why, why)
