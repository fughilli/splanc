#!/usr/bin/env python3
"""Turn a Bazel Build Event Protocol (BEP) stream into CI-failure telemetry.

This is the heart of the CI-observability pipeline (FUG-128). Bazel is asked to
write its build events as newline-delimited JSON:

    bazel test //... --build_event_json_file=bep.json

and this tool reads that file, follows each test's ``test.xml`` (JUnit) output
to recover *per-test-case* results, and emits three things:

  1. Normalized records (NDJSON) — one per test case (or per failed build
     target) — carrying enough context (runner/DUT, target, test case, failure
     category + signature + full trace, timing) to drive the dashboards.
  2. A self-contained static HTML report — summary, CSS/SVG charts, and a
     collapsible ``<details>`` block per target with its per-case rows and
     traces — meant to be uploaded as a CI artifact and linked from the log.
  3. Optional pushes of the records to a telemetry sink (Grafana Cloud Loki
     and/or a ClickHouse-compatible columnar DB); see ``sinks.py``. Each sink
     no-ops when its credentials are absent, so this is safe to wire into CI
     unconditionally, including on fork PRs.

Everything here is standard-library only (matching the other stdlib tools in
``tools/``) so the CI step needs nothing but ``python3``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import os
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Callable, Iterable, Optional

# ---------------------------------------------------------------------------
# Record model
# ---------------------------------------------------------------------------

# Test-result statuses we normalize onto. Bazel's TestStatus enum plus a
# synthetic BUILD_FAILED for targets that never produced a test result because
# they failed to build/analyze.
STATUS_PASSED = "PASSED"
STATUS_FAILED = "FAILED"
STATUS_TIMEOUT = "TIMEOUT"
STATUS_FLAKY = "FLAKY"
STATUS_SKIPPED = "SKIPPED"
STATUS_ERROR = "ERROR"
STATUS_BUILD_FAILED = "BUILD_FAILED"

_FAILING = {STATUS_FAILED, STATUS_TIMEOUT, STATUS_ERROR, STATUS_BUILD_FAILED}


@dataclass
class Record:
    """One normalized CI result row (a test case, or a failed build target)."""

    # Invocation / VCS / CI context (shared across every record in a run).
    invocation_id: str = ""
    timestamp: str = ""  # ISO-8601 UTC
    commit: str = ""
    branch: str = ""
    pr: str = ""
    workflow: str = ""
    job: str = ""
    run_url: str = ""
    runner: str = ""  # e.g. github:linux, github:macos, hitl-rig-1:c6-abcdef
    runner_os: str = ""

    # What ran.
    target: str = ""  # //pkg:name
    target_kind: str = ""  # "py_test rule"
    record_type: str = "test_case"  # test_case | target
    test_suite: str = ""
    test_case: str = ""  # classname.name (empty for target-level records)

    # Outcome.
    status: str = STATUS_PASSED
    cached: bool = False
    duration_ms: int = 0
    attempt: int = 1
    run: int = 1
    shard: int = 1

    # Failure detail (empty for passes).
    failure_category: str = ""  # coarse bucket: timeout|disk|memory|network|build|assertion|other
    failure_signature: str = ""  # normalized one-liner, groups identical failures
    failure_reason: str = ""  # raw first meaningful line
    failure_trace: str = ""  # full trace/log excerpt (truncated)

    def is_failure(self) -> bool:
        return self.status in _FAILING


# ---------------------------------------------------------------------------
# Failure categorization
# ---------------------------------------------------------------------------

# Coarse buckets, matched against the failure text in order. The point is the
# "failures aggregated by trace/reason" view: a nonzero disk/memory/network
# rate usually means infra flake, while assertion/build means a real regression.
_CATEGORY_PATTERNS = [
    ("disk", re.compile(r"no space left on device|ENOSPC|out of disk|disk quota", re.I)),
    (
        "memory",
        re.compile(
            r"out of memory|cannot allocate memory|\bOOM\b|oom-kill|std::bad_alloc|MemoryError",
            re.I,
        ),
    ),
    ("timeout", re.compile(r"\btimed? ?out\b|deadline exceeded|Timeout", re.I)),
    (
        "network",
        re.compile(
            r"connection refused|connection reset|temporary failure in name resolution|"
            r"could not resolve host|network is unreachable|ECONNREFUSED|ETIMEDOUT|TLS handshake",
            re.I,
        ),
    ),
    (
        "build",
        re.compile(
            r"\berror:\s|undefined reference|compilation failed|no such target|"
            r"cannot find|linker command failed|BUILD failure",
            re.I,
        ),
    ),
    (
        "assertion",
        re.compile(r"AssertionError|assert |Expected .* but|to equal|Error: expect", re.I),
    ),
]

# Noise stripped out of a failure line so identical failures collapse to one
# signature regardless of run-specific paths, addresses, timestamps, or ids.
_SIG_SCRUBBERS = [
    (re.compile(r"0x[0-9a-fA-F]+"), "0xADDR"),
    (re.compile(r"/[^\s:]+/"), "/…/"),  # collapse absolute paths
    (re.compile(r":\d+"), ":N"),  # :lineno / :port
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[ T][\d:.,]+\b"), "<ts>"),
    (re.compile(r"\b[0-9a-f]{7,40}\b"), "<hex>"),  # sha-ish
    (re.compile(r"\b\d+(\.\d+)?(ms|s|us|ns)\b"), "<dur>"),
    (re.compile(r"\b\d+\b"), "N"),
]


def categorize(text: str, status: str) -> str:
    """Bucket a failure by its text; TIMEOUT/BUILD_FAILED win by status."""
    if status == STATUS_TIMEOUT:
        return "timeout"
    if status == STATUS_BUILD_FAILED:
        # A build failure is 'build' unless the text points at infra (disk/mem).
        for name, pat in _CATEGORY_PATTERNS:
            if name in ("disk", "memory") and pat.search(text or ""):
                return name
        return "build"
    for name, pat in _CATEGORY_PATTERNS:
        if pat.search(text or ""):
            return name
    return "other"


def first_meaningful_line(text: str) -> str:
    """First non-blank, non-decorative line — the human-facing failure reason."""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        # Skip pure separators / framing.
        if re.fullmatch(r"[=\-_*~#]{3,}", line):
            continue
        return line[:400]
    return ""


def signature(reason: str) -> str:
    """Normalize a reason into a stable grouping key (scrub run-specific noise)."""
    sig = reason
    for pat, repl in _SIG_SCRUBBERS:
        sig = pat.sub(repl, sig)
    return sig.strip()[:300]


# ---------------------------------------------------------------------------
# BEP parsing
# ---------------------------------------------------------------------------


def _uri_to_path(uri: str) -> Optional[str]:
    """file:// URI -> local path (BEP test outputs are local to the runner)."""
    if not uri:
        return None
    if uri.startswith("file://"):
        parsed = urllib.parse.urlparse(uri)
        return urllib.parse.unquote(parsed.path)
    if uri.startswith("/"):
        return uri
    return None


