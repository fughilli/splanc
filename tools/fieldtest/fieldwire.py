"""Decode what the field kit records (firmware/fieldtest/field_node.cpp): TLV blocks from a
node's flash dump or its serial copy, window entries, phase records, collector logs.

Block: b'S' <type> u16 len, u32 crc32(payload), payload, padded to 4 bytes in flash.
  'W' window   WinHdr (20 B) + n x Entry (16 B)
  'P' phase    Ctrl (48 B) + up_ms u32, boot u16, id u8, from_air u8, rssi i8, pad[3]
  'M' mesh window (mesh mode)  WinHdr + n x MEntry (8 B): per flood origin rx/exp/hops
  'O' boot     fw[24], mac[6], factory_mac[6], boot u16, reset_reason u8, pad, Cfg
"""

from __future__ import annotations

import base64
import struct
import zlib
from dataclasses import dataclass, field

RATE_NAMES = {
    0x00: "1",
    0x01: "2",
    0x02: "5.5",
    0x03: "11",
    0x05: "2S",
    0x06: "5.5S",
    0x07: "11S",
    0x0B: "6",
    0x0F: "9",
    0x0A: "12",
    0x0E: "18",
    0x09: "24",
    0x0D: "36",
    0x08: "48",
    0x0C: "54",
}
RATE_MBPS = {
    "1": 1,
    "2": 2,
    "5.5": 5.5,
    "11": 11,
    "2S": 2,
    "5.5S": 5.5,
    "11S": 11,
    "6": 6,
    "9": 9,
    "12": 12,
    "18": 18,
    "24": 24,
    "36": 36,
    "48": 48,
    "54": 54,
}
F_OUTAGE, F_PWRCHG, F_RATEMISMATCH, F_REBOOT, F_SELF = 1, 2, 4, 8, 16

WIN_HDR = struct.Struct("<BBHIIIBBbB")  # id phase boot win up_ms ctrl_epoch n channel pwr pad
ENTRY = struct.Struct("<BBBBbbbBBBBBbbBB")
CTRL = struct.Struct("<IIIBB18sHHbB4sBBBBBB")
MENTRY = struct.Struct("<BBBBBbH")  # origin rx exp hmin hmax rssi hsum
PHASE_TAIL = struct.Struct("<IHBBb3x")


def rate_name(code: int) -> str:
    return RATE_NAMES.get(code, f"r{code:#x}")


@dataclass
class Entry:
    peer: int
    rate: str
    rx: int
    exp: int
    rmean: int
    rmin: int
    rmax: int
    rstd: float
    urx: int
    uexp: int
    aok: int
    afail: int
    nf: int
    ptx: int
    flags: int
    dup: int


@dataclass
class Window:
    node: int
    phase: int
    boot: int
    win: int
    up_ms: int
    ctrl_epoch: int
    channel: int
    pwr: int
    entries: list[Entry] = field(default_factory=list)
    source: str = ""  # flash | serial | air


@dataclass
class MeshEntry:
    origin: int
    rx: int
    exp: int
    hmin: int
    hmax: int
    rssi: int
    hsum: int


@dataclass
class MeshWindow:
    node: int
    phase: int
    boot: int
    win: int
    up_ms: int
    entries: list[MeshEntry] = field(default_factory=list)


def parse_mesh_window(p: bytes) -> MeshWindow | None:
    if len(p) < WIN_HDR.size:
        return None
    nid, phase, boot, win, up, _epoch, n, _ch, _pwr, _ = WIN_HDR.unpack_from(p)
    w = MeshWindow(nid, phase, boot, win, up)
    for i in range(n):
        off = WIN_HDR.size + i * MENTRY.size
        if off + MENTRY.size > len(p):
            break
        w.entries.append(MeshEntry(*MENTRY.unpack_from(p, off)))
    return w


@dataclass
class Rtt:
    host_t: float
    collector: int
    node: int
    seq: int
    rtt_ms: int
    hops_out: int
    hops_back: int


@dataclass
class Phase:
    node: int
    boot: int
    up_ms: int
    epoch: int
    host_unix: int
    age_ms: int
    phase: int
    origin: int
    label: str
    from_air: bool
    rssi: int
    pwr: int | None
    rates: list[str] | None


@dataclass
class Boot:
    fw: str
    mac: str
    factory_mac: str
    boot: int
    reset_reason: int
    node: int


