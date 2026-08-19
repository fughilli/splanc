# CI observability — failure dashboarding (FUG-128)

Turn every Bazel-running CI job into queryable failure telemetry and a browsable
report. From the Bazel **Build Event Protocol** (BEP) we recover **per-test-case**
results, categorize failures, and drive a Grafana dashboard that answers:

- **Failures aggregated by trace / reason** — `Failure: out of disk` vs
  `ValueError: divide by zero` (grouped by a scrubbed failure _signature_).
- **Failures aggregated by runner / DUT** — `github:linux` vs `github:macos`
  vs `hitl` — to spot flaky hardware/runner configurations.
- **Heatmap of failures by test case** — which tests fail most.

Each Bazel job also uploads a **self-contained static HTML report** (charts +
collapsible per-target details) and links it from the job summary and the log.

## Architecture

```text
  GitHub Actions job (test / firmware / build-site / hitl / test-macos)
     │  bazel test|build … --build_event_json_file=bep.json
     ▼
  .github/actions/bep-report  (composite action, always())
     │  python3 tools/ci_observability/bep_report.py
     ├─► report.html ──► upload-artifact ──► link in job summary + ::notice:: log line
     └─► NDJSON records ──► sinks.push_all()
                              ├─► Grafana Cloud Loki   (default; reuses FUG-117 creds)
                              └─► ClickHouse-compatible (optional columnar; Tinybird/…)
                                        │
                  dashboards-as-code    ▼
        observability/ci/dashboards/ci-failures.json ──► Grafana  (3 views above)
```

## Components

| Path                                                 | What                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bep_report.py`                                      | Parse BEP → normalized records → NDJSON + HTML + step-summary; push to sinks. Stdlib only. |
| `report_html.py`                                     | The self-contained static HTML report renderer.                                            |
| `sinks.py`                                           | `loki` + `clickhouse` sinks; each no-ops without credentials.                              |
| `schema/ci_test_results.sql`                         | ClickHouse DDL for the columnar table.                                                     |
| `schema/ci_test_results.datasource`                  | Tinybird-native Data Source form of the same.                                              |
| `../../.github/actions/bep-report/action.yml`        | Reusable CI step wiring it all together.                                                   |
| `../../observability/ci/dashboards/ci-failures.json` | The Grafana dashboard, as code.                                                            |

## Per-test-case granularity

Bazel's BEP `TestResult` events point at each test's `test.xml` (JUnit). The
parser follows those and extracts one record **per `<testcase>`** — classname,
name, time, and the `<failure>`/`<error>` message + trace. When a target doesn't
emit its own JUnit XML, Bazel writes a minimal one and we fall back to a single
synthetic case for the whole target (trace pulled from `test.log`). Build/analysis
failures (no test result) become one `record_type=target` row, with the compiler
stderr as the reason.

> To get true per-case rows from a `py_test`, have it write JUnit XML to the
> `$XML_OUTPUT_FILE` Bazel sets — e.g. `pytest --junitxml="$XML_OUTPUT_FILE"`.
> Without it you still get correct target-level pass/fail, just not sub-case rows.

Each record also carries a `failure_category` (coarse bucket:
`disk|memory|timeout|network|build|assertion|other`) and a `failure_signature`
(the reason line with paths/addresses/line-numbers/timestamps scrubbed) so
identical failures across runs group into one row.

## The columnar database

The issue asks for a **columnar** store that is low-cost, fully-hosted, and
well-supported. Evaluated options:

| Option                    | Free & hosted?                      | Notes                                                                                                                                                                     |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tinybird** (Build plan) | ✅ free, hosted, managed ClickHouse | **Recommended columnar backend.** No credit card; ClickHouse under the hood, so `schema/ci_test_results.sql` applies and Grafana's ClickHouse datasource works.           |
| ClickHouse Cloud          | ⚠️ 30-day trial then paid           | The archetype, but not fully-free-hosted.                                                                                                                                 |
| Self-hosted ClickHouse    | free, **not** hosted                | You run it.                                                                                                                                                               |
| **Grafana Cloud Loki**    | ✅ free, hosted                     | Not columnar, but LogQL aggregates these structured events into all three views — and FUG-117 already wired the credentials, so this is the **zero-new-account default**. |

**What we ship:** the dashboard (`ci-failures.json`) is built against **Loki**,
because those credentials already exist in this repo (FUG-117) — so the pipeline
produces the three required views the moment the Loki secrets are present, with
no new account. The **ClickHouse sink + DDL** are the columnar upgrade: point
`CLICKHOUSE_URL` at a Tinybird/ClickHouse endpoint and the same records also land
in a real columnar table for ad-hoc SQL (the three reference queries are in the
DDL). Both sinks run; either can be left unconfigured.

## Configuration — the only manual step

Everything above is wired and tested. To light it up, set credentials (nothing
else):

### 1. Telemetry sink credentials (GitHub → repository secrets)

Set these as **repository** secrets (Settings → Secrets and variables → Actions
→ _Repository secrets_) so every workflow job inherits them; fork PRs see empty
values and the push/report steps no-op.

**Loki (default; same values FUG-117 uses for the HITL push):**

| Secret                    | Value                                                     |
| ------------------------- | --------------------------------------------------------- |
| `GRAFANA_CLOUD_LOKI_URL`  | `https://logs-prod-<region>.grafana.net/loki/api/v1/push` |
| `GRAFANA_CLOUD_LOKI_USER` | numeric Loki instance id                                  |
| `GRAFANA_CLOUD_LOKI_KEY`  | access-policy token with `logs:write`                     |

> These already live in the "HITL" _environment_ from FUG-117. Copy the same
> values to repository secrets so the non-HITL jobs (test, macos, …) can read
> them too. (Environment secrets are only visible to jobs that opt into that
> environment; the CI-observability jobs don't.)

**ClickHouse / Tinybird (optional columnar backend):**

| Secret                                    | Value                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `CLICKHOUSE_URL`                          | HTTP(S) endpoint, e.g. `https://<host>:8443` (ClickHouse) or the Tinybird ClickHouse-compatible URL |
| `CLICKHOUSE_DATABASE`                     | database name (optional)                                                                            |
| `CLICKHOUSE_TABLE`                        | table name (default `ci_test_results`)                                                              |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | ClickHouse auth, **or**                                                                             |
| `CLICKHOUSE_TOKEN`                        | a bearer token (Tinybird)                                                                           |

Then create the table once from `schema/ci_test_results.sql` (or push
`schema/ci_test_results.datasource` with the Tinybird CLI).

### 2. Grafana dashboard sync (already set up by FUG-117)

The dashboard is synced by the existing `grafana-dashboards.yaml` workflow,
which reads the "Grafana" Actions environment (`GRAFANA_URL`, `GRAFANA_TOKEN`,
optional `GRAFANA_FOLDER_UID`). It now also globs
`observability/ci/dashboards/*.json`, so a merge to `main` pushes the CI
dashboard automatically. Add a **Loki datasource** to your Grafana (Connections
→ Data sources) pointing at the same Grafana Cloud stack; the dashboard's
`DS_LOKI` variable selects it. For the columnar path, add the **ClickHouse**
datasource plugin and repoint the panels (or import the SQL from the DDL).

That's it — once the secrets are in place, the next CI run parses its BEP,
uploads the HTML report, and populates the dashboard.

## Local use

```sh
bazel test //some/target --build_event_json_file=/tmp/bep.json
bazel run //tools/ci_observability:bep_report -- \
  --bep /tmp/bep.json --out-html /tmp/report.html --runner local
open /tmp/report.html
```

`bazel test //tools/ci_observability:bep_report_test` runs the unit tests.
