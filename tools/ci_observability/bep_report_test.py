#!/usr/bin/env python3
"""Unit tests for the BEP -> CI-record pipeline.

Drives the parser with a synthetic BEP event stream and injected file contents
(test.xml / stderr), so no real bazel run or filesystem layout is needed.
"""

import unittest

import bep_report as B
import report_html
import sinks


def _reader(files):
    """Return a file_reader that serves from a {path: content} dict."""
    return lambda path: files.get(path, "")


JUNIT_MIXED = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="math_test" tests="3" failures="1" errors="0">
    <testcase classname="math_test" name="test_add" time="0.01"/>
    <testcase classname="math_test" name="test_div" time="0.02">
      <failure message="ValueError: division by zero">Traceback (most recent call last):
  File "/home/runner/work/repo/math_test.py", line 42, in test_div
    x = 1 / 0
ValueError: division by zero</failure>
    </testcase>
    <testcase classname="math_test" name="test_skip" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>"""


class TestJUnitParsing(unittest.TestCase):
    def test_per_case_extraction(self):
        cases = B.parse_junit_xml(JUNIT_MIXED)
        self.assertEqual(len(cases), 3)
        by_name = {c["name"]: c for c in cases}
        self.assertEqual(by_name["math_test.test_add"]["status"], B.STATUS_PASSED)
        self.assertEqual(by_name["math_test.test_div"]["status"], B.STATUS_FAILED)
        self.assertEqual(by_name["math_test.test_skip"]["status"], B.STATUS_SKIPPED)
        self.assertIn("division by zero", by_name["math_test.test_div"]["trace"])
        self.assertEqual(by_name["math_test.test_add"]["duration_ms"], 10)

    def test_bare_testsuite_root(self):
        xml = '<testsuite name="s" tests="1"><testcase name="a" time="0"/></testsuite>'
        cases = B.parse_junit_xml(xml)
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]["name"], "a")

    def test_garbage_returns_empty(self):
        self.assertEqual(B.parse_junit_xml("not xml"), [])
        self.assertEqual(B.parse_junit_xml(""), [])


class TestCategorize(unittest.TestCase):
    def test_buckets(self):
        self.assertEqual(B.categorize("No space left on device", B.STATUS_FAILED), "disk")
        self.assertEqual(B.categorize("java.lang.OutOfMemoryError", B.STATUS_FAILED), "memory")
        self.assertEqual(B.categorize("Connection refused", B.STATUS_FAILED), "network")
        self.assertEqual(B.categorize("AssertionError: nope", B.STATUS_FAILED), "assertion")
        self.assertEqual(B.categorize("whatever", B.STATUS_TIMEOUT), "timeout")
        self.assertEqual(B.categorize("error: no such target //x", B.STATUS_BUILD_FAILED), "build")
        self.assertEqual(B.categorize("mystery boom", B.STATUS_FAILED), "other")

    def test_build_failure_infra_wins(self):
        # A build that died from disk exhaustion is 'disk', not 'build'.
        self.assertEqual(
            B.categorize("gcc: No space left on device", B.STATUS_BUILD_FAILED), "disk"
        )


class TestSignature(unittest.TestCase):
    def test_scrubs_noise(self):
        # Same failure across two runs: differing line numbers, addresses, and
        # durations collapse to one signature.
        a = B.signature('File "/home/runner/x/y.py", line 42, in f: boom 0xdeadbeef at 3.2ms')
        b = B.signature('File "/home/runner/x/y.py", line 77, in f: boom 0xcafef00d at 9.9ms')
        self.assertEqual(a, b)


def _events():
    """A synthetic BEP stream: one passing test, one failing test, one build failure."""
    return [
        {
            "id": {"started": {}},
            "started": {"uuid": "inv-123", "startTimeMillis": "1723075200000", "command": "test"},
        },
        # passing test target
        {
            "id": {"targetCompleted": {"label": "//a:pass_test"}},
            "completed": {"success": True, "targetKind": "py_test rule"},
        },
        {
            "id": {"testResult": {"label": "//a:pass_test", "run": 1, "attempt": 1}},
            "testResult": {
                "status": "PASSED",
                "testAttemptDurationMillis": "50",
                "cachedLocally": False,
                "testActionOutput": [
                    {"name": "test.xml", "uri": "file:///out/a/pass.xml"},
                    {"name": "test.log", "uri": "file:///out/a/pass.log"},
                ],
            },
        },
        # failing test target (with per-case xml)
        {
            "id": {"targetCompleted": {"label": "//b:math_test"}},
            "completed": {"success": True, "targetKind": "py_test rule"},
        },
        {
            "id": {"testResult": {"label": "//b:math_test", "run": 1, "attempt": 1}},
            "testResult": {
                "status": "FAILED",
                "testAttemptDurationMillis": "120",
                "cachedLocally": False,
                "testActionOutput": [
                    {"name": "test.xml", "uri": "file:///out/b/test.xml"},
                    {"name": "test.log", "uri": "file:///out/b/test.log"},
                ],
            },
        },
        {
            "id": {"testSummary": {"label": "//b:math_test"}},
            "testSummary": {"overallStatus": "FAILED", "totalRunCount": 1},
        },
        # build failure target (action failed, no test result)
        {
            "id": {"targetCompleted": {"label": "//c:broken"}},
            "completed": {"success": False, "targetKind": "cc_binary rule"},
        },
        {
            "id": {"actionCompleted": {"label": "//c:broken", "primaryOutput": "x.o"}},
            "action": {
                "success": False,
                "type": "CppCompile",
                "label": "//c:broken",
                "stderr": {"uri": "file:///out/c/stderr.txt"},
            },
        },
    ]


PASS_XML = '<testsuite name="pass_test" tests="1"><testcase classname="pass_test" name="ok" time="0.05"/></testsuite>'


class TestPipeline(unittest.TestCase):
    def setUp(self):
        files = {
            "/out/a/pass.xml": PASS_XML,
            "/out/a/pass.log": "Executing tests from //a:pass_test\nRan 1 test\nOK\n",
            "/out/b/test.xml": JUNIT_MIXED,
            "/out/b/test.log": "irrelevant",
            "/out/c/stderr.txt": "x.cc:10:5: error: 'foo' was not declared in this scope\n",
        }
        parser = B.BepParser(
            context={
                "runner": "github:linux",
                "runner_os": "linux",
                "commit": "abc123",
                "workflow": "Test",
            },
            file_reader=_reader(files),
        )
        for ev in _events():
            parser.consume(ev)
        self.records = parser.records()
        self.by_target = {}
        for r in self.records:
            self.by_target.setdefault(r.target, []).append(r)

    def test_invocation_and_context(self):
        self.assertTrue(all(r.invocation_id == "inv-123" for r in self.records))
        self.assertTrue(all(r.runner == "github:linux" for r in self.records))
        self.assertTrue(
            all(
                r.timestamp.startswith("2024-08-07") or r.timestamp.startswith("2024-08-08")
                for r in self.records
            )
        )

    def test_per_test_case_granularity(self):
        # //b:math_test should yield 3 per-case records, not just one target row.
        b = self.by_target["//b:math_test"]
        self.assertEqual(len(b), 3)
        names = {r.test_case for r in b}
        self.assertEqual(names, {"math_test.test_add", "math_test.test_div", "math_test.test_skip"})

    def test_failure_detail(self):
        div = next(
            r for r in self.by_target["//b:math_test"] if r.test_case == "math_test.test_div"
        )
        self.assertEqual(div.status, B.STATUS_FAILED)
        self.assertEqual(div.failure_category, "other")  # ValueError -> not an infra bucket
        self.assertIn("division by zero", div.failure_reason)
        self.assertTrue(div.failure_signature)
        self.assertIn("Traceback", div.failure_trace)

    def test_build_failure_record(self):
        c = self.by_target["//c:broken"]
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0].record_type, "target")
        self.assertEqual(c[0].status, B.STATUS_BUILD_FAILED)
        self.assertEqual(c[0].failure_category, "build")
        self.assertIn("was not declared", c[0].failure_reason)

    def test_passing_target(self):
        a = self.by_target["//a:pass_test"]
        self.assertEqual(len(a), 1)
        self.assertEqual(a[0].status, B.STATUS_PASSED)
        self.assertFalse(a[0].is_failure())
        # Even a PASSING target carries its test.log so the report can show it.
        self.assertIn("Ran 1 test", a[0].log_excerpt)

    def test_summary_counts(self):
        s = B.summarize(self.records)
        # 1 pass (a.ok) + 1 pass (test_add) + 1 fail (test_div) + 1 skip + 1 build fail
        self.assertEqual(s["failed"], 2)
        self.assertEqual(s["skipped"], 1)
        cats = dict(s["by_category"])
        self.assertEqual(cats.get("build"), 1)
        self.assertEqual(cats.get("other"), 1)

    def test_html_renders(self):
        s = B.summarize(self.records)
        htmlout = report_html.render_html(
            self.records,
            s,
            {"workflow": "Test", "runner": "github:linux"},
            console="INFO: bazel build\nERROR: something\n",
        )
        self.assertIn("<!doctype html>", htmlout)
        self.assertIn("//b:math_test", htmlout)
        self.assertIn("division by zero", htmlout)
        self.assertIn("Per-target details", htmlout)
        # The passing target's log shows in the report.
        self.assertIn("Ran 1 test", htmlout)
        # The bazel console output section is included.
        self.assertIn("Console output", htmlout)
        # No unescaped traceback breaking the doc.
        self.assertNotIn("<script", htmlout.lower())

    def test_markdown_report(self):
        s = B.summarize(self.records)
        md = B.render_markdown_report(
            self.records, s, {"workflow": "Test", "runner": "github:linux"}
        )
        self.assertIn("CI report", md)
        self.assertIn("Per-target details", md)
        self.assertIn("//b:math_test", md)
        # Collapsible per-target sections render on the run page (no download).
        self.assertIn("<details", md)
        # A failing case surfaces its reason inline.
        self.assertIn("division by zero", md)


class TestFlaky(unittest.TestCase):
    def test_flaky_detection(self):
        events = [
            {"id": {"started": {}}, "started": {"uuid": "i", "startTimeMillis": "1723075200000"}},
            {
                "id": {"targetCompleted": {"label": "//x:t"}},
                "completed": {"success": True, "targetKind": "py_test rule"},
            },
            {
                "id": {"testResult": {"label": "//x:t", "run": 1, "attempt": 1}},
                "testResult": {
                    "status": "FAILED",
                    "testAttemptDurationMillis": "10",
                    "testActionOutput": [{"name": "test.log", "uri": "file:///l1"}],
                },
            },
            {
                "id": {"testResult": {"label": "//x:t", "run": 1, "attempt": 2}},
                "testResult": {
                    "status": "PASSED",
                    "testAttemptDurationMillis": "10",
                    "testActionOutput": [{"name": "test.xml", "uri": "file:///x.xml"}],
                },
            },
            {"id": {"testSummary": {"label": "//x:t"}}, "testSummary": {"overallStatus": "FLAKY"}},
        ]
        parser = B.BepParser(context={}, file_reader=_reader({"/x.xml": PASS_XML, "/l1": "boom"}))
        for e in events:
            parser.consume(e)
        recs = parser.records()
        # Final attempt passed after an earlier failure -> surfaced as FLAKY.
        self.assertTrue(any(r.status == B.STATUS_FLAKY for r in recs))
        self.assertFalse(any(r.is_failure() for r in recs))


class TestBepStatusReconciliation(unittest.TestCase):
    """Bazel's synthesized test.xml for a FAILED test keeps status="run" with no
    <failure> element (the failure is only in test.log). The BEP TestResult
    status is authoritative — a failed attempt whose XML shows no failing case
    must still yield a failing record, enriched with the log trace.
    """

    # Mimics bazel's minimal XML for a failed sh_test / py_test: one testcase,
    # a generic <error>, no useful per-case detail.
    GENERIC_FAIL_XML = (
        '<testsuites><testsuite name="x/t" tests="1" failures="0" errors="1">'
        '<testcase name="x/t" status="run" time="0">'
        '<error message="exited with error code 1"></error>'
        "</testcase></testsuite></testsuites>"
    )
    LOG = "Executing tests from //x:t\nstarting\nValueError: divide by zero\n"

    def _run(self, xml):
        events = [
            {"id": {"started": {}}, "started": {"uuid": "i", "startTimeMillis": "1723075200000"}},
            {
                "id": {"targetCompleted": {"label": "//x:t"}},
                "completed": {"success": True, "targetKind": "sh_test rule"},
            },
            {
                "id": {"testResult": {"label": "//x:t", "run": 1, "attempt": 1}},
                "testResult": {
                    "status": "FAILED",
                    "testAttemptDurationMillis": "10",
                    "testActionOutput": [
                        {"name": "test.xml", "uri": "file:///t.xml"},
                        {"name": "test.log", "uri": "file:///t.log"},
                    ],
                },
            },
        ]
        parser = B.BepParser(context={}, file_reader=_reader({"/t.xml": xml, "/t.log": self.LOG}))
        for e in events:
            parser.consume(e)
        return parser.records()

    def test_generic_xml_failure_is_recorded(self):
        recs = self._run(self.GENERIC_FAIL_XML)
        self.assertEqual(len(recs), 1)
        self.assertTrue(recs[0].is_failure())
        # The generic <error> message drives the (stable) reason...
        self.assertIn("error code", recs[0].failure_reason)
        # ...but the trace is enriched with the real log cause for debugging.
        self.assertIn("divide by zero", recs[0].failure_trace)

    def test_failed_attempt_with_no_failure_xml_synthesizes(self):
        # XML that parses but shows the case as passing (bazel's status="run").
        passing_xml = '<testsuite name="x/t" tests="1"><testcase name="x/t" time="0"/></testsuite>'
        recs = self._run(passing_xml)
        self.assertEqual(len(recs), 1)
        self.assertTrue(recs[0].is_failure())  # BEP status wins over the XML
        self.assertIn("divide by zero", recs[0].failure_trace)


class TestConsoleAndLogs(unittest.TestCase):
    def test_console_captured_and_build_failure_falls_back_to_it(self):
        # A target that aborted because a *dependency* failed: no action stderr
        # attributed to it, but the compiler error is in the console (progress).
        events = [
            {"id": {"started": {}}, "started": {"uuid": "i", "startTimeMillis": "1723075200000"}},
            {
                "id": {"progress": {"opaqueCount": 1}},
                "progress": {"stderr": "gen.cc:5:2: error: expected ';' before '}' token\n"},
            },
            {
                "id": {"targetCompleted": {"label": "//d:dep"}},
                "completed": {"success": False, "targetKind": "cc_library rule"},
            },
            {
                "id": {"aborted": {"label": "//d:dep"}},
                "aborted": {"reason": "USER_INTERRUPTED", "description": "build failed"},
            },
        ]
        parser = B.BepParser(context={}, file_reader=_reader({}))
        for e in events:
            parser.consume(e)
        self.assertIn("expected ';'", parser.console())
        recs = parser.records()
        self.assertEqual(len(recs), 1)
        rec = recs[0]
        self.assertEqual(rec.status, B.STATUS_BUILD_FAILED)
        # Reason picked from the console error line (not the generic "build failed").
        self.assertIn("error", rec.failure_reason.lower())
        # The compiler output is available for the report.
        self.assertIn("expected ';'", rec.log_excerpt)

    def test_build_failure_uses_own_action_stderr(self):
        files = {"/e/stderr.txt": "e.cc:1:1: error: boom in this file\n"}
        events = [
            {"id": {"started": {}}, "started": {"uuid": "i", "startTimeMillis": "1723075200000"}},
            {
                "id": {"targetCompleted": {"label": "//e:t"}},
                "completed": {"success": False, "targetKind": "cc_binary rule"},
            },
            {
                "id": {"actionCompleted": {"label": "//e:t"}},
                "action": {
                    "success": False,
                    "type": "CppCompile",
                    "label": "//e:t",
                    "stderr": {"uri": "file:///e/stderr.txt"},
                },
            },
        ]
        parser = B.BepParser(context={}, file_reader=_reader(files))
        for e in events:
            parser.consume(e)
        rec = parser.records()[0]
        self.assertIn("boom in this file", rec.failure_reason)
        self.assertIn("boom in this file", rec.log_excerpt)


class TestSinksNoop(unittest.TestCase):
    def test_loki_noop_without_creds(self):
        import os

        for k in ("GRAFANA_CLOUD_LOKI_URL", "GRAFANA_CLOUD_LOKI_KEY"):
            os.environ.pop(k, None)
        self.assertFalse(sinks.push_loki([B.Record(target="//x")]))

    def test_clickhouse_noop_without_creds(self):
        import os

        os.environ.pop("CLICKHOUSE_URL", None)
        self.assertFalse(sinks.push_clickhouse([B.Record(target="//x")]))

    def test_tinybird_noop_without_creds(self):
        import os

        for k in ("TINYBIRD_API_URL", "TINYBIRD_TOKEN"):
            os.environ.pop(k, None)
        self.assertFalse(sinks.push_tinybird([B.Record(target="//x")]))

    def test_push_all_swallows_a_raising_sink(self):
        # A sink raising (e.g. an unforeseen network error) must not propagate —
        # it would fail the CI step. push_all must swallow it.
        import os

        os.environ["GRAFANA_CLOUD_LOKI_URL"] = "http://127.0.0.1:0/bad"
        os.environ["GRAFANA_CLOUD_LOKI_KEY"] = "k"
        orig = sinks._post
        try:
            sinks._post = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
            # Must not raise despite the sink blowing up.
            sinks.push_all([B.Record(target="//x", runner="hitl")])
        finally:
            sinks._post = orig
            os.environ.pop("GRAFANA_CLOUD_LOKI_URL", None)
            os.environ.pop("GRAFANA_CLOUD_LOKI_KEY", None)

    def test_tinybird_row_keeps_iso_timestamp(self):
        rec = B.Record(target="//x", status="FAILED", cached=True, timestamp="2024-08-07T12:00:00Z")
        row = sinks._tinybird_row(rec)
        self.assertEqual(set(row), set(sinks._CLICKHOUSE_COLUMNS))
        self.assertEqual(row["cached"], 1)
        self.assertEqual(row["timestamp"], "2024-08-07T12:00:00Z")  # ISO, not space-format

    def test_clickhouse_row_shape(self):
        rec = B.Record(target="//x", status="FAILED", cached=True, timestamp="2024-08-07T12:00:00Z")
        row = sinks._clickhouse_row(rec)
        self.assertEqual(set(row), set(sinks._CLICKHOUSE_COLUMNS))
        self.assertEqual(row["cached"], 1)
        self.assertEqual(row["timestamp"], "2024-08-07 12:00:00")


if __name__ == "__main__":
    unittest.main()
