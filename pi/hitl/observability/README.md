# HITL observability — Grafana dashboarding (FUG-117)

Status, health, and throughput of the HITL rigs and their CI, shipped to
**Grafana Cloud** (free tier) and plotted from dashboards kept **as code** in
this repo.

This directory holds everything: the metrics the daemon exposes (implemented in
`hitl-managerd`), the collector config (`alloy.alloy`), an opt-in NixOS module to
run it (`alloy.nix`), the dashboards (`dashboards/*.json`), the CI-result push
(`push-ci-metrics.sh`), and the workflow that syncs dashboards
(`.github/workflows/grafana-dashboards.yaml`).

## Architecture

```text
  ┌────────────── each HITL rig (Pi, on the tailnet) ──────────────┐
  │  hitl-managerd  ──GET /metrics──►  Grafana Alloy               │
  │  (queue, DUTs,                     (scrape :8087 + host node   │
  │   host cpu/mem/temp)                metrics; remote_write out) │
  └───────────────────────────────────────────┬───────────────────┘
                                               │ HTTPS remote_write (push)
                                               ▼
  GitHub Actions (HITL CI) ──result──►   ┌──────────────────────┐
     • Grafana Cloud GitHub integration  │    Grafana Cloud     │
       (workflow/job pass-fail, zero     │  Prometheus + Loki   │
        code), and/or                    │   + Dashboards       │
     • push-ci-metrics.sh → Loki         └──────────┬───────────┘
                                                    │
                        dashboards-as-code  ────────┘
                 (CI POSTs dashboards/*.json to /api/dashboards/db)
```

**Why a push (remote_write) model, not Grafana scraping the rigs.** The rigs sit
behind Tailscale and accept only tailnet peers (see `DESIGN.md` "Security") —
Grafana Cloud can't reach in to scrape them, and we don't want to expose an
inbound port. So a collector (**Grafana Alloy**) runs _on each Pi_, scrapes the
daemon and host locally, and dials _out_ to Grafana Cloud over HTTPS. This is the
standard pattern for edge/agent fleets and needs no inbound firewall holes.

## 1. Reporting from the runners

`hitl-managerd` serves Prometheus metrics at `GET /metrics` (port 8087, same as
the reservation API). Implemented in `internal/metrics` (a small stdlib-only
text-exposition writer — the `pi/hitl` Go module is deliberately dependency-free,
so we don't pull in `client_golang`) and `cmd/hitl-managerd/main.go`
(`writeMetrics`). Every series carries a `rig` label.

| Metric                                              | Type    | Meaning                                    |
| --------------------------------------------------- | ------- | ------------------------------------------ |
| `hitl_up`                                           | gauge   | 1 while the daemon serves.                 |
| `hitl_duts_total`                                   | gauge   | Configured DUTs on the rig.                |
| `hitl_duts_busy`                                    | gauge   | DUTs with an active reservation.           |
| `hitl_dut_busy{device}`                             | gauge   | Per-DUT occupancy (0/1).                   |
| `hitl_queue_depth`                                  | gauge   | Reservations queued waiting for a DUT.     |
| `hitl_active_reservations`                          | gauge   | Active reservations (one per busy DUT).    |
| `hitl_lease_seconds`                                | gauge   | Heartbeat lease window.                    |
| `hitl_reservations_total`                           | counter | Reservations enqueued.                     |
| `hitl_activations_total`                            | counter | Queued→active transitions.                 |
| `hitl_releases_total`                               | counter | Reservations ended (any reason).           |
| `hitl_lease_expirations_total`                      | counter | Reservations reaped for a lapsed lease.    |
| `hitl_start_failures_total`                         | counter | Container start failures during reconcile. |
| `hitl_host_load1`                                   | gauge   | Host 1-minute load average.                |
| `hitl_host_memory_total_bytes` / `_available_bytes` | gauge   | Host memory.                               |
| `hitl_host_temperature_celsius`                     | gauge   | SoC temperature.                           |

The daemon reads host CPU/mem/temp itself from `/proc` and `/sys` so a minimal
dashboard works even without the node exporter; `alloy.alloy` _also_ enables
Alloy's built-in Unix collector for the full set (per-core CPU, disk, net), which
the "Host resources" dashboard row can be extended to use.

Health/failure signals worth alerting on: a nonzero
`rate(hitl_start_failures_total)` (a DUT that won't come up), a sustained
`rate(hitl_lease_expirations_total)` (clients dying mid-session), or
`hitl_queue_depth` staying high (bench under-provisioned for CI load).

## 2. Reporting from GitHub

Two complementary options — use either or both:

**a) Grafana Cloud GitHub integration (recommended baseline, zero code).**
Grafana Cloud ships a GitHub integration that authorizes a GitHub App and pulls
workflow/job data via the API, producing Prometheus metrics (workflow run
counts, conclusions, durations) _and_ a prebuilt dashboard — including the HITL
workflow's pass/fail and runtime. Enable it under **Connections → Add new
connection → GitHub** and point it at this repo. No changes to our CI.

**b) Per-run push to Loki (`push-ci-metrics.sh`, optional, richer).** A CI job is
a discrete event, not a scrape target, so it goes to **Loki** (Grafana Cloud's
log store) rather than Prometheus — LogQL turns the events back into a pass-rate.
`.github/workflows/hitl.yaml` calls the script in a final `always()` step; it
no-ops when the `GRAFANA_CLOUD_LOKI_*` secrets are absent (so fork PRs and
un-configured repos are unaffected). Panel example (needs a Loki datasource):

