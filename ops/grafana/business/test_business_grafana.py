"""Lint + dry-run for the private business dashboards and alert rules.

- the committed dashboards/*.json are exactly what gen_dashboards.py makes;
- every dashboard and rule passes sync.py's validation (uids, titles, units,
  the $env variable never defaulting to synthetic data, Loki datasource, no
  identifying field in any query);
- the sync's dry run builds complete provisioning payloads (alert rules
  with reduce + threshold/math, the private folder, role grants removed)
  WITHOUT any network access.

Cross-checks against the relay's event schema live in agent/tests/ops.test.ts.
"""

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gen_dashboards  # noqa: E402
import sync  # noqa: E402


class Dashboards(unittest.TestCase):
    def test_committed_json_is_generated(self):
        # Compared as data: the pre-commit prettier hook reflows the JSON text.
        for name, text in gen_dashboards.render().items():
            committed = json.loads((sync.HERE / "dashboards" / name).read_text(encoding="utf-8"))
            self.assertEqual(
                committed,
                json.loads(text),
                f"{name} is stale: run python3 ops/grafana/business/gen_dashboards.py",
            )

    def test_the_four_dashboards(self):
        titles = sorted(d["title"] for d in sync.load_dashboards())
        self.assertEqual(
            titles,
            [
                "Splanc — AI spend & margin",
                "Splanc — Free tier & demo",
                "Splanc — Revenue & credits",
                "Splanc — User feedback",
            ],
        )

    def test_valid(self):
        for d in sync.load_dashboards():
            self.assertEqual(sync.validate_dashboard(d), [], d["uid"])

    def test_defaults(self):
        for d in sync.load_dashboards():
            self.assertIn(d["time"]["from"], ("now-7d", "now-30d"))
            env = d["templating"]["list"][0]
            self.assertEqual(env["current"]["value"], ["production", "sandbox"])
            self.assertTrue(any(a.get("name") == "App releases" for a in d["annotations"]["list"]))

    def test_money_panels_are_usd(self):
        d = next(x for x in sync.load_dashboards() if x["uid"] == "splanc-biz-revenue")
        units = {
            p["title"]: p["fieldConfig"]["defaults"]["unit"]
            for p in d["panels"]
            if p.get("fieldConfig")
        }
        self.assertEqual(units["Gross revenue"], "currencyUSD")
        self.assertEqual(units["Credits sold"], "suffix: credits")

    def test_validation_catches_problems(self):
        bad = json.loads(json.dumps(sync.load_dashboards()[0]))
        bad["templating"]["list"][0]["current"] = {"value": ["synthetic"]}
        bad["panels"][1]["targets"][0][
            "expr"
        ] = 'sum(count_over_time({component="ai-billing"} | json | account="x" [1h]))'
        bad["panels"][1]["fieldConfig"]["defaults"].pop("unit")
        errs = sync.validate_dashboard(bad)
        self.assertTrue(any("synthetic" in e for e in errs))
        self.assertTrue(any("ignores $env" in e for e in errs))
        self.assertTrue(any("identifying" in e for e in errs))
        self.assertTrue(any("no unit" in e for e in errs))


class Alerts(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(sync.validate_alerts(sync.load_alerts()), [])

    def test_payloads(self):
        p = sync.plan()
        self.assertEqual(len(p["rules"]), len(sync.load_alerts()["rules"]))
        for r in p["rules"]:
            self.assertEqual(r["folderUID"], "splanc-business")
            self.assertEqual(r["condition"], "C")
            refs = [x["refId"] for x in r["data"]]
            self.assertEqual(refs[-1], "C")
            self.assertIn("RA", refs)
            for x in r["data"]:
                if x["datasourceUid"] == "grafanacloud-logs":
                    self.assertNotIn("$env", x["model"]["expr"])
                    self.assertIn('env=~"production|sandbox"', x["model"]["expr"])
            self.assertIn(r["labels"]["severity"], ("page", "warn"))
            self.assertNotIn("notification_settings", r)  # the default policy routes them

    def test_math_rule(self):
        r = next(x for x in sync.plan()["rules"] if x["uid"] == "biz-feedback-spike")
        c = r["data"][-1]["model"]
        self.assertEqual(c["type"], "math")
        self.assertEqual(c["expression"], "$RA > 5 && $RA > 3 * $RB")

    def test_threshold_rule(self):
        r = next(x for x in sync.plan()["rules"] if x["uid"] == "biz-org-spend-80")
        c = r["data"][-1]["model"]
        self.assertEqual(c["conditions"][0]["evaluator"], {"type": "gt", "params": [0.8]})

    def test_alert_env_override(self):
        r = sync.plan("production")["rules"][0]
        self.assertIn('env=~"production"', r["data"][0]["model"]["expr"])


class DryRun(unittest.TestCase):
    def test_no_network(self):
        out = io.StringIO()
        with mock.patch(
            "urllib.request.urlopen", side_effect=AssertionError("network in a dry run")
        ), redirect_stdout(out):
            self.assertEqual(sync.main(["--dry-run"]), 0)
        text = out.getvalue()
        self.assertIn("DRY RUN", text)
        self.assertIn("remove role grants: Viewer, Editor", text)
        self.assertEqual(text.count("  dashboard "), 4)
        self.assertGreaterEqual(text.count("  alert biz-"), 14)

    def test_apply_touches_only_its_folder(self):
        calls = []

        class Fake(sync.Grafana):
            def __init__(self):
                pass

            def call(self, method, path, body=None, headers=None):
                calls.append((method, path))
                if path == "/api/access-control/folders/splanc-business" and method == "GET":
                    return 200, [{"builtInRole": "Admin", "permission": "Admin"}]
                if method == "GET" and "alert-rules/" in path:
                    return 404, None
                return 200, {}

        self.assertEqual(sync.apply(Fake(), sync.plan(), log=lambda *_: None), 0)
        for method, path in calls:
            if method == "GET":
                continue
            self.assertTrue(
                path in ("/api/dashboards/db", "/api/v1/provisioning/alert-rules")
                or "splanc-business" in path,
                f"{method} {path} outside the private folder",
            )
        posted = [p for m, p in calls if m == "POST" and "builtInRoles" in p]
        self.assertEqual(
            posted,
            [
                f"/api/access-control/folders/splanc-business/builtInRoles/{r}"
                for r in ("Viewer", "Editor")
            ],
        )


if __name__ == "__main__":
    unittest.main()
