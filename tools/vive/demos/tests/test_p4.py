"""--p4 (a Splanc P4 player with its tracker wired in): lhd's stations go out as standalone
/lh/station datagrams, the P4's tracker (/lh/pose) is the fixture tracker for probing, the
stylus fit goes out as /lh/mount (P4 tracker <- fixture map, column-major), and live shapes
go out in the world frame.

    python3 tools/vive/demos/tests/test_p4.py
"""

import os
import sys
import time
import unittest

import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import app as appmod  # noqa: E402
import osc  # noqa: E402
import synth  # noqa: E402


class Transport:
    def __init__(self):
        self.sent = []

    def send(self, data):
        self.sent.append(data)

    def messages(self, addr):
        return [args for d in self.sent for a, args in osc.decode(d) if a == addr]


class Stream:
    sent = 0

    def __init__(self):
        self.values = {}
        self.transport = Transport()

    def set(self, addr, *v, keepalive=None):
        self.values[addr] = v

    def clear(self, *addrs):
        for a in addrs:
            self.values.pop(a, None)


class Source:
    def __init__(self):
        q = np.array([0.5, 0.5, 0.5, 0.5])
        self.lighthouses = {"1416427640": (np.array([1.0, 2.0, 2.5]), q)}

    def status(self):
        return {"source": "test"}


class Fit:
    def __init__(self, T):
        self.T_TF = T

    def to_json(self):
        return {}


class P4Mode(unittest.TestCase):
    def setUp(self):
        lm, *_ = synth.cylinder_lamp()
        self.stream = Stream()
        self.app = appmod.App(
            lm, Source(), self.stream, "test", mount_name="p4-test", stylus="S", p4=True
        )

    def tearDown(self):
        p = os.path.join(appmod.MOUNTS, "p4-test.json")
        if os.path.exists(p):
            os.remove(p)

    def test_stations(self):
        time.sleep(0.2)
        msgs = self.stream.transport.messages("/lh/station")
        self.assertTrue(msgs)
        sid, *pose = msgs[0]
        self.assertEqual(sid & 0xFFFFFFFF, 1416427640)
        np.testing.assert_allclose(pose, [1.0, 2.0, 2.5, 0.5, 0.5, 0.5, 0.5], atol=1e-6)
        # Standalone messages, never bundles (the P4 module only claims single messages).
        self.assertFalse(any(d.startswith(b"#bundle") for d in self.stream.transport.sent))

    def test_mount_and_world_shapes(self):
        T = np.eye(4)
        T[:3, :3] = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
        T[:3, 3] = [0.3, -0.2, 0.9]
        self.app.pfit = Fit(T)
        self.app.save_probe_mount()
        mt = self.stream.transport.messages("/lh/mount")
        self.assertEqual(len(mt), 3)
        np.testing.assert_allclose(mt[0], T.T.reshape(-1), atol=1e-6)  # column-major
        self.assertFalse(self.stream.transport.messages("/lh/fixture"))
        self.assertEqual(self.app.mode, "live")
        self.app.set_shape("sphere")
        self.app.set_sphere([0.1, 0.2, 1.3], 0.05)
        # The sphere goes out as given, in the world frame (the P4 has the pose).
        np.testing.assert_allclose(self.stream.values["/sphere"], [0.1, 0.2, 1.3, 0.05], atol=1e-6)

    def test_stylus_is_relative_to_the_p4_tracker(self):
        # The P4's tracker at (0.5, 0, 1), turned 90° about z; the stylus 0.1 m along world x.
        c, h = np.cos(np.pi / 4), np.sin(np.pi / 4)
        self.app.on_osc_in(osc.message("/lh/pose", 1.0, 0.5, 0.0, 1.0, c, 0.0, 0.0, h))
        M_WS = np.eye(4)
        M_WS[:3, 3] = [0.6, 0.0, 1.0]
        self.app.on_stylus(M_WS)
        _, M_TS = self.app.recent_rel[-1]
        np.testing.assert_allclose(
            M_TS[:3, 3], [0.0, -0.1, 0.0], atol=1e-9
        )  # in the tracker's frame

    def test_one_effect_told_what_to_show(self):
        # tracker_demo_pose.glsl: /pick is an LED to blink, -1 the live shape, -2 the outline.
        self.app.set_mode("idle")
        self.assertEqual(self.stream.values["/pick"], (appmod.P4_LOOK_DIM,))
        self.app.c_tip = np.zeros(3)
        self.app.set_mode("probe")
        row = self.app.pick_row
        self.assertIsNotNone(row)
        self.assertEqual(self.stream.values["/pick"], (float(self.app.ledmap.index[row]),))
        self.app.set_mode("live")
        self.assertEqual(self.stream.values["/pick"], (appmod.P4_LOOK_SHAPE,))
        self.assertEqual(self.stream.values["/shape"], (0.0,))
        self.app.set_shape("sphere")
        self.assertEqual(self.stream.values["/shape"], (1.0,))

    def test_p4_poses_are_drawn(self):
        # What the P4's tracker module sends back: its tracker, then the fixture.
        T = np.eye(4)
        T[:3, 3] = [0.5, 0.25, 1.0]
        self.app.on_osc_in(osc.message("/lh/pose", 1.0, 0.1, 0.2, 0.3, 1.0, 0.0, 0.0, 0.0))
        self.app.on_osc_in(osc.message("/lh/fixture_pose", *T.T.reshape(-1)))
        st = self.app.state()
        np.testing.assert_allclose(np.array(st["pose"]["M"])[:3, 3], [0.1, 0.2, 0.3], atol=1e-6)
        np.testing.assert_allclose(np.array(st["T_WF"])[:3, 3], [0.5, 0.25, 1.0], atol=1e-6)
        self.assertEqual(st["T_WF_source"], "P4 (its tracker x mount)")
        self.assertTrue(st["p4"]["tracking"])

    def test_udp_round_trip(self):
        # The fixture answers to the transport's source port (as the C6 does).
        import socket

        fixture = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        fixture.bind(("127.0.0.1", 0))
        udp = osc.UdpTransport("127.0.0.1", fixture.getsockname()[1])
        got = []
        udp.on_receive(got.append)
        udp.send(osc.message("/lh/station", 1.0))
        data, peer = fixture.recvfrom(1024)
        fixture.sendto(osc.message("/lh/pose", 1, 0, 0, 0, 1, 0, 0, 0), peer)
        for _ in range(50):
            if got:
                break
            time.sleep(0.01)
        self.assertEqual(osc.decode(got[0])[0][0], "/lh/pose")
        udp.close()
        fixture.close()


if __name__ == "__main__":
    unittest.main()
