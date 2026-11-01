"""The P4 link frames (docs/design/p4-c6-split.md §4.1), host side.

Byte-for-byte the same as firmware/p4/link/link_codec.h: a 12-byte little-endian
header (ver, type, lane, flags, session, seq, len, crc), CRC-16/CCITT-FALSE over
the header (crc = 0) and the payload, and on a byte stream each frame as
0x00 + COBS(header + payload) + 0x00. p4_link_test.py pins the same vectors as
link_codec_test.cc.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

VERSION = 1
HEADER = 12
MTU = 4096

PLAYER, REPLY, PUSH, LINK, BULK, LOG, OSC = 1, 2, 3, 4, 5, 6, 7
MORE, ACK_REQ = 1, 2
OP_HELLO, OP_HEARTBEAT, OP_RESET, OP_NAME, OP_STATS = 1, 2, 3, 4, 5

TYPE_NAMES = {PLAYER: "PLAYER", REPLY: "REPLY", PUSH: "PUSH", LINK: "LINK", BULK: "BULK", LOG: "LOG", OSC: "OSC"}


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


@dataclass
class Frame:
    type: int
    payload: bytes = b""
    lane: int = 0
    flags: int = 0
    session: int = 0
    seq: int = 0

    def pack(self) -> bytes:
        """Header + payload (not yet COBS-framed)."""
        if len(self.payload) > MTU:
            raise ValueError(f"payload {len(self.payload)} > MTU {MTU}")
        hdr = struct.pack("<BBBBHHHH", VERSION, self.type, self.lane, self.flags, self.session, self.seq,
                          len(self.payload), 0)
        crc = crc16(self.payload, crc16(hdr))
        return hdr[:10] + struct.pack("<H", crc) + self.payload


def unpack(raw: bytes) -> Frame | None:
    """A decoded frame (header + payload), or None when it isn't valid."""
    if len(raw) < HEADER:
        return None
    ver, typ, lane, flags, session, seq, n, crc = struct.unpack_from("<BBBBHHHH", raw)
    if ver != VERSION or n > MTU or HEADER + n != len(raw):
        return None
    if crc16(raw[HEADER:], crc16(raw[:10] + b"\0\0")) != crc:
        return None
    return Frame(typ, bytes(raw[HEADER:]), lane, flags, session, seq)


def cobs_encode(data: bytes) -> bytes:
    out = bytearray()
    block = bytearray()
    for b in data:
        if b == 0:
            out.append(len(block) + 1)
            out += block
            block.clear()
        else:
            block.append(b)
            if len(block) == 254:
                out.append(255)
                out += block
                block.clear()
    out.append(len(block) + 1)
    out += block
    return bytes(out)


def cobs_decode(data: bytes) -> bytes | None:
    out = bytearray()
    i = 0
    while i < len(data):
        code = data[i]
        i += 1
        if code == 0 or i + code - 1 > len(data):
            return None
        out += data[i:i + code - 1]
        i += code - 1
        if code != 0xFF and i < len(data):
            out.append(0)
    return bytes(out)


def encode(frame: Frame) -> bytes:
    """One frame as stream bytes."""
    return b"\0" + cobs_encode(frame.pack()) + b"\0"


def fragments(typ: int, msg: bytes, session: int = 0, lane: int = 0) -> list[Frame]:
    """A message as MTU-sized frames, all but the last flagged MORE (seq left 0)."""
    parts = [msg[i:i + MTU] for i in range(0, len(msg), MTU)] or [b""]
    return [Frame(typ, p, lane, MORE if k + 1 < len(parts) else 0, session) for k, p in enumerate(parts)]


class StreamDecoder:
    """Splits a byte stream into frames and noise (bytes that aren't frames: the
    ROM's and bootloader's console text, or a frame cut by a reset)."""

    def __init__(self) -> None:
        self.buf = bytearray()

    def feed(self, data: bytes) -> list[Frame | bytes]:
        out: list[Frame | bytes] = []
        start = 0
        while True:
            z = data.find(b"\0", start)
            if z < 0:
                self.buf += data[start:]
                break
            self.buf += data[start:z]
            start = z + 1
            if not self.buf:
                continue
            raw = bytes(self.buf)
            self.buf.clear()
            dec = cobs_decode(raw)
            frame = unpack(dec) if dec is not None else None
            out.append(frame if frame is not None else raw)
        return out


class Reassembler:
    """Joins MORE fragments per (type, session) into whole messages."""

    def __init__(self) -> None:
        self.parts: dict[tuple[int, int], bytearray] = {}

    def push(self, f: Frame) -> bytes | None:
        key = (f.type, f.session)
        buf = self.parts.setdefault(key, bytearray())
        buf += f.payload
        if f.flags & MORE:
            return None
        del self.parts[key]
        return bytes(buf)
