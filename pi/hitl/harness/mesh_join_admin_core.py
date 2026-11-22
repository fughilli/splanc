"""Pure logic for the mesh M7 `mesh_join_admin` HITL (docs/design/mesh.md §7, mesh M7):
parsing the firmware's membership lines and the gate. No hardware here; unit-tested in
//pi/hitl/tests:test_mesh_join_admin_core.
"""

from __future__ import annotations

import re

_KV = re.compile(r"(\w+)=(\S+)")
_CRYPTO = re.compile(r"\[mesh\] crypto job=(\d+) us=(\d+)")
_TIMEBASE = re.compile(r"\[mt\] timebase gen=(\d+) origin=([0-9a-f]{4})")
_HEARD = re.compile(r"\[mt\] epoch heard gen=(\d+) origin=([0-9a-f]{4})")
_LATE = re.compile(r"\[late\] n=(\d+) max=(\d+) ago_ms=(\d+)")
_FT_LINE = re.compile(r"\[ft\] r\d+:")
_SAVE = re.compile(r"\[mesh\] state (?:saved|erased) \S+(?: us=(\d+))?")


def kv(line: str) -> dict[str, str]:
    return dict(_KV.findall(line))


def last(lines: list[str], tag: str) -> dict[str, str]:
    """The newest `[mesh] <tag> k=v ...` line as a dict ({} if none)."""
    for t in reversed(lines):
        if f"[mesh] {tag} " in t:
            return kv(t)
    return {}


_HEX = {"key", "groups", "id"}


def membership(lines: list[str]) -> dict:
    """`MESH INFO`'s membership and admin lines (M7) merged, numbers as ints, the gateway
    counters as `gw_*`, the node id (hex) and the pending joins as {node: key hash}."""
    m = last(lines, "membership")
    a = last(lines, "admin")
    g = {f"gw_{k}": v for k, v in last(lines, "gw").items()}
    g.update({f"stack_{k}": v for k, v in last(lines, "stack").items()})
    g.update({f"heap_{k}": v for k, v in last(lines, "heap").items()})
    i = last(lines, "info")
    out: dict = {"id": i["id"]} if "id" in i else {}
    for k, v in {**m, **a, **g}.items():
        if k.startswith("pend") and len(k) == 8:
            out.setdefault("pending_keys", {})[k[4:]] = v
        elif k not in _HEX and re.fullmatch(r"-?\d+", v):
            out[k] = int(v)
        else:
            out[k] = v
    out.setdefault("pending_keys", {})
    return out


def crypto_us(lines: list[str]) -> list[int]:
    """Session crypto jobs (a grant's verify + ECDH, an Ack's ECDH): µs each."""
    return [int(m.group(2)) for t in lines if (m := _CRYPTO.search(t))]


def late_frames(lines: list[str]) -> list[dict]:
    """The firmware's `[late]` windows (PR-40: a render-start interval over 1.5 frame periods,
    i.e. a dropped frame): {n, max_us, ago_ms, save_us}. `save_us` is the membership write
    (a littlefs flash write, which stalls the whole chip) in the same [ft] window or the one
    before, if any: those are told apart from CPU work (crypto) that must never delay one."""
    # Windows: the lines up to and including each [ft]. A save is printed when it ENDS, so one
    # that straddles a window's end shows up in the next: a late frame is a save's if the save
    # line is in its window, the one before, or the one after.
    wins: list[dict] = [{"save": None, "late": []}]
    for t in lines:
        if m := _SAVE.search(t):
            wins[-1]["save"] = int(m.group(1) or 0)
        elif _FT_LINE.search(t):
            wins.append({"save": None, "late": []})
        elif m := _LATE.search(t):
            n, mx, ago = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if mx >= 1 << 31 or ago >= 1 << 31:
                continue  # a clock step's negative interval (older firmware), not a late frame
            # The [late] line follows its [ft]: its window is the one that [ft] closed.
            wins[-2 if len(wins) > 1 else -1]["late"].append({"n": n, "max_us": mx, "ago_ms": ago})
    out: list[dict] = []
    for i, w in enumerate(wins):
        near = [wins[j]["save"] for j in (i, i - 1, i + 1) if 0 <= j < len(wins)]
        save = next((x for x in near if x is not None), None)
        out.extend({**x, "save_us": save} for x in w["late"])
    return out


