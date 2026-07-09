"""Protobuf wire boundary (proto-comms): binary frames <-> flat §7 dicts.

The WebSocket now carries binary `ledmapper.v1.ClientMessage` /
`ServerMessage` protobuf frames. Everything INSIDE the server still speaks
the original flat-JSON message shape (pydantic models keyed by a "type"
discriminator), so this module is the entire migration surface:

    bytes --decode_client--> {"type": "hello", ...}   (into handler.handle)
    {"type": "welcome", ...} --encode_server--> bytes (out of the handlers)

The proto file was designed for JSON parity (see ledmapper.proto), so the
conversion is `json_format` plus three small seams:
  - the envelope: oneof arm name == the "type" value (snake_case);
  - None values are stripped before ParseDict (JSON null == proto unset);
  - trajectories reshape between [[x,y,z], ...] and repeated Vec3
    ({"v": [x,y,z]}) — the one nesting proto3 JSON cannot express.

Unset optional fields DECODE as absent keys; the pydantic models give every
such field a None default, so absence and null are equivalent downstream.
Repeated fields decode as [] where the JSON wire may have said null — all
consumers treat the two alike (checked by test_proto_wire.py).
"""

from __future__ import annotations

from typing import Any, Dict

from google.protobuf import json_format
from ledmapper_pb2 import ClientMessage, ServerMessage


def _strip_nones(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_nones(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_nones(v) for v in value]
    return value


def _trajectory_to_proto(value: Any) -> Any:
    """[[x,y,z], ...] -> [{"v": [x,y,z]}, ...] wherever a `trajectory` key
    appears (OutputMap inside live_map, and solve_status)."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "trajectory" and isinstance(v, list):
                out[k] = [{"v": p} for p in v]
            else:
                out[k] = _trajectory_to_proto(v)
        return out
    if isinstance(value, list):
        return [_trajectory_to_proto(v) for v in value]
    return value


def _trajectory_from_proto(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "trajectory" and isinstance(v, list):
                out[k] = [p.get("v", []) for p in v]
            else:
                out[k] = _trajectory_from_proto(v)
        return out
    if isinstance(value, list):
        return [_trajectory_from_proto(v) for v in value]
    return value


def _encode(envelope, flat: Dict[str, Any]) -> bytes:
    msg_type = flat["type"]
    inner = {k: v for k, v in flat.items() if k != "type"}
    inner = _trajectory_to_proto(_strip_nones(inner))
    arm = getattr(envelope, msg_type)
    json_format.ParseDict(inner, arm)
    # Touch the arm so empty messages (stop_mapping, get_status, ...) still
    # select their oneof case.
    getattr(envelope, msg_type).SetInParent()
    return envelope.SerializeToString()


def _decode(envelope) -> Dict[str, Any]:
    arm = envelope.WhichOneof("msg")
    if arm is None:
        raise json_format.ParseError("envelope has no message set")
    inner = json_format.MessageToDict(
        getattr(envelope, arm),
        preserving_proto_field_name=False,
        always_print_fields_with_no_presence=True,
    )
    flat = {"type": arm, **_trajectory_from_proto(inner)}
    return flat


def encode_client(flat: Dict[str, Any]) -> bytes:
    return _encode(ClientMessage(), flat)


def decode_client(data: bytes) -> Dict[str, Any]:
    msg = ClientMessage()
    msg.ParseFromString(data)
    return _decode(msg)


def encode_server(flat: Dict[str, Any]) -> bytes:
    return _encode(ServerMessage(), flat)


def decode_server(data: bytes) -> Dict[str, Any]:
    msg = ServerMessage()
    msg.ParseFromString(data)
    return _decode(msg)
