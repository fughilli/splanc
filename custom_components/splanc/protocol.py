"""A small protobuf wire codec for the Splanc player protocol.

The player speaks binary protobuf over ``wss://<host>/ws``: every WebSocket
message is one ``ClientMessage`` (to the lamp) or ``ServerMessage`` (from it)
envelope, see ``shared/protocol/proto/ledmapper.proto``. Home Assistant needs a
handful of arms, so this module hand-codes exactly those instead of depending on
the ``protobuf`` package (whose pinned version Home Assistant core controls).

``tests/test_protocol.py`` (a Bazel test) parses ``ledmapper.proto`` and checks
every field number used here, so a renumbering on either side fails CI.

This module must not import Home Assistant: the Bazel test loads it on its own.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any

# -- ClientMessage arms -------------------------------------------------------
C_HELLO = 1
C_TIME_SYNC_PING = 2
C_SET_BRIGHTNESS = 31
C_LIST_KEYPOINTS = 42
C_BLEND_KEYPOINTS = 44
C_SET_POWER = 130
C_GET_POWER = 131

# -- ServerMessage arms -------------------------------------------------------
S_WELCOME = 1
S_TIME_SYNC_PONG = 2
S_ERROR = 9
S_PLAYBACK_STATE = 13
S_KEYPOINT_LIST = 22
S_POWER_STATE = 70

SERVER_ARM_NAMES = {
    S_WELCOME: "welcome",
    S_TIME_SYNC_PONG: "time_sync_pong",
    S_ERROR: "error",
    S_PLAYBACK_STATE: "playback_state",
    S_KEYPOINT_LIST: "keypoint_list",
    S_POWER_STATE: "power_state",
}

# Field numbers per message, as used below (checked against the .proto).
FIELDS: dict[str, dict[str, int]] = {
    "ClientMessage": {
        "hello": C_HELLO,
        "time_sync_ping": C_TIME_SYNC_PING,
        "set_brightness": C_SET_BRIGHTNESS,
        "list_keypoints": C_LIST_KEYPOINTS,
        "blend_keypoints": C_BLEND_KEYPOINTS,
        "set_power": C_SET_POWER,
        "get_power": C_GET_POWER,
    },
    "ServerMessage": {name: num for num, name in SERVER_ARM_NAMES.items()},
    "Hello": {"client": 1, "app_version": 2},
    "TimeSyncPing": {"t0": 1},
    "SetBrightness": {"brightness": 1},
    "ListKeypoints": {"deck": 1, "effect_id": 2},
    "KeypointWeight": {"name": 1, "weight": 2},
    "BlendKeypoints": {"deck": 1, "weights": 2, "seconds": 3},
    "SetPower": {"on": 1, "toggle": 2, "instant": 3, "duration_ms": 4},
    "Welcome": {
        "session_id": 1,
        "mac": 4,
        "device_name": 5,
        "brightness": 6,
        "fw_version": 9,
        "features": 10,
    },
    "Error": {"code": 1, "message": 2},
    "PlaybackState": {"active": 1, "effect": 2},
    "KeypointInfo": {"index": 1, "name": 2, "stale": 3},
    "KeypointList": {"effect_id": 1, "deck": 2, "keypoints": 3, "capacity": 4},
    "PowerState": {
        "on": 1,
        "phase": 2,
        "brightness": 3,
        "effect_id": 4,
        "source": 5,
        "boot": 6,
        "toggle_trigger": 9,
        "trigger_count": 10,
        "seq": 12,
        "transition_left_ms": 13,
    },
}

# Messages that come from the lamp-power work (feature "power").
POWER_MESSAGES = ("SetPower", "PowerState")
POWER_ARMS = {"set_power", "get_power", "power_state"}

# PowerState.phase / .source values.
PHASE_OFF, PHASE_ON, PHASE_TURNING_ON, PHASE_TURNING_OFF = 0, 1, 2, 3
PHASE_NAMES = ["off", "on", "turning_on", "turning_off"]
SOURCE_BOOT, SOURCE_CLIENT, SOURCE_TRIGGER = 0, 1, 2
# TRIGGER = the lamp's toggle trigger fired (a tap on the lid's touch sensor).
SOURCE_NAMES = ["boot", "client", "trigger"]

WT_VARINT, WT_I64, WT_LEN, WT_I32 = 0, 1, 2, 5


class DecodeError(ValueError):
    """The bytes are not a valid protobuf message."""


# -- encoding -----------------------------------------------------------------


def _varint(n: int) -> bytes:
    if n < 0:
        n &= (1 << 64) - 1  # int32/int64 negatives are 10-byte varints
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _key(num: int, wt: int) -> bytes:
    return _varint((num << 3) | wt)


def f_varint(num: int, v: int | bool) -> bytes:
    """A varint field (uint32/int32/bool); proto3 drops zero values."""
    v = int(v)
    return _key(num, WT_VARINT) + _varint(v) if v else b""


def f_double(num: int, v: float, *, always: bool = False) -> bytes:
    return _key(num, WT_I64) + struct.pack("<d", v) if (v or always) else b""


def f_float(num: int, v: float, *, always: bool = False) -> bytes:
    return _key(num, WT_I32) + struct.pack("<f", v) if (v or always) else b""


def f_bytes(num: int, v: bytes, *, always: bool = False) -> bytes:
    return _key(num, WT_LEN) + _varint(len(v)) + v if (v or always) else b""


def f_str(num: int, v: str, *, always: bool = False) -> bytes:
    return f_bytes(num, v.encode(), always=always)


def envelope(arm: int, body: bytes) -> bytes:
    """A ClientMessage with oneof `arm` set (an empty body still selects it)."""
    return f_bytes(arm, body, always=True)


def hello(client: str, app_version: str) -> bytes:
    return envelope(C_HELLO, f_str(1, client) + f_str(2, app_version))


def time_sync_ping(t0: float) -> bytes:
    return envelope(C_TIME_SYNC_PING, f_double(1, t0))


def set_brightness(brightness: float) -> bytes:
    b = min(1.0, max(0.0, brightness))
    return envelope(C_SET_BRIGHTNESS, f_double(1, b))


def list_keypoints(deck: int = 0) -> bytes:
    return envelope(C_LIST_KEYPOINTS, f_varint(1, deck))


def blend_keypoints(weights: dict[str, float], seconds: float, deck: int = 0) -> bytes:
    body = f_varint(1, deck)
    for name, w in weights.items():
        body += f_bytes(2, f_str(1, name) + f_float(2, w))
    body += f_float(3, seconds)
    return envelope(C_BLEND_KEYPOINTS, body)


def set_power(
    on: bool | None = None,
    *,
    toggle: bool = False,
    instant: bool = False,
    duration_ms: int = 0,
) -> bytes:
    body = f_varint(1, bool(on)) + f_varint(2, toggle) + f_varint(3, instant)
    body += f_varint(4, max(0, int(duration_ms)))
    return envelope(C_SET_POWER, body)


def get_power() -> bytes:
    return envelope(C_GET_POWER, b"")


# -- decoding -----------------------------------------------------------------


def _read_varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = 0
    n = 0
    while True:
        if i >= len(buf):
            raise DecodeError("truncated varint")
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7
        if shift > 63:
            raise DecodeError("varint too long")


def fields(buf: bytes) -> list[tuple[int, int, Any]]:
    """Every (field number, wire type, raw value) in `buf`, in order. LEN
    values are bytes, I64/I32 are the raw 8/4 bytes, VARINT an int."""
    out: list[tuple[int, int, Any]] = []
    i = 0
    while i < len(buf):
        key, i = _read_varint(buf, i)
        num, wt = key >> 3, key & 7
        if wt == WT_VARINT:
            v, i = _read_varint(buf, i)
        elif wt == WT_I64:
            v, i = buf[i : i + 8], i + 8
        elif wt == WT_LEN:
            n, i = _read_varint(buf, i)
            v, i = buf[i : i + n], i + n
        elif wt == WT_I32:
            v, i = buf[i : i + 4], i + 4
        else:
            raise DecodeError(f"unsupported wire type {wt}")
        if i > len(buf):
            raise DecodeError("truncated field")
        out.append((num, wt, v))
    return out


def _double(raw: Any, wt: int) -> float:
    if wt != WT_I64:
        raise DecodeError("expected a double")
    return struct.unpack("<d", raw)[0]


def _text(raw: Any, wt: int) -> str:
    if wt != WT_LEN:
        raise DecodeError("expected a string")
    return bytes(raw).decode("utf-8", "replace")


@dataclass
class Welcome:
    session_id: str = ""
    mac: str = ""
    device_name: str = ""
    brightness: float | None = None
    fw_version: str = ""
    features: list[str] = field(default_factory=list)


@dataclass
class ErrorReply:
    code: str = ""
    message: str = ""


@dataclass
class PlaybackState:
    active: bool = False
    effect: str = ""


@dataclass
class KeypointList:
    effect_id: str = ""
    deck: int = 0
    names: list[str] = field(default_factory=list)
    capacity: int = 0


@dataclass
class PowerState:
    on: bool = False
    phase: int = 0
    brightness: float = 0.0
    effect_id: str = ""
    source: int = 0
    boot: int = 0
    # The uniform-pool trigger bound to "toggle" (e.g. "touch_tap"); "" = none.
    toggle_trigger: str = ""
    # How often that trigger toggled the lamp since boot.
    trigger_count: int = 0
    seq: int = 0
    transition_left_ms: int = 0


def _decode_welcome(buf: bytes) -> Welcome:
    w = Welcome()
    for num, wt, v in fields(buf):
        if num == 1:
            w.session_id = _text(v, wt)
        elif num == 4:
            w.mac = _text(v, wt)
        elif num == 5:
            w.device_name = _text(v, wt)
        elif num == 6:
            w.brightness = _double(v, wt)
        elif num == 9:
            w.fw_version = _text(v, wt)
        elif num == 10:
            w.features.append(_text(v, wt))
    return w


def _decode_error(buf: bytes) -> ErrorReply:
    e = ErrorReply()
    for num, wt, v in fields(buf):
        if num == 1:
            e.code = _text(v, wt)
        elif num == 2:
            e.message = _text(v, wt)
    return e


def _decode_playback(buf: bytes) -> PlaybackState:
    p = PlaybackState()
    for num, wt, v in fields(buf):
        if num == 1 and wt == WT_VARINT:
            p.active = bool(v)
        elif num == 2:
            p.effect = _text(v, wt)
    return p


def _decode_keypoints(buf: bytes) -> KeypointList:
    k = KeypointList()
    for num, wt, v in fields(buf):
        if num == 1:
            k.effect_id = _text(v, wt)
        elif num == 2 and wt == WT_VARINT:
            k.deck = v
        elif num == 3 and wt == WT_LEN:
            for n2, wt2, v2 in fields(v):
                if n2 == 2:
                    k.names.append(_text(v2, wt2))
        elif num == 4 and wt == WT_VARINT:
            k.capacity = v
    return k


_POWER_VARINTS = {
    1: "on",
    2: "phase",
    5: "source",
    6: "boot",
    10: "trigger_count",
    12: "seq",
    13: "transition_left_ms",
}
_BOOLS = {"on"}


def _decode_power(buf: bytes) -> PowerState:
    p = PowerState()
    for num, wt, v in fields(buf):
        if num == 3:
            p.brightness = _double(v, wt)
        elif num == 4:
            p.effect_id = _text(v, wt)
        elif num == 9:
            p.toggle_trigger = _text(v, wt)
        elif num in _POWER_VARINTS and wt == WT_VARINT:
            name = _POWER_VARINTS[num]
            setattr(p, name, bool(v) if name in _BOOLS else v)
    return p


_DECODERS = {
    S_WELCOME: _decode_welcome,
    S_ERROR: _decode_error,
    S_PLAYBACK_STATE: _decode_playback,
    S_KEYPOINT_LIST: _decode_keypoints,
    S_POWER_STATE: _decode_power,
}


def decode_server(buf: bytes) -> tuple[str, Any]:
    """Decode a ServerMessage envelope: (arm name, decoded body). Arms this
    module doesn't model come back as ("arm_<n>", raw bytes)."""
    fs = fields(buf)
    if not fs:
        raise DecodeError("empty envelope")
    num, wt, v = fs[-1]  # a oneof: the last one wins
    if wt != WT_LEN:
        raise DecodeError("envelope arm is not a message")
    name = SERVER_ARM_NAMES.get(num)
    dec = _DECODERS.get(num)
    if dec is None:
        return (name or f"arm_{num}", bytes(v))
    return name or f"arm_{num}", dec(bytes(v))