def parse_window(p: bytes, source: str) -> Window | None:
    if len(p) < WIN_HDR.size:
        return None
    nid, phase, boot, win, up, epoch, n, ch, pwr, _ = WIN_HDR.unpack_from(p)
    w = Window(nid, phase, boot, win, up, epoch, ch, pwr, source=source)
    for i in range(n):
        off = WIN_HDR.size + i * ENTRY.size
        if off + ENTRY.size > len(p):
            break
        f = ENTRY.unpack_from(p, off)
        w.entries.append(
            Entry(
                f[0],
                rate_name(f[1]),
                f[2],
                f[3],
                f[4],
                f[5],
                f[6],
                f[7] / 4.0,
                f[8],
                f[9],
                f[10],
                f[11],
                f[12],
                f[13],
                f[14],
                f[15],
            )
        )
    return w


def parse_phase(p: bytes) -> Phase | None:
    if len(p) < CTRL.size + PHASE_TAIL.size:
        return None
    (
        epoch,
        unix,
        age,
        phase,
        origin,
        label,
        period,
        ln,
        pwr,
        nrates,
        rates,
        uni,
        quiet,
        win_s,
        raw,
        mesh,
        hops,
    ) = CTRL.unpack_from(p)
    up, boot, nid, from_air, rssi = PHASE_TAIL.unpack_from(p, CTRL.size)
    lab = label.split(b"\0", 1)[0].decode("utf-8", "replace")
    return Phase(
        nid,
        boot,
        up,
        epoch,
        unix,
        age,
        phase,
        origin,
        lab,
        bool(from_air),
        rssi,
        None if pwr == 127 else pwr,
        [rate_name(r) for r in rates[:nrates]] if nrates else None,
    )


def parse_boot(p: bytes) -> Boot | None:
    if len(p) < 40:
        return None
    fw = p[:24].split(b"\0", 1)[0].decode("utf-8", "replace")
    mac = ":".join(f"{b:02x}" for b in p[24:30])
    fmac = ":".join(f"{b:02x}" for b in p[30:36])
    boot, rr = struct.unpack_from("<HB", p, 36)
    cfg_id = p[40 + 1] if len(p) > 41 else 0
    return Boot(fw, mac, fmac, boot, rr, cfg_id)


