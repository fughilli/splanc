"""Synthetic fixture and tracker, for testing the calibration without hardware.

- `cylinder_lamp`: a fake LED map (a helix of LEDs on a ~0.12 m tall cylinder, frame F,
  +Y up, with a few interpolated mapped=0 rows that carry extra error).
- `Truth`: the hidden ground truth: T_WF (with the map's true scale error), contact point
  c, diffuser offset o. The true surface is the analytic cylinder.
- `Sim`: a simulated tracker in W (+Z up) producing T_WT samples: rubs (flat on the
  surface, random spin, small tilt, noise, lift-off outliers), touches on a given LED
  (varied tilt, held still, with noise), transit moves between them, and a mounted mode.
"""

import calib
import frames as fr
import numpy as np
from ledmap import LedMap


def cylinder_lamp(
    n=300, radius=0.04, height=0.12, turns=10, n_unmapped=20, map_noise=0.0003, seed=1
):
    """Returns (LedMap as Splanc would export it, true LED positions in F, true outward normals in F,
    geometry dict). The exported map has noise; unmapped rows have 5x the noise."""
    rng = np.random.default_rng(seed)
    u = np.linspace(0, 1, n)
    th = 2 * np.pi * turns * u
    y = 0.005 + (height - 0.01) * u
    true_p = np.stack([radius * np.cos(th), y, radius * np.sin(th)], 1)
    true_n = np.stack([np.cos(th), np.zeros(n), np.sin(th)], 1)
    mapped = np.ones(n, bool)
    mapped[rng.choice(n, n_unmapped, replace=False)] = False
    noise = rng.normal(0, map_noise, (n, 3)) * np.where(mapped, 1.0, 5.0)[:, None]
    m = LedMap(true_p + noise, mapped=mapped, source={"synthetic": "cylinder_lamp", "n": n})
    return m, true_p, true_n, {"radius": radius, "height": height}


class Truth:
    def __init__(
        self,
        geom,
        s=1.03,
        c=(0.0015, -0.002, 0.0008),
        o=0.003,
        yaw_deg=37.0,
        tilt_deg=2.0,
        t=(0.45, -0.25, 0.80),
    ):
        self.geom = geom
        R = (
            fr.rotvec_to_mat([0, 0, np.radians(yaw_deg)])
            @ fr.rotvec_to_mat([np.radians(tilt_deg), 0, 0])
            @ fr.Y_UP_TO_Z_UP
        )
        self.T_WF = fr.make_pose(R, t, s)
        self.c = np.array(c, float)
        self.o = float(o)

    @property
    def s(self):
        return fr.sim_parts(self.T_WF)[0]

    def surface_point_F(self, theta, y):
        """True contact surface (diffuser) point and outward normal, in F, map units."""
        r = self.geom["radius"]
        n = np.array([np.cos(theta), 0.0, np.sin(theta)])
        return np.array([r * np.cos(theta), y, r * np.sin(theta)]), n


def _frame_with_z(z, spin):
    """A rotation whose +Z column is z, spun by `spin` about it."""
    z = z / np.linalg.norm(z)
    a = np.array([1.0, 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1.0, 0])
    x = np.cross(a, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z], 1)
    return R @ fr.rotvec_to_mat([0, 0, spin])


