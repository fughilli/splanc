"""Unit tests: frames / plane maths, LED map surface, hold detector, OSC encoding and
streaming (rate cap, keep-alive, UDP loopback), pose sources.

    python3 tools/vive/demos/tests/test_units.py [-v]
"""

import os
import socket
import sys
import tempfile
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import calib  # noqa: E402
import frames as fr  # noqa: E402
import osc  # noqa: E402
import poses  # noqa: E402
import synth  # noqa: E402
from ledmap import LedMap  # noqa: E402

rng = np.random.default_rng(0)


def rand_rot():
    return fr.rotvec_to_mat(rng.normal(size=3))


class Frames(unittest.TestCase):
    def test_quat_roundtrip(self):
        for _ in range(50):
            R = rand_rot()
            np.testing.assert_allclose(fr.quat_to_mat(fr.mat_to_quat(R)), R, atol=1e-12)
        # libsurvive order is (w, x, y, z): 90 deg about z.
        q = [np.cos(np.pi / 4), 0, 0, np.sin(np.pi / 4)]
        np.testing.assert_allclose(fr.quat_to_mat(q) @ [1, 0, 0], [0, 1, 0], atol=1e-12)

    def test_rotvec_roundtrip(self):
        for _ in range(50):
            v = rng.normal(size=3)
            v *= rng.uniform(0, np.pi - 1e-3) / np.linalg.norm(v)
            np.testing.assert_allclose(fr.mat_to_rotvec(fr.rotvec_to_mat(v)), v, atol=1e-9)
        v = np.array([0, 0, np.pi])
        np.testing.assert_allclose(
            fr.rotvec_to_mat(fr.mat_to_rotvec(fr.rotvec_to_mat(v))), fr.rotvec_to_mat(v), atol=1e-9
        )

    def test_up_axes(self):
        # +Y up (F, SteamVR) -> +Z up (W), right-handed.
        M = fr.Y_UP_TO_Z_UP
        np.testing.assert_allclose(M @ [0, 1, 0], [0, 0, 1])
        self.assertAlmostEqual(np.linalg.det(M), 1.0)

    def test_similarity_inverse_and_compose(self):
        for _ in range(20):
            A = fr.make_pose(rand_rot(), rng.normal(size=3), s=rng.uniform(0.9, 1.1))
            B = fr.make_pose(rand_rot(), rng.normal(size=3))
            np.testing.assert_allclose(fr.inv(A) @ A, np.eye(4), atol=1e-12)
            # T_TF = T_WT^-1 T_WF, then T_WT T_TF = T_WF.
            T_TF = calib.mount_transform(B, A)
            np.testing.assert_allclose(calib.live_fixture_pose(B, T_TF), A, atol=1e-12)
            s, R, t = fr.sim_parts(T_TF)
            self.assertAlmostEqual(s, fr.sim_parts(A)[0])

    def test_plane_to_fixture(self):
        """Every point on the plane in W maps into F onto n_F . p = d_F, with |n_F| = 1."""
        for _ in range(50):
            T_WF = fr.make_pose(rand_rot(), rng.normal(size=3), s=rng.uniform(0.9, 1.1))
            n_W = rng.normal(size=3) * 3  # unnormalised on purpose
            d_W = rng.normal()
            n_F, d_F = fr.plane_to_fixture(T_WF, n_W, d_W)
            self.assertAlmostEqual(np.linalg.norm(n_F), 1.0)
            u = np.cross(n_W, rng.normal(size=3))
            v = np.cross(n_W, u)
            x_W = (
                n_W / np.linalg.norm(n_W) * d_W / np.linalg.norm(n_W)
                + np.outer(rng.normal(size=5), u)
                + np.outer(rng.normal(size=5), v)
            )
            p = fr.apply(fr.inv(T_WF), x_W)
            np.testing.assert_allclose(p @ n_F, d_F, atol=1e-9)
            # Distances scale by 1/s: a point h metres off the plane in W is h/s in F.
            s = fr.sim_parts(T_WF)[0]
            off = x_W[0] + 0.01 * n_W / np.linalg.norm(n_W)
            self.assertAlmostEqual(fr.apply(fr.inv(T_WF), off) @ n_F - d_F, 0.01 / s, places=9)

    def test_sphere_to_fixture(self):
        """Points on the sphere in W land on the sphere (c_F, r_F) in F; radii scale by 1/s."""
        for _ in range(50):
            T_WF = fr.make_pose(rand_rot(), rng.normal(size=3), s=rng.uniform(0.9, 1.1))
            c_W, r_W = rng.normal(size=3), rng.uniform(0.01, 0.5)
            c_F, r_F = fr.sphere_to_fixture(T_WF, c_W, r_W)
            u = rng.normal(size=(5, 3))
            x_W = c_W + r_W * u / np.linalg.norm(u, axis=1)[:, None]
            p = fr.apply(fr.inv(T_WF), x_W)
            np.testing.assert_allclose(np.linalg.norm(p - c_F, axis=1), r_F, atol=1e-9)
            self.assertAlmostEqual(r_F, r_W / fr.sim_parts(T_WF)[0], places=12)

    def test_plane_identity_is_unchanged(self):
        n_F, d_F = fr.plane_to_fixture(np.eye(4), [0, 1, 0], 0.1)
        np.testing.assert_allclose(n_F, [0, 1, 0])
        self.assertAlmostEqual(d_F, 0.1)

    def test_mean_pose_and_spread(self):
        base = fr.make_pose(rand_rot(), [1, 2, 3])
        Ms = []
        for _ in range(100):
            M = base.copy()
            M[:3, :3] = fr.rotvec_to_mat(rng.normal(0, 0.001, 3)) @ M[:3, :3]
            M[:3, 3] += rng.normal(0, 0.0001, 3)
            Ms.append(M)
        m = fr.mean_pose(Ms)
        self.assertLess(fr.rot_angle_deg(m[:3, :3].T @ base[:3, :3]), 0.05)
        dpos, drot = fr.pose_spread(Ms)
        self.assertLess(dpos, 0.001)
        self.assertLess(drot, 0.5)

    def test_umeyama(self):
        src = rng.normal(size=(10, 3))
        s, R, t = 1.05, rand_rot(), rng.normal(size=3)
        dst = s * src @ R.T + t
        s2, R2, t2 = fr.umeyama(src, dst)
        self.assertAlmostEqual(s2, s)
        np.testing.assert_allclose(R2, R, atol=1e-9)
        np.testing.assert_allclose(t2, t, atol=1e-9)