def late_counts(per_dut: dict[str, list[dict]]) -> tuple[int, int]:
    """(late frames with no flash write near them, late frames next to a membership write)."""
    cpu = sum(x["n"] for v in per_dut.values() for x in v if x["save_us"] is None)
    save = sum(x["n"] for v in per_dut.values() for x in v if x["save_us"] is not None)
    return cpu, save


def timebase_origins(lines: list[str]) -> set[str]:
    """The origins of the show epochs this DUT mapped onto its time base."""
    return {m.group(2) for t in lines if (m := _TIMEBASE.search(t))}


def heard_origins(lines: list[str]) -> set[str]:
    return {m.group(2) for t in lines if (m := _HEARD.search(t))}


def admin_error(reply: dict | None) -> str | None:
    """A `mesh.admin` reply's error name (None if the reply was something else)."""
    if not reply or reply.get("type") != "mesh":
        return None
    a = reply.get("admin")
    if a is None:
        return None
    return a.get("error", "MESH_ADMIN_OK")


def send_error(reply: dict | None) -> str | None:
    """A refused `mesh_send`'s error name (None if the gateway took it)."""
    if not reply or reply.get("type") != "mesh":
        return None
    r = reply.get("result") or {}
    e = r.get("error", "MESH_SEND_OK")
    return None if e == "MESH_SEND_OK" else e


def member_status(result: dict | None) -> dict[int, str]:
    """A pushed MeshResult's per-member status: {node: status name}."""
    out: dict[int, str] = {}
    for m in (result or {}).get("members", []):
        out[int(m.get("node", 0))] = m.get("status", "MESH_MEMBER_OK")
    return out


def rounds_ok(sends: list[dict], want_ok: set[int], want_absent: set[int]) -> int:
    """Rounds in which every node of `want_ok` answered OK and none of `want_absent` did."""
    n = 0
    for s in sends:
        st = s.get("members", {})
        ok = all(st.get(x) == "MESH_MEMBER_OK" for x in want_ok)
        none = all(st.get(x) != "MESH_MEMBER_OK" for x in want_absent)
        n += ok and none
    return n


GATE_FPS_DROP = 2
EXEMPT = ("reboot",)
# No late frame (PR-40) anywhere but while the effect starts (baseline) and the reboot.
LATE_EXEMPT = ("baseline", "reboot")