```logql
sum(count_over_time({job="hitl-ci"} | logfmt | result="fail" [1d]))
/
sum(count_over_time({job="hitl-ci"} | logfmt [1d]))
```

## 3. Setting up Grafana Cloud (free tier)

The free tier (10k active Prometheus series, 50 GB logs, 14-day retention) is
comfortably enough for a handful of rigs.

1. Create a free stack at <https://grafana.com>.
2. **Prometheus** → _Details_: note the remote_write URL and the numeric
   username; create an **access-policy token** with `metrics:write`.
3. (For option 2b) **Loki** → _Details_: note the push URL and username; a token
   with `logs:write`.
4. Put the metrics creds in `pi/secrets/grafana.env` (the three
   `GRAFANA_CLOUD_PROM_*` keys — see `alloy.nix`) and seed each rig with
   `bazel run //pi/hitl:seed_grafana [-- host]`. That one file is
   **fleet-identical**: the per-rig `rig` label is injected by `alloy.nix` from
   the hostname (matching `hitl-managerd --rig`), so there's nothing per-rig to
   edit. Seeded out-of-band like the Tailscale/WiFi creds.
5. Put the Loki creds + the dashboard-sync creds in GitHub Actions
   _environments_ ("HITL" and "Grafana" respectively) — see the workflow files.

## 4. Running the collector on the rigs

`alloy.alloy` is the Alloy pipeline (scrape `127.0.0.1:8087/metrics` + host
metrics → remote_write to Grafana Cloud), run by the `alloy.nix` NixOS module.
That module is already imported by `flake.nix` (in `appModules`), so a normal
`bazel run //pi/hitl:hitl.deploy_live` ships it to every rig.

The `hitl-alloy` service starts only once `/var/lib/hitl/grafana.env` exists
(`ConditionPathExists`), so shipping it never breaks a rig that isn't wired to
Grafana yet — it stays dormant until `seed_grafana` drops the creds in.

## 5. Dashboards as code (bonus)

`dashboards/*.json` are Grafana dashboard models, versioned and reviewed like
code. `dashboards/hitl-rigs.json` covers the rig metrics above. It carries **no
template variables** (so the dashboard can be shared via Grafana's public/shared
link — those reject `datasource`/`query` variables): every panel pins the
Prometheus datasource `grafanacloud-prom`, and each panel breaks the
fleet out per-rig via the `{{rig}}` legend rather than a `$rig` filter. If your
Prometheus datasource UID differs, update the pinned `uid` in the JSON.

`.github/workflows/grafana-dashboards.yaml` pushes them to Grafana on any change
to `dashboards/` on `main` (`POST /api/dashboards/db`, `overwrite:true`, keyed on
each model's `uid`). Config lives in a "Grafana" Actions environment
(`GRAFANA_URL`, `GRAFANA_TOKEN` service-account token, optional
`GRAFANA_FOLDER_UID`). Edit a panel by editing the JSON in a PR; merging syncs it.

To iterate locally you can import a dashboard by hand (Dashboards → New →
Import → paste the JSON) and pick your Prometheus datasource.

## What's implemented here vs. operator setup

- **Implemented & tested in-repo:** the `/metrics` endpoint + metrics
  (`internal/metrics`, unit-tested and smoke-tested against a live daemon), the
  Alloy config, the opt-in Alloy NixOS module, the dashboard JSON, the
  CI-result push script (wired into `hitl.yaml`), and the dashboard-sync
  workflow.
- **Operator one-time setup (needs the Grafana Cloud account + secrets):**
  creating the stack, generating tokens, seeding `grafana.env` on the rigs,
  populating the "HITL"/"Grafana" GitHub environments, and enabling the GitHub
  integration. The Alloy NixOS module and the dashboard workflow are provided
  but not build-verified in-container (no Nix/Grafana network here); they follow
  the same deploy path as the rest of the rig.
