"""The HA integration's hand-written protobuf codec vs. the real contract.

1. Every field number in protocol.FIELDS matches shared/protocol/proto/ledmapper.proto
   (parsed as text), so a renumbering on either side fails here.
2. Frames the codec encodes decode with the protoc-generated ledmapper_pb2 into
   the intended values, and frames built with ledmapper_pb2 decode with the codec.

The power arms (set_power / get_power / power_state) come from the lamp-power
work (docs/design/lamp-power.md). Until that lands in ledmapper.proto, their
checks are skipped; once it does, they run.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import unittest
from pathlib import Path


def _runfile(rel: str) -> Path:
    for root in (os.environ.get("TEST_SRCDIR"), os.environ.get("RUNFILES_DIR")):
        if root:
            for ws in ("_main", ""):
                p = Path(root, ws, rel)
                if p.exists():
                    return p
    here = Path(__file__).resolve().parents[2] / rel  # outside Bazel
    if here.exists():
        return here
    raise FileNotFoundError(rel)


def _load_protocol():
    path = _runfile("custom_components/splanc/protocol.py")
    spec = importlib.util.spec_from_file_location("splanc_protocol", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["splanc_protocol"] = mod
    spec.loader.exec_module(mod)
    return mod


p = _load_protocol()
PROTO = _runfile("shared/protocol/proto/ledmapper.proto").read_text()

import ledmapper_pb2 as pb  # noqa: E402


def proto_fields(text: str) -> dict[str, dict[str, int]]:
    """{message: {field: number}} for the top-level messages of a .proto file
    (oneof members included; nested messages are not used by the codec)."""
    out: dict[str, dict[str, int]] = {}
    for m in re.finditer(r"^message (\w+) \{(.*?)^\}", text, re.S | re.M):
        body = re.sub(r"//[^\n]*", "", m.group(2))
        fields = {}
        for f in re.finditer(r"^\s*(?:optional |repeated )?[\w.]+ (\w+) = (\d+)", body, re.M):
            fields[f.group(1)] = int(f.group(2))
        out[m.group(1)] = fields
    return out


FIELDS = proto_fields(PROTO)
HAS_POWER = "set_power" in FIELDS.get("ClientMessage", {})


class FieldNumbers(unittest.TestCase):
    def test_every_field_number_matches_the_proto(self) -> None:
        for msg, fields in p.FIELDS.items():
            if msg in p.POWER_MESSAGES and not HAS_POWER:
                continue
            with self.subTest(msg=msg):
                self.assertIn(msg, FIELDS, f"{msg} is not in ledmapper.proto")
                for name, num in fields.items():
                    if (
                        msg in ("ClientMessage", "ServerMessage")
                        and name in p.POWER_ARMS
                        and not HAS_POWER
                    ):
                        continue
                    self.assertEqual(FIELDS[msg].get(name), num, f"{msg}.{name}")

    def test_power_arms_stay_free_or_match(self) -> None:
        # Before the lamp-power proto lands, nothing else may take its numbers.
        if HAS_POWER:
            self.skipTest("power arms are in the proto (checked above)")
        client = {v: k for k, v in FIELDS["ClientMessage"].items()}
        server = {v: k for k, v in FIELDS["ServerMessage"].items()}
        for num in (p.C_SET_POWER, p.C_GET_POWER):
            self.assertNotIn(num, client, f"ClientMessage {num} is taken by {client.get(num)}")
        self.assertNotIn(p.S_POWER_STATE, server, f"ServerMessage {p.S_POWER_STATE} is taken")


class RoundTrips(unittest.TestCase):
    def client(self, frame: bytes):
        m = pb.ClientMessage()
        m.ParseFromString(frame)
        return m

    def test_hello(self) -> None:
        m = self.client(p.hello("home-assistant", "0.1.0"))
        self.assertEqual(m.WhichOneof("msg"), "hello")
        self.assertEqual((m.hello.client, m.hello.app_version), ("home-assistant", "0.1.0"))

    def test_set_brightness(self) -> None:
        m = self.client(p.set_brightness(0.25))
        self.assertEqual(m.WhichOneof("msg"), "set_brightness")
        self.assertAlmostEqual(m.set_brightness.brightness, 0.25)
        # 0 still selects the arm (an empty body).
        m = self.client(p.set_brightness(0.0))
        self.assertEqual(m.WhichOneof("msg"), "set_brightness")
        self.assertEqual(m.set_brightness.brightness, 0.0)

    def test_list_and_blend_keypoints(self) -> None:
        m = self.client(p.list_keypoints(0))
        self.assertEqual(m.WhichOneof("msg"), "list_keypoints")
        m = self.client(p.blend_keypoints({"Party": 1.0}, 0.5))
        self.assertEqual(m.WhichOneof("msg"), "blend_keypoints")
        b = m.blend_keypoints
        self.assertEqual([(w.name, w.weight) for w in b.weights], [("Party", 1.0)])
        self.assertAlmostEqual(b.seconds, 0.5)

    def test_time_sync_ping(self) -> None:
        m = self.client(p.time_sync_ping(12.5))
        self.assertEqual(m.time_sync_ping.t0, 12.5)

    def test_welcome_from_pb(self) -> None:
        s = pb.ServerMessage()
        w = s.welcome
        w.session_id = "x"
        w.mac = "AA:BB:CC:00:11:22"
        w.device_name = "Coil"
        w.brightness = 0.7
        w.fw_version = "1.20.0"
        w.features.extend(["effects", "keypoints", "power"])
        w.fxb_format = 3  # a field the codec skips
        arm, got = p.decode_server(s.SerializeToString())
        self.assertEqual(arm, "welcome")
        self.assertEqual(got.mac, "AA:BB:CC:00:11:22")
        self.assertEqual(got.device_name, "Coil")
        self.assertAlmostEqual(got.brightness, 0.7)
        self.assertEqual(got.features, ["effects", "keypoints", "power"])
        # The codec's own encoder (the fake lamp's) agrees with pb.
        s2 = pb.ServerMessage()
        s2.ParseFromString(p.encode_welcome(got))
        self.assertEqual(s2.welcome.mac, w.mac)
        self.assertEqual(list(s2.welcome.features), list(w.features))

    def test_keypoint_list_error_playback_from_pb(self) -> None:
        s = pb.ServerMessage()
        s.keypoint_list.effect_id = "aurora"
        for i, n in enumerate(["Calm", "Party"]):
            k = s.keypoint_list.keypoints.add()
            k.index, k.name = i, n
        s.keypoint_list.capacity = 16
        arm, kl = p.decode_server(s.SerializeToString())
        self.assertEqual(
            (arm, kl.effect_id, kl.names, kl.capacity),
            ("keypoint_list", "aurora", ["Calm", "Party"], 16),
        )

        s = pb.ServerMessage()
        s.error.code, s.error.message = "no_keypoint", "nope"
        arm, e = p.decode_server(s.SerializeToString())
        self.assertEqual((arm, e.code, e.message), ("error", "no_keypoint", "nope"))

        s = pb.ServerMessage()
        s.playback_state.active, s.playback_state.effect = True, "aurora"
        arm, ps = p.decode_server(s.SerializeToString())
        self.assertEqual((arm, ps.active, ps.effect), ("playback_state", True, "aurora"))

    def test_unknown_arm_is_passed_through(self) -> None:
        s = pb.ServerMessage()
        s.tls_info.state = "ready"
        arm, raw = p.decode_server(s.SerializeToString())
        self.assertEqual(arm, f"arm_{FIELDS['ServerMessage']['tls_info']}")

    @unittest.skipUnless(HAS_POWER, "the lamp-power arms are not in ledmapper.proto yet")
    def test_power_arms(self) -> None:
        m = self.client(p.set_power(False, duration_ms=2000))
        self.assertEqual(m.WhichOneof("msg"), "set_power")
        self.assertEqual((m.set_power.on, m.set_power.duration_ms), (False, 2000))
        self.assertEqual(self.client(p.get_power()).WhichOneof("msg"), "get_power")
        s = pb.ServerMessage()
        ps = s.power_state
        ps.on, ps.phase, ps.brightness, ps.effect_id = True, 2, 0.5, "aurora"
        ps.source, ps.toggle_trigger, ps.trigger_count, ps.seq = 2, "touch_tap", 3, 42
        arm, got = p.decode_server(s.SerializeToString())
        self.assertEqual(arm, "power_state")
        self.assertEqual(
            (
                got.on,
                got.phase,
                got.effect_id,
                got.source,
                got.toggle_trigger,
                got.trigger_count,
                got.seq,
            ),
            (True, 2, "aurora", 2, "touch_tap", 3, 42),
        )
        self.assertAlmostEqual(got.brightness, 0.5)


class Codec(unittest.TestCase):
    def test_varints(self) -> None:
        for n in (0, 1, 127, 128, 300, 2**32 - 1, 2**63):
            enc = p._varint(n)
            self.assertEqual(p._read_varint(enc, 0), (n, len(enc)))

    def test_power_state_round_trip(self) -> None:
        ps = p.PowerState(
            on=True,
            phase=1,
            brightness=0.3,
            effect_id="e",
            source=2,
            toggle_trigger="t",
            trigger_count=5,
            seq=9,
        )
        arm, got = p.decode_server(p.encode_power_state(ps))
        self.assertEqual(arm, "power_state")
        self.assertEqual(got, ps)

    def test_truncated_frames_raise(self) -> None:
        frame = p.encode_welcome(p.Welcome(mac="AA:BB:CC:00:11:22", device_name="Coil"))
        for cut in (1, 3, len(frame) - 1):
            with self.assertRaises(p.DecodeError):
                p.decode_server(frame[:cut])


if __name__ == "__main__":
    unittest.main()
