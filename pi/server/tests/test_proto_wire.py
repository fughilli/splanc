"""Protobuf wire boundary (proto_wire): §7 flat dicts <-> binary frames.

Every message type round-trips through the binary envelope and re-validates
against the pydantic contract models. Null/absence semantics are pinned:
JSON null == proto unset (absent key after decode; the pydantic models
default those fields to None), and nullable REPEATED fields decode as []
(consumers treat null and [] alike).
"""

import json

import pytest
from ledmapper_protocol import ClientMessage, ServerMessage
from server import proto_wire
from server.proto_examples import CLIENT_FLATS, OUTPUT_MAP, POSELESS, SERVER_FLATS

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11", "PR-34")


def _normalize(flat):
    """Decode-side equivalences: absent == null; nullable repeated == []."""

    def norm(v):
        if isinstance(v, dict):
            return {k: norm(x) for k, x in v.items() if x is not None}
        if isinstance(v, list):
            return [norm(x) for x in v]
        return v

    out = norm(flat)
    for key in ("leds", "trajectory"):
        if (
            flat.get(key) is None
            and key in ("leds", "trajectory")
            and flat["type"] == "solve_status"
        ):
            out[key] = []
    return out


@pytest.mark.parametrize("flat", CLIENT_FLATS, ids=lambda f: f["type"])
def test_client_roundtrip(flat):
    data = proto_wire.encode_client(flat)
    back = proto_wire.decode_client(data)
    assert back["type"] == flat["type"]
    # The decoded dict must re-validate against the §7 pydantic contract.
    model = ClientMessage.model_validate(back).root
    assert model.type == flat["type"]
    # Semantic equality modulo null/absent/[] equivalences.
    revalidated = json.loads(ClientMessage.model_validate(back).root.model_dump_json())
    original = json.loads(ClientMessage.model_validate(flat).root.model_dump_json())
    assert _normalize(revalidated) == _normalize(original)


@pytest.mark.parametrize("flat", SERVER_FLATS, ids=lambda f: f["type"] + str(f.get("active", "")))
def test_server_roundtrip(flat):
    data = proto_wire.encode_server(flat)
    back = proto_wire.decode_server(data)
    assert back["type"] == flat["type"]
    model = ServerMessage.model_validate(back).root
    assert model.type == flat["type"]
    revalidated = json.loads(ServerMessage.model_validate(back).root.model_dump_json())
    original = json.loads(ServerMessage.model_validate(flat).root.model_dump_json())
    assert _normalize(revalidated) == _normalize(original)


def test_poseless_record_decodes_with_pose_absent_then_none():
    data = proto_wire.encode_client({"type": "detections", "batch": [POSELESS]})
    back = proto_wire.decode_client(data)
    rec = back["batch"][0]
    assert "pose" not in rec  # proto unset -> absent key
    model = ClientMessage.model_validate(back).root
    assert model.batch[0].pose is None  # pydantic default fills None


def test_trajectory_reshapes_between_nested_arrays_and_vec3():
    flat = {"type": "live_map", "active": True, "map": OUTPUT_MAP}
    back = proto_wire.decode_server(proto_wire.encode_server(flat))
    assert back["map"]["trajectory"] == [[0.0, 0.0, 0.0], [0.05, 0.01, -0.02]]


def test_undecodable_frame_raises():
    with pytest.raises(Exception):
        proto_wire.decode_client(b"\xff\xfe not a proto frame")