def verdict(phases: dict[str, dict], allow_save_late: bool = False) -> tuple[bool, list[str]]:
    """The gate (each phase records what it saw; missing evidence fails):

    - form: a and b, holding the site secret, form a closed mesh by themselves;
    - unapproved: c (mesh id + admin key, no site secret) is not a member after the wait,
      holds no key, and the gateway lists it as pending under its device key;
    - locked: before a grant the gateway refuses mesh_send and admit (LOCKED); a grant the
      admin did not sign is refused; an insider's envelope-framed control is refused by the
      members (untrusted) and dispatched by none;
    - unlock: the signed grant unlocks a; b syncs its session;
    - admit: after the admin's admit c joins, syncs, and gets control;
    - control: every member OK in >= 90 % of rounds;
    - epoch: b's own set_time_base is refused, b's forged beacon epoch is taken by nobody,
      a's epoch (its session's signed TIME_BASE) reaches b and c;
    - revoke: a rotation leaves c out: b OK and c not, in >= 90 % of rounds; c's rejoin is
      refused (revoked);
    - reboot: a and b come back from flash on the new epoch with c revoked; after a fresh
      unlock b gets control, c does not, and c's rejoins are still refused;
    - render: fps not below the baseline - 2 in any phase but the reboot; no resets outside
      the reboot phase;
    - no blip (PR-40): no late frame (a render interval over 1.5 periods) on any DUT in any
      phase but the baseline and the reboot. `allow_save_late` tolerates the ones next to a
      membership flash write (a chip-wide flash stall, not crypto), reported either way.
    """
    why: list[str] = []
    base = phases.get("baseline", {}).get("fps_min")

    def need(name: str, cond: bool, text: str) -> None:
        if not cond:
            why.append(f"{name}: {text}")

    f = phases.get("form", {})
    need("form", bool(f.get("formed")), "a and b did not form a closed mesh from the site secret")
    u = phases.get("unapproved", {})
    need(
        "unapproved",
        u.get("c_phase") == "joining",
        f"c is {u.get('c_phase')!r}, not waiting to join",
    )
    need("unapproved", u.get("c_epoch", 1) == 0, "c holds a mesh key without approval")
    need("unapproved", bool(u.get("listed")), "the gateway does not list c as pending")
    lk = phases.get("locked", {})
    need(
        "locked",
        lk.get("send_error") == "MESH_SEND_LOCKED",
        f"mesh_send before a grant: {lk.get('send_error')}",
    )
    need(
        "locked",
        lk.get("admit_error") == "MESH_ADMIN_LOCKED",
        f"admit before a grant: {lk.get('admit_error')}",
    )
    need(
        "locked",
        lk.get("b_send_error") == "MESH_SEND_LOCKED",
        f"b's mesh_send (no grant): {lk.get('b_send_error')}",
    )
    need(
        "locked",
        lk.get("bad_grant_error") == "MESH_ADMIN_BAD_GRANT",
        f"an unsigned grant: {lk.get('bad_grant_error')}",
    )
    need(
        "locked",
        lk.get("forged_untrusted", 0) >= 1,
        "the insider's envelope control was not refused as untrusted",
    )
    need(
        "locked",
        lk.get("forged_dispatched", 1) == 0,
        "the insider's envelope control was dispatched",
    )
    un = phases.get("unlock", {})
    need("unlock", un.get("error") == "MESH_ADMIN_OK", f"unlock: {un.get('error')}")
    need("unlock", bool(un.get("b_synced")), "b never synced the admin session")
    ad = phases.get("admit", {})
    need("admit", ad.get("error") == "MESH_ADMIN_OK", f"admit: {ad.get('error')}")
    need("admit", bool(ad.get("c_member")), "c did not join after the admit")
    need("admit", bool(ad.get("c_synced")), "c never synced the admin session")
    for name in ("control", "revoked", "after_reboot"):
        p = phases.get(name)
        if p is None:
            why.append(f"{name}: missing")
            continue
        r = p.get("rounds", {})
        if not r.get("sent"):
            why.append(f"{name}: no rounds sent")
        elif r.get("ok", 0) < 0.9 * r["sent"]:
            why.append(
                f"{name}: {r.get('ok', 0)}/{r['sent']} rounds as expected ({p.get('expect')})"
            )
    e = phases.get("epoch", {})
    need("epoch", bool(e.get("b_refused")), "b's own set_time_base was not refused")
    need("epoch", bool(e.get("forged_sent")), "b's forged epoch was not sent")
    need(
        "epoch", not e.get("forged_taken"), f"b's forged epoch was taken by {e.get('forged_taken')}"
    )
    need("epoch", bool(e.get("a_originated")), "a's session did not start the epoch")
    need(
        "epoch",
        set(e.get("followed", [])) >= {"b", "c"},
        f"a's epoch followed by {e.get('followed')}",
    )
    rv = phases.get("revoke", {})
    need("revoke", rv.get("error") == "MESH_ADMIN_OK", f"revoke: {rv.get('error')}")
    need("revoke", set(rv.get("rekeyed", [])) >= {"a", "b"}, f"rekeyed: {rv.get('rekeyed')}")
    need(
        "revoked",
        phases.get("revoked", {}).get("rejoin_refused", 0) > 0,
        "c's rejoin was never refused",
    )
    rb = phases.get("reboot", {})
    for lab in ("a", "b"):
        s = rb.get("restored", {}).get(lab) or {}
        need("reboot", s.get("epoch") == 2 and s.get("revoked", 0) >= 1, f"{lab} restored {s}")
    need(
        "after_reboot",
        phases.get("after_reboot", {}).get("rejoin_refused", 0) > 0,
        "c's rejoin not refused after the reboot",
    )
    for name, p in phases.items():
        fm = p.get("fps_min")
        if (
            base is not None
            and fm is not None
            and name != "baseline"
            and name not in EXEMPT
            and not p.get("fps_exempt")
        ):
            if fm < base - GATE_FPS_DROP:
                why.append(f"{name}: render {fm} fps < baseline {base} - {GATE_FPS_DROP}")
        if p.get("resets") and name not in EXEMPT:
            why.append(f"{name}: {p['resets']} reset(s)")
        if name not in LATE_EXEMPT and "late" in p:
            cpu, save = late_counts(p["late"])
            if cpu:
                why.append(f"{name}: {cpu} late frame(s) not explained by a flash write (PR-40)")
            if save and not allow_save_late:
                why.append(f"{name}: {save} late frame(s) next to a membership flash write (PR-40)")
    return (not why, why)
