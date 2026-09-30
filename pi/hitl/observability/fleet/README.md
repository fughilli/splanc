# HITL fleet inventory

A single **fleet-inventory table** in Grafana showing every HITL host and DUT with
its metadata — board, capabilities, and the identifying serial / port / UDID —
plus live free/busy. It answers "what's in the fleet and where" from the
authoritative source (the reservation catalogs), for the WHOLE fleet: Pi rigs,
`amd-rig` (SDR + phone benches), and the Mac — including hosts that aren't pushing
metrics yet.

## Why a separate artifact (metrics can't carry this)

The live Prometheus metrics only carry per-DUT **busy** flags — not the board
type, capabilities, or serials. That rich metadata lives in the reservation
catalogs (`pi/hitl/reserve/catalog*.json`), which the daemons read but never
export. And two catalog realities make the fleet un-derivable from metrics alone:

- `catalog.json` (the Pi rigs) is **fleet-identical and discovery-based** — it
  never names `hitl-rig-1/2/3` and lists no concrete DUTs (they're auto-discovered
  at runtime).
- `amd-rig` runs **two** daemons off two catalogs (`catalog-sdr.json` +
  `catalog-phone.json`); the Mac has its own (`catalog-mac.json`).

So `gen_inventory.py` aggregates the catalogs — bound to hosts by
[`fleet.json`](fleet.json), the one host↔catalog map that isn't in the catalogs —
into one flat `fleet-inventory.json` (one row per DUT). Because it's **static**,
every host appears even offline or pre-metrics (the Mac shows before its
observability lands — see the main README's follow-up).

## Data path (mirrors the fx_bench pipeline, minus the size)

```text
pi/hitl/reserve/catalog*.json  +  fleet.json  (host ↔ catalog / board / discovery-chips)
        │
        ▼   gen_inventory.py  (stdlib, flattens to one row per DUT)
fleet-inventory.json   ──committed (tiny; the 600 KB hook is fine)──►
        │
        ▼   Grafana Cloud `grafanacloud-infinity` reads the committed raw URL
   dashboards/hitl-fleet.json  →  "Fleet inventory" table (Infinity)
                                +  "Live per-DUT free/busy" table (Prometheus)
```

Unlike the multi-MB `fxbench-data` dataset (a release asset), this artifact is a
few KB, so it's committed and served from
`https://raw.githubusercontent.com/fughilli/splanc/main/pi/hitl/observability/fleet/fleet-inventory.json`
— no release, no token, and the change is reviewable in the PR. A
`--upload-release` mode is provided for parity if you'd rather serve it from a
`fleet-inventory` GitHub release like fx_bench (then point the panel's URL at the
release download instead).

## Row shape

`host, board, unit, dut, type, kind, capabilities, identifier, discovered,
pin_only, source`. Concrete components (amd-rig, Mac) fill every field from their
resource type + env markers; `discovered:true` rows are the Pi rigs' auto-discovered
DUT **classes** (the exact boards show up in the dashboard's live-status table).

## Running

```bash
# Regenerate after editing a catalog or fleet.json (commit the result):
python3 pi/hitl/observability/fleet/gen_inventory.py

# CI guard — fails if the committed JSON is stale:
python3 pi/hitl/observability/fleet/gen_inventory.py --check

# Unit tests (offline; parses the 4 real catalogs):
cd pi/hitl/observability/fleet && python3 test_gen_inventory.py

# Optional: publish to a `fleet-inventory` GitHub release instead of the raw URL:
GITHUB_TOKEN=$(cat /workspace/credentials/github_api_token.txt) \
  python3 pi/hitl/observability/fleet/gen_inventory.py --upload-release
```

`.github/workflows/fleet-inventory.yaml` runs the tests + `--check` on any change
to the catalogs or this directory, so the dashboard can't silently drift from the
catalogs. The dashboard itself syncs to Grafana via the existing
`grafana-dashboards.yaml` workflow.
