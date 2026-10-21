"""Pure logic for the netstack "stable network identity" HITL gate
(hitl_stable_identity.py): the station MAC / lease parse of a boot log, a minimal
mDNS (DNS) query builder + answer parser for a legacy-unicast `_splanc._tcp` browse,
the extra-client refusal grading, and the run's verdict.

What the gate asserts (field report: a player's IP walked .155 -> .159 -> .163 ...
across reboots because the netstack picked a random MAC every boot, so the bridge kept
dialling stale addresses):
  * the station MAC is the chip's factory MAC and is the SAME after a reboot, and the
    rig's DHCP hands back the SAME lease;
  * after the reboot the board announces mDNS for its lease, and a unicast
    `_splanc._tcp.local` query answers with that IP and TXT id=<device id>;
  * while one TLS client holds the board's single session, an extra client gets a
    prompt, clean refusal (RST / closed), not a hang, and the first stays usable.
"""

from __future__ import annotations

import re
import struct

MAC_RE = re.compile(
    r"^MAC ([0-9a-f]{2}(?::[0-9a-f]{2}){5})(?: \((factory|random per boot)\))?", re.M
)
LEASE_RE = re.compile(
    r"(?:DHCP LEASE ACQUIRED.*?IP\s+|TCP LISTEN on\s+|PROV re-received.*?IP\s+)(\d{1,3}(?:\.\d{1,3}){3})"
)
MDNS_ANNOUNCE_RE = re.compile(r"\[mdns\] announcing _splanc\._tcp on (\d{1,3}(?:\.\d{1,3}){3})")
IDENTITY_RE = re.compile(r"\[player\] identity ([0-9A-F]{2}(?::[0-9A-F]{2}){5}) ")
BOOT_MARKER = "SPI_FAST_FLASH_BOOT"


def parse_boot(log: str) -> dict:
    log = log or ""
    mac = MAC_RE.search(log)
    lease = LEASE_RE.search(log)
    ann = MDNS_ANNOUNCE_RE.search(log)
    ident = IDENTITY_RE.search(log)
    return {
        "booted": BOOT_MARKER in log,
        "sta_mac": mac.group(1) if mac else None,
        "mac_kind": (mac.group(2) if mac and mac.group(2) else None),
        "lease_ip": lease.group(1) if lease else None,
        "mdns_ip": ann.group(1) if ann else None,
        "device_id": ident.group(1) if ident else None,
    }


# ---- minimal DNS ------------------------------------------------------------------

SERVICE = "_splanc._tcp.local"
T_A, T_PTR, T_TXT, T_SRV = 1, 12, 16, 33


def _qname(name: str) -> bytes:
    out = b""
    for label in name.strip(".").split("."):
        b = label.encode()
        out += bytes([len(b)]) + b
    return out + b"\x00"


def build_ptr_query(name: str = SERVICE, txid: int = 0x5A5A) -> bytes:
    """A one-question PTR query. Sent from an ephemeral port (not 5353) it is a
    legacy-unicast query (RFC 6762 §6.7): the responder answers to that address/port."""
    return struct.pack(">HHHHHH", txid, 0, 1, 0, 0, 0) + _qname(name) + struct.pack(">HH", T_PTR, 1)


def _read_name(msg: bytes, off: int, depth: int = 0) -> tuple[str, int]:
    labels: list[str] = []
    jumped_end = None
    while True:
        if off >= len(msg) or depth > 16:
            raise ValueError("bad name")
        n = msg[off]
        if n == 0:
            off += 1
            break
        if n & 0xC0 == 0xC0:
            ptr = ((n & 0x3F) << 8) | msg[off + 1]
            if jumped_end is None:
                jumped_end = off + 2
            off = ptr
            depth += 1
            continue
        labels.append(msg[off + 1 : off + 1 + n].decode("utf-8", "replace"))
        off += 1 + n
    return ".".join(labels), (jumped_end if jumped_end is not None else off)


