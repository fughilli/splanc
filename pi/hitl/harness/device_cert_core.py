"""Pure logic for the per-device TLS identity HITL check (hitl_device_cert.py).

Parses the firmware's identity log lines (firmware/player_app/device_cert.cpp), grades
the connect-storm race and a whole run, and compares runs across DUTs. No hardware, no
network — unit-tested in //pi/hitl/tests:test_device_cert_core.py.
"""

from __future__ import annotations

import re
from typing import Any

# SHA-256 of the shared CN=heapless certificate every pre-per-device netstack image
# served (firmware/player_app/device_cert_core.h kLegacySharedCertSha256).
LEGACY_SHA256 = "9a2b1729debfa516f1b3a5ade76df3a3332b97868ed667f89298ffc574a1d641"

_GEN = re.compile(
    r"\[tls\] generated per-device identity in (\d+) ms \(keygen\+sign\), persist=(\S+)"
    r"(?: \(RAM-only this boot\))? in (\d+) ms \((\d+) B\); cert sha256=([0-9a-f]{64})"
)
_LOAD = re.compile(
    r"\[tls\] loaded per-device identity in (\d+) ms"
    r"(?: \(first-boot keygen\+sign took (\d+) ms\))?; cert sha256=([0-9a-f]{64})"
)
_FAIL = re.compile(r"\[tls\] device identity generation FAILED")
_SETUP = re.compile(
    r"TLS init: setup ok \(per-device identity, sha256=([0-9a-f]{64}), persisted=(\d)\)"
)


def parse_identity_log(log: str) -> dict[str, Any]:
    """What a boot log says about the identity: generated (+ keygen/persist ms) or
    loaded (+ load ms), its sha256, generation failures, and the TLS setup line."""
    out: dict[str, Any] = {"generated": False, "loaded": False, "sha": None, "failures": 0}
    m = _GEN.search(log)
    if m:
        out.update(
            generated=True,
            gen_ms=int(m.group(1)),
            persist=m.group(2),
            persist_ms=int(m.group(3)),
            blob_bytes=int(m.group(4)),
            sha=m.group(5),
        )
    m = _LOAD.search(log)
    if m:
        out.update(loaded=True, load_ms=int(m.group(1)), sha=out["sha"] or m.group(3))
        out["loaded_sha"] = m.group(3)
        if m.group(2) is not None:
            out["recorded_gen_ms"] = int(m.group(2))
    out["failures"] = len(_FAIL.findall(log))
    m = _SETUP.search(log)
    if m:
        out["setup_sha"] = m.group(1)
        out["setup_persisted"] = m.group(2) == "1"
    return out


def race_verdict(attempts: list[dict[str, Any]], legacy: str = LEGACY_SHA256) -> dict[str, Any]:
    """Grade the connect storm started the instant the DUT leased.

    Each attempt is {t, ok?, sha?, err?}. A TCP-level failure (port not open yet) is
    expected early on; what must never happen is a COMPLETED handshake presenting a
    different certificate than the others, or the legacy shared one.
    """
    oks = [a for a in attempts if a.get("ok")]
    shas = sorted({a["sha"] for a in oks if a.get("sha")})
    errs: dict[str, int] = {}
    for a in attempts:
        if a.get("err"):
            kind = a["err"].split(":", 2)
            key = ":".join(kind[:2])
            errs[key] = errs.get(key, 0) + 1
    first_ok = min((a["t"] for a in oks), default=None)
    tls_after_first_ok = sum(
        1
        for a in attempts
        if str(a.get("err", "")).startswith("tls:") and first_ok is not None and a["t"] > first_ok
    )
    return {
        "attempts": len(attempts),
        "ok": len(oks),
        "distinct": len(shas),
        "sha": shas[0] if len(shas) == 1 else None,
        "shas": shas,
        "legacy_seen": legacy in shas,
        "first_ok_s": first_ok,
        "errors": errs,
        "tls_errors_after_first_ok": tls_after_first_ok,
    }


def check_run(r: dict[str, Any]) -> list[str]:
    """Every property a single-DUT run must show; [] = PASS."""
    p: list[str] = []
    fb = r.get("first_boot") or {}
    # The boot monitor can reset the C6 on attach (hitl-monitor), so the captured boot may
    # be the SECOND one: then it loads the identity and reports the first-boot keygen
    # time the blob recorded. Either proves a first-boot generation happened.
    if not fb.get("generated") and fb.get("recorded_gen_ms") is None:
        p.append("first boot after --erase-fs did not log a generated identity")
    elif fb.get("generated") and fb.get("persist") != "ok":
        p.append(f"first-boot identity was not persisted (persist={fb.get('persist')})")
    if fb.get("failures"):
        p.append(f"{fb['failures']} identity generation failure(s) on first boot")
    race = r.get("race") or {}
    sha = race.get("sha")
    if not race.get("ok"):
        p.append("no TLS handshake completed during the race window")
    if race.get("distinct", 0) > 1:
        p.append(
            f"handshakes presented {race['distinct']} different certificates: {race.get('shas')}"
        )
    if race.get("legacy_seen"):
        p.append("a handshake presented the LEGACY shared certificate")
    if sha and fb.get("sha") and sha != fb["sha"]:
        p.append(f"served cert {sha[:16]} != the first-boot log's {fb['sha'][:16]}")
    info = r.get("tls_info") or {}
    if info.get("state") != "ready":
        p.append(f"get_tls_info state={info.get('state')!r} (want 'ready')")
    if sha and info.get("certSha256") != sha:
        p.append(f"get_tls_info cert {str(info.get('certSha256'))[:16]} != served {sha[:16]}")
    if info.get("persisted") is not True:
        p.append("get_tls_info persisted is not true")
    if sha and r.get("ws_sha") != sha:
        p.append("the wss session presented a different certificate than the race handshakes")
    mt = r.get("manifest_tls") or {}
    if not mt:
        p.append("no manifest fetched during the race")
    elif (
        mt.get("cert_sha256") != sha
        or mt.get("state") != "ready"
        or mt.get("persisted") is not True
    ):
        p.append(f"manifest tls block {mt} does not pin the served cert as ready+persisted")
    rb = r.get("reboot") or {}
    if not rb.get("loaded"):
        p.append("after a reboot the identity was not loaded from flash")
    elif rb.get("loaded_sha") != sha:
        p.append(
            f"after a reboot the loaded cert {str(rb.get('loaded_sha'))[:16]} != {str(sha)[:16]}"
        )
    if rb.get("generated"):
        p.append("the reboot REGENERATED the identity (persistence failed)")
    rr = r.get("reboot_race") or {}
    if rr.get("sha") != sha:
        p.append(f"after the reboot the DUT served {rr.get('shas')} (want {str(sha)[:16]})")
    return p


def compare_runs(runs: list[dict[str, Any]]) -> list[str]:
    """Across DUTs: each device has its own certificate (and none is the legacy one)."""
    p: list[str] = []
    by_mac: dict[str, str] = {}
    for r in runs:
        mac, sha = r.get("mac"), (r.get("race") or {}).get("sha")
        if not mac or not sha:
            p.append(f"run on {r.get('unit')} has no mac/cert to compare")
            continue
        if sha == LEGACY_SHA256:
            p.append(f"{mac} serves the legacy shared certificate")
        by_mac.setdefault(mac, sha)
    shas = list(by_mac.values())
    if len(by_mac) < 2:
        p.append(f"need runs on two different devices, have {sorted(by_mac)}")
    elif len(set(shas)) != len(shas):
        p.append(f"two devices share a certificate: {by_mac}")
    return p
