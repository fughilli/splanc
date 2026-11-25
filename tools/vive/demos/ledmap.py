"""The fixture's LED map (§4) and the implicit surface it defines.

CSV from Splanc `export_map` (format csv), frame F (metres, +Y up):
    index,P(0),P(1),P(2),mapped,confidence,channel,channel_index,segment,arclength
`mapped=0` rows are interpolated, so they get a low weight (MAPPED0_WEIGHT) in the
surface and are not offered as touch targets. segment/arclength are ignored (#396).

Surface: each LED gets a normal from PCA over its K nearest neighbours, oriented
out of the fixture (MST propagation seeded from the LED farthest from the centroid,
so it also works on non-convex fixtures). The signed distance of a query point q
is taken to the local surface of each of its k nearest LEDs (a plane with the LED's
outward normal, plus a quadric curvature term fitted through that LED's
neighbours), blended with Gaussian distance weights so it stays continuous as the
neighbour set changes, which the optimiser needs.

Reach: the tracker touches with its flat base, so an LED in a concave part (a waist
between two bulges) can't be touched: other LEDs stand proud of its tangent plane
within the base's radius and hold the base off it. `reachable` marks the LEDs the base
can sit on within BASE_CLEARANCE; only those are offered as touch targets.
"""

import csv
import hashlib
import heapq

import numpy as np
from scipy.spatial import cKDTree

MAPPED0_WEIGHT = 0.2
BASE_RADIUS = 0.025  # m, the tracker base's flat contact disc
BASE_CLEARANCE = 0.002  # m, how far the base may stand off the LED and still count