class LedMapSurface(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m, cls.true_p, cls.true_n, cls.geom = synth.cylinder_lamp()

    def test_normals_point_out(self):
        radial = self.m.p.copy()
        radial[:, 1] = 0
        dots = np.einsum(
            "ni,ni->n", self.m.n, radial / np.linalg.norm(radial, axis=1, keepdims=True)
        )
        self.assertGreater(np.mean(dots > 0.9), 0.95)

    def test_signed_distance(self):
        th = rng.uniform(0, 2 * np.pi, 500)
        y = rng.uniform(0.02, 0.1, 500)
        for off in (-0.004, 0.0, 0.006):
            r = self.geom["radius"] + off
            q = np.stack([r * np.cos(th), y, r * np.sin(th)], 1)
            d = self.m.signed_distance(q)
            self.assertLess(abs(np.median(d) - off), 0.0003, off)

    def test_csv_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.csv")
            self.m.to_csv(path)
            m2 = LedMap.from_csv(path)
        np.testing.assert_allclose(m2.p, self.m.p, atol=1e-5)
        np.testing.assert_array_equal(m2.mapped, self.m.mapped)
        self.assertEqual(m2.row_of(17), 17)
        self.assertTrue(m2.source["sha256_16"])

    def test_csv_doc_example(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.csv")
            with open(path, "w") as f:
                f.write(
                    "index,P(0),P(1),P(2),mapped,confidence,channel,channel_index,segment,arclength\n"
                )
                for i in range(20):
                    a = i * 0.6
                    f.write(
                        "%d,%.5f,%.5f,%.5f,%d,0,0,%d,0,0\n"
                        % (i, 0.04 * np.cos(a), 0.005 * i, 0.04 * np.sin(a), i % 5 != 0, i)
                    )
            m = LedMap.from_csv(path)
        self.assertEqual(len(m.p), 20)
        self.assertEqual(int(m.mapped.sum()), 16)
        self.assertAlmostEqual(m.w[0], 0.2)  # mapped=0 is down-weighted

    def test_next_led(self):
        first = calib.next_led(self.m, [])
        second = calib.next_led(self.m, [first])
        # The second pick is far away (the other end of the lamp).
        self.assertGreater(np.linalg.norm(self.m.p[first] - self.m.p[second]), 0.08)
        self.assertTrue(self.m.mapped[first] and self.m.mapped[second])


class Hold(unittest.TestCase):
    def test_hold_and_rearm(self):
        det = calib.HoldDetector()
        M = fr.make_pose(rand_rot(), [0.3, 0.2, 0.9])
        t = 0.0

        def feed(M, secs, noise=0.0001):  # noqa: E306
            nonlocal t
            out = None
            for _ in range(int(secs * 120)):
                t += 1 / 120
                N = M.copy()
                N[:3, 3] += rng.normal(0, noise, 3)
                h = det.feed(t, N, np.zeros(3))
                out = h if h is not None else out
            return out

        self.assertIsNone(feed(M, 0.8))  # not long enough
        self.assertIsNotNone(feed(M, 0.5))  # 1.3 s still
        self.assertIsNone(feed(M, 2.0))  # no re-fire without moving
        self.assertIsNone(feed(M, 2.0, noise=0.002))  # too shaky
        M2 = M.copy()
        M2[:3, 3] += [0.05, 0, 0]
        self.assertIsNotNone(feed(M2, 1.5))  # moved away and held again

    def test_rotation_spread_blocks(self):
        det = calib.HoldDetector()
        M = fr.make_pose(np.eye(3), [0, 0, 1])
        fired = None
        for i in range(240):
            N = M.copy()
            N[:3, :3] = fr.rotvec_to_mat(
                [0, 0, np.radians(1.0) * np.sin(i / 10)]
            )  # 1 deg wobble about the contact
            fired = det.feed(i / 120, N, np.zeros(3)) if fired is None else fired
        self.assertIsNone(fired)


class Osc(unittest.TestCase):
    def test_encoding_matches_doc(self):
        # The doc's minimal sender.
        import struct

        def doc_osc(addr, *floats):  # noqa: E306
            pad = lambda b: b + b"\0" * (4 - len(b) % 4)  # noqa: E731
            return (
                pad(addr.encode())
                + pad(("," + "f" * len(floats)).encode())
                + b"".join(struct.pack(">f", f) for f in floats)
            )

        self.assertEqual(
            osc.message("/plane", 0.0, 1.0, 0.0, 0.1), doc_osc("/plane", 0.0, 1.0, 0.0, 0.1)
        )
        self.assertEqual(osc.message("/pick", 17.0), doc_osc("/pick", 17.0))
        self.assertEqual(osc.decode(osc.message("/glow", 1, 0.5, 0)), [("/glow", [1.0, 0.5, 0.0])])
        b = osc.bundle(osc.message("/width", 0.01), osc.message("/plane", 0, 0, 1, 0.2))
        dec = osc.decode(b)
        self.assertEqual([a for a, _ in dec], ["/width", "/plane"])
        self.assertEqual(len(osc.message("/plane", 0, 0, 1, 0.2)) % 4, 0)

    def test_rate_cap_and_keepalive(self):
        sent = []
        clock = [0.0]
        st = osc.OscStreamer(
            osc.CallbackTransport(sent.append), max_hz=100, keepalive_hz=5, clock=lambda: clock[0]
        )
        # 1 s of updates at 1 kHz: at most ~100 datagrams, the latest value wins.
        for i in range(1000):
            clock[0] = i / 1000
            st.set("/plane", 0, 0, 1, i / 1000)
            st.step()
        self.assertLessEqual(len(sent), 101)
        self.assertGreaterEqual(len(sent), 95)
        # The last value is held back by the cap, then goes out at the next slot.
        clock[0] = 1.011
        st.step()
        self.assertAlmostEqual(osc.decode(sent[-1])[0][1][3], 0.999, places=5)
        # Idle for 2 s: keep-alive re-sends at 5 Hz.
        n0 = len(sent)
        for i in range(2000):
            clock[0] = 1.0 + i / 1000
            st.step()
        self.assertGreaterEqual(len(sent) - n0, 9)
        self.assertLessEqual(len(sent) - n0, 11)
        # A setting with a 1 s keep-alive: once on set, then once a second, in the same
        # bundles as the 5 Hz address.
        st.set("/width", 0.01, keepalive=1.0)
        n0 = len(sent)
        widths = 0
        for i in range(3000):
            clock[0] = 3.0 + i / 1000
            if st.step():
                widths += any(a == "/width" for a, _ in osc.decode(sent[-1]))
        self.assertIn(widths, (3, 4))
        self.assertGreaterEqual(len(sent) - n0, 14)
        self.assertLessEqual(len(sent) - n0, 17)
        clock[0] = 3.0
        # clear() stops an address.
        st.clear("/plane", "/width")
        n0 = len(sent)
        for i in range(1000):
            clock[0] = 6.0 + i / 1000
            st.step()
        self.assertEqual(len(sent), n0)

    def test_streamer_limits(self):
        with self.assertRaises(AssertionError):
            osc.OscStreamer(osc.LogTransport(), max_hz=500)
        with self.assertRaises(AssertionError):
            osc.OscStreamer(osc.LogTransport(), keepalive_hz=1)

    def test_udp_loopback_threaded(self):
        rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        rx.bind(("127.0.0.1", 0))
        rx.settimeout(2)
        port = rx.getsockname()[1]
        tx = osc.UdpTransport("127.0.0.1", port)
        st = osc.OscStreamer(tx, max_hz=120, keepalive_hz=10).start()
        try:
            st.set("/plane", 0.6, 0.0, 0.8, 0.05)
            msgs = osc.decode(rx.recv(1024))
            self.assertEqual(msgs[0][0], "/plane")
            np.testing.assert_allclose(msgs[0][1], [0.6, 0.0, 0.8, 0.05], atol=1e-6)
            t0, n = time.time(), 0
            while time.time() - t0 < 0.55:  # keep-alive at 10 Hz
                rx.recv(1024)
                n += 1
            self.assertGreaterEqual(n, 4)
        finally:
            st.stop()
            rx.close()
            tx.close()

    def test_dry_run_log(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "osc.log")
            t = osc.LogTransport(path)
            t.send(osc.message("/plane", 0, 1, 0, 0.1))
            t.f.close()
            with open(path) as f:
                line = f.read()
        self.assertIn("/plane 0 1 0 0.1", line)

    def test_fake_fixture(self):
        m, _, _, _ = synth.cylinder_lamp()
        fx = synth.FakeFixture(m)
        fx.receive(
            osc.bundle(
                osc.message("/plane", 0, 1, 0, 0.06),
                osc.message("/width", 0.005),
                osc.message("/pick", 42),
            )
        )
        lit = fx.lit()
        self.assertTrue(np.all(np.abs(m.p[lit, 1] - 0.06) < 0.005))
        self.assertEqual(fx.pick_row(), 42)


class Sources(unittest.TestCase):
    def test_replay_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "poses.txt")
            with open(path, "w") as f:
                f.write("0.0 T20 INFO LOG hello\n")
                for i in range(30):
                    f.write("%.4f T20 POSE 0.1 0.2 %.3f 1 0 0 0\n" % (i / 100, 1 + i / 1000))
            got = []
            src = poses.ReplaySource(path, speed=10, loop=False)
            src.start(got.append)
            time.sleep(0.3)
        self.assertEqual(len(got), 30)
        self.assertEqual(got[0].dev, "T20")
        np.testing.assert_allclose(got[-1].matrix()[:3, 3], [0.1, 0.2, 1.029])

    def test_sse_y_up_conversion(self):
        src = poses.SseSource("http://127.0.0.1:1", world_up="y")
        p, q = src._convert([0, 1, 0], [1, 0, 0, 0])
        np.testing.assert_allclose(p, [0, 0, 1], atol=1e-12)
        np.testing.assert_allclose(fr.quat_to_mat(q), fr.Y_UP_TO_Z_UP, atol=1e-12)


if __name__ == "__main__":
    unittest.main()