def blocks(buf: bytes):
    """Yield (offset, type, payload) from a flash image, skipping torn sectors as the node does."""
    off = 0
    n = len(buf)
    while off + 8 <= n:
        h = buf[off : off + 8]
        if h[:4] == b"\xff\xff\xff\xff":
            break
        typ, ln, crc = h[1], struct.unpack_from("<H", h, 2)[0], struct.unpack_from("<I", h, 4)[0]
        ok = h[0] == ord("S") and off + 8 + ln <= n
        if ok:
            payload = buf[off + 8 : off + 8 + ln]
            ok = zlib.crc32(payload) & 0xFFFFFFFF == crc
        if not ok:
            off = (off // 4096 + 1) * 4096
            continue
        yield off, chr(typ), payload
        off += (8 + ln + 3) & ~3


def tlv_from_b64(s: str):
    """One serial block copy ("<b64>") -> (type, payload) or None if corrupt."""
    try:
        b = base64.b64decode(s)
    except Exception:
        return None
    if len(b) < 8 or b[0] != ord("S"):
        return None
    ln = struct.unpack_from("<H", b, 2)[0]
    crc = struct.unpack_from("<I", b, 4)[0]
    payload = b[8 : 8 + ln]
    if len(payload) != ln or zlib.crc32(payload) & 0xFFFFFFFF != crc:
        return None
    return chr(b[1]), payload


@dataclass
class Frame:
    host_t: float
    node_t: int  # receiver uptime ms
    rx_node: int
    src: int
    type: int
    rate: str
    seq: int
    rssi: int
    nf: int
    bbfmt: int
    rxrate: int
    length: int
    retry: int
    ptx: int


@dataclass
class Ack:
    host_t: float
    node_t: int
    tx_node: int
    dst: int
    rate: str
    ok: int


@dataclass
class Dataset:
    windows: dict = field(default_factory=dict)  # (node, boot, win) -> Window
    mesh: dict = field(default_factory=dict)  # (node, boot, win) -> MeshWindow
    rtts: list = field(default_factory=list)
    phases: list[Phase] = field(default_factory=list)
    boots: list[Boot] = field(default_factory=list)
    frames: list[Frame] = field(default_factory=list)
    acks: list[Ack] = field(default_factory=list)
    host_anchor: dict = field(default_factory=dict)  # (node, boot) -> (host_t - node_ms/1000)
    collector_nodes: set = field(default_factory=set)
    sources: list[str] = field(default_factory=list)

    def add_window(self, w: Window) -> None:
        k = (w.node, w.boot, w.win)
        old = self.windows.get(k)
        rank = {"flash": 3, "serial": 2, "air": 1}
        if old is None or rank[w.source] > rank[old.source]:
            self.windows[k] = w

    def add_phase(self, ph: Phase) -> None:
        if not any(
            p.node == ph.node and p.boot == ph.boot and p.epoch == ph.epoch for p in self.phases
        ):
            self.phases.append(ph)

    def load_flash(self, path: str) -> None:
        buf = open(path, "rb").read()
        self.sources.append(path)
        for _, typ, p in blocks(buf):
            self._block(typ, p, "flash")

    def _block(self, typ: str, p: bytes, source: str) -> None:
        if typ == "W":
            w = parse_window(p, source)
            if w:
                self.add_window(w)
        elif typ == "M":
            m = parse_mesh_window(p)
            if m:
                self.mesh[(m.node, m.boot, m.win)] = m
        elif typ == "P":
            ph = parse_phase(p)
            if ph:
                self.add_phase(ph)
        elif typ == "O":
            b = parse_boot(p)
            if b and not any(x.mac == b.mac and x.boot == b.boot for x in self.boots):
                self.boots.append(b)

    def load_log(self, path: str) -> None:
        """A collector log: '<host unix>\\t<serial line>' (fieldkit.py collect)."""
        self.sources.append(path)
        me = None
        boot = None
        for raw in open(path, encoding="utf-8", errors="replace"):
            if "\t" not in raw:
                continue
            ts, line = raw.rstrip("\n").split("\t", 1)
            try:
                ht = float(ts)
            except ValueError:
                continue
            tag = line[:2]
            if line.startswith("I,field_node"):
                for kv in line.split(","):
                    if kv.startswith("id="):
                        me = int(kv[3:])
                    if kv.startswith("boot="):
                        boot = int(kv[5:])
                if me:
                    self.collector_nodes.add(me)
            elif tag == "R,":
                f = line.split(",")
                if len(f) >= 13 and me:
                    self.frames.append(
                        Frame(
                            ht,
                            int(f[1]),
                            me,
                            int(f[2]),
                            int(f[3]),
                            f[4],
                            int(f[5]),
                            int(f[6]),
                            int(f[7]),
                            int(f[8]),
                            int(f[9]),
                            int(f[10]),
                            int(f[11]),
                            int(f[12]),
                        )
                    )
                    if boot is not None:
                        self.host_anchor.setdefault((me, boot), ht - int(f[1]) / 1000.0)
            elif tag == "Q,":
                f = line.split(",")
                if len(f) >= 7 and me:
                    self.rtts.append(
                        Rtt(ht, me, int(f[2]), int(f[3]), int(f[4]), int(f[5]), int(f[6]))
                    )
            elif tag == "T,":
                f = line.split(",")
                if len(f) >= 5 and me:
                    self.acks.append(Ack(ht, int(f[1]), me, int(f[2]), f[3], int(f[4])))
            elif tag == "B,":
                t = tlv_from_b64(line[2:])
                if t:
                    self._block(t[0], t[1], "serial")
            elif tag == "H,":
                f = line.split(",", 4)
                if len(f) == 5:
                    t = tlv_from_b64(f[4].lstrip(","))
                    if t:
                        self._block(t[0], t[1], "air")
            elif line.startswith("XB64,"):
                buf = base64.b64decode(line[5:])
                for _, typ, p in blocks(buf):
                    self._block(typ, p, "flash")

    # ---- time ---------------------------------------------------------------------------
    def wall_offset(self, node: int, boot: int) -> float | None:
        """Seconds to add to node uptime (s) to get unix time, for one boot of one node."""
        if (node, boot) in self.host_anchor:
            return self.host_anchor[(node, boot)]
        for p in sorted(self.phases, key=lambda p: p.up_ms):
            if p.node == node and p.boot == boot and p.host_unix:
                return p.host_unix + p.age_ms / 1000.0 - p.up_ms / 1000.0
        return None

    def phase_labels(self) -> dict:
        out = {}
        for p in sorted(self.phases, key=lambda p: p.epoch):
            if p.label and p.phase not in out:
                out[p.phase] = p.label
        return out