def iter_bep_events(path: str) -> Iterable[dict]:
    """Yield each BEP event dict from a --build_event_json_file (NDJSON)."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # A partially written last line (bazel killed mid-flush) — skip.
                continue


def _default_reader(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


@dataclass
class _TargetInfo:
    label: str
    kind: str = ""
    build_success: Optional[bool] = None
    abort_reason: str = ""
    abort_description: str = ""
    action_failures: list = field(default_factory=list)  # (type, stderr_text)


class BepParser:
    """Fold a BEP event stream into per-target and per-test-case results.

    ``file_reader`` is injectable so tests can supply test.xml / stderr content
    without touching the filesystem.
    """

    def __init__(self, context: dict, file_reader: Callable[[str], str] = _default_reader):
        self.context = context
        self.read = file_reader
        self.invocation_id = ""
        self.start_millis = 0
        self.targets: dict = {}  # label -> _TargetInfo
        # label -> list of test attempts (dicts)
        self.test_results: dict = defaultdict(list)
        self.test_summaries: dict = {}  # label -> summary dict

    def _target(self, label: str) -> _TargetInfo:
        info = self.targets.get(label)
        if info is None:
            info = _TargetInfo(label=label)
            self.targets[label] = info
        return info

    def consume(self, event: dict) -> None:
        eid = event.get("id", {})
        if "started" in eid and "started" in event:
            st = event["started"]
            self.invocation_id = st.get("uuid", self.invocation_id)
            try:
                self.start_millis = int(st.get("startTimeMillis", 0))
            except (TypeError, ValueError):
                self.start_millis = 0
        elif "targetCompleted" in eid:
            self._on_target_completed(eid["targetCompleted"], event.get("completed", {}))
        elif "aborted" in eid:
            self._on_aborted(eid["aborted"], event.get("aborted", {}))
        elif "actionCompleted" in eid:
            self._on_action(eid["actionCompleted"], event.get("action", {}))
        elif "testResult" in eid:
            self._on_test_result(eid["testResult"], event.get("testResult", {}))
        elif "testSummary" in eid:
            self._on_test_summary(eid["testSummary"], event.get("testSummary", {}))

    def _on_target_completed(self, tid: dict, completed: dict) -> None:
        label = tid.get("label", "")
        if not label:
            return
        info = self._target(label)
        info.kind = completed.get("targetKind", info.kind)
        info.build_success = bool(completed.get("success", False))

    def _on_aborted(self, tid: dict, aborted: dict) -> None:
        label = tid.get("label", "")
        if not label:
            return
        info = self._target(label)
        info.abort_reason = aborted.get("reason", "")
        info.abort_description = aborted.get("description", "")
        if info.build_success is None:
            info.build_success = False

    def _on_action(self, aid: dict, action: dict) -> None:
        # Only *failed* actions appear in BEP by default — a build/compile
        # failure with the compiler stderr we can attribute to the target.
        if action.get("success", True):
            return
        label = action.get("label") or aid.get("label", "")
        if not label:
            return
        info = self._target(label)
        stderr_text = ""
        stderr = action.get("stderr", {})
        if isinstance(stderr, dict):
            path = _uri_to_path(stderr.get("uri", ""))
            if path:
                stderr_text = self.read(path)
            elif stderr.get("contents"):
                stderr_text = stderr["contents"]
        info.action_failures.append((action.get("type", ""), stderr_text))
        if info.build_success is None:
            info.build_success = False

    def _on_test_result(self, tid: dict, result: dict) -> None:
        label = tid.get("label", "")
        if not label:
            return
        outputs = {}
        for out in result.get("testActionOutput", []):
            outputs[out.get("name", "")] = out.get("uri", "")
        self.test_results[label].append(
            {
                "run": int(tid.get("run", 1) or 1),
                "shard": int(tid.get("shardNumber", tid.get("shard", 1)) or 1),
                "attempt": int(tid.get("attempt", 1) or 1),
                "status": result.get("status", ""),
                "status_details": result.get("statusDetails", ""),
                "cached": bool(result.get("cachedLocally", False))
                or bool(result.get("executionInfo", {}).get("cachedRemotely", False)),
                "duration_ms": int(result.get("testAttemptDurationMillis", 0) or 0),
                "xml_uri": outputs.get("test.xml", ""),
                "log_uri": outputs.get("test.log", ""),
            }
        )

    def _on_test_summary(self, tid: dict, summary: dict) -> None:
        label = tid.get("label", "")
        if label:
            self.test_summaries[label] = summary

    # -- record materialization ---------------------------------------------

    def _base_record(self) -> Record:
        ctx = self.context
        millis = self.start_millis or 0
        if millis:
            ts = _dt.datetime.fromtimestamp(millis / 1000.0, tz=_dt.timezone.utc)
        else:
            ts = _dt.datetime.now(tz=_dt.timezone.utc)
        return Record(
            invocation_id=self.invocation_id,
            timestamp=ts.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            commit=ctx.get("commit", ""),
            branch=ctx.get("branch", ""),
            pr=ctx.get("pr", ""),
            workflow=ctx.get("workflow", ""),
            job=ctx.get("job", ""),
            run_url=ctx.get("run_url", ""),
            runner=ctx.get("runner", ""),
            runner_os=ctx.get("runner_os", ""),
        )

    def records(self) -> list:
        """Materialize the normalized record list for the whole invocation."""
        out: list = []
        # Every target that we saw a build result or test result for.
        labels = set(self.targets) | set(self.test_results) | set(self.test_summaries)
        for label in sorted(labels):
            info = self.targets.get(label)
            attempts = self.test_results.get(label, [])

            # Build/analysis failure with no test result -> one target record.
            if not attempts:
                if info and info.build_success is False:
                    out.append(self._build_failure_record(info))
                continue

            # Use the last attempt of each (run) as the authoritative outcome,
            # but keep FLAKY awareness: if any attempt passed after failing.
            out.extend(self._records_for_test(label, info, attempts))
        return out

    def _build_failure_record(self, info: _TargetInfo) -> Record:
        rec = self._base_record()
        rec.target = info.label
        rec.target_kind = info.kind
        rec.record_type = "target"
        rec.status = STATUS_BUILD_FAILED
        # Prefer compiler stderr; fall back to the abort description.
        text = ""
        if info.action_failures:
            text = "\n".join(t for _, t in info.action_failures if t) or ""
        if not text:
            text = info.abort_description or info.abort_reason or "build failed"
        rec.failure_reason = first_meaningful_line(text) or (info.abort_reason or "build failed")
        rec.failure_signature = signature(rec.failure_reason)
        rec.failure_category = categorize(text, STATUS_BUILD_FAILED)
        rec.failure_trace = _truncate(text)
        return rec

    def _records_for_test(self, label: str, info: Optional[_TargetInfo], attempts: list) -> list:
        # Group attempts by run; the final attempt is authoritative, but a pass
        # preceded by a failure is FLAKY.
        by_run: dict = defaultdict(list)
        for a in attempts:
            by_run[a["run"]].append(a)

        case_records: list = []
        summary_status = (self.test_summaries.get(label, {}) or {}).get("overallStatus", "")

        for run, run_attempts in sorted(by_run.items()):
            run_attempts.sort(key=lambda a: a["attempt"])
            final = run_attempts[-1]
            failed_earlier = any(_norm_status(a["status"]) in _FAILING for a in run_attempts[:-1])
            fstatus = _norm_status(final["status"])
            # A run whose final attempt passed only after an earlier failure is
            # flaky — surface that on its (passing) case rows so the "flaky
            # hardware/runner" view sees it. Bazel's own FLAKY summary counts too.
            run_flaky = (fstatus == STATUS_PASSED and failed_earlier) or summary_status == "FLAKY"

            # Per-test-case rows from the JUnit XML (falls back to one synthetic
            # case for the whole target when there's no usable XML).
            cases = self._parse_cases(final)
            for case in cases:
                rec = self._base_record()
                rec.target = label
                rec.target_kind = info.kind if info else ""
                rec.record_type = "test_case"
                rec.test_suite = case["suite"]
                rec.test_case = case["name"]
                rec.status = case["status"]
                if case["status"] == STATUS_PASSED and run_flaky:
                    rec.status = STATUS_FLAKY
                rec.cached = final["cached"]
                rec.duration_ms = case["duration_ms"]
                rec.attempt = final["attempt"]
                rec.run = run
                rec.shard = final["shard"]
                if case["status"] in _FAILING:
                    text = case["trace"] or final.get("status_details", "")
                    rec.failure_reason = first_meaningful_line(text) or case["status"]
                    rec.failure_signature = signature(rec.failure_reason)
                    rec.failure_category = categorize(text, case["status"])
                    rec.failure_trace = _truncate(text)
                case_records.append(rec)

        return case_records

    def _parse_cases(self, attempt: dict) -> list:
        xml_path = _uri_to_path(attempt.get("xml_uri", ""))
        status = _norm_status(attempt["status"])
        content = self.read(xml_path) if xml_path else ""
        cases = parse_junit_xml(content) if content.strip() else []

        if cases:
            return cases

        # No usable per-case XML: synthesize a single case for the whole target,
        # pulling the trace from the test log on failure.
        trace = ""
        if status in _FAILING:
            log_path = _uri_to_path(attempt.get("log_uri", ""))
            if log_path:
                trace = _tail(self.read(log_path))
            if not trace:
                trace = attempt.get("status_details", "")
        return [
            {
                "suite": "",
                "name": "(target)",
                "status": status,
                "duration_ms": attempt["duration_ms"],
                "trace": trace,
            }
        ]


def _norm_status(status: str) -> str:
    s = (status or "").upper()
    if s in (STATUS_PASSED, STATUS_FAILED, STATUS_TIMEOUT, STATUS_FLAKY, STATUS_SKIPPED):
        return s
    if s in ("FAILED_TO_BUILD", "BUILD_FAILURE"):
        return STATUS_BUILD_FAILED
    if s in ("INCOMPLETE", "REMOTE_FAILURE", "TOOL_HALTED_BEFORE_TESTING"):
        return STATUS_ERROR
    if s == "":
        return STATUS_ERROR
    return s


def parse_junit_xml(content: str) -> list:
    """Parse JUnit XML into per-case dicts. Tolerant of the common variants.

    Returns [] when the content isn't parseable JUnit, so the caller can fall
    back to a target-level synthetic case.
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []

    suites = []
    if root.tag == "testsuites":
        suites = list(root.findall("testsuite"))
    elif root.tag == "testsuite":
        suites = [root]
    else:
        return []

    cases = []
    for suite in suites:
        suite_name = suite.get("name", "")
        for case in suite.findall("testcase"):
            name = case.get("name", "")
            classname = case.get("classname", "")
            # Standard JUnit identity: classname.name. Keeps per-case rows stable
            # and disambiguates same-named cases across suites/classes.
            full = f"{classname}.{name}" if classname else name
            try:
                duration_ms = int(float(case.get("time", "0")) * 1000)
            except (TypeError, ValueError):
                duration_ms = 0
            status = STATUS_PASSED
            trace = ""
            fail = case.find("failure")
            err = case.find("error")
            skip = case.find("skipped")
            node = fail if fail is not None else err
            if node is not None:
                status = STATUS_FAILED if node is case.find("failure") else STATUS_ERROR
                msg = node.get("message", "")
                body = (node.text or "").strip()
                trace = (msg + "\n" + body).strip() if msg else body
            elif skip is not None:
                status = STATUS_SKIPPED
            cases.append(
                {
                    "suite": suite_name,
                    "name": full or "(unnamed)",
                    "status": status,
                    "duration_ms": duration_ms,
                    "trace": trace,
                }
            )
    return cases


