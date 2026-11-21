"""Pure logic for the netstack "rename leaves the mDNS listing" HITL gate
(hitl_mdns_rename.py, PR #510).

The field report: after `set_device_name`, `dns-sd -B _splanc._tcp` kept listing the old
name for 9+ minutes and only showed the new one about a minute later. The fix sends a
goodbye (TTL 0) for the old service records and re-announces under the new name once no
wss session is open. What a browser shows is its cache, which only that traffic changes,
so the gate watches two things from the rig's reservation container:

  * the multicast group (224.0.0.251:5353): after the rename, a packet from the DUT
    carrying the OLD instance's PTR with TTL 0 (the goodbye) and an announcement of the
    NEW instance with TTL > 0. The rig container is routed rather than bridged on some
    rigs, so the group may be invisible; then that half is reported as not observable
    rather than failed;
  * legacy-unicast PTR queries to <dut>:5353 once a second: the responder must answer
    with the new name and never the old one again.

All times are seconds on the container's clock.
"""

from __future__ import annotations

import re
import struct

from stable_identity_core import SERVICE, T_PTR, _read_name

# How long after the wss session closes the new name must show up (and the old be gone).
# The firmware sends the goodbye + first announcement on the next idle tick; the report's
# 60 s refresh is the failure this bounds.
DEADLINE_S = 10.0


def instance(name: str) -> str:
    return f"{name}.{SERVICE}"


def parse_records(msg: bytes) -> list[dict]:
    """Every resource record in a DNS message as {"name", "type", "ttl", "ptr"} (ptr only
    for PTR records). Raises ValueError on a malformed message."""
    if len(msg) < 12:
        raise ValueError("short DNS message")
    _id, _flags, qd, an, ns, ar = struct.unpack(">HHHHHH", msg[:12])
    off = 12
    for _ in range(qd):
        _, off = _read_name(msg, off)
        off += 4
    out: list[dict] = []
    for _ in range(an + ns + ar):
        name, off = _read_name(msg, off)
        if off + 10 > len(msg):
            raise ValueError("truncated record")
        rtype, _cls, ttl, rdlen = struct.unpack(">HHIH", msg[off : off + 10])
        off += 10
        rec = {"name": name, "type": rtype, "ttl": ttl}
        if rtype == T_PTR:
            rec["ptr"] = _read_name(msg, off)[0]
        out.append(rec)
        off += rdlen
    return out


def _ptrs(records: list[dict]) -> list[tuple[str, int]]:
    return [
        (r["ptr"].lower(), r["ttl"])
        for r in records
        if r["type"] == T_PTR and r["name"].lower() == SERVICE
    ]


def _first(events, pred, after: float):
    for e in events:
        if e["t"] >= after and pred(e):
            return e["t"]
    return None


def grade_rename(events: list[dict], old: str, new: str, renamed_t: float, closed_t: float) -> dict:
    """Grade one rename old -> new.

    `events` are the listener's {"t", "src" ("mcast"|"ucast"), "records"} rows (records as
    parse_records gives them); `renamed_t` is when set_device_name was sent and `closed_t`
    when the wss session closed (announcements wait for no session)."""
    o, n = instance(old).lower(), instance(new).lower()
    ucast = [e for e in events if e["src"] == "ucast"]
    mcast = [e for e in events if e["src"] == "mcast"]
    problems: list[str] = []

    before = [e for e in ucast if e["t"] < renamed_t]
    if not any(o in dict(_ptrs(e["records"])) for e in before):
        problems.append(f"before the rename no unicast answer named {old!r}")

    def new_only(e) -> bool:
        p = dict(_ptrs(e["records"]))
        return n in p and o not in p

    t_new = _first(ucast, new_only, renamed_t)
    stale_after = [
        e["t"]
        for e in ucast
        if t_new is not None and e["t"] > t_new and o in dict(_ptrs(e["records"]))
    ]
    if t_new is None:
        problems.append(f"unicast answers never named {new!r} alone after the rename")
    elif t_new - closed_t > DEADLINE_S:
        problems.append(
            f"unicast answers named {new!r} only {t_new - closed_t:.1f} s after the session closed"
        )
    if stale_after:
        problems.append(f"unicast answers named {old!r} again {stale_after[0] - t_new:.1f} s later")

    observable = bool(mcast)
    t_bye = _first(mcast, lambda e: dict(_ptrs(e["records"])).get(o) == 0, renamed_t)
    t_ann = _first(mcast, lambda e: (dict(_ptrs(e["records"])).get(n) or 0) > 0, renamed_t)
    stale_mcast = [
        e["t"]
        for e in mcast
        if t_bye is not None and e["t"] > t_bye and (dict(_ptrs(e["records"])).get(o) or 0) > 0
    ]
    if observable:
        if t_bye is None:
            problems.append(f"no multicast goodbye (TTL 0 PTR) for {old!r} after the rename")
        elif t_bye - closed_t > DEADLINE_S:
            problems.append(
                f"goodbye for {old!r} only {t_bye - closed_t:.1f} s after the session closed"
            )
        if t_ann is None:
            problems.append(f"no multicast announcement of {new!r} after the rename")
        elif t_ann - closed_t > DEADLINE_S:
            problems.append(
                f"{new!r} announced only {t_ann - closed_t:.1f} s after the session closed"
            )
        if stale_mcast:
            problems.append(f"{old!r} announced again (TTL > 0) after its goodbye")

    def rel(t):
        return None if t is None else round(t - closed_t, 2)

    return {
        "old": old,
        "new": new,
        "unicast_new_s": rel(t_new),
        "multicast_observable": observable,
        "goodbye_s": rel(t_bye),
        "announce_s": rel(t_ann),
        "problems": problems,
    }


GOODBYE_RE = re.compile(r"\[mdns\] renamed: goodbye for the old name \((\d+) B\)")


def serial_goodbyes(serial: str | None) -> int | None:
    """How many goodbyes the firmware says it sent (None: no serial log captured)."""
    if not serial:
        return None
    return len(GOODBYE_RE.findall(serial))


def verdict(renames: list[dict], skip: str | None = None, goodbyes: int | None = None) -> dict:
    """SKIP for infra (no lease, no unicast answers at all); FAIL lists every problem.

    When the group isn't visible from the rig container, the firmware's own serial line
    for each goodbye (`goodbyes`, from serial_goodbyes) stands in: fewer than one per
    rename is a FAIL. No serial log at all leaves that half unchecked."""
    if skip:
        return {"verdict": "SKIP", "skip": skip, "problems": []}
    problems = [f"{r['old']} -> {r['new']}: {p}" for r in renames for p in r["problems"]]
    if not renames:
        return {"verdict": "SKIP", "skip": "no rename was attempted", "problems": []}
    if goodbyes is not None and not any(r["multicast_observable"] for r in renames):
        if goodbyes < len(renames):
            problems.append(
                f"the DUT logged {goodbyes} mDNS goodbye(s) for {len(renames)} rename(s)"
            )
    return {"verdict": "FAIL" if problems else "PASS", "skip": None, "problems": problems}
