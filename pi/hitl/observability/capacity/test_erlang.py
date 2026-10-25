"""Unit tests for erlang.py: published Erlang B/C table values, M/M/1 closed forms,
and a simulation check of the FIFO and priority wait tails. Run: python3 test_erlang.py"""

import collections
import heapq
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import erlang as e  # noqa: E402


def simulate(c, lams, hold, n, seed=1):
    """Non-preemptive priority M/M/c (class 0 highest; one class = FIFO). Returns the
    waits per class."""
    rng = random.Random(seed)
    lam = sum(lams)
    t, arrivals = 0.0, []
    for _ in range(n):
        t += rng.expovariate(lam)
        u, k = rng.random() * lam, 0
        while u > lams[k]:
            u -= lams[k]
            k += 1
        arrivals.append((t, k))
    free = [0.0] * c
    queues = [collections.deque() for _ in lams]
    waits = [[] for _ in lams]
    i = 0
    while i < n or any(queues):
        waiting = any(queues)
        if i < n and (not waiting or arrivals[i][0] <= free[0]):
            ta, k = arrivals[i]
            i += 1
            if not waiting and free[0] <= ta:
                heapq.heapreplace(free, ta + rng.expovariate(1 / hold))
                waits[k].append(0.0)
            else:
                queues[k].append(ta)
        else:
            s = free[0]
            for k, q in enumerate(queues):
                if q:
                    waits[k].append(s - q.popleft())
                    heapq.heapreplace(free, s + rng.expovariate(1 / hold))
                    break
    return waits


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


class ErlangTables(unittest.TestCase):
    def test_erlang_b_table(self):
        # Standard Erlang B table entries (blocking probability).
        self.assertAlmostEqual(e.erlang_b(10, 10.0), 0.2146, places=4)
        self.assertAlmostEqual(e.erlang_b(5, 2.0), 0.0367, places=4)
        self.assertAlmostEqual(e.erlang_b(20, 15.0), 0.0456, places=4)

    def test_erlang_c_table(self):
        # Standard Erlang C table entries (probability of waiting), A = 10 Erlangs.
        self.assertAlmostEqual(e.erlang_c(11, 10.0), 0.6821, places=4)
        self.assertAlmostEqual(e.erlang_c(12, 10.0), 0.4494, places=4)
        self.assertAlmostEqual(e.erlang_c(13, 10.0), 0.2853, places=4)

    def test_erlang_c_exact_small(self):
        self.assertAlmostEqual(e.erlang_c(3, 2.0), 4 / 9)
        self.assertAlmostEqual(e.erlang_c(2, 1.0), 1 / 3)
        for a in (0.1, 0.5, 0.9):  # M/M/1: P(wait) = rho
            self.assertAlmostEqual(e.erlang_c(1, a), a)

    def test_edges(self):
        self.assertEqual(e.erlang_c(4, 0.0), 0.0)
        self.assertEqual(e.erlang_c(4, 4.0), 1.0)  # unstable
        self.assertEqual(e.erlang_c(0, 1.0), 1.0)
        self.assertEqual(e.wait_quantile(0.95, 2, 1 / 30, 60.0), math.inf)  # a = 2 = c
        self.assertEqual(e.required_servers(0.0, 60, 600), 0)


