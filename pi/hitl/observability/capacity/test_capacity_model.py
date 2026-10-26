"""Unit tests for capacity_model.py and the Prometheus adapter in sources.py.
Run: python3 test_capacity_model.py"""

import copy
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import capacity_model as cm  # noqa: E402
import reservations as rsv  # noqa: E402
import sources  # noqa: E402

T0 = 1_792_800_000 - 1_792_800_000 % 3600  # an hour boundary
CFG = cm.Config()


def rec(
    id_,
    owner,
    req,
    act=None,
    rel=None,
    unit="",
    caps=(),
    typ="esp32c6",
    prio="pr-ci",
    outcome="passed",
):
    r = rsv.Reservation(
        id=id_,
        rig="hitl-rig-2",
        owner=owner,
        requested=T0 + req,
        req_type=typ,
        req_caps=tuple(caps),
        activated=None if act is None else T0 + act,
        released=None if rel is None else T0 + rel,
        unit=unit,
        reason="holder",
    )
    r.caps_class = rsv.demand_caps_class(r)
    r.prio_class, r.outcome = prio, outcome
    return r


def synthetic_aggs(hours=48, per_hour=(6, 1), hold=300.0, c6=2, la=2, merge_share=0.25):
    """Aggregates with `per_hour` (plain c6, c6-la) served requests every hour."""
    demand, avail = [], []
    for k in range(hours):
        t = T0 + k * 3600
        for caps, n in zip(("c6", "c6-la"), per_hour):
            for prio, share in (("merge-queue", merge_share), ("pr-ci", 1 - merge_share)):
                d = cm._new_demand(t, caps, prio)
                d["requests"] = d["served"] = n * share
                d["hold_s"] = n * share * hold
                d["hold_sq_s"] = n * share * 2 * hold * hold  # exponential holds: E[x^2] = 2 h^2
                d["wait_act"][0] = n * share
                demand.append(d)
        avail.append({"t": t, "caps_class": "c6", "host": "hitl-rig-1", "avail_s": 3600.0 * c6})
        avail.append({"t": t, "caps_class": "c6-la", "host": "hitl-rig-2", "avail_s": 3600.0 * la})
    return {"demand": demand, "busy": [], "avail": avail, "start": T0, "end": T0 + hours * 3600}


class Usable(unittest.TestCase):
    def test_uncapped(self):
        u = cm.usable_boards(
            {"esp32c6": {"c6": 2}, "led-mapper-pi": {"pi": 1, "pi-la": 1}}, 0, {}, {}
        )
        self.assertEqual(u, {"c6": 2, "pi": 1, "pi-la": 1})

    def test_class_cap(self):
        u = cm.usable_boards({"esp32c6": {"c6": 3}}, 0, {"esp32c6": 2}, {})
        self.assertEqual(u["c6"], 2)

    def test_shared_host_cap_follows_load(self):
        units = {"esp32c6": {"c6": 1, "c6-la": 1}, "led-mapper-pi": {"pi": 2}}
        u = cm.usable_boards(units, 2, {}, {"esp32c6": 3000.0, "led-mapper-pi": 1000.0})
        self.assertAlmostEqual(u["c6"] + u["c6-la"], 1.5)
        self.assertAlmostEqual(u["c6"], 0.75)
        self.assertAlmostEqual(u["pi"], 0.5)
        # idle pi: c6 takes the whole cap (water-filled up to its 2 boards)
        u = cm.usable_boards(units, 2, {}, {"esp32c6": 10.0})
        self.assertAlmostEqual(u["c6"] + u["c6-la"], 2.0)
        self.assertAlmostEqual(u["pi"], 0.0)
        # idle host: equal shares
        u = cm.usable_boards(units, 2, {}, {})
        self.assertAlmostEqual(u["pi"], 1.0)


