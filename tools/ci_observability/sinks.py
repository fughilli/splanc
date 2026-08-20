#!/usr/bin/env python3
"""Telemetry sinks for the CI-observability records (FUG-128).

Two pluggable backends, each a thin adapter over the normalized records and
each a **no-op when its credentials are absent** — so a CI job can call
``push_all`` unconditionally (fork PRs, un-configured repos, and local runs just
skip it):

  * ``loki``       Grafana Cloud Loki. Reuses the SAME ``GRAFANA_CLOUD_LOKI_*``
                   credentials FUG-117 already set up for the HITL CI push, so
                   the dashboards work with zero new secrets. Loki is not a
                   columnar DB, but LogQL aggregates these structured events into
                   the three required views (by trace, by runner, heatmap).

  * ``clickhouse``  A ClickHouse-compatible columnar DB over the HTTP interface
                   (``INSERT INTO <table> FORMAT JSONEachRow``). This is the
                   columnar option the issue asks for — it works against
                   Tinybird's free "Build" plan (managed ClickHouse), ClickHouse
                   Cloud, or any self-hosted ClickHouse. See schema/ for the DDL.

Standard-library only (urllib); no third-party HTTP client.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict


def _log(msg: str) -> None:
    print(f"ci-observability/sinks: {msg}", file=sys.stderr)


def _post(url: str, data: bytes, headers: dict, timeout: int = 20):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


# ---------------------------------------------------------------------------
# Loki
# ---------------------------------------------------------------------------

# Only these low-cardinality fields become Loki *stream labels* (labels are
# indexed; high-cardinality labels blow up Loki). Everything else rides in the
# JSON log line and is extracted at query time with `| json`.
_LOKI_LABELS = (
    "job",
    "result",
    "runner",
    "runner_os",
    "workflow",
    "record_type",
    "failure_category",
)


def push_loki(records: list) -> bool:
    url = os.environ.get("GRAFANA_CLOUD_LOKI_URL", "")
    key = os.environ.get("GRAFANA_CLOUD_LOKI_KEY", "")
    user = os.environ.get("GRAFANA_CLOUD_LOKI_USER", "")
    if not url or not key:
        _log("Loki creds unset; skipping Loki push.")
        return False
    if not records:
        _log("no records; skipping Loki push.")
        return False

    ts_ns = str(int(time.time() * 1_000_000_000))
    # Group records into streams keyed by their label set (Loki requires each
    # stream's label set be consistent; values within a stream vary in the line).
    streams: dict = {}
    for rec in records:
        d = asdict(rec)
        result = "fail" if rec.is_failure() else ("flaky" if rec.status == "FLAKY" else "pass")
        labels = {
            "job": "ci-results",
            "result": result,
            "runner": rec.runner or "unknown",
            "runner_os": rec.runner_os or "unknown",
            "workflow": rec.workflow or "unknown",
            "record_type": rec.record_type,
            "failure_category": rec.failure_category or "none",
        }
        key_t = tuple(sorted(labels.items()))
        streams.setdefault(key_t, (labels, []))[1].append(json.dumps(d, separators=(",", ":")))

    payload = {
        "streams": [
            {"stream": labels, "values": [[ts_ns, line] for line in lines]}
            for labels, lines in streams.values()
        ]
    }
    headers = {"Content-Type": "application/json"}
    if user:
        token = base64.b64encode(f"{user}:{key}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    else:
        headers["Authorization"] = f"Bearer {key}"

    try:
        resp = _post(url, json.dumps(payload).encode(), headers)
        code = resp.getcode()
    except urllib.error.HTTPError as e:
        _log(f"Loki push failed: HTTP {e.code} {e.read()[:200]!r}")
        return False
    except urllib.error.URLError as e:
        _log(f"Loki push failed: {e}")
        return False
    if code not in (204, 200):
        _log(f"Loki push returned HTTP {code}")
        return False
    _log(f"pushed {len(records)} records to Loki in {len(streams)} streams.")
    return True


# ---------------------------------------------------------------------------
# ClickHouse (Tinybird / ClickHouse Cloud / self-hosted)
# ---------------------------------------------------------------------------

# The columnar table columns, in the order the DDL declares them. JSONEachRow is
# order-independent by name, but we build explicit dicts to stay robust.
_CLICKHOUSE_COLUMNS = (
    "timestamp",
    "invocation_id",
    "commit",
    "branch",
    "pr",
    "workflow",
    "job",
    "run_url",
    "runner",
    "runner_os",
    "target",
    "target_kind",
    "record_type",
    "test_suite",
    "test_case",
    "status",
    "cached",
    "duration_ms",
    "attempt",
    "run",
    "shard",
    "failure_category",
    "failure_signature",
    "failure_reason",
    "failure_trace",
)


def _clickhouse_row(rec) -> dict:
    d = asdict(rec)
    row = {c: d.get(c) for c in _CLICKHOUSE_COLUMNS}
    # ClickHouse DateTime64 accepts 'YYYY-MM-DD HH:MM:SS'; our timestamp is ISO
    # with a trailing Z — normalize.
    ts = row.get("timestamp") or ""
    row["timestamp"] = ts.replace("T", " ").replace("Z", "")
    row["cached"] = 1 if row.get("cached") else 0
    return row


def push_clickhouse(records: list) -> bool:
    url = os.environ.get("CLICKHOUSE_URL", "")  # full HTTP endpoint, e.g. https://<host>:8443
    if not url:
        _log("ClickHouse creds unset; skipping ClickHouse push.")
        return False
    if not records:
        _log("no records; skipping ClickHouse push.")
        return False

    table = os.environ.get("CLICKHOUSE_TABLE", "ci_test_results")
    database = os.environ.get("CLICKHOUSE_DATABASE", "")
    user = os.environ.get("CLICKHOUSE_USER", "")
    password = os.environ.get("CLICKHOUSE_PASSWORD", "")
    token = os.environ.get("CLICKHOUSE_TOKEN", "")  # Tinybird uses a bearer token

    fq_table = f"{database}.{table}" if database else table
    query = f"INSERT INTO {fq_table} FORMAT JSONEachRow"
    body = "\n".join(
        json.dumps(_clickhouse_row(r), separators=(",", ":")) for r in records
    ).encode()

    sep = "&" if "?" in url else "?"
    endpoint = f"{url}{sep}query={urllib.parse.quote(query)}"
    headers = {"Content-Type": "application/x-ndjson"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif user:
        cred = base64.b64encode(f"{user}:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {cred}"

    try:
        resp = _post(endpoint, body, headers)
        code = resp.getcode()
    except urllib.error.HTTPError as e:
        _log(f"ClickHouse push failed: HTTP {e.code} {e.read()[:200]!r}")
        return False
    except urllib.error.URLError as e:
        _log(f"ClickHouse push failed: {e}")
        return False
    if code not in (200, 204):
        _log(f"ClickHouse push returned HTTP {code}")
        return False
    _log(f"pushed {len(records)} records to ClickHouse table {fq_table}.")
    return True


# ---------------------------------------------------------------------------
# Tinybird (Forward) — the recommended free, fully-hosted columnar backend
# ---------------------------------------------------------------------------

# Tinybird does NOT expose a raw ClickHouse `INSERT` HTTP endpoint; it ingests
# through its high-throughput Events API (POST /v0/events?name=<datasource>,
# newline-delimited JSON, Bearer token with append scope). This is the correct
# path for Tinybird Forward / the free "Build" plan. (push_clickhouse above is
# for real ClickHouse / ClickHouse Cloud / self-hosted.)


def _tinybird_row(rec) -> dict:
    # Same columns as the columnar schema, but keep the ISO-8601 timestamp — the
    # Events API parses ISO into DateTime64 — and coerce the bool to 0/1 for the
    # UInt8 column.
    d = asdict(rec)
    row = {c: d.get(c) for c in _CLICKHOUSE_COLUMNS}
    row["cached"] = 1 if row.get("cached") else 0
    return row


def push_tinybird(records: list) -> bool:
    api = os.environ.get("TINYBIRD_API_URL", "")  # e.g. https://api.us-east.aws.tinybird.co
    token = os.environ.get("TINYBIRD_TOKEN", "")  # token with DATASOURCES:APPEND scope
    if not api or not token:
        _log("Tinybird creds unset; skipping Tinybird push.")
        return False
    if not records:
        _log("no records; skipping Tinybird push.")
        return False

    datasource = os.environ.get("TINYBIRD_DATASOURCE", "ci_test_results")
    endpoint = f"{api.rstrip('/')}/v0/events?name={urllib.parse.quote(datasource)}"
    body = "\n".join(json.dumps(_tinybird_row(r), separators=(",", ":")) for r in records).encode()
    headers = {"Content-Type": "application/x-ndjson", "Authorization": f"Bearer {token}"}

    try:
        resp = _post(endpoint, body, headers)
        code = resp.getcode()
    except urllib.error.HTTPError as e:
        _log(f"Tinybird push failed: HTTP {e.code} {e.read()[:200]!r}")
        return False
    except urllib.error.URLError as e:
        _log(f"Tinybird push failed: {e}")
        return False
    if code not in (200, 202):
        _log(f"Tinybird push returned HTTP {code}")
        return False
    _log(f"pushed {len(records)} records to Tinybird datasource {datasource}.")
    return True


def push_all(records: list) -> None:
    """Push to every configured sink; each no-ops without its credentials."""
    push_loki(records)
    push_clickhouse(records)
    push_tinybird(records)
