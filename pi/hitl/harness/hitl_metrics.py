"""Named numeric measurements from HITL gates, for the "HITL performance" dashboard.

A gate calls `emit()` once per measured value it gates on (or wants trended). Each
call prints ONE line to stdout:

    HITL_METRIC {"v":1,"gate":"ble_rename","metric":"name_seen_latency","unit":"s",...}

CI runs the HITL suite with `--test_output=all`, so the line lands in the
`hitl_tests` job log. `pi/hitl/observability/metrics/ingest_hitl_metrics.py` parses
those lines out of every run's log (the way the fx_bench ingest parses its
`frame=` lines), attaches the run context (run id, branch, commit, time, bazel
target, attempt) and publishes the rows to the `fxbench-data` release, which
Grafana's Infinity datasource reads. The same record is also appended to
`$TEST_UNDECLARED_OUTPUTS_DIR/hitl_metrics.jsonl` (the hitl-test-outputs artifact)
so local runs and artifacts carry it too.

The schema (v1) is in pi/hitl/observability/metrics/README.md. In short:

  gate    short gate id, the bazel target minus its `_netstack`/SKU suffix
  metric  snake_case name of the quantity, no unit in it (`unit` carries that)
  unit    s | ms | us | fps | cycles | bytes | count | pct | kbps
  value   the number
  limit   the pass/fail bound the gate applies to THIS value (None = telemetry)
  cmp     "<=" | "<" | ">=" | ">"  (value <cmp> limit means pass)
  phase   optional sub-scenario (idle / connected, stored / absent, sender=osc...)
  stat    optional: "p50"/"p95"/"p99"/"max"/"mean" when value summarises samples
  n       optional: the number of samples behind a `stat`
  dut     DUT unit name; rig: rig host. Both default to the active Reservation
  fw      firmware commit; defaults to $GITHUB_SHA
  ok      whether value met limit (computed from limit/cmp when not given)

Emitting never raises: a telemetry failure must not fail a gate.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time

SCHEMA_VERSION = 1
PREFIX = "HITL_METRIC "
UNITS = ("s", "ms", "us", "fps", "cycles", "bytes", "count", "pct", "kbps")
CMPS = ("<=", "<", ">=", ">")

# Set by hitl_client.Reservation once a unit is active (rig host + DUT name), so a
# gate's emit() calls carry them without plumbing.
_context: dict[str, str] = {}


def set_context(**kw: str | None) -> None:
    """Record defaults (dut=, rig=, fw=) for later emit() calls. None clears a key."""
    for k, v in kw.items():
        if v is None:
            _context.pop(k, None)
        else:
            _context[k] = str(v)


def passes(value: float, limit: float, cmp: str) -> bool:
    if cmp == "<=":
        return value <= limit
    if cmp == "<":
        return value < limit
    if cmp == ">=":
        return value >= limit
    if cmp == ">":
        return value > limit
    raise ValueError(f"cmp must be one of {CMPS}, got {cmp!r}")


def record(
    gate: str,
    metric: str,
    value: float,
    unit: str,
    *,
    limit: float | None = None,
    cmp: str = "<=",
    phase: str | None = None,
    stat: str | None = None,
    n: int | None = None,
    dut: str | None = None,
    rig: str | None = None,
    fw: str | None = None,
    ok: bool | None = None,
    ts: float | None = None,
) -> dict:
    """Build (and validate) one metric record without printing it."""
    if not gate or not metric:
        raise ValueError("gate and metric are required")
    if unit not in UNITS:
        raise ValueError(f"unit must be one of {UNITS}, got {unit!r}")
    if cmp not in CMPS:
        raise ValueError(f"cmp must be one of {CMPS}, got {cmp!r}")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"value must be finite, got {value!r}")
    rec: dict = {"v": SCHEMA_VERSION, "gate": gate, "metric": metric, "unit": unit}
    rec["value"] = round(value, 6)
    if limit is not None:
        rec["limit"] = float(limit)
        rec["cmp"] = cmp
        rec["ok"] = passes(value, float(limit), cmp) if ok is None else bool(ok)
    elif ok is not None:
        rec["ok"] = bool(ok)
    if phase:
        rec["phase"] = str(phase)
    if stat:
        rec["stat"] = str(stat)
    if n is not None:
        rec["n"] = int(n)
    for key, given, env in (
        ("dut", dut, None),
        ("rig", rig, None),
        ("fw", fw, "GITHUB_SHA"),
    ):
        val = given or _context.get(key) or (os.environ.get(env) if env else None)
        if val:
            rec[key] = str(val)
    rec["ts"] = round(time.time() if ts is None else float(ts), 3)
    return rec


def emit(gate: str, metric: str, value: float, unit: str, **kw) -> dict | None:
    """Print one HITL_METRIC line (and append it to the test's outputs dir).

    Returns the record, or None if it could not be built (logged, never raised)."""
    try:
        rec = record(gate, metric, value, unit, **kw)
    except (TypeError, ValueError) as e:
        print(f"[hitl_metrics] dropped {gate}/{metric}: {e}", flush=True)
        return None
    line = json.dumps(rec, separators=(",", ":"), sort_keys=False)
    print(PREFIX + line, flush=True)
    out = os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR")
    if out:
        try:
            with open(os.path.join(out, "hitl_metrics.jsonl"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            print(f"[hitl_metrics] could not append to outputs: {e}", file=sys.stderr)
    return rec


def parse_line(line: str) -> dict | None:
    """The inverse of emit() for one log line (any prefix before HITL_METRIC is
    ignored, e.g. a CI timestamp). Returns None for other lines / bad JSON."""
    i = line.find(PREFIX)
    if i < 0:
        return None
    try:
        rec = json.loads(line[i + len(PREFIX) :].strip())
    except ValueError:
        return None
    if not isinstance(rec, dict) or not rec.get("gate") or not rec.get("metric"):
        return None
    if not isinstance(rec.get("value"), (int, float)):
        return None
    return rec