class WaitTails(unittest.TestCase):
    def test_mm1_closed_form(self):
        lam, hold = 0.8, 1.0  # rho 0.8, mu 1
        # P(W > t) = rho * exp(-(mu - lam) t)
        for t in (0.0, 1.0, 5.0):
            self.assertAlmostEqual(e.wait_tail(t, 1, lam, hold), 0.8 * math.exp(-0.2 * t))
        # p95: rho e^{-0.2 t} = 0.05 -> t = ln(16) / 0.2
        self.assertAlmostEqual(e.wait_quantile(0.95, 1, lam, hold), math.log(16) / 0.2)
        # fewer than 5% wait -> p95 is 0
        self.assertEqual(e.wait_quantile(0.95, 1, 0.04, 1.0), 0.0)

    def test_fifo_matches_simulation(self):
        c, hold, lam = 3, 1.0, 2.4  # rho 0.8
        waits = simulate(c, [lam], hold, 150_000, seed=7)[0]
        for q in (0.8, 0.95):
            sim, model = pct(waits, q), e.wait_quantile(q, c, lam, hold)
            self.assertAlmostEqual(sim, model, delta=0.08 * model + 0.02, msg=f"q={q}")
        self.assertAlmostEqual(
            sum(w > 0 for w in waits) / len(waits), e.erlang_c(c, lam * hold), delta=0.01
        )

    def test_priority_top_class_matches_simulation(self):
        c, hold = 3, 1.0
        lams = [0.6, 1.95]  # top class 25% of an 85%-loaded pool
        waits = simulate(c, lams, hold, 200_000, seed=11)
        lam, a = sum(lams), sum(lams) * hold
        for q in (0.9, 0.95):
            model = e.class_wait_quantile(
                q, c, lam, hold, policy="priority", share_ahead=0.0, share_own=lams[0] / lam
            )
            self.assertAlmostEqual(
                pct(waits[0], q), model, delta=0.15 * model + 0.03, msg=f"top q={q}"
            )
        # Cobham's mean for the second class is exact; the exponential tail is close.
        mean2 = sum(waits[1]) / len(waits[1])
        cobham = e.erlang_c(c, a) * hold / c / ((1 - lams[0] / c) * (1 - a / c))
        self.assertAlmostEqual(mean2, cobham, delta=0.1 * cobham)
        # Priority helps the top class against FIFO.
        self.assertLess(pct(waits[0], 0.95), e.wait_quantile(0.95, c, lam, hold))

    def test_allen_cunneen_scales_conditional_wait(self):
        base = e.wait_quantile(0.95, 4, 3.0, 1.0)
        burst = e.wait_quantile(0.95, 4, 3.0, 1.0, variability=3.0)
        self.assertAlmostEqual(burst, 3.0 * base)


class Requirement(unittest.TestCase):
    def test_required_servers_is_minimal(self):
        for lam, hold, slo in [(0.05, 240.0, 600.0), (0.5, 60.0, 30.0), (2.0, 300.0, 120.0)]:
            c = e.required_servers(lam, hold, slo)
            self.assertLessEqual(e.wait_quantile(0.95, c, lam, hold), slo)
            if c > math.floor(lam * hold) + 1:
                self.assertGreater(e.wait_quantile(0.95, c - 1, lam, hold), slo)

    def test_required_grows_with_load(self):
        prev = 0
        for m in (0.5, 1, 2, 4, 8):
            c = e.required_servers(m * 0.02, 230.0, 600.0)
            self.assertGreaterEqual(c, prev)
            prev = c

    def test_priority_needs_no_more_than_fifo(self):
        lam, hold = 0.03, 230.0
        fifo = e.required_servers(lam, hold, 600.0)
        prio = e.required_servers(
            lam, hold, 600.0, policy="priority", targets=[(0.0, 0.2, 600.0), (0.2, 0.7, 2400.0)]
        )
        self.assertLessEqual(prio, fifo)

    def test_headroom(self):
        lam, hold, c, slo = 0.01, 230.0, 4, 600.0
        h = e.headroom(lam, hold, c, slo, tol=1e-4)
        self.assertGreater(h, 1.0)
        self.assertLessEqual(e.required_servers(lam * h, hold, slo), c)
        self.assertGreater(e.required_servers(lam * (h + 0.01), hold, slo), c)
        short = e.headroom(0.05, hold, c, slo)  # already short: demand must SHRINK
        self.assertLess(short, 1.0)
        self.assertLessEqual(e.required_servers(0.05 * short, hold, slo), c)
        self.assertEqual(e.headroom(1e-6, hold, c, slo, m_max=4.0), 4.0)


if __name__ == "__main__":
    unittest.main()
