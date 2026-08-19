# CI observability dashboards (FUG-128)

`dashboards/ci-failures.json` is the Grafana dashboard — **as code** — for CI
failure analysis. It renders the three views the issue asks for:

1. **Failures aggregated by trace / reason** (scrubbed failure _signature_).
2. **Failures aggregated by runner / DUT** (`github:linux` / `github:macos` /
   `hitl` — flaky-hardware detection).
3. **Heatmap of failures by test case** (per-test-case failure counts).

It is backed by **Grafana Cloud Loki** (datasource variable `DS_LOKI`), which is
populated by the `ci-results` records the BEP parser pushes from every
Bazel-running CI job. The parser, sinks, and the columnar (ClickHouse/Tinybird)
alternative are documented in
[`tools/ci_observability/README.md`](../../tools/ci_observability/README.md).

## Sync

`.github/workflows/grafana-dashboards.yaml` pushes every `*.json` here (and the
HITL dashboards) to Grafana on a change to `main` (`POST /api/dashboards/db`,
keyed on the model `uid`). Edit a panel by editing the JSON in a PR; merging
syncs it. Config lives in the "Grafana" Actions environment (`GRAFANA_URL`,
`GRAFANA_TOKEN`, optional `GRAFANA_FOLDER_UID`) — set up in FUG-117.

To iterate by hand: Grafana → Dashboards → New → Import → paste the JSON, then
pick your Loki datasource.