class Aggregation(unittest.TestCase):
    def test_aggregate_records(self):
        recs = [
            rec("a", "o1", 10, 70, 670, unit="c6-x"),  # 60 s wait, 600 s hold
            rec(
                "b", "o2", 20, 3000, 4000, unit="c6-y", caps=("logic-analyzer-led-strip",)
            ),  # spans 2 hours
            rec("c", "o3", 30, None, 2430),  # timeout, not retried -> unserved demand
            rec("d", "o1", 40, None, 2440),  # timeout, retried 30 s later -> not counted again
            rec("e", "o1", 2470, 2500, 2600, unit="c6-x"),
            rec("f", "o4", 50, None, 100),  # withdrawn early (cancelled run): not demand
        ]
        aggs = cm.aggregate_records(
            recs,
            la_units={"c6-y"},
            unit_hosts={"c6-x": "h1", "c6-y": "h2"},
            t0=T0,
            t1=T0 + 7200,
            cfg=CFG,
        )
        d = {(r["t"], r["caps_class"]): r for r in aggs["demand"]}
        c6 = d[(T0, "c6")]
        self.assertEqual((c6["requests"], c6["served"], c6["abandoned"]), (5, 2, 3))
        self.assertEqual((c6["timeouts"], c6["unserved"]), (2, 1))
        self.assertEqual(c6["hold_s"], 700)
        self.assertEqual(d[(T0, "c6-la")]["served"], 1)
        busy = {(b["t"], b["caps_class"]): b["busy_s"] for b in aggs["busy"]}
        self.assertEqual(busy[(T0, "c6-la")], 600)  # 3000..3600
        self.assertEqual(busy[(T0 + 3600, "c6-la")], 400)  # 3600..4000
        self.assertEqual(aggs["unretried_timeout_fraction"]["c6"], 0.5)
        self.assertEqual({a["caps_class"] for a in aggs["avail"]}, {"c6", "c6-la"})

    def test_merge_later_source_wins(self):
        a = synthetic_aggs(hours=4)
        b = synthetic_aggs(hours=2, per_hour=(1, 0))
        for k in ("demand", "avail"):
            for r in b[k]:
                r["t"] += 2 * 3600
        b["start"], b["end"] = T0 + 2 * 3600, T0 + 4 * 3600
        m = cm.merge_aggregates(a, b)
        late = [r for r in m["demand"] if r["t"] >= T0 + 2 * 3600 and r["caps_class"] == "c6"]
        self.assertEqual(sum(r["served"] for r in late), 2)  # b's 1/h, not a's 6/h
        self.assertEqual((m["start"], m["end"]), (T0, T0 + 4 * 3600))


class Model(unittest.TestCase):
    def test_window_stats(self):
        w = cm.pool_window(synthetic_aggs(), "c6", T0, T0 + 48 * 3600, CFG)
        self.assertAlmostEqual(w.hold, 300.0)
        self.assertAlmostEqual(w.cs2, 1.0)
        self.assertAlmostEqual(w.lam_peak * 3600, 7.0)
        self.assertAlmostEqual(w.healthy, 4.0)
        self.assertAlmostEqual(w.shares["merge-queue"], 0.25)
        self.assertAlmostEqual(w.rho, 7 * 300 / 3600 / 4)

    def test_child_pool_absorbs_parent_plain_demand(self):
        aggs = synthetic_aggs()
        w = cm.pool_window(aggs, "c6-la", T0, T0 + 48 * 3600, CFG)
        # own 1/h + half (2 of 4 boards) of the plain 6/h
        self.assertAlmostEqual(w.lam_peak * 3600, 1 + 3)
        alone = cm.pool_window(aggs, "c6-la", T0, T0 + 48 * 3600, cm.Config(child_spill=False))
        self.assertAlmostEqual(alone.lam_peak * 3600, 1)

    def test_deficit_and_nesting(self):
        aggs = synthetic_aggs(per_hour=(60, 12))  # heavy: 72/h x 5 min = 6 Erlangs on 4 boards
        wins = {p: cm.pool_window(aggs, p, T0, T0 + 48 * 3600, CFG) for p in cm.POOLS}
        rows = {
            (r["pool"], r["policy"]): r
            for r in cm.headline_rows(wins, CFG, "fifo")
            if r["slo_min"] == 10 and r["growth"] == 1.0
        }
        c6, la = rows[("c6", "fifo")], rows[("c6-la", "fifo")]
        self.assertGreater(c6["required"], 6)
        self.assertGreater(la["deficit"], 0)
        # parent reports what is left after buying the child's boards
        self.assertAlmostEqual(c6["deficit"], c6["deficit_pool"] - max(0.0, la["deficit_pool"]))
        self.assertLess(c6["headroom"], 1.0)
        # priority scheduling never needs more boards than FIFO for the same SLO
        self.assertLessEqual(rows[("c6", "priority")]["required"], c6["required"])
        # growth only ever raises the requirement
        req = [
            r["required"]
            for r in cm.headline_rows(wins, CFG, "fifo")
            if r["pool"] == "c6" and r["policy"] == "fifo" and r["slo_min"] == 10
        ]
        self.assertEqual(req, sorted(req))

    def test_efficiency_gains_lower_demand_not_raise_capacity(self):
        aggs = synthetic_aggs(per_hour=(60, 12))
        lean = copy.deepcopy(aggs)
        for d in lean["demand"]:  # e.g. test selection skips 40% of the work
            for k in ("requests", "served", "hold_s", "hold_sq_s"):
                d[k] *= 0.6
        before = cm.pool_window(aggs, "c6", T0, T0 + 48 * 3600, CFG)
        after = cm.pool_window(lean, "c6", T0, T0 + 48 * 3600, CFG)
        self.assertLess(after.demand_bh, before.demand_bh)
        self.assertEqual(after.healthy, before.healthy)
        ev_b = cm.evaluate(before, CFG, slo_s=600)
        ev_a = cm.evaluate(after, CFG, slo_s=600)
        self.assertLessEqual(ev_a["required"], ev_b["required"])
        self.assertGreater(ev_a["headroom"], ev_b["headroom"])

    def test_measured_survival_excludes_withdrawn_and_keeps_timeouts(self):
        aggs = synthetic_aggs(hours=1, per_hour=(10, 0))
        d = next(
            r for r in aggs["demand"] if r["caps_class"] == "c6" and r["prio_class"] == "pr-ci"
        )
        i_early = cm.bucket_index(100, cm.WAIT_BUCKETS)
        i_to = cm.bucket_index(2401, cm.WAIT_BUCKETS)
        d["wait_ab"][i_early] += 50  # withdrawn after 100 s: ignored
        d["wait_ab"][i_to] += 10  # timed out after 40 min: waited > every bound below 2400
        w = cm.pool_window(aggs, "c6", T0, T0 + 3600, CFG)
        s = cm.measured_survival(w, CFG)
        self.assertAlmostEqual(s[cm.WAIT_BUCKETS.index(600)], 0.5)  # 10 of 20 waited > 10 min
        self.assertAlmostEqual(s[cm.WAIT_BUCKETS.index(3600)], 0.0)

    def test_quantiles(self):
        self.assertEqual(cm.quantile([1, 2, 3, 4, 5], 0.9), 4.6)
        surv = [1.0 - i / len(cm.WAIT_BUCKETS) for i in range(1, len(cm.WAIT_BUCKETS) + 1)]
        t, cens = cm.hist_quantile(surv, 0.5)
        self.assertFalse(cens)
        self.assertTrue(cm.WAIT_BUCKETS[5] <= t <= cm.WAIT_BUCKETS[7])