class LedMap:
    def __init__(self, points, mapped=None, index=None, k_normal=10, k_query=6, source=None):
        self.p = np.asarray(points, float)
        n = len(self.p)
        self.index = np.arange(n) if index is None else np.asarray(index, int)
        self.mapped = np.ones(n, bool) if mapped is None else np.asarray(mapped, bool)
        self.w = np.where(self.mapped, 1.0, MAPPED0_WEIGHT)
        self.source = source
        self.tree = cKDTree(self.p)
        self.k_query = min(k_query, n)
        d, _ = self.tree.query(self.p, k=2)
        self.spacing = float(np.median(d[:, 1]))  # typical LED pitch
        self.h = 1.5 * self.spacing  # neighbour weighting radius
        self.centroid = self.p.mean(0)
        self.n = self._normals(min(k_normal, n))
        self.basis, self.jet = self._jets(min(max(k_normal, 12), n))
        # Principal axes of the cloud (for coverage/span measures).
        X = self.p - self.centroid
        vals, vecs = np.linalg.eigh(X.T @ X / n)
        self.axes = vecs[:, ::-1]
        proj = X @ self.axes
        self.extent = proj.max(0) - proj.min(0)
        self.reachable = self._reach(BASE_RADIUS, BASE_CLEARANCE)

    # ---------- loading ----------
    @classmethod
    def from_csv(cls, path, **kw):
        rows = []
        with open(path, newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                row = {k.strip(): v for k, v in row.items() if k}
                rows.append(
                    (
                        int(float(row["index"])),
                        float(row["P(0)"]),
                        float(row["P(1)"]),
                        float(row["P(2)"]),
                        int(float(row.get("mapped", 1) or 1)),
                    )
                )
        rows.sort()
        a = np.array(rows, float)
        with open(path, "rb") as f:
            h = hashlib.sha256(f.read()).hexdigest()[:16]
        m = cls(
            a[:, 1:4],
            mapped=a[:, 4] > 0,
            index=a[:, 0].astype(int),
            source={"path": path, "sha256_16": h},
            **kw
        )
        return m

    def to_csv(self, path):
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(
                [
                    "index",
                    "P(0)",
                    "P(1)",
                    "P(2)",
                    "mapped",
                    "confidence",
                    "channel",
                    "channel_index",
                    "segment",
                    "arclength",
                ]
            )
            for i, p, m in zip(self.index, self.p, self.mapped):
                w.writerow(
                    [
                        int(i),
                        "%.5f" % p[0],
                        "%.5f" % p[1],
                        "%.5f" % p[2],
                        int(m),
                        0,
                        0,
                        int(i),
                        0,
                        0,
                    ]
                )

    def row_of(self, led_index):
        """CSV `index` -> row number."""
        hits = np.nonzero(self.index == int(led_index))[0]
        if not len(hits):
            raise KeyError(led_index)
        return int(hits[0])

    # ---------- normals ----------
    def _normals(self, k):
        _, nb = self.tree.query(self.p, k=k)
        P = self.p[nb] - self.p[nb].mean(1, keepdims=True)
        C = np.einsum("nki,nkj->nij", P, P)
        vals, vecs = np.linalg.eigh(C)
        normals = vecs[:, :, 0]
        # Orient: MST over the kNN graph (Hoppe et al.), cost 1 - |n_i . n_j|, seeded at the
        # LED farthest from the centroid with its normal pointing away from the centroid.
        n = len(self.p)
        seed = int(np.argmax(np.linalg.norm(self.p - self.centroid, axis=1)))
        if normals[seed] @ (self.p[seed] - self.centroid) < 0:
            normals[seed] *= -1
        done = np.zeros(n, bool)
        heap = [(0.0, seed, seed)]
        while heap:
            _, i, parent = heapq.heappop(heap)
            if done[i]:
                continue
            done[i] = True
            if i != parent and normals[i] @ normals[parent] < 0:
                normals[i] *= -1
            for j in nb[i]:
                if not done[j]:
                    heapq.heappush(heap, (1.0 - abs(normals[i] @ normals[j]), int(j), i))
        # Any disconnected piece: orient away from the centroid.
        for i in np.nonzero(~done)[0]:
            if normals[i] @ (self.p[i] - self.centroid) < 0:
                normals[i] *= -1
        return normals

    def _jets(self, k, ridge=1e-3):
        """Per LED: a local quadric height field over its tangent plane (a 2-jet),
        w = c0 + c1 u + c2 v + c3 u^2 + c4 uv + c5 v^2 in the LED's frame (e1, e2, n),
        fitted through its k nearest LEDs. Taking the curvature into account removes the
        chord ('sagitta') bias a plane through neighbouring LEDs has on a curved fixture,
        which otherwise trades off against o and s."""
        e1 = np.cross(self.n, np.where(np.abs(self.n[:, :1]) < 0.9, [[1.0, 0, 0]], [[0, 1.0, 0]]))
        e1 /= np.linalg.norm(e1, axis=1, keepdims=True)
        e2 = np.cross(self.n, e1)
        E = np.stack([e1, e2, self.n], 2)  # columns: local axes, in F
        d, nb = self.tree.query(self.p, k=k)
        L = np.einsum("nki,nij->nkj", self.p[nb] - self.p[:, None], E) / self.h
        u, v, w = L[..., 0], L[..., 1], L[..., 2]
        A = np.stack([np.ones_like(u), u, v, u * u, u * v, v * v], 2)
        W = self.w[nb] * np.exp(-((d / (2 * self.h)) ** 2))
        AtA = (
            np.einsum("nki,nk,nkj->nij", A, W, A)
            + ridge * np.diag([0, 0, 0, 1, 1, 1.0])[None]
            + 1e-9 * np.eye(6)[None]
        )
        Atb = np.einsum("nki,nk,nk->ni", A, W, w)
        jet = np.linalg.solve(AtA, Atb[..., None])[..., 0]
        return E, jet  # jet in units of h

    # ---------- surface queries ----------
    def local_planes(self, q):
        """For points q (N, 3) in F: (centre (N,3), unit outward normal (N,3), neighbour
        distance of the nearest LED (N,))."""
        q = np.atleast_2d(q)
        d, nb = self.tree.query(q, k=self.k_query)
        w = self.w[nb] * np.exp(-((d / self.h) ** 2)) + 1e-12
        w = w / w.sum(1, keepdims=True)
        m = np.einsum("nk,nki->ni", w, self.p[nb])
        nn = np.einsum("nk,nki->ni", w, self.n[nb])
        nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-12
        return m, nn, d[:, 0]

    def signed_distance(self, q):
        """Signed distance (F units) of points q to the LED surface, + outside: the
        distance to each of the k nearest LEDs' local quadric (first order: height
        difference over the slope), blended with smooth distance weights."""
        q = np.atleast_2d(q)
        d, nb = self.tree.query(q, k=self.k_query)
        wt = self.w[nb] * np.exp(-((d / self.h) ** 2)) + 1e-12
        wt = wt / wt.sum(1, keepdims=True)
        L = np.einsum("nki,nkij->nkj", q[:, None] - self.p[nb], self.basis[nb]) / self.h
        u, v, w = L[..., 0], L[..., 1], L[..., 2]
        J = self.jet[nb]
        hgt = (
            J[..., 0]
            + J[..., 1] * u
            + J[..., 2] * v
            + J[..., 3] * u * u
            + J[..., 4] * u * v
            + J[..., 5] * v * v
        )
        gu = J[..., 1] + 2 * J[..., 3] * u + J[..., 4] * v
        gv = J[..., 2] + J[..., 4] * u + 2 * J[..., 5] * v
        dist = (w - hgt) / np.sqrt(1 + gu * gu + gv * gv)
        return (wt * dist).sum(1) * self.h

    def signed_distance_planar(self, q):
        """Signed distance to the plane through the weighted centroid of the k nearest LEDs
        (no curvature term; kept for comparison)."""
        m, nn, _ = self.local_planes(q)
        return np.einsum("ni,ni->n", np.atleast_2d(q) - m, nn)

    def _reach(self, radius, clearance):
        """True where a flat disc of `radius`, laid on the LED's tangent plane, has no
        other LED more than `clearance` above that plane (so it can rest on the LED)."""
        out = np.ones(len(self.p), bool)
        for i, nb in enumerate(self.tree.query_ball_point(self.p, radius * 1.5)):
            d = self.p[nb] - self.p[i]
            h = d @ self.n[i]
            tang = np.linalg.norm(d - np.outer(h, self.n[i]), axis=1)
            out[i] = not ((tang < radius) & (h > clearance)).any()
        return out

    def summary(self):
        return {
            "count": int(len(self.p)),
            "mapped": int(self.mapped.sum()),
            "reachable": int((self.mapped & self.reachable).sum()),
            "spacing_mm": self.spacing * 1e3,
            "extent_mm": (self.extent * 1e3).round(1).tolist(),
            "source": self.source,
        }