# -- test helpers: the lamp's side of the wire --------------------------------


def server_envelope(arm: int, body: bytes) -> bytes:
    return f_bytes(arm, body, always=True)


def encode_welcome(w: Welcome) -> bytes:
    body = f_str(1, w.session_id) + f_str(4, w.mac) + f_str(5, w.device_name)
    if w.brightness is not None:
        body += f_double(6, w.brightness, always=True)
    body += f_str(9, w.fw_version)
    for feat in w.features:
        body += f_str(10, feat, always=True)
    return server_envelope(S_WELCOME, body)


def encode_power_state(p: PowerState) -> bytes:
    body = f_double(3, p.brightness) + f_str(4, p.effect_id) + f_str(9, p.toggle_trigger)
    for num, name in _POWER_VARINTS.items():
        body += f_varint(num, getattr(p, name))
    return server_envelope(S_POWER_STATE, body)


def encode_keypoint_list(k: KeypointList) -> bytes:
    body = f_str(1, k.effect_id) + f_varint(2, k.deck)
    for i, n in enumerate(k.names):
        body += f_bytes(3, f_varint(1, i) + f_str(2, n), always=True)
    body += f_varint(4, k.capacity)
    return server_envelope(S_KEYPOINT_LIST, body)


def encode_playback(p: PlaybackState) -> bytes:
    return server_envelope(S_PLAYBACK_STATE, f_varint(1, p.active) + f_str(2, p.effect))


def encode_error(code: str, message: str = "") -> bytes:
    return server_envelope(S_ERROR, f_str(1, code) + f_str(2, message))


def encode_pong(t0: float) -> bytes:
    return server_envelope(S_TIME_SYNC_PONG, f_double(1, t0))


def decode_client(buf: bytes) -> tuple[int, dict[int, list[Any]]]:
    """Decode a ClientMessage envelope into (arm, {field: [raw values]}) (tests)."""
    fs = fields(buf)
    if not fs:
        raise DecodeError("empty envelope")
    num, _wt, v = fs[-1]
    body: dict[int, list[Any]] = {}
    for n2, _wt2, v2 in fields(bytes(v)):
        body.setdefault(n2, []).append(v2)
    return num, body


def unpack_double(raw: bytes) -> float:
    return struct.unpack("<d", raw)[0]


def unpack_float(raw: bytes) -> float:
    return struct.unpack("<f", raw)[0]