_MAX_TRACE = 8000


def _truncate(text: str, limit: int = _MAX_TRACE) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated {len(text) - limit} chars]"


def _tail(text: str, lines: int = 60) -> str:
    text = text or ""
    parts = text.splitlines()
    return "\n".join(parts[-lines:])


# ---------------------------------------------------------------------------
# Aggregation for the report / summary
# ---------------------------------------------------------------------------


def summarize(records: list) -> dict:
    """Roll records up into the counts the HTML report + step summary need."""
    total = len(records)
    failures = [r for r in records if r.is_failure()]
    by_category = Counter(r.failure_category or "other" for r in failures)
    by_signature = Counter(r.failure_signature or r.failure_reason for r in failures)
    by_runner = Counter(r.runner or "unknown" for r in failures)
    by_target = Counter(r.target for r in failures)
    passed = sum(1 for r in records if r.status == STATUS_PASSED)
    flaky = sum(1 for r in records if r.status == STATUS_FLAKY)
    skipped = sum(1 for r in records if r.status == STATUS_SKIPPED)
    return {
        "total": total,
        "passed": passed,
        "failed": len(failures),
        "flaky": flaky,
        "skipped": skipped,
        "by_category": by_category.most_common(),
        "by_signature": by_signature.most_common(15),
        "by_runner": by_runner.most_common(),
        "by_target": by_target.most_common(20),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _context_from_args(args: argparse.Namespace) -> dict:
    return {
        "commit": args.commit,
        "branch": args.branch,
        "pr": args.pr,
        "workflow": args.workflow,
        "job": args.job,
        "run_url": args.run_url,
        "runner": args.runner,
        "runner_os": args.runner_os,
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--bep", required=True, help="Path to bazel --build_event_json_file output")
    p.add_argument("--out-ndjson", help="Write normalized records as NDJSON here")
    p.add_argument("--out-html", help="Write the static HTML report here")
    p.add_argument(
        "--out-summary", help="Write a short markdown summary here (e.g. $GITHUB_STEP_SUMMARY)"
    )
    p.add_argument(
        "--report-url",
        default="",
        help="Public URL of the uploaded HTML artifact (for the summary link)",
    )
    # CI / VCS context.
    p.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    p.add_argument("--branch", default=os.environ.get("GITHUB_REF_NAME", ""))
    p.add_argument("--pr", default="")
    p.add_argument("--workflow", default=os.environ.get("GITHUB_WORKFLOW", ""))
    p.add_argument("--job", default=os.environ.get("GITHUB_JOB", ""))
    p.add_argument("--run-url", default="")
    p.add_argument(
        "--runner", default="", help="Runner/DUT label, e.g. github:linux or hitl-rig-1:c6-abcdef"
    )
    p.add_argument("--runner-os", default=os.environ.get("RUNNER_OS", "").lower())
    # Sinks.
    p.add_argument(
        "--push", action="store_true", help="Push records to configured sinks (Loki/ClickHouse)"
    )
    return p


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.runner:
        # Sensible default for GitHub-hosted runners.
        os_name = (args.runner_os or "").lower() or "linux"
        args.runner = f"github:{os_name}"

    parser = BepParser(_context_from_args(args))
    for event in iter_bep_events(args.bep):
        parser.consume(event)
    records = parser.records()
    summary = summarize(records)

    if args.out_ndjson:
        with open(args.out_ndjson, "w", encoding="utf-8") as fh:
            for rec in records:
                fh.write(json.dumps(asdict(rec), separators=(",", ":")) + "\n")

    if args.out_html:
        from report_html import render_html  # local import keeps sinks/html optional

        with open(args.out_html, "w", encoding="utf-8") as fh:
            fh.write(render_html(records, summary, _context_from_args(args)))

    if args.out_summary:
        with open(args.out_summary, "a", encoding="utf-8") as fh:
            fh.write(render_markdown_summary(summary, args.report_url))

    if args.push:
        import sinks

        sinks.push_all(records)

    # Surface a one-line result on stdout for the CI log.
    print(
        f"ci-observability: {summary['total']} results "
        f"({summary['failed']} failed, {summary['flaky']} flaky) on {args.runner}"
    )
    return 0


def render_markdown_summary(summary: dict, report_url: str) -> str:
    """Small GitHub-flavored markdown block for $GITHUB_STEP_SUMMARY."""
    lines = ["", "### CI results", ""]
    lines.append(
        f"**{summary['passed']} passed**, **{summary['failed']} failed**, "
        f"{summary['flaky']} flaky, {summary['skipped']} skipped "
        f"({summary['total']} total)."
    )
    lines.append("")
    if report_url:
        lines.append(f"📊 [Open the full CI report]({report_url})")
        lines.append("")
    if summary["by_category"]:
        lines.append("| Failure category | Count |")
        lines.append("| --- | ---: |")
        for cat, n in summary["by_category"]:
            lines.append(f"| {cat} | {n} |")
        lines.append("")
    if summary["by_signature"]:
        lines.append("<details><summary>Top failure signatures</summary>")
        lines.append("")
        for sig, n in summary["by_signature"][:10]:
            lines.append(f"- `{n}×` {html.escape(sig)[:160]}")
        lines.append("")
        lines.append("</details>")
        lines.append("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