def parse_answers(msg: bytes) -> dict:
    """Parse every resource record (answers + authority + additional) of a DNS reply
    into {"ptr": [...], "srv": [(target, port)], "txt": {k: v}, "a": [ip, ...]}."""
    if len(msg) < 12:
        raise ValueError("short DNS message")
    _id, _flags, qd, an, ns, ar = struct.unpack(">HHHHHH", msg[:12])
    off = 12
    for _ in range(qd):
        _, off = _read_name(msg, off)
        off += 4
    out: dict = {"ptr": [], "srv": [], "txt": {}, "a": []}
    for _ in range(an + ns + ar):
        _name, off = _read_name(msg, off)
        rtype, _cls, _ttl, rdlen = struct.unpack(">HHIH", msg[off : off + 10])
        off += 10
        rd = msg[off : off + rdlen]
        if rtype == T_PTR:
            out["ptr"].append(_read_name(msg, off)[0])
        elif rtype == T_SRV:
            port = struct.unpack(">H", rd[4:6])[0]
            out["srv"].append((_read_name(msg, off + 6)[0], port))
        elif rtype == T_TXT:
            i = 0
            while i < len(rd):
                n = rd[i]
                s = rd[i + 1 : i + 1 + n].decode("utf-8", "replace")
                k, _, v = s.partition("=")
                out["txt"][k] = v
                i += 1 + n
        elif rtype == T_A and rdlen == 4:
            out["a"].append(".".join(str(b) for b in rd))
        off += rdlen
    return out


# ---- verdict ----------------------------------------------------------------------


def grade(boot1: dict | None, boot2: dict | None, mdns: dict | None, refusal: dict | None) -> dict:
    """SKIP when the first boot never leased (infra). FAIL lists every broken claim."""
    if not boot1 or not boot1.get("lease_ip"):
        return {
            "verdict": "SKIP",
            "problems": [],
            "skip": "first provisioning never leased (infra)",
        }
    if not boot2 or not boot2.get("booted"):
        return {"verdict": "SKIP", "problems": [], "skip": "reboot never came back up (infra)"}
    p: list[str] = []
    if boot1.get("mac_kind") != "factory":
        p.append(
            f"station MAC is not the factory MAC ({boot1.get('sta_mac')} {boot1.get('mac_kind')})"
        )
    if boot1.get("sta_mac") != boot2.get("sta_mac"):
        p.append(
            f"station MAC changed across reboot: {boot1.get('sta_mac')} -> {boot2.get('sta_mac')}"
        )
    if not boot2.get("lease_ip"):
        p.append("no lease after the reboot")
    elif boot1["lease_ip"] != boot2["lease_ip"]:
        p.append(f"DHCP lease changed across reboot: {boot1['lease_ip']} -> {boot2['lease_ip']}")
    if boot2.get("lease_ip") and boot2.get("mdns_ip") != boot2.get("lease_ip"):
        p.append(f"no mDNS announcement for the new lease (announced {boot2.get('mdns_ip')})")
    if mdns is None:
        p.append("unicast _splanc._tcp query got no answer")
    else:
        if boot2.get("lease_ip") and boot2["lease_ip"] not in mdns.get("a", []):
            p.append(
                f"mDNS A record {mdns.get('a')} does not carry the lease {boot2.get('lease_ip')}"
            )
        dev = boot2.get("device_id") or boot1.get("device_id")
        if dev and mdns.get("txt", {}).get("id") != dev:
            p.append(f"mDNS TXT id={mdns.get('txt', {}).get('id')!r}, want {dev!r}")
    if refusal is not None:
        if refusal.get("second") not in ("refused", "reset", "closed"):
            p.append(
                f"extra client was not refused cleanly: {refusal.get('second')} after {refusal.get('second_s')} s"
            )
        elif (refusal.get("second_s") or 0) > 5.0:
            p.append(f"extra client refusal took {refusal.get('second_s')} s (hang-like)")
        if refusal.get("first_after") != 200:
            p.append(
                f"first client unusable after the refusal (ping -> {refusal.get('first_after')})"
            )
    return {"verdict": "FAIL" if p else "PASS", "problems": p, "skip": None}