class Prometheus(unittest.TestCase):
    def test_cumulative_to_counts(self):
        cum = {10.0: 1, 30.0: 3, 60.0: 3, float("inf"): 5}
        counts = sources.cumulative_to_counts(cum, [10, 30, 60, 120])
        self.assertEqual(counts, [1, 2, 0, 0, 2])

    def test_prom_aggregates_from_fake_series(self):
        t = T0 + 3600  # value at t covers the hour starting at T0
        lb = {"caps_class": "c6", "prio_class": "merge-queue"}

        def query(expr, start, end, step):
            if "requests_total" in expr:
                return [(lb, [(t, 10.0)])]
            if "hold_seconds_count" in expr:
                return [(lb, [(t, 8.0)])]
            if "hold_seconds_sum" in expr:
                return [(lb, [(t, 2400.0)])]
            if "hold_seconds_bucket" in expr:
                return [({**lb, "le": "300"}, [(t, 8.0)]), ({**lb, "le": "+Inf"}, [(t, 8.0)])]
            if "abandoned_total" in expr:
                return [(lb, [(t, 2.0)])]
            if "wait_seconds_bucket" in expr:
                ab = {**lb, "result": "abandoned"}
                return [
                    ({**ab, "le": "1800"}, [(t, 0.0)]),
                    ({**ab, "le": "2400"}, [(t, 0.0)]),
                    ({**ab, "le": "3600"}, [(t, 2.0)]),
                    ({**ab, "le": "+Inf"}, [(t, 2.0)]),
                    ({**lb, "result": "activated", "le": "60"}, [(t, 8.0)]),
                    ({**lb, "result": "activated", "le": "+Inf"}, [(t, 8.0)]),
                ]
            if "busy_seconds_total" in expr:
                return [
                    (
                        {"caps_class": "c6", "prio_class": "merge-queue", "outcome": "expired"},
                        [(t, 1800.0)],
                    )
                ]
            if "available_seconds_total" in expr:
                return [({"caps_class": "c6", "host": "hitl-rig-1"}, [(t, 7200.0)])]
            return []

        a = sources.prom_aggregates(query, ["hitl-rig-1"], T0, T0 + 3600, CFG, {"c6": 0.25})
        d = a["demand"][0]
        self.assertEqual((d["t"], d["requests"], d["served"], d["hold_s"]), (T0, 10.0, 8.0, 2400.0))
        self.assertEqual((d["timeouts"], d["unserved"]), (2.0, 0.5))
        self.assertTrue(d["live"])
        self.assertEqual(a["avail"][0]["avail_s"], 7200.0)
        self.assertEqual((a["start"], a["end"]), (T0, T0 + 3600))
        self.assertEqual(cm.current_policy(a, T0, T0 + 3600), "priority")


class Backfill(unittest.TestCase):
    def test_committed_backfill_builds(self):
        path = os.path.join(HERE, "data", "backfill_aggregates.json")
        with open(path) as f:
            aggs = cm.merge_aggregates(json.load(f))
        ds = cm.build_dataset(aggs, CFG)
        self.assertEqual(ds["policy_in_effect"], "fifo")
        pools = {r["pool"] for r in ds["headline"]}
        self.assertEqual(pools, set(cm.POOLS))
        n = len(CFG.slo_grid_min) * len(CFG.growth_grid) * 2 * len(cm.POOLS)
        self.assertEqual(len(ds["headline"]), n)
        for r in ds["headline"]:
            self.assertTrue(math.isfinite(r["deficit"]))
            self.assertLessEqual(r["usable"], r["healthy"] + 1e-9)
        self.assertTrue(ds["validation_summary"])
        self.assertTrue(any(r["pool"] == "_all" for r in ds["daily"]))


if __name__ == "__main__":
    unittest.main()