class Sim:
    def __init__(
        self, truth, true_p, true_n, rate=120.0, pos_noise=0.0002, rot_noise_deg=0.03, seed=2
    ):
        self.truth, self.true_p, self.true_n = truth, true_p, true_n
        self.rate = rate
        self.pos_noise, self.rot_noise = pos_noise, np.radians(rot_noise_deg)
        self.rng = np.random.default_rng(seed)
        self.t = 0.0

    def _noisy(self, M, scale=1.0):
        out = M.copy()
        out[:3, :3] = fr.rotvec_to_mat(self.rng.normal(0, self.rot_noise * scale, 3)) @ M[:3, :3]
        out[:3, 3] += self.rng.normal(0, self.pos_noise * scale, 3)
        return out

    def _tracker_at(self, x_W, inward_W, spin, tilt_axis=None, tilt=0.0):
        """T_WT with its contact point c at x_W and +Z_T (out of the base) along inward_W,
        tilted by `tilt` rad about tilt_axis (rotation about the contact point)."""
        R = _frame_with_z(inward_W, spin)
        if tilt and tilt_axis is not None:
            R = fr.rotvec_to_mat(tilt_axis / np.linalg.norm(tilt_axis) * tilt) @ R
        return fr.make_pose(R, x_W - R @ self.truth.c)

    def _rest_on_surface(self, M):
        """Lift a tilted pose along -Z_T until no point of the flat base is inside the
        (cylindrical) fixture: a real base rests on its rim, it can't sink in."""
        s, R, t = fr.sim_parts(self.truth.T_WF)
        r_surf = s * self.truth.geom["radius"] + self.truth.o
        for _ in range(3):
            q = (M[:3, :3] @ (self.truth.c + calib.DISC).T).T + M[:3, 3]
            pF = (q - t) @ R / s
            pen = (r_surf - s * np.hypot(pF[:, 0], pF[:, 2])).max()
            if pen <= 1e-6:
                break
            M = M.copy()
            M[:3, 3] -= M[:3, 2] * pen
        return M

    def _surface_W(self, theta, y):
        s, R, t = fr.sim_parts(self.truth.T_WF)
        pF, nF = self.truth.surface_point_F(theta, y)
        return s * R @ pF + t + self.truth.o * R @ nF, R @ nF

    def rub(self, seconds=20.0, liftoff=0.06, tilt_deg=4.0):
        """Rubbing samples covering the side wall, all around and top to bottom. The path
        continues across calls (so it can be streamed in short chunks); 20 s go ~3.3 times
        around and ~5.7 times end to end."""
        n = int(seconds * self.rate)
        h = self.truth.geom["height"]
        out = []
        tau0 = getattr(self, "_rub_tau", 0.0)
        tau = tau0 + np.arange(1, n + 1) / self.rate
        self._rub_tau = tau0 + n / self.rate
        theta = 2 * np.pi * 0.165 * tau + 0.4 * np.sin(2 * np.pi * 0.35 * tau)
        y = 0.012 + (h - 0.024) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.285 * tau))
        spin = 2 * np.pi * 0.085 * tau
        for i in range(n):
            x, nW = self._surface_W(theta[i], y[i])
            tilt_axis = np.cross(nW, self.rng.normal(size=3))
            M = self._rest_on_surface(
                self._tracker_at(
                    x, -nW, spin[i], tilt_axis, np.radians(self.rng.normal(0, tilt_deg))
                )
            )
            if self.rng.random() < liftoff:
                M[:3, 3] += nW * self.rng.uniform(0.005, 0.03)
            self.t += 1 / self.rate
            out.append((self.t, self._noisy(M)))
        return out

    def touch_pose(self, row, tilt_deg=None):
        """The true pose of the tracker touching LED `row` (true LED position, diffuser offset)."""
        s, R, t = fr.sim_parts(self.truth.T_WF)
        x = s * R @ self.true_p[row] + t + self.truth.o * R @ self.true_n[row]
        nW = R @ self.true_n[row]
        tilt = np.radians(self.rng.uniform(10, 35) if tilt_deg is None else tilt_deg)
        axis = np.cross(nW, self.rng.normal(size=3))
        return self._tracker_at(x, -nW, self.rng.uniform(0, 2 * np.pi), axis, tilt)

    def hold(self, M, seconds=1.6, scale=0.4):
        out = []
        for _ in range(int(seconds * self.rate)):
            self.t += 1 / self.rate
            out.append((self.t, self._noisy(M, scale)))
        return out

    def transit(self, A, B, seconds=0.8):
        """Move from pose A to pose B, lifting away from the fixture on the way."""
        out = []
        n = int(seconds * self.rate)
        dR = fr.mat_to_rotvec(B[:3, :3] @ A[:3, :3].T)
        for i in range(1, n + 1):
            a = i / n
            M = fr.make_pose(
                fr.rotvec_to_mat(a * dR) @ A[:3, :3],
                (1 - a) * A[:3, 3] + a * B[:3, 3] + np.array([0, 0, 0.05 * np.sin(np.pi * a)]),
            )
            self.t += 1 / self.rate
            out.append((self.t, self._noisy(M)))
        return out

    def mount_pose(self, T_WF_now=None):
        """Tracker rigidly mounted on top of the fixture (a true T_TF), given the fixture's
        current true pose."""
        T_WF_now = self.truth.T_WF if T_WF_now is None else T_WF_now
        s, R, t = fr.sim_parts(T_WF_now)
        top = s * R @ np.array([0, self.truth.geom["height"] + 0.01, 0]) + t
        up = R @ np.array([0, 1.0, 0])
        # Base faces down onto the lamp's top: +Z_T points into the fixture (-up).
        Rt = _frame_with_z(-up, 0.3)
        return fr.make_pose(Rt, top - Rt @ self.truth.c)


class FakeFixture:
    """Stands in for the Splanc fixture in synthetic / loopback runs: decodes the OSC
    datagrams the app sends and renders like plane_slice / led_pick would, from its own
    map (the exported one; the fixture only knows its map positions)."""

    def __init__(self, ledmap):
        import osc

        self._decode = osc.decode
        self.ledmap = ledmap
        self.params = {
            "plane": [0.0, 1.0, 0.0, 0.1],
            "sphere": [0.0, 0.1, 0.0, 0.08],
            "width": [0.01],
            "halo": [0.03],
            "glow": [1.0, 0.4, 0.1],
            "pick": [0.0],
            "dim": [0.02],
            "color": [1.0, 1.0, 1.0],
        }
        self.received = 0
        self.last = {}
        self.shape = "plane"  # the effect running: whichever of /plane, /sphere came last

    def receive(self, data):
        for addr, args in self._decode(data):
            self.received += 1
            name = addr.strip("/")
            if "/" in name:  # /plane/x style single components
                base, comp = name.split("/", 1)
                if base in self.params and comp in "xyzw" and args:
                    self.params[base]["xyzw".index(comp)] = float(args[0])
                continue
            self.params[name] = [float(a) for a in args]
            self.last[name] = args
            if name in ("plane", "sphere"):
                self.shape = name

    def pick_row(self):
        if "pick" not in self.last:
            return None
        k = int(self.params["pick"][0] + 0.5)
        try:
            return self.ledmap.row_of(k)
        except KeyError:
            return None

    def lit(self):
        """Indices (rows) of LEDs plane_slice (|n.p - d| < width) or sphere_shell
        (||p - c| - r| < width) lights fully."""
        if self.shape == "sphere":
            cx, cy, cz, r = self.params["sphere"]
            dist = np.abs(np.linalg.norm(self.ledmap.p - np.array([cx, cy, cz]), axis=1) - r)
        else:
            nx, ny, nz, d = self.params["plane"]
            dist = np.abs(self.ledmap.p @ np.array([nx, ny, nz]) - d)
        return np.nonzero(dist < self.params["width"][0])[0]
